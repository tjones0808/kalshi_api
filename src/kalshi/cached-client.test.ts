import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCachedKalshiClient } from './cached-client.js'
import { createKalshiClient } from './kalshi-client.js'
import type { KalshiClient } from './kalshi-client.js'
import { TtlCache } from './ttl-cache.js'
import type { Market } from './types.js'

const BASE = 'https://example.test/trade-api/v2'

function sampleMarket (ticker: string): Market {
	return {
		ticker,
		event_ticker: 'EVT',
		market_type: 'binary',
		yes_sub_title: 'Yes',
		status: 'active',
		yes_bid_dollars: '0.4000',
		yes_ask_dollars: '0.4300',
		no_bid_dollars: '0.5700',
		no_ask_dollars: '0.6000',
	}
}

function jsonResponse (body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json',
		},
	})
}

function callsTo (
	fetchImpl: ReturnType<typeof vi.fn>,
	suffix: string,
): number {
	return fetchImpl.mock.calls.filter(function (call) {
		const args = call as unknown[]
		return String(args[0]).includes(suffix)
	}).length
}

function cachedHarness () {
	const fetchImpl = vi.fn(async function (
		input: RequestInfo | URL,
	) {
		const path = new URL(String(input)).pathname
		if (path.endsWith('/markets/ABC/orderbook')) {
			return jsonResponse({
				orderbook_fp: {
					yes_dollars: [['0.4500', '10']],
					no_dollars: [],
				},
			})
		}
		if (path.endsWith('/markets/ABC')) {
			return jsonResponse({ market: sampleMarket('ABC') })
		}
		if (path.endsWith('/markets/DEF')) {
			return jsonResponse({ market: sampleMarket('DEF') })
		}
		if (path.endsWith('/series/S')) {
			return jsonResponse({
				series: {
					ticker: 'S',
					title: 'Series',
					frequency: 'daily',
					category: 'Sports',
				},
			})
		}
		if (path.endsWith('/markets/trades')) {
			return jsonResponse({ trades: [] })
		}
		if (path.endsWith('/candlesticks')) {
			return jsonResponse({
				ticker: 'T',
				candlesticks: [],
			})
		}
		if (path.endsWith('/exchange/status')) {
			return jsonResponse({
				exchange_active: true,
				trading_active: true,
			})
		}
		if (path.endsWith('/milestones')) {
			return jsonResponse({ milestones: [] })
		}
		if (path.includes('/milestones/')) {
			return jsonResponse({
				milestone: {
					id: 'ms-1',
					category: 'Sports',
					type: 'football_game',
					start_date: '2026-11-12T00:00:00Z',
					title: 'Game',
					related_event_tickers: [],
					primary_event_tickers: [],
					details: {},
				},
			})
		}
		if (path.endsWith('/events')) {
			return jsonResponse({ events: [] })
		}
		if (path.endsWith('/live_data/batch')) {
			return jsonResponse({ live_datas: [] })
		}
		throw new Error(`unexpected ${path}`)
	})

	const client = createCachedKalshiClient(
		createKalshiClient({
			baseUrl: BASE,
			fetchImpl: fetchImpl as typeof fetch,
		}),
		new TtlCache(),
		{
			cacheTtlSeriesMs: 0,
			cacheTtlMarketsMs: 60_000,
			cacheTtlOrderbookMs: 5_000,
			cacheTtlLiveMs: 5_000,
			cacheTtlTradesMs: 10_000,
		},
	)

	return { fetchImpl, client }
}

