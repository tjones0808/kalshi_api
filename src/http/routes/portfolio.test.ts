import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { parseEnv } from '../../config/env.js'
import type { GamesService } from '../../domain/games-service.js'
import type { ParlayService } from '../../domain/parlay-service.js'
import type { PortfolioService } from '../../domain/portfolio-service.js'
import {
	KalshiAuthError,
	KalshiAuthNotConfiguredError,
	KalshiRateLimitError,
} from '../../kalshi/errors.js'
import type { KalshiClient } from '../../kalshi/kalshi-client.js'
import { createApp } from '../app.js'
import type { AppServices } from '../app.js'

const keyOne = 'a'.repeat(32)
const keyTwo = 'b'.repeat(32)
const paths = [
	'/v1/portfolio/balance',
	'/v1/portfolio/positions',
	'/v1/portfolio/fills',
	'/v1/portfolio/orders',
	'/v1/portfolio/settlements',
]
const notConfigured = {
	error: 'portfolio_not_configured',
	message: 'Portfolio access is not configured',
}
const forbidden = {
	error: 'forbidden',
	message: 'This API key cannot access the portfolio',
}

function envWith (extra: Record<string, string> = {}) {
	return parseEnv({
		API_KEYS: `${keyOne},${keyTwo}`,
		RATE_LIMIT_MAX: '100',
		RATE_LIMIT_ANON_MAX: '100',
		...extra,
	})
}

function portfolioStub (
	parts: Partial<PortfolioService> = {},
): PortfolioService {
	const balance = {
		balance: 12.34,
		portfolioValue: 5,
		updatedTs: 1,
		byExchangeIndex: null,
	}
	return {
		getBalance: vi.fn(async function () {
			return balance
		}),
		getPositions: vi.fn(async function () {
			return {
				marketPositions: [],
				eventPositions: [],
				cursor: null,
			}
		}),
		getFills: vi.fn(async function () {
			return { fills: [], cursor: null }
		}),
		getOrders: vi.fn(async function () {
			return { orders: [], cursor: null }
		}),
		getSettlements: vi.fn(async function () {
			return { settlements: [], cursor: null }
		}),
		...parts,
	}
}

function servicesWith (
	portfolio: PortfolioService | undefined,
): AppServices {
	return {
		kalshi: {} as KalshiClient,
		games: {} as GamesService,
		parlay: {} as ParlayService,
		...(portfolio === undefined ? {} : { portfolio }),
	}
}

function silenceError () {
	return vi.spyOn(console, 'error').mockImplementation(
		function () {},
	)
}

