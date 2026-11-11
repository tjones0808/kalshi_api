import type { Response } from 'supertest'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { parseEnv } from '../config/env.js'
import type { GamesService } from '../domain/games-service.js'
import type { ParlayService } from '../domain/parlay-service.js'
import { quoteFromMarket } from '../domain/prices.js'
import { createApp } from '../http/app.js'
import type { AppServices } from '../http/app.js'
import {
	KalshiHttpError,
	KalshiRateLimitError,
	KalshiTimeoutError,
} from '../kalshi/errors.js'
import type { KalshiClient } from '../kalshi/kalshi-client.js'
import type { Market } from '../kalshi/types.js'

const apiKey = 'a'.repeat(32)
const accept = 'application/json, text/event-stream'
const missingAuth = {
	error: 'unauthorized',
	message: 'Missing or invalid Authorization header',
}
const protocolVersion = '2025-03-26'
const toolNames = [
	'exchange_status',
	'get_candlesticks',
	'get_game_markets',
	'get_live_game',
	'get_market',
	'get_orderbook',
	'get_trades',
	'list_games',
	'price_parlay',
]

interface RpcBody {
	jsonrpc?: string
	id?: number | string | null
	result?: {
		isError?: boolean
		content?: Array<{
			type?: string
			text?: string
		}>
		tools?: Array<{ name?: string }>
		protocolVersion?: string
		serverInfo?: {
			name?: string
		}
	}
	error?: {
		message?: string
	}
}

