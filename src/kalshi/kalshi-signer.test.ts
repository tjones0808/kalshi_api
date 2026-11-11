import {
	constants,
	generateKeyPairSync,
	verify,
	type KeyObject,
} from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKalshiSigner, maskKeyId } from './kalshi-signer.js'

const keyId = 'abcd1234-0000-4000-8000-000000000000'
const now = 1_731_000_000_123

function rsaPair () {
	return generateKeyPairSync('rsa', { modulusLength: 2048 })
}

function verifyRsa (
	publicKey: KeyObject,
	text: string,
	signature: string,
): boolean {
	return verify(
		'sha256',
		Buffer.from(text, 'utf8'),
		{
			key: publicKey,
			padding: constants.RSA_PKCS1_PSS_PADDING,
			saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
		},
		Buffer.from(signature, 'base64'),
	)
}

describe('createKalshiSigner', function () {
	afterEach(function () {
		vi.useRealTimers()
	})

	it('signs timestamp, method and path with RSA-PSS', function () {
		vi.useFakeTimers()
		vi.setSystemTime(now)
		const { privateKey, publicKey } = rsaPair()
		const sign = createKalshiSigner({ keyId, privateKey })
		const path = '/trade-api/v2/portfolio/balance'
		const headers = sign('GET', path)
		expect(headers['KALSHI-ACCESS-KEY']).toBe(keyId)
		expect(headers['KALSHI-ACCESS-TIMESTAMP']).toBe(String(now))
		const text = `${now}GET${path}`
		const signature = headers['KALSHI-ACCESS-SIGNATURE']
		expect(verifyRsa(publicKey, text, signature)).toBe(true)
		expect(verifyRsa(publicKey, `${text}x`, signature))
			.toBe(false)
	})

	it('uses a salt as long as the digest', function () {
		const { privateKey, publicKey } = rsaPair()
		const sign = createKalshiSigner({ keyId, privateKey })
		const headers = sign('GET', '/trade-api/v2/portfolio/fills')
		const text = `${headers['KALSHI-ACCESS-TIMESTAMP']}GET`
			+ '/trade-api/v2/portfolio/fills'
		const wrongSalt = verify(
			'sha256',
			Buffer.from(text, 'utf8'),
			{
				key: publicKey,
				padding: constants.RSA_PKCS1_PSS_PADDING,
				saltLength: 0,
			},
			Buffer.from(headers['KALSHI-ACCESS-SIGNATURE'], 'base64'),
		)
		expect(wrongSalt).toBe(false)
	})

	it('signs with Ed25519 keys directly', function () {
		vi.useFakeTimers()
		vi.setSystemTime(now)
		const { privateKey, publicKey } =
			generateKeyPairSync('ed25519')
		const sign = createKalshiSigner({ keyId, privateKey })
		const path = '/trade-api/v2/portfolio/positions'
		const headers = sign('GET', path)
		const ok = verify(
			null,
			Buffer.from(`${now}GET${path}`, 'utf8'),
			publicKey,
			Buffer.from(
				headers['KALSHI-ACCESS-SIGNATURE'],
				'base64',
			),
		)
		expect(ok).toBe(true)
	})

	it('excludes the query string from the signed path', function () {
		vi.useFakeTimers()
		vi.setSystemTime(now)
		const { privateKey, publicKey } = rsaPair()
		const sign = createKalshiSigner({ keyId, privateKey })
		const headers = sign(
			'get',
			'/trade-api/v2/portfolio/orders?limit=5&cursor=a',
		)
		const signature = headers['KALSHI-ACCESS-SIGNATURE']
		expect(verifyRsa(
			publicKey,
			`${now}GET/trade-api/v2/portfolio/orders`,
			signature,
		)).toBe(true)
		expect(verifyRsa(
			publicKey,
			`${now}GET/trade-api/v2/portfolio/orders?limit=5`
				+ '&cursor=a',
			signature,
		)).toBe(false)
	})

	it('reads the clock on every call', function () {
		vi.useFakeTimers()
		vi.setSystemTime(now)
		const { privateKey } = rsaPair()
		const sign = createKalshiSigner({ keyId, privateKey })
		const first = sign('GET', '/trade-api/v2/exchange/status')
		vi.setSystemTime(now + 5)
		const second = sign('GET', '/trade-api/v2/exchange/status')
		expect(first['KALSHI-ACCESS-TIMESTAMP']).toBe(String(now))
		expect(second['KALSHI-ACCESS-TIMESTAMP'])
			.toBe(String(now + 5))
	})

	it('rejects key types Kalshi does not use', function () {
		const { privateKey } = generateKeyPairSync('ec', {
			namedCurve: 'prime256v1',
		})
		expect(function () {
			createKalshiSigner({ keyId, privateKey })
		}).toThrow('Unsupported private key type')
	})
})

describe('maskKeyId', function () {
	it('keeps only the first four characters', function () {
		expect(maskKeyId(keyId)).toBe('abcd…')
		expect(maskKeyId('abcdefghi')).toBe('abcd…')
	})

	it('hides short ids entirely', function () {
		expect(maskKeyId('ab')).toBe('****')
		expect(maskKeyId('abcdefgh')).toBe('****')
		expect(maskKeyId('')).toBe('****')
	})
})
