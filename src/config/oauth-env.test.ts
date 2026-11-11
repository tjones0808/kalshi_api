import { describe, expect, it } from 'vitest'
import { parseEnv } from './env.js'

const apiKey = 'a'.repeat(32)
const secret = 's'.repeat(32)

function parse (extra: Record<string, string>) {
	return parseEnv({ API_KEYS: apiKey, ...extra })
}

describe('oauth env', function () {
	it('is off without a secret', function () {
		expect(parse({}).oauth).toBeNull()
		expect(parse({
			PUBLIC_BASE_URL: 'https://x.example',
		}).oauth).toBeNull()
		expect(parse({ OAUTH_TOKEN_SECRET: '  ' }).oauth).toBeNull()
	})

	it('is off without a base URL', function () {
		expect(parse({ OAUTH_TOKEN_SECRET: secret }).oauth)
			.toBeNull()
	})

	it('turns on with a secret and PUBLIC_BASE_URL', function () {
		const env = parse({
			OAUTH_TOKEN_SECRET: secret,
			PUBLIC_BASE_URL: 'https://Api.Example.com/',
		})
		expect(env.oauth).toEqual({
			tokenSecret: secret,
			baseUrl: 'https://api.example.com',
			allowedRedirectHosts: [
				'chatgpt.com',
				'localhost',
				'127.0.0.1',
			],
			cimdHosts: ['chatgpt.com'],
		})
	})

	it('falls back to RAILWAY_PUBLIC_DOMAIN', function () {
		const env = parse({
			OAUTH_TOKEN_SECRET: secret,
			RAILWAY_PUBLIC_DOMAIN: 'kalshiapi-production.up.railway.app',
		})
		expect(env.oauth?.baseUrl).toBe(
			'https://kalshiapi-production.up.railway.app',
		)
		const explicit = parse({
			OAUTH_TOKEN_SECRET: secret,
			PUBLIC_BASE_URL: 'https://mine.example',
			RAILWAY_PUBLIC_DOMAIN: 'other.up.railway.app',
		})
		expect(explicit.oauth?.baseUrl).toBe('https://mine.example')
	})

	it('allows http only for localhost', function () {
		for (const url of [
			'http://localhost:3000',
			'http://127.0.0.1:3000',
		]) {
			const env = parse({
				OAUTH_TOKEN_SECRET: secret,
				PUBLIC_BASE_URL: url,
			})
			expect(env.oauth?.baseUrl).toBe(url)
		}
		expect(function () {
			parse({
				OAUTH_TOKEN_SECRET: secret,
				PUBLIC_BASE_URL: 'http://api.example.com',
			})
		}).toThrow('https')
	})

	it('rejects a bad base URL', function () {
		for (const url of [
			'not a url',
			'https://x.example/path',
			'https://x.example/?q=1',
			'https://user:pw@x.example',
		]) {
			expect(function () {
				parse({
					OAUTH_TOKEN_SECRET: secret,
					PUBLIC_BASE_URL: url,
				})
			}).toThrow('PUBLIC_BASE_URL')
		}
	})

	it('rejects a short or placeholder secret', function () {
		const base = { PUBLIC_BASE_URL: 'https://x.example' }
		expect(function () {
			parse({ ...base, OAUTH_TOKEN_SECRET: 'short' })
		}).toThrow('at least 32')
		expect(function () {
			parse({
				...base,
				OAUTH_TOKEN_SECRET: 'replace-me-with-a-long-random-secret',
			})
		}).toThrow('placeholder')
		expect(function () {
			parse({ OAUTH_TOKEN_SECRET: 'short' })
		}).toThrow('at least 32')
	})

	it('never puts the secret in an error', function () {
		const bad = 'replace-me-' + 'z'.repeat(30)
		try {
			parse({
				OAUTH_TOKEN_SECRET: bad,
				PUBLIC_BASE_URL: 'https://x.example',
			})
			expect.unreachable()
		} catch (err) {
			expect(String(err)).not.toContain(bad)
		}
	})

	it('reads OAUTH_CIMD_HOSTS apart from the redirect hosts', function () {
		const base = {
			OAUTH_TOKEN_SECRET: secret,
			PUBLIC_BASE_URL: 'https://x.example',
		}
		const env = parse({
			...base,
			OAUTH_ALLOWED_REDIRECT_HOSTS: 'a.example',
			OAUTH_CIMD_HOSTS: 'B.example, c.example',
		})
		expect(env.oauth?.allowedRedirectHosts).toEqual(['a.example'])
		expect(env.oauth?.cimdHosts).toEqual(['b.example', 'c.example'])
		expect(function () {
			parse({ ...base, OAUTH_CIMD_HOSTS: 'https://x.example' })
		}).toThrow('OAUTH_CIMD_HOSTS')
	})

	it('reads OAUTH_ALLOWED_REDIRECT_HOSTS', function () {
		const base = {
			OAUTH_TOKEN_SECRET: secret,
			PUBLIC_BASE_URL: 'https://x.example',
		}
		const env = parse({
			...base,
			OAUTH_ALLOWED_REDIRECT_HOSTS: ' ChatGPT.com , a.b ,a.b',
		})
		expect(env.oauth?.allowedRedirectHosts).toEqual([
			'chatgpt.com',
			'a.b',
		])
		for (const hosts of [
			'https://chatgpt.com',
			'chatgpt.com/path',
			'host:8080',
			'*.example.com',
			',',
		]) {
			expect(function () {
				parse({
					...base,
					OAUTH_ALLOWED_REDIRECT_HOSTS: hosts,
				})
			}).toThrow('OAUTH_ALLOWED_REDIRECT_HOSTS')
		}
	})
})