function testEnv () {
	return parseEnv({
		API_KEYS: apiKey,
		RATE_LIMIT_MAX: '50',
		RATE_LIMIT_ANON_MAX: '50',
	})
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

function silenceError () {
	return vi.spyOn(console, 'error').mockImplementation(
		function () {},
	)
}

function marketFixture (): Market {
	return {
		ticker: 'KXNBAGAME-26NOV11BOSNYK-BOS',
		event_ticker: 'KXNBAGAME-26NOV11BOSNYK',
		market_type: 'binary',
		yes_sub_title: 'Boston',
		status: 'active',
		yes_bid_dollars: '0.40',
		yes_ask_dollars: '0.42',
		no_bid_dollars: '0.58',
		no_ask_dollars: '0.60',
		volume_fp: '10',
		close_time: '2026-11-11T00:00:00Z',
	}
}

function initializeBody () {
	return {
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: {
			protocolVersion,
			capabilities: {},
			clientInfo: {
				name: 'test',
				version: '0.0.0',
			},
		},
	}
}

function parseRpc (text: string): RpcBody {
	const trimmed = text.trim()
	if (
		trimmed.startsWith('{')
		|| trimmed.startsWith('[')
	) {
		return JSON.parse(trimmed) as RpcBody
	}
	const messages: RpcBody[] = []
	for (const line of trimmed.split('\n')) {
		if (!line.startsWith('data:')) {
			continue
		}
		const payload = line.slice('data:'.length).trim()
		if (payload.length === 0) {
			continue
		}
		messages.push(JSON.parse(payload) as RpcBody)
	}
	const found = messages.find(function (message) {
		return message.jsonrpc === '2.0'
	})
	if (found === undefined) {
		throw new Error(`No JSON-RPC message in ${trimmed}`)
	}
	return found
}

async function postMcp (
	app: ReturnType<typeof createApp>,
	body: unknown,
	key?: string,
): Promise<Response> {
	const req = request(app)
		.post('/mcp')
		.set('Accept', accept)
		.set('Content-Type', 'application/json')
	if (key !== undefined) {
		req.set('Authorization', `Bearer ${key}`)
	}
	return req.send(body)
}

function toolText (body: RpcBody): string {
	expect(body.error).toBeUndefined()
	const content = body.result?.content ?? []
	const block = content[0]
	expect(body.result?.isError).not.toBe(true)
	expect(block?.type).toBe('text')
	expect(typeof block?.text).toBe('string')
	return block?.text ?? ''
}

describe('mcp endpoint', function () {
	it(
		'rejects initialize without a key',
		async function () {
			const listGames = vi.fn()
			const app = createApp(testEnv(), servicesFrom({
				games: { listGames },
			}))
			const res = await postMcp(app, initializeBody())
			expect(res.status).toBe(401)
			expect(res.body).toEqual(missingAuth)
			expect(listGames).not.toHaveBeenCalled()
		},
	)

	it('initializes and lists tools', async function () {
		const app = createApp(testEnv(), servicesFrom({}))
		const init = await postMcp(
			app,
			initializeBody(),
			apiKey,
		)
		expect(init.status).toBe(200)
		const initBody = parseRpc(init.text)
		expect(initBody.result?.protocolVersion).toBe(
			protocolVersion,
		)
		expect(initBody.result?.serverInfo?.name).toBe(
			'kalshi-sports-api',
		)
		const listed = await postMcp(app, {
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/list',
			params: {},
		}, apiKey)
		expect(listed.status).toBe(200)
		const body = parseRpc(listed.text)
		const names = (body.result?.tools ?? [])
			.map(function (tool) {
				return tool.name
			})
			.sort()
		expect(names).toEqual(toolNames)
	})

	it(
		'calls list_games for nba with the open default',
		async function () {
			const games = [{
				league: 'nba',
				eventTicker: 'KXNBAGAME-26NOV11BOSNYK',
				title: 'Boston at New York',
			}]
			const listGames = vi.fn(async function () {
				return { games, truncated: true }
			})
			const app = createApp(testEnv(), servicesFrom({
				games: { listGames },
			}))
			const res = await postMcp(app, {
				jsonrpc: '2.0',
				id: 3,
				method: 'tools/call',
				params: {
					name: 'list_games',
					arguments: { league: 'nba' },
				},
			}, apiKey)
			expect(res.status).toBe(200)
			const text = toolText(parseRpc(res.text))
			expect(JSON.parse(text)).toEqual({
				league: 'nba',
				games,
				truncated: true,
			})
			expect(listGames).toHaveBeenCalledWith({
				league: 'nba',
				status: 'open',
			})
		},
	)

	it('returns a compact market quote', async function () {
		const market = marketFixture()
		const getMarket = vi.fn(async function () {
			return market
		})
		const app = createApp(testEnv(), servicesFrom({
			kalshi: { getMarket },
		}))
		const res = await postMcp(app, {
			jsonrpc: '2.0',
			id: 4,
			method: 'tools/call',
			params: {
				name: 'get_market',
				arguments: { ticker: market.ticker },
			},
		}, apiKey)
		expect(res.status).toBe(200)
		const text = toolText(parseRpc(res.text))
		expect(JSON.parse(text)).toEqual({
			ticker: market.ticker,
			event_ticker: market.event_ticker,
			status: market.status,
			yes_sub_title: market.yes_sub_title,
			quote: quoteFromMarket(market),
			volume_fp: '10',
			close_time: '2026-11-11T00:00:00Z',
		})
	})

	it(
		'hides a Kalshi 404 and a rate limit',
		async function () {
			silenceError()
			const getMarket = vi.fn(async function () {
				throw new KalshiHttpError(
					404,
					'/markets/NOPE',
					'secret-snippet',
				)
			})
			const getExchangeStatus = vi.fn(
				async function () {
					throw new KalshiRateLimitError(
						'/exchange/status',
						'secret-limit',
					)
				},
			)
			const app = createApp(testEnv(), servicesFrom({
				kalshi: { getMarket, getExchangeStatus },
			}))
			const missing = await postMcp(app, {
				jsonrpc: '2.0',
				id: 5,
				method: 'tools/call',
				params: {
					name: 'get_market',
					arguments: { ticker: 'NOPE' },
				},
			}, apiKey)
			const missingBody = parseRpc(missing.text)
			expect(missingBody.result?.isError).toBe(true)
			expect(missingBody.result?.content?.[0]?.text)
				.toBe('Not found')
			expect(missing.text).not.toContain(
				'secret-snippet',
			)
			const limited = await postMcp(app, {
				jsonrpc: '2.0',
				id: 6,
				method: 'tools/call',
				params: {
					name: 'exchange_status',
					arguments: {},
				},
			}, apiKey)
			const limitedBody = parseRpc(limited.text)
			expect(limitedBody.result?.isError).toBe(true)
			expect(limitedBody.result?.content?.[0]?.text)
				.toBe('Kalshi rate limited the request')
			expect(limited.text).not.toContain('secret-limit')
		},
	)

	it(
		'resolves candlestick series from the market',
		async function () {
			const market = marketFixture()
			const candles = {
				ticker: market.ticker,
				candlesticks: [],
			}
			const getMarket = vi.fn(async function () {
				return market
			})
			const getMarketCandlesticks = vi.fn(
				async function () {
					return candles
				},
			)
			const app = createApp(testEnv(), servicesFrom({
				kalshi: {
					getMarket,
					getMarketCandlesticks,
				},
			}))
			const res = await postMcp(app, {
				jsonrpc: '2.0',
				id: 7,
				method: 'tools/call',
				params: {
					name: 'get_candlesticks',
					arguments: {
						ticker: market.ticker,
						interval: 60,
						start_ts: 10,
						end_ts: 20,
					},
				},
			}, apiKey)
			expect(res.status).toBe(200)
			expect(JSON.parse(toolText(parseRpc(res.text))))
				.toEqual(candles)
			expect(getMarketCandlesticks).toHaveBeenCalledWith(
				'KXNBAGAME',
				market.ticker,
				{
					start_ts: 10,
					end_ts: 20,
					period_interval: 60,
				},
			)
		},
	)

	it('returns only orderbook_fp', async function () {
		const getMarketOrderbook = vi.fn(async function () {
			return {
				orderbook_fp: {
					yes_dollars: [['0.40', '5']],
				},
				orderbook: { secret: true },
			}
		})
		const app = createApp(testEnv(), servicesFrom({
			kalshi: { getMarketOrderbook },
		}))
		const res = await postMcp(app, {
			jsonrpc: '2.0',
			id: 8,
			method: 'tools/call',
			params: {
				name: 'get_orderbook',
				arguments: { ticker: 'KXNBAGAME-BOS' },
			},
		}, apiKey)
		expect(res.status).toBe(200)
		expect(JSON.parse(toolText(parseRpc(res.text))))
			.toEqual({
				orderbook_fp: {
					yes_dollars: [['0.40', '5']],
				},
			})
		expect(res.text).not.toContain('secret')
	})

	it('prices a parlay from the service', async function () {
		const priced = {
			legs: [],
			combinedProbability: 0.4,
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
			side: 'yes',
		}]
		const res = await postMcp(app, {
			jsonrpc: '2.0',
			id: 9,
			method: 'tools/call',
			params: {
				name: 'price_parlay',
				arguments: { legs },
			},
		}, apiKey)
		expect(res.status).toBe(200)
		expect(JSON.parse(toolText(parseRpc(res.text))))
			.toEqual(priced)
		expect(priceParlay).toHaveBeenCalledWith(legs)
	})

	it('loads one game and its live snapshot', async function () {
		const game = {
			eventTicker: 'KXNBAGAME-26NOV11BOSNYK',
			title: 'Boston at New York',
		}
		const live = {
			milestoneId: 'mile-1',
			status: 'inprogress',
		}
		const getGame = vi.fn(async function () {
			return game
		})
		const getLive = vi.fn(async function () {
			return live
		})
		const app = createApp(testEnv(), servicesFrom({
			games: { getGame, getLive },
		}))
		const gameRes = await postMcp(app, {
			jsonrpc: '2.0',
			id: 10,
			method: 'tools/call',
			params: {
				name: 'get_game_markets',
				arguments: {
					eventKey: game.eventTicker,
				},
			},
		}, apiKey)
		expect(JSON.parse(toolText(parseRpc(gameRes.text))))
			.toEqual(game)
		expect(getGame).toHaveBeenCalledWith(
			game.eventTicker,
		)
		const liveRes = await postMcp(app, {
			jsonrpc: '2.0',
			id: 11,
			method: 'tools/call',
			params: {
				name: 'get_live_game',
				arguments: { milestoneId: 'mile-1' },
			},
		}, apiKey)
		expect(JSON.parse(toolText(parseRpc(liveRes.text))))
			.toEqual(live)
		expect(getLive).toHaveBeenCalledWith('mile-1')
	})

	it('forwards trade filters', async function () {
		const trades = {
			trades: [],
			cursor: 'next',
		}
		const getTrades = vi.fn(async function () {
			return trades
		})
		const app = createApp(testEnv(), servicesFrom({
			kalshi: { getTrades },
		}))
		const res = await postMcp(app, {
			jsonrpc: '2.0',
			id: 12,
			method: 'tools/call',
			params: {
				name: 'get_trades',
				arguments: {
					ticker: 'KXNBAGAME-BOS',
					limit: 5,
					cursor: 'page',
					min_ts: 1,
					max_ts: 9,
				},
			},
		}, apiKey)
		expect(JSON.parse(toolText(parseRpc(res.text))))
			.toEqual(trades)
		expect(getTrades).toHaveBeenCalledWith({
			ticker: 'KXNBAGAME-BOS',
			limit: 5,
			cursor: 'page',
			min_ts: 1,
			max_ts: 9,
		})
	})

	it(
		'rejects an invalid candlestick range',
		async function () {
			silenceError()
			const getMarket = vi.fn()
			const app = createApp(testEnv(), servicesFrom({
				kalshi: { getMarket },
			}))
			const ranges = [
				{ start_ts: 100, end_ts: 100, interval: 60 },
				{ start_ts: 0, end_ts: 300060, interval: 1 },
			]
			for (const range of ranges) {
				const res = await postMcp(app, {
					jsonrpc: '2.0',
					id: 20,
					method: 'tools/call',
					params: {
						name: 'get_candlesticks',
						arguments: { ticker: 'T', ...range },
					},
				}, apiKey)
				const body = parseRpc(res.text)
				expect(
					body.result?.isError === true
					|| body.error !== undefined,
				).toBe(true)
			}
			expect(getMarket).not.toHaveBeenCalled()
		},
	)

	it('reports a Kalshi timeout briefly', async function () {
		silenceError()
		const getExchangeStatus = vi.fn(async function () {
			throw new KalshiTimeoutError('/exchange/status')
		})
		const app = createApp(testEnv(), servicesFrom({
			kalshi: { getExchangeStatus },
		}))
		const res = await postMcp(app, {
			jsonrpc: '2.0',
			id: 21,
			method: 'tools/call',
			params: {
				name: 'exchange_status',
				arguments: {},
			},
		}, apiKey)
		const body = parseRpc(res.text)
		expect(body.result?.isError).toBe(true)
		expect(body.result?.content?.[0]?.text)
			.toBe('Upstream request timed out')
	})

	it('hides non-domain error messages', async function () {
		silenceError()
		const getGame = vi.fn(async function () {
			throw new TypeError('Cannot read properties of undefined')
		})
		const app = createApp(testEnv(), servicesFrom({
			games: { getGame },
		}))
		const res = await postMcp(app, {
			jsonrpc: '2.0',
			id: 30,
			method: 'tools/call',
			params: {
				name: 'get_game_markets',
				arguments: { eventKey: 'GAME' },
			},
		}, apiKey)
		const body = parseRpc(res.text)
		expect(body.result?.isError).toBe(true)
		expect(body.result?.content?.[0]?.text).toBe(
			'Internal server error',
		)
		expect(res.text).not.toContain('properties')
	})

	it('passes known domain messages through', async function () {
		silenceError()
		const getGame = vi.fn(async function () {
			throw new Error('Milestone abc has no game event')
		})
		const app = createApp(testEnv(), servicesFrom({
			games: { getGame },
		}))
		const res = await postMcp(app, {
			jsonrpc: '2.0',
			id: 31,
			method: 'tools/call',
			params: {
				name: 'get_game_markets',
				arguments: { eventKey: 'GAME' },
			},
		}, apiKey)
		const body = parseRpc(res.text)
		expect(body.result?.isError).toBe(true)
		expect(body.result?.content?.[0]?.text).toBe(
			'Milestone abc has no game event',
		)
	})

	it('hides stack text from tool errors', async function () {
		silenceError()
		const getGame = vi.fn(async function () {
			throw new Error(
				'boom\n    at secret (file.js:1:1)',
			)
		})
		const app = createApp(testEnv(), servicesFrom({
			games: { getGame },
		}))
		const res = await postMcp(app, {
			jsonrpc: '2.0',
			id: 13,
			method: 'tools/call',
			params: {
				name: 'get_game_markets',
				arguments: { eventKey: 'GAME' },
			},
		}, apiKey)
		const body = parseRpc(res.text)
		expect(body.result?.isError).toBe(true)
		expect(body.result?.content?.[0]?.text).toBe(
			'Internal server error',
		)
		expect(res.text).not.toContain('secret')
	})

	it(
		'stays unmounted when services are omitted',
		async function () {
			const app = createApp(testEnv())
			const res = await postMcp(
				app,
				initializeBody(),
				apiKey,
			)
			expect(res.status).toBe(404)
			expect(res.body).toEqual({
				error: 'not_found',
				message: 'Not found',
			})
		},
	)
})