describe('portfolio routes', function () {
	it('answers 503 on every route without credentials', async function () {
		const app = createApp(envWith(), servicesWith(undefined))
		for (const path of paths) {
			const res = await request(app)
				.get(path)
				.set('Authorization', `Bearer ${keyOne}`)
			expect(res.status).toBe(503)
			expect(res.body).toEqual(notConfigured)
			expect(res.headers['cache-control']).toBe('no-store')
		}
	})

	it('still requires an API key first', async function () {
		const app = createApp(envWith(), servicesWith(undefined))
		const res = await request(app).get(paths[0] ?? '')
		expect(res.status).toBe(401)
	})

	it('serves the balance with no-store', async function () {
		const portfolio = portfolioStub()
		const app = createApp(envWith(), servicesWith(portfolio))
		const res = await request(app)
			.get('/v1/portfolio/balance?subaccount=1')
			.set('Authorization', `Bearer ${keyOne}`)
		expect(res.status).toBe(200)
		expect(res.headers['cache-control']).toBe('no-store')
		expect(res.body.balance).toBe(12.34)
		expect(portfolio.getBalance).toHaveBeenCalledWith({
			subaccount: 1,
		})
	})

	it('lets every key in when PORTFOLIO_API_KEYS is unset', async function () {
		const app = createApp(envWith(), servicesWith(portfolioStub()))
		for (const key of [keyOne, keyTwo]) {
			const res = await request(app)
				.get('/v1/portfolio/balance')
				.set('Authorization', `Bearer ${key}`)
			expect(res.status).toBe(200)
		}
	})

	it('answers 403 for a key outside PORTFOLIO_API_KEYS', async function () {
		const portfolio = portfolioStub()
		const env = envWith({ PORTFOLIO_API_KEYS: keyTwo })
		const app = createApp(env, servicesWith(portfolio))
		for (const path of paths) {
			const denied = await request(app)
				.get(path)
				.set('Authorization', `Bearer ${keyOne}`)
			expect(denied.status).toBe(403)
			expect(denied.body).toEqual(forbidden)
			expect(denied.headers['cache-control']).toBe('no-store')
			const allowed = await request(app)
				.get(path)
				.set('Authorization', `Bearer ${keyTwo}`)
			expect(allowed.status).toBe(200)
		}
		expect(portfolio.getBalance).toHaveBeenCalledTimes(1)
	})

	it('passes typed filters to each service method', async function () {
		const portfolio = portfolioStub()
		const app = createApp(envWith(), servicesWith(portfolio))
		const auth = `Bearer ${keyOne}`
		await request(app)
			.get('/v1/portfolio/positions?limit=50&cursor=c'
				+ '&count_filter=position,total_traded'
				+ '&settlement_status=all&ticker=T&event_ticker=E'
				+ '&exchange_index=0')
			.set('Authorization', auth)
			.expect(200)
		await request(app)
			.get('/v1/portfolio/fills?ticker=A,B&order_id=o'
				+ '&min_ts=1&max_ts=2&limit=1000&subaccount=0')
			.set('Authorization', auth)
			.expect(200)
		await request(app)
			.get('/v1/portfolio/orders?status=resting&limit=1'
				+ '&event_ticker=E1,E2&cursor=x')
			.set('Authorization', auth)
			.expect(200)
		await request(app)
			.get('/v1/portfolio/settlements?min_ts=5&ticker=T&cursor=')
			.set('Authorization', auth)
			.expect(200)
		expect(portfolio.getPositions).toHaveBeenCalledWith({
			limit: 50,
			cursor: 'c',
			count_filter: 'position,total_traded',
			settlement_status: 'all',
			ticker: 'T',
			event_ticker: 'E',
			exchange_index: 0,
		})
		expect(portfolio.getFills).toHaveBeenCalledWith({
			ticker: 'A,B',
			order_id: 'o',
			min_ts: 1,
			max_ts: 2,
			limit: 1000,
			subaccount: 0,
		})
		expect(portfolio.getOrders).toHaveBeenCalledWith({
			status: 'resting',
			limit: 1,
			event_ticker: 'E1,E2',
			cursor: 'x',
		})
		expect(portfolio.getSettlements).toHaveBeenCalledWith({
			min_ts: 5,
			ticker: 'T',
		})
	})

	it('rejects invalid queries with 400', async function () {
		silenceError()
		const portfolio = portfolioStub()
		const app = createApp(envWith(), servicesWith(portfolio))
		const bad = [
			'/v1/portfolio/fills?limit=0',
			'/v1/portfolio/fills?limit=1001',
			'/v1/portfolio/fills?min_ts=-1',
			'/v1/portfolio/orders?status=bogus',
			'/v1/portfolio/positions?settlement_status=bogus',
			'/v1/portfolio/positions?count_filter=nope',
			'/v1/portfolio/balance?subaccount=-2',
		]
		for (const path of bad) {
			const res = await request(app)
				.get(path)
				.set('Authorization', `Bearer ${keyOne}`)
			expect(res.status).toBe(400)
			expect(res.headers['cache-control']).toBe('no-store')
		}
		expect(portfolio.getFills).not.toHaveBeenCalled()
		expect(portfolio.getOrders).not.toHaveBeenCalled()
	})

	it('maps a Kalshi 401 to upstream_auth_failed', async function () {
		silenceError()
		const getBalance = vi.fn(async function () {
			throw new KalshiAuthError(401, '/portfolio/balance')
		})
		const app = createApp(
			envWith(),
			servicesWith(portfolioStub({ getBalance })),
		)
		const res = await request(app)
			.get('/v1/portfolio/balance')
			.set('Authorization', `Bearer ${keyOne}`)
		expect(res.status).toBe(502)
		expect(res.body).toEqual({
			error: 'upstream_auth_failed',
			message: 'Kalshi rejected the API credentials',
		})
		expect(res.headers['cache-control']).toBe('no-store')
	})

	it('keeps Kalshi 429 distinct from our own', async function () {
		silenceError()
		const getFills = vi.fn(async function () {
			throw new KalshiRateLimitError('/portfolio/fills', 'x')
		})
		const app = createApp(
			envWith(),
			servicesWith(portfolioStub({ getFills })),
		)
		const res = await request(app)
			.get('/v1/portfolio/fills')
			.set('Authorization', `Bearer ${keyOne}`)
		expect(res.status).toBe(502)
		expect(res.body.error).toBe('upstream_rate_limited')
	})

	it('maps a missing signer to 503', async function () {
		silenceError()
		const getOrders = vi.fn(async function () {
			throw new KalshiAuthNotConfiguredError()
		})
		const app = createApp(
			envWith(),
			servicesWith(portfolioStub({ getOrders })),
		)
		const res = await request(app)
			.get('/v1/portfolio/orders')
			.set('Authorization', `Bearer ${keyOne}`)
		expect(res.status).toBe(503)
		expect(res.body).toEqual(notConfigured)
	})

	it('has no write routes', async function () {
		silenceError()
		const portfolio = portfolioStub()
		const app = createApp(envWith(), servicesWith(portfolio))
		const attempts = [
			['post', '/v1/portfolio/orders'],
			['put', '/v1/portfolio/orders/abc'],
			['delete', '/v1/portfolio/orders/abc'],
			['post', '/v1/portfolio/orders/batched'],
			['patch', '/v1/portfolio/orders/abc/amend'],
			['post', '/v1/portfolio/balance'],
		] as const
		for (const [method, path] of attempts) {
			const res = await request(app)[method](path)
				.set('Authorization', `Bearer ${keyOne}`)
				.send({})
			expect(res.status).toBe(404)
		}
		expect(portfolio.getOrders).not.toHaveBeenCalled()
	})

	it('does not add no-store to market data', async function () {
		const getExchangeStatus = vi.fn(async function () {
			return { exchange_active: true, trading_active: true }
		})
		const app = createApp(envWith(), {
			...servicesWith(portfolioStub()),
			kalshi: { getExchangeStatus } as unknown as KalshiClient,
		})
		const res = await request(app)
			.get('/v1/exchange/status')
			.set('Authorization', `Bearer ${keyOne}`)
		expect(res.status).toBe(200)
		expect(res.headers['cache-control']).not.toBe('no-store')
	})
})
