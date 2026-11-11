import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { parseEnv } from '../../config/env.js'
import type { GamesService } from '../../domain/games-service.js'
import type { ParlayService } from '../../domain/parlay-service.js'
import type { ParlayPrice } from '../../domain/parlay-service.js'
import { KalshiHttpError } from '../../kalshi/errors.js'
import type { KalshiClient } from '../../kalshi/kalshi-client.js'
import { createApp } from '../app.js'
import type { AppServices } from '../app.js'

const apiKey = 'a'.repeat(32)
const gamesPath = '/v1/leagues/nba/games'
const missingAuth = {
	error: 'unauthorized',
	message: 'Missing or invalid Authorization header',
}
const badRequest = {
	error: 'bad_request',
	message: 'Invalid request',
}
const unknownLeague = {
	error: 'bad_request',
	message: 'Unknown league',
}

function testEnv () {
	return parseEnv({
		API_KEYS: apiKey,
		RATE_LIMIT_MAX: '50',
		RATE_LIMIT_ANON_MAX: '50',
	})
}

function silenceError () {
	return vi.spyOn(console, 'error').mockImplementation(
		function () {},
	)
}

function servicesFrom (parts: {
	kalshi?: Partial<KalshiClient>
	games?: Partial<GamesService>
	parlay?: Partial<ParlayService>
}): AppServices {
	return {
		kalshi: (parts.kalshi ?? {}) as KalshiClient,
		games: (parts.games ?? {}) as GamesService,
		parlay: (parts.parlay ?? {}) as ParlayService,
	}
}

