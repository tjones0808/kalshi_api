import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { parseEnv } from '../config/env.js'
import { createApp } from './app.js'

const authCheck = '/v1/_auth-check'
const keyOne = 'a'.repeat(32)
const keyTwo = 'b'.repeat(48)
const missingAuth = {
	error: 'unauthorized',
	message: 'Missing or invalid Authorization header',
}
const invalidKey = {
	error: 'unauthorized',
	message: 'Invalid API key',
}
const rateLimited = {
	error: 'rate_limited',
	message: 'Too many requests',
}

describe('http auth', function () {
	it('serves /health without Authorization', async function () {
		const env = parseEnv({
			API_KEYS: `${keyOne},${keyTwo}`,
			RATE_LIMIT_ANON_MAX: '2',
			RATE_LIMIT_MAX: '2',
		})
		const app = createApp(env)
		for (let i = 0; i < 4; i += 1) {
			const res = await request(app).get('/health')
			expect(res.status).toBe(200)
			expect(res.body).toEqual({
				status: 'ok',
				service: 'kalshi-sports-api',
			})
		}
		const head = await request(app).head('/health')
		expect(head.status).toBe(200)
		expect(app.locals).not.toHaveProperty('config')
		expect(app.locals).not.toHaveProperty('apiKeys')
	})

	it(
		'rejects /v1/_auth-check without a header',
		async function () {
			const env = parseEnv({ API_KEYS: keyOne })
			const app = createApp(env)
			const res = await request(app).get(authCheck)
			expect(res.status).toBe(401)
			expect(res.body).toEqual(missingAuth)
		},
	)

	it('rejects a wrong bearer token', async function () {
		const env = parseEnv({
			API_KEYS: `${keyOne},${keyTwo}`,
		})
		const app = createApp(env)
		const res = await request(app)
			.get(authCheck)
			.set('Authorization', 'Bearer wrong')
		expect(res.status).toBe(401)
		expect(res.body).toEqual(invalidKey)
		expect(res.text).not.toContain(keyTwo)
	})

	it(
		'accepts a valid key from parseEnv',
		async function () {
			const env = parseEnv({ API_KEYS: keyOne })
			const app = createApp(env)
			const res = await request(app)
				.get(authCheck)
				.set('Authorization', `Bearer ${keyOne}`)
			expect(res.status).toBe(200)
			expect(res.body).toEqual({ ok: true })
			const lower = await request(app)
				.get(authCheck)
				.set('Authorization', `bearer ${keyOne}`)
			expect(lower.status).toBe(200)
			expect(lower.body).toEqual({ ok: true })
		},
	)

	it(
		'accepts the second comma-separated key',
		async function () {
			const env = parseEnv({
				API_KEYS: `${keyOne},${keyTwo}`,
			})
			expect(env.apiKeys).toEqual([keyOne, keyTwo])
			const app = createApp(env)
			const res = await request(app)
				.get(authCheck)
				.set('Authorization', `Bearer ${keyTwo}`)
			expect(res.status).toBe(200)
			expect(res.body).toEqual({ ok: true })
			expect(res.text).not.toContain(keyTwo)
		},
	)

	it('rejects malformed Authorization', async function () {
		const env = parseEnv({ API_KEYS: keyOne })
		const app = createApp(env)
		const headers = [
			`Basic ${keyOne}`,
			'Bearer',
			'Bearer ',
		]
		for (const header of headers) {
			const res = await request(app)
				.get(authCheck)
				.set('Authorization', header)
			expect(res.status).toBe(401)
			expect(res.body).toEqual(missingAuth)
		}
	})

	it(
		'returns 401 or 404 for unknown paths',
		async function () {
			const env = parseEnv({ API_KEYS: keyOne })
			const app = createApp(env)
			const missing = await request(app).get('/no-such')
			expect(missing.status).toBe(401)
			expect(missing.body).toEqual(missingAuth)
			const found = await request(app)
				.get('/no-such')
				.set('Authorization', `Bearer ${keyOne}`)
			expect(found.status).toBe(404)
			expect(found.body).toEqual({
				error: 'not_found',
				message: 'Not found',
			})
		},
	)

	it(
		'does not count valid keys against the IP limit',
		async function () {
			const env = parseEnv({
				API_KEYS: keyOne,
				RATE_LIMIT_ANON_MAX: '2',
				RATE_LIMIT_MAX: '10',
			})
			const app = createApp(env)
			for (let i = 0; i < 5; i += 1) {
				const res = await request(app)
					.get(authCheck)
					.set('Authorization', `Bearer ${keyOne}`)
				expect(res.status).toBe(200)
				expect(res.body).toEqual({ ok: true })
			}
			const statuses: number[] = []
			for (let i = 0; i < 3; i += 1) {
				const res = await request(app).get(authCheck)
				statuses.push(res.status)
				if (i === 2) {
					expect(res.body).toEqual(rateLimited)
				}
			}
			expect(statuses).toEqual([401, 401, 429])
		},
	)

	it(
		'does not count authenticated 404s against the IP limit',
		async function () {
			const env = parseEnv({
				API_KEYS: keyOne,
				RATE_LIMIT_ANON_MAX: '2',
				RATE_LIMIT_MAX: '10',
			})
			const app = createApp(env)
			for (let i = 0; i < 5; i += 1) {
				const res = await request(app)
					.get('/no-such')
					.set('Authorization', `Bearer ${keyOne}`)
				expect(res.status).toBe(404)
			}
			const statuses: number[] = []
			for (let i = 0; i < 3; i += 1) {
				const res = await request(app).get(authCheck)
				statuses.push(res.status)
			}
			expect(statuses).toEqual([401, 401, 429])
		},
	)

	it(
		'lets 40 concurrent valid-key requests from one IP succeed',
		async function () {
			const env = parseEnv({
				API_KEYS: keyOne,
				RATE_LIMIT_ANON_MAX: '30',
				RATE_LIMIT_MAX: '1000',
			})
			const app = createApp(env)
			const results = await Promise.all(
				Array.from({ length: 40 }, function () {
					return request(app)
						.get(authCheck)
						.set('Authorization', `Bearer ${keyOne}`)
				}),
			)
			const statuses = results.map(function (res) {
				return res.status
			})
			expect(statuses.every(function (status) {
				return status === 200
			})).toBe(true)
		},
	)

	it(
		'rate limits the 31st bad-key request from one IP',
		async function () {
			const env = parseEnv({
				API_KEYS: keyOne,
				RATE_LIMIT_ANON_MAX: '30',
			})
			const app = createApp(env)
			const statuses: number[] = []
			for (let i = 0; i < 31; i += 1) {
				const res = await request(app)
					.get(authCheck)
					.set('Authorization', 'Bearer wrong')
				statuses.push(res.status)
			}
			expect(statuses.slice(0, 30).every(function (status) {
				return status === 401
			})).toBe(true)
			expect(statuses[30]).toBe(429)
		},
	)

	it(
		'accepts a valid key after the IP is anon-limited',
		async function () {
			const env = parseEnv({
				API_KEYS: keyOne,
				RATE_LIMIT_ANON_MAX: '2',
				RATE_LIMIT_MAX: '10',
			})
			const app = createApp(env)
			for (let i = 0; i < 3; i += 1) {
				await request(app).get(authCheck)
			}
			const blocked = await request(app).get(authCheck)
			expect(blocked.status).toBe(429)
			const res = await request(app)
				.get(authCheck)
				.set('Authorization', `Bearer ${keyOne}`)
			expect(res.status).toBe(200)
			expect(res.body).toEqual({ ok: true })
		},
	)

	it(
		'rejects an unauthenticated malformed body with 401',
		async function () {
			const env = parseEnv({ API_KEYS: keyOne })
			const app = createApp(env)
			const res = await request(app)
				.post('/v1/live/batch')
				.set('Content-Type', 'application/json')
				.send('{not json')
			expect(res.status).toBe(401)
			expect(res.body).toEqual(missingAuth)
		},
	)

	it(
		'rate limits unauthenticated requests by IP',
		async function () {
			const env = parseEnv({
				API_KEYS: keyOne,
				RATE_LIMIT_ANON_MAX: '2',
			})
			const app = createApp(env)
			const statuses: number[] = []
			for (let i = 0; i < 3; i += 1) {
				const res = await request(app).get(authCheck)
				statuses.push(res.status)
				if (i === 2) {
					expect(res.body).toEqual(rateLimited)
					expect(res.text).not.toContain(keyOne)
				}
			}
			expect(statuses).toEqual([401, 401, 429])
		},
	)

	it(
		'rate limits the third request for one key',
		async function () {
			const env = parseEnv({
				API_KEYS: `${keyOne},${keyTwo}`,
				RATE_LIMIT_MAX: '2',
				RATE_LIMIT_ANON_MAX: '10',
			})
			const app = createApp(env)
			const statuses: number[] = []
			for (let i = 0; i < 3; i += 1) {
				const res = await request(app)
					.get(authCheck)
					.set('Authorization', `Bearer ${keyOne}`)
				statuses.push(res.status)
				if (i === 2) {
					expect(res.body).toEqual(rateLimited)
					expect(res.text).not.toContain(keyOne)
				}
			}
			expect(statuses).toEqual([200, 200, 429])
			const other = await request(app)
				.get(authCheck)
				.set('Authorization', `Bearer ${keyTwo}`)
			expect(other.status).toBe(200)
			expect(other.body).toEqual({ ok: true })
		},
	)
})
