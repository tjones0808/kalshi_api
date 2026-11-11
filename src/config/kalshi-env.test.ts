import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseEnv } from './env.js'

const keyOne = 'a'.repeat(32)
const keyTwo = 'b'.repeat(40)
const keyId = 'abcd1234-0000-4000-8000-000000000000'

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
const rsaPem = String(rsa.privateKey.export({
	type: 'pkcs8',
	format: 'pem',
}))
const rsaPkcs1 = String(rsa.privateKey.export({
	type: 'pkcs1',
	format: 'pem',
}))
const edPem = String(
	generateKeyPairSync('ed25519').privateKey.export({
		type: 'pkcs8',
		format: 'pem',
	}),
)
const dir = mkdtempSync(join(tmpdir(), 'kalshi-env-'))

afterAll(function () {
	rmSync(dir, { recursive: true, force: true })
})

function envWith (extra: Record<string, string>) {
	return { API_KEYS: `${keyOne},${keyTwo}`, ...extra }
}

function keyBody (pem: string): string {
	return pem
		.split('\n')
		.filter(function (line) {
			return line.length > 0 && !line.startsWith('-----')
		})
		.join('')
}

describe('parseEnv kalshi credentials', function () {
	it('has no auth and open portfolio by default', function () {
		const env = parseEnv(envWith({}))
		expect(env.kalshiAuth).toBeNull()
		expect(env.portfolioApiKeys).toBeNull()
	})

	it('treats blank values as unset', function () {
		const env = parseEnv(envWith({
			KALSHI_API_KEY_ID: '',
			KALSHI_PRIVATE_KEY: '  ',
			KALSHI_PRIVATE_KEY_PATH: '',
		}))
		expect(env.kalshiAuth).toBeNull()
		expect(env.portfolioApiKeys).toBeNull()
	})

	it('accepts a raw multiline PEM', function () {
		const env = parseEnv(envWith({
			KALSHI_API_KEY_ID: ` ${keyId} `,
			KALSHI_PRIVATE_KEY: rsaPem,
		}))
		expect(env.kalshiAuth?.keyId).toBe(keyId)
		expect(env.kalshiAuth?.privateKey.asymmetricKeyType)
			.toBe('rsa')
	})

	it('accepts a PKCS#1 RSA PEM', function () {
		expect(rsaPkcs1).toContain('BEGIN RSA PRIVATE KEY')
		const env = parseEnv(envWith({
			KALSHI_API_KEY_ID: keyId,
			KALSHI_PRIVATE_KEY: rsaPkcs1,
		}))
		expect(env.kalshiAuth?.privateKey.asymmetricKeyType)
			.toBe('rsa')
	})

	it('accepts a PEM with literal \\n escapes', function () {
		const escaped = rsaPem.trim().replace(/\n/g, '\\n')
		expect(escaped).not.toContain('\n')
		const env = parseEnv(envWith({
			KALSHI_API_KEY_ID: keyId,
			KALSHI_PRIVATE_KEY: escaped,
		}))
		expect(env.kalshiAuth?.privateKey.asymmetricKeyType)
			.toBe('rsa')
	})

	it('accepts a base64-encoded PEM', function () {
		const encoded = Buffer.from(rsaPem, 'utf8')
			.toString('base64')
		expect(encoded).not.toContain('-----BEGIN')
		const env = parseEnv(envWith({
			KALSHI_API_KEY_ID: keyId,
			KALSHI_PRIVATE_KEY: encoded,
		}))
		expect(env.kalshiAuth?.privateKey.asymmetricKeyType)
			.toBe('rsa')
	})

	it('accepts an Ed25519 key', function () {
		const env = parseEnv(envWith({
			KALSHI_API_KEY_ID: keyId,
			KALSHI_PRIVATE_KEY: edPem,
		}))
		expect(env.kalshiAuth?.privateKey.asymmetricKeyType)
			.toBe('ed25519')
	})

	it('reads the key from KALSHI_PRIVATE_KEY_PATH', function () {
		const file = join(dir, 'kalshi.pem')
		writeFileSync(file, rsaPem)
		const env = parseEnv(envWith({
			KALSHI_API_KEY_ID: keyId,
			KALSHI_PRIVATE_KEY_PATH: file,
		}))
		expect(env.kalshiAuth?.privateKey.asymmetricKeyType)
			.toBe('rsa')
	})

	it('fails when the key file is missing', function () {
		const file = join(dir, 'missing-secret-dir.pem')
		let message = ''
		try {
			parseEnv(envWith({
				KALSHI_API_KEY_ID: keyId,
				KALSHI_PRIVATE_KEY_PATH: file,
			}))
		} catch (err) {
			message = err instanceof Error ? err.message : ''
		}
		expect(message).toBe('KALSHI_PRIVATE_KEY_PATH could not be read')
		expect(message).not.toContain('missing-secret-dir')
	})

	it('fails when both key sources are set', function () {
		expect(function () {
			parseEnv(envWith({
				KALSHI_API_KEY_ID: keyId,
				KALSHI_PRIVATE_KEY: rsaPem,
				KALSHI_PRIVATE_KEY_PATH: join(dir, 'x.pem'),
			}))
		}).toThrow('Set only one of KALSHI_PRIVATE_KEY')
	})

	it('fails when only one of id and key is set', function () {
		const together = 'must be set together'
		expect(function () {
			parseEnv(envWith({ KALSHI_API_KEY_ID: keyId }))
		}).toThrow(together)
		expect(function () {
			parseEnv(envWith({ KALSHI_PRIVATE_KEY: rsaPem }))
		}).toThrow(together)
		const file = join(dir, 'only-key.pem')
		writeFileSync(file, rsaPem)
		expect(function () {
			parseEnv(envWith({ KALSHI_PRIVATE_KEY_PATH: file }))
		}).toThrow(together)
	})

	it('rejects an invalid PEM without leaking it', function () {
		const secret = 'SECRETKEYMATERIAL'
		const broken = '-----BEGIN PRIVATE KEY-----\\n'
			+ `${secret}\\n-----END PRIVATE KEY-----`
		let message = ''
		try {
			parseEnv(envWith({
				KALSHI_API_KEY_ID: keyId,
				KALSHI_PRIVATE_KEY: broken,
			}))
		} catch (err) {
			message = err instanceof Error ? err.message : ''
		}
		expect(message).toContain('KALSHI_PRIVATE_KEY is not a valid')
		expect(message).not.toContain(secret)
		expect(message).not.toContain('BEGIN')
	})

	it('rejects base64 that is not a PEM without leaking', function () {
		const junk = Buffer.from('not a pem at all', 'utf8')
			.toString('base64')
		let message = ''
		try {
			parseEnv(envWith({
				KALSHI_API_KEY_ID: keyId,
				KALSHI_PRIVATE_KEY: junk,
			}))
		} catch (err) {
			message = err instanceof Error ? err.message : ''
		}
		expect(message).toContain('is not a valid private key')
		expect(message).not.toContain(junk)
	})

	it('rejects key types Kalshi does not use', function () {
		const ec = String(
			generateKeyPairSync('ec', {
				namedCurve: 'prime256v1',
			}).privateKey.export({ type: 'pkcs8', format: 'pem' }),
		)
		expect(function () {
			parseEnv(envWith({
				KALSHI_API_KEY_ID: keyId,
				KALSHI_PRIVATE_KEY: ec,
			}))
		}).toThrow('must be an RSA or Ed25519 private key')
	})
})

