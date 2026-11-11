import { describe, expect, it } from 'vitest'
import { parseEnv } from './env.js'

const longKey = 'a'.repeat(32)
const otherKey = 'b'.repeat(32)
const requiredKeysMessage =
	'API_KEYS is required. The server must not start without keys.'
const shortKeyMessage =
	'Each API key in API_KEYS must be at least 32 characters.'

describe('parseEnv', function () {
	it('succeeds with a 32 character API key', function () {
		const env = parseEnv({ API_KEYS: longKey })
		expect(env.apiKeys).toEqual([longKey])
		expect(env.port).toBe(3000)
		expect(env.rateLimitMax).toBe(120)
		expect(env.rateLimitAnonMax).toBe(30)
	})

	it('defaults and bounds the timeout and cache size', function () {
		const env = parseEnv({ API_KEYS: longKey })
		expect(env.kalshiTimeoutMs).toBe(8000)
		expect(env.kalshiDeadlineMs).toBe(20000)
		expect(env.cacheMaxEntries).toBe(5000)
		const custom = parseEnv({
			API_KEYS: longKey,
			KALSHI_TIMEOUT_MS: '1000',
			CACHE_MAX_ENTRIES: '100000',
		})
		expect(custom.kalshiTimeoutMs).toBe(1000)
		expect(custom.cacheMaxEntries).toBe(100000)
		for (const bad of [
			{ KALSHI_TIMEOUT_MS: '999' },
			{ KALSHI_TIMEOUT_MS: '60001' },
			{ KALSHI_DEADLINE_MS: '1999' },
			{ KALSHI_DEADLINE_MS: '120001' },
			{ CACHE_MAX_ENTRIES: '99' },
			{ CACHE_MAX_ENTRIES: '100001' },
		]) {
			expect(function () {
				parseEnv({ API_KEYS: longKey, ...bad })
			}).toThrow('Invalid environment')
		}
	})

	it('throws if API_KEYS is missing', function () {
		expect(function () {
			parseEnv({})
		}).toThrow(requiredKeysMessage)
	})

	it('throws if API_KEYS is empty', function () {
		expect(function () {
			parseEnv({ API_KEYS: '' })
		}).toThrow(requiredKeysMessage)
		expect(function () {
			parseEnv({ API_KEYS: '  ,  ' })
		}).toThrow(requiredKeysMessage)
	})

	it('throws if any API key is shorter than 32', function () {
		expect(function () {
			parseEnv({ API_KEYS: 'abc' })
		}).toThrow(shortKeyMessage)
		expect(function () {
			parseEnv({ API_KEYS: `${longKey},ab` })
		}).toThrow(shortKeyMessage)
		expect(function () {
			parseEnv({ API_KEYS: 'a'.repeat(31) })
		}).toThrow(shortKeyMessage)
	})

	it('rejects the .env.example placeholder key', function () {
		const placeholder = 'replace-me-with-a-long-random-key-32'
		expect(placeholder.length).toBeGreaterThanOrEqual(32)
		expect(function () {
			parseEnv({ API_KEYS: placeholder })
		}).toThrow('placeholder')
		expect(function () {
			parseEnv({ API_KEYS: `${longKey},${placeholder}` })
		}).toThrow('Generate a real key')
		expect(function () {
			parseEnv({ API_KEYS: 'replace-me' })
		}).toThrow('placeholder')
		expect(function () {
			parseEnv({ API_KEYS: `x-REPLACE-ME-${'a'.repeat(32)}` })
		}).toThrow('placeholder')
	})

	it('splits comma-separated keys and trims', function () {
		const env = parseEnv({
			API_KEYS: ` ${longKey} , ${otherKey} , `,
		})
		expect(env.apiKeys).toEqual([longKey, otherKey])
	})
})