describe('v1 routes', function () {
	it(
		'rejects league games without a key',
		async function () {
			const listGames = vi.fn()
			const app = createApp(testEnv(), servicesFrom({
				games: { listGames },
			}))
			const res = await request(app).get(gamesPath)
			expect(res.status).toBe(401)
			expect(res.body).toEqual(missingAuth)
			expect(listGames).not.toHaveBeenCalled()
		},
	)

	it('lists games from the games service', async function () {
		const games = [{
			league: 'nba',
			eventTicker: 'KXNBAGAME-26NOV11BOSNYK',
			title: 'Boston at New York',
		}]
		const listGames = vi.fn(async function () {
			return { games, truncated: false }
		})
		const app = createApp(testEnv(), servicesFrom({
			games: { listGames },
		}))
		const res = await request(app)
			.get(gamesPath)
			.set('Authorization', `Bearer ${apiKey}`)
		expect(res.status).toBe(200)
		expect(res.body).toEqual({
			league: 'nba',
			games,
			truncated: false,
		})
		expect(listGames).toHaveBeenCalledWith({
			league: 'nba',
			status: 'open',
		})
	})

	it('rejects an unknown league', async function () {
		silenceError()
		const listGames = vi.fn()
		const app = createApp(testEnv(), servicesFrom({
			games: { listGames },
		}))
		const res = await request(app)
			.get('/v1/leagues/mlb/games')
			.set('Authorization', `Bearer ${apiKey}`)
		expect(res.status).toBe(400)
		expect(res.body).toEqual(unknownLeague)
		expect(listGames).not.toHaveBeenCalled()
	})

	it('rejects a bad game date', async function () {
		silenceError()
		const listGames = vi.fn()
		const app = createApp(testEnv(), servicesFrom({
			games: { listGames },
		}))
		const res = await request(app)
			.get(`${gamesPath}?date=not-a-date`)
			.set('Authorization', `Bearer ${apiKey}`)
		expect(res.status).toBe(400)
		expect(res.body).toEqual(badRequest)
		expect(listGames).not.toHaveBeenCalled()
	})

	it('prices a parlay from the parlay service', async function () {
		const priced: ParlayPrice = {
			legs: [],
			combinedProbability: 0.4,
			decimalOdds: 2.5,
			americanOdds: 150,
			payoutPerDollar: 2.5,
			profitPerDollar: 1.5,
			warnings: [],
		}
		const priceParlay = vi.fn(async function () {
			return priced
		})
		const app = createApp(testEnv(), servicesFrom({
			parlay: { priceParlay },
		}))
		const legs = [{
			ticker: 'KXNBAGAME-26NOV11BOSNYK-BOS',
			side: 'yes' as const,
		}]
		const res = await request(app)
			.post('/v1/parlays/price')
			.set('Authorization', `Bearer ${apiKey}`)
			.send({ legs })
		expect(res.status).toBe(200)
		expect(res.body).toEqual(priced)
		expect(priceParlay).toHaveBeenCalledWith(legs)
	})

	it('rejects a parlay body without legs', async function () {
		silenceError()
		const priceParlay = vi.fn()
		const app = createApp(testEnv(), servicesFrom({
			parlay: { priceParlay },
		}))
		const res = await request(app)
			.post('/v1/parlays/price')
			.set('Authorization', `Bearer ${apiKey}`)
			.send({})
		expect(res.status).toBe(400)
		expect(res.body).toEqual(badRequest)
		expect(priceParlay).not.toHaveBeenCalled()
	})

	it(
		'maps a Kalshi 404 on a market read',
		async function () {
			silenceError()
			const getMarket = vi.fn(async function () {
				throw new KalshiHttpError(
					404,
					'/markets/NOPE',
					'secret-snippet',
				)
			})
			const app = createApp(testEnv(), servicesFrom({
				kalshi: { getMarket },
			}))
			const res = await request(app)
				.get('/v1/markets/NOPE')
				.set('Authorization', `Bearer ${apiKey}`)
			expect(res.status).toBe(404)
			expect(res.body).toEqual({
				error: 'not_found',
				message: 'Not found',
			})
			expect(res.text).not.toContain('secret-snippet')
		},
	)

	describe('candlesticks range', function () {
		const base = '/v1/markets/KXNBAGAME-26NOV11BOSNYK-BOS'
			+ '/candlesticks'

		function candleApp () {
			const getMarket = vi.fn(async function () {
				return {
					ticker: 'KXNBAGAME-26NOV11BOSNYK-BOS',
					event_ticker: 'KXNBAGAME-26NOV11BOSNYK',
				}
			})
			const getMarketCandlesticks = vi.fn(async function () {
				return { ticker: 'T', candlesticks: [] }
			})
			const app = createApp(testEnv(), servicesFrom({
				kalshi: {
					getMarket: getMarket as unknown as
						KalshiClient['getMarket'],
					getMarketCandlesticks,
				},
			}))
			return { app, getMarket, getMarketCandlesticks }
		}

		it('accepts a valid range', async function () {
			const { app, getMarketCandlesticks } = candleApp()
			const res = await request(app)
				.get(`${base}?interval=60&start_ts=0&end_ts=3600`)
				.set('Authorization', `Bearer ${apiKey}`)
			expect(res.status).toBe(200)
			expect(getMarketCandlesticks).toHaveBeenCalledTimes(1)
		})

		it('accepts exactly 5000 candles', async function () {
			const { app } = candleApp()
			const res = await request(app)
				.get(`${base}?interval=1&start_ts=0&end_ts=300000`)
				.set('Authorization', `Bearer ${apiKey}`)
			expect(res.status).toBe(200)
		})

		it('rejects end_ts not after start_ts', async function () {
			silenceError()
			const { app, getMarket } = candleApp()
			for (const query of [
				'start_ts=100&end_ts=100',
				'start_ts=200&end_ts=100',
			]) {
				const res = await request(app)
					.get(`${base}?interval=60&${query}`)
					.set('Authorization', `Bearer ${apiKey}`)
				expect(res.status).toBe(400)
				expect(res.body).toEqual({
					error: 'bad_request',
					message: 'end_ts must be after start_ts',
				})
			}
			expect(getMarket).not.toHaveBeenCalled()
		})

		it('rejects more than 5000 candles', async function () {
			silenceError()
			const { app, getMarket } = candleApp()
			const res = await request(app)
				.get(`${base}?interval=1&start_ts=0&end_ts=300060`)
				.set('Authorization', `Bearer ${apiKey}`)
			expect(res.status).toBe(400)
			expect(res.body).toEqual({
				error: 'bad_request',
				message: 'range spans more than 5000 candles',
			})
			expect(getMarket).not.toHaveBeenCalled()
		})
	})

	it('serves health without a key', async function () {
		const app = createApp(testEnv(), servicesFrom({}))
		const res = await request(app).get('/health')
		expect(res.status).toBe(200)
		expect(res.body).toEqual({
			status: 'ok',
			service: 'kalshi-sports-api',
		})
	})
})