describe('createCachedKalshiClient', function () {
	afterEach(function () {
		vi.useRealTimers()
	})

	it('caches getMarket per ticker', async function () {
		const { fetchImpl, client } = cachedHarness()
		await client.getMarket('ABC')
		await client.getMarket('ABC')
		await client.getMarket('DEF')
		expect(callsTo(fetchImpl, '/markets/ABC')).toBe(1)
		expect(callsTo(fetchImpl, '/markets/DEF')).toBe(1)
	})

	it('keys getAllEvents on maxPages', async function () {
		const { fetchImpl, client } = cachedHarness()
		await client.getAllEvents({ maxPages: 3 })
		await client.getAllEvents({ maxPages: 3 })
		expect(callsTo(fetchImpl, '/events')).toBe(1)
		await client.getAllEvents({ maxPages: 2 })
		await client.getAllEvents({})
		expect(callsTo(fetchImpl, '/events')).toBe(3)
	})

	it('does not cache series when the series ttl is 0', async function () {
		const { fetchImpl, client } = cachedHarness()
		await client.getSeries('S')
		await client.getSeries('S')
		expect(callsTo(fetchImpl, '/series/S')).toBe(2)
	})

	it('caches the first trades page and not later cursors', async function () {
		const { fetchImpl, client } = cachedHarness()
		await client.getTrades({ ticker: 'ABC' })
		await client.getTrades({ ticker: 'ABC' })
		await client.getTrades({ ticker: 'ABC', cursor: 'c1' })
		await client.getTrades({ ticker: 'ABC', cursor: 'c1' })
		expect(callsTo(fetchImpl, '/markets/trades')).toBe(3)
	})

	it('caches candlesticks by the full query', async function () {
		const { fetchImpl, client } = cachedHarness()
		const first = {
			start_ts: 1,
			end_ts: 2,
			period_interval: 60 as const,
		}
		const second = {
			start_ts: 3,
			end_ts: 4,
			period_interval: 60 as const,
		}
		await client.getMarketCandlesticks('S', 'T', first)
		await client.getMarketCandlesticks('S', 'T', first)
		await client.getMarketCandlesticks('S', 'T', second)
		expect(callsTo(fetchImpl, '/candlesticks')).toBe(2)
	})

	it('caches exchange status for 10 seconds', async function () {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
		const { fetchImpl, client } = cachedHarness()
		await client.getExchangeStatus()
		await client.getExchangeStatus()
		expect(callsTo(fetchImpl, '/exchange/status')).toBe(1)
		vi.advanceTimersByTime(9_999)
		await client.getExchangeStatus()
		expect(callsTo(fetchImpl, '/exchange/status')).toBe(1)
		vi.advanceTimersByTime(1)
		await client.getExchangeStatus()
		expect(callsTo(fetchImpl, '/exchange/status')).toBe(2)
	})

	it('caches milestones, events, and orderbooks', async function () {
		const { fetchImpl, client } = cachedHarness()
		await client.getMilestones({ limit: 10 })
		await client.getMilestones({ limit: 10 })
		await client.getEvents({ status: 'open' })
		await client.getEvents({ status: 'open' })
		await client.getMarketOrderbook('ABC')
		await client.getMarketOrderbook('ABC')
		expect(callsTo(fetchImpl, '/milestones')).toBe(1)
		expect(callsTo(fetchImpl, '/events')).toBe(1)
		expect(callsTo(fetchImpl, '/orderbook')).toBe(1)
	})

	it('caches one milestone by id', async function () {
		const { fetchImpl, client } = cachedHarness()
		await client.getMilestone('ms-1')
		await client.getMilestone('ms-1')
		expect(callsTo(fetchImpl, '/milestones/ms-1')).toBe(1)
	})

	it('caches a live data batch as one result', async function () {
		const { fetchImpl, client } = cachedHarness()
		await client.getLiveDataBatch(['a', 'b'])
		await client.getLiveDataBatch(['a', 'b'])
		expect(callsTo(fetchImpl, '/live_data/batch')).toBe(1)
	})

	it('never caches portfolio reads', async function () {
		const inner = {
			getBalance: vi.fn(async function () {
				return { balance: 1, portfolio_value: 2 }
			}),
			getPositions: vi.fn(async function () {
				return { market_positions: [], event_positions: [] }
			}),
			getFills: vi.fn(async function () {
				return { fills: [] }
			}),
			getOrders: vi.fn(async function () {
				return { orders: [] }
			}),
			getSettlements: vi.fn(async function () {
				return { settlements: [] }
			}),
		}
		const cache = new TtlCache()
		const wrap = vi.spyOn(cache, 'wrap')
		const client = createCachedKalshiClient(
			inner as unknown as KalshiClient,
			cache,
			{
				cacheTtlSeriesMs: 60_000,
				cacheTtlMarketsMs: 60_000,
				cacheTtlOrderbookMs: 60_000,
				cacheTtlLiveMs: 60_000,
				cacheTtlTradesMs: 60_000,
			},
		)
		const params = { limit: 5 }
		for (let round = 0; round < 2; round += 1) {
			await client.getBalance()
			await client.getPositions(params)
			await client.getFills(params)
			await client.getOrders(params)
			await client.getSettlements(params)
		}
		for (const method of Object.values(inner)) {
			expect(method).toHaveBeenCalledTimes(2)
		}
		expect(inner.getFills).toHaveBeenCalledWith(params)
		expect(wrap).not.toHaveBeenCalled()
	})
})
