import { describe, expect, it } from 'vitest'
import {
	createTokenService,
	keyFingerprint,
	openToken,
	signToken,
} from './oauth-tokens.js'

const secret = 's'.repeat(40)

describe('signToken and openToken', function () {
	it('round-trips a payload', function () {
		const token = signToken(secret, { typ: 'x', n: 1 })
		expect(token.startsWith('v1.')).toBe(true)
		expect(openToken(secret, token)).toEqual({ typ: 'x', n: 1 })
	})

	it('rejects the wrong secret and altered parts', function () {
		const token = signToken(secret, { n: 1 })
		const parts = token.split('.')
		expect(openToken('t'.repeat(40), token)).toBeUndefined()
		expect(openToken(secret, `${token}A`)).toBeUndefined()
		const body = Buffer.from('{"n":2}').toString('base64url')
		expect(
			openToken(secret, `v1.${body}.${parts[2]}`),
		).toBeUndefined()
		expect(
			openToken(secret, `v2.${parts[1]}.${parts[2]}`),
		).toBeUndefined()
	})

	it('rejects malformed and oversized input', function () {
		for (const token of ['', 'v1', 'v1.a', 'v1.a.b.c', '...']) {
			expect(openToken(secret, token)).toBeUndefined()
		}
		expect(
			openToken(secret, `v1.${'a'.repeat(9000)}.b`),
		).toBeUndefined()
	})

	it('rejects a signed payload that is not JSON', function () {
		const body = Buffer.from('not json').toString('base64url')
		const input = `v1.${body}`
		const token = signToken(secret, {}).split('.')
		expect(openToken(secret, `${input}.${token[2]}`))
			.toBeUndefined()
	})
})

describe('createTokenService', function () {
	it('keeps token types apart', function () {
		const service = createTokenService(secret, () => 0)
		const access = service.issueAccess({
			iss: 'i',
			aud: 'a',
			cid: 'c',
			sc: 's',
			kfp: 'k',
			fam: 'f',
		}, 60)
		const code = service.issueCode({
			jti: 'j',
			cid: 'c',
			ruri: 'r',
			cc: 'x',
			res: 'a',
			sc: 's',
			kfp: 'k',
		}, 60)
		expect(service.readAccess(access)).toBeDefined()
		expect(service.readCode(access)).toBeUndefined()
		expect(service.readRefresh(access)).toBeUndefined()
		expect(service.readClient(access)).toBeUndefined()
		expect(service.readAuthRequest(code)).toBeUndefined()
		expect(service.readAccess(code)).toBeUndefined()
	})

	it('expires tokens by the injected clock', function () {
		let now = 1_000_000
		const service = createTokenService(secret, function () {
			return now
		})
		const token = service.issueRefresh({
			iss: 'i',
			aud: 'a',
			cid: 'c',
			sc: 's',
			kfp: 'k',
			fam: 'f',
			jti: 'j',
		}, 10)
		expect(service.readRefresh(token)).toBeDefined()
		now += 9_000
		expect(service.readRefresh(token)).toBeDefined()
		now += 1_000
		expect(service.readRefresh(token)).toBeUndefined()
	})

	it('reads a client registration without expiry', function () {
		let now = 0
		const service = createTokenService(secret, function () {
			return now
		})
		const token = service.issueClient('Name', ['https://a/b'])
		now = 10 ** 13
		expect(service.readClient(token)).toMatchObject({
			name: 'Name',
			uris: ['https://a/b'],
		})
	})
})

describe('keyFingerprint', function () {
	it('is 128 bits, stable, and tied to key and secret', function () {
		const key = 'k'.repeat(32)
		const first = keyFingerprint(secret, key)
		expect(first).toMatch(/^[0-9a-f]{32}$/)
		expect(keyFingerprint(secret, key)).toBe(first)
		expect(keyFingerprint(secret, 'j'.repeat(32))).not.toBe(first)
		expect(keyFingerprint('t'.repeat(40), key)).not.toBe(first)
	})
})