describe('parseEnv PORTFOLIO_API_KEYS', function () {
	it('parses a subset of API_KEYS', function () {
		const env = parseEnv(envWith({
			PORTFOLIO_API_KEYS: ` ${keyTwo} , `,
		}))
		expect(env.portfolioApiKeys).toEqual([keyTwo])
	})

	it('rejects a key that is not in API_KEYS', function () {
		const stranger = 'c'.repeat(32)
		let message = ''
		try {
			parseEnv(envWith({ PORTFOLIO_API_KEYS: stranger }))
		} catch (err) {
			message = err instanceof Error ? err.message : ''
		}
		expect(message).toContain('must also be listed in API_KEYS')
		expect(message).not.toContain(stranger)
	})

	it('rejects short keys', function () {
		expect(function () {
			parseEnv(envWith({ PORTFOLIO_API_KEYS: 'abc' }))
		}).toThrow('at least 32 characters')
	})

	it('fails closed when the value holds no keys', function () {
		expect(function () {
			parseEnv(envWith({ PORTFOLIO_API_KEYS: ' , ' }))
		}).toThrow('PORTFOLIO_API_KEYS is set but contains no keys')
	})

	it('fails closed when the variable is blank', function () {
		for (const blank of ['', '   ']) {
			expect(function () {
				parseEnv(envWith({ PORTFOLIO_API_KEYS: blank }))
			}).toThrow('PORTFOLIO_API_KEYS is set but contains no keys')
		}
	})
})
