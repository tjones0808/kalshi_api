import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	KalshiHttpError,
	KalshiNetworkError,
	KalshiRateLimitError,
	KalshiTimeoutError,
} from './errors.js'
import { createKalshiClient } from './kalshi-client.js'
import type { Market, Milestone } from './types.js'

const BASE = 'https://example.test/trade-api/v2/'

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

function sampleMilestone (id: string): Milestone {
	return {
		id,
		category: 'Sports',
		type: 'football_game',
		start_date: '2026-11-11T00:00:00Z',
		title: 'Game',
		related_event_tickers: ['EVT'],
		primary_event_tickers: ['EVT'],
		details: {},
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

function createClient (
	fetchImpl: ReturnType<typeof vi.fn>,
	maxRetries?: number,
) {
	return createKalshiClient({
		baseUrl: BASE,
		fetchImpl: fetchImpl as typeof fetch,
		...(typeof maxRetries === 'number'
			? { maxRetries }
			: {}),
	})
}

function callUrl (
	fetchImpl: ReturnType<typeof vi.fn>,
	index: number,
): URL {
	const call = fetchImpl.mock.calls[index] as unknown[] | undefined
	if (!call) {
		throw new Error(`missing fetch call ${index}`)
	}
	return new URL(String(call[0]))
}

function callInit (
	fetchImpl: ReturnType<typeof vi.fn>,
	index: number,
): RequestInit {
	const call = fetchImpl.mock.calls[index] as unknown[] | undefined
	if (!call) {
		throw new Error(`missing fetch call ${index}`)
	}
	return call[1] as RequestInit
}

describe('createKalshiClient', function () {
	afterEach(function () {
		vi.useRealTimers()
	})

	it('gets a market without auth headers', async function () {
		const fetchImpl = vi.fn(async function () {
			return jsonResponse({ market: sampleMarket('ABC') })
		})
		const client = createClient(fetchImpl)
		const market = await client.getMarket('ABC')
		expect(market.ticker).toBe('ABC')
		expect(market.yes_bid_dollars).toBe('0.4000')

		const url = callUrl(fetchImpl, 0)
		expect(url.href).toBe(
			'https://example.test/trade-api/v2/markets/ABC',
		)
		const init = callInit(fetchImpl, 0)
		expect(init.method).toBe('GET')
		expect(init.body).toBeUndefined()
		const headers = init.headers as Record<string, string>
		expect(headers.Accept).toBe('application/json')
		expect(headers['User-Agent']).toBe('kalshi-sports-api/0.1')
		expect(headers.Authorization).toBeUndefined()
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it('encodes query params and skips undefined ones', async function () {
		const fetchImpl = vi.fn(async function () {
			return jsonResponse({ markets: [] })
		})
		const client = createClient(fetchImpl)
		const result = await client.getMarkets({
			series_ticker: 'A&B',
			event_ticker: 'EV T',
			tickers: 'M1,M2',
			limit: 2,
			cursor: 'cur sor',
		})
		expect(result.markets).toEqual([])
		const url = callUrl(fetchImpl, 0)
		expect(url.pathname).toBe('/trade-api/v2/markets')
		expect(url.searchParams.get('series_ticker')).toBe('A&B')
		expect(url.searchParams.get('event_ticker')).toBe('EV T')
		expect(url.searchParams.get('tickers')).toBe('M1,M2')
		expect(url.searchParams.get('limit')).toBe('2')
		expect(url.searchParams.get('cursor')).toBe('cur sor')
		expect(url.searchParams.get('status')).toBeNull()
		expect(url.search).toContain('series_ticker=A%26B')
		expect(url.searchParams.getAll('series_ticker')).toEqual(['A&B'])
	})

	it('retries a 429 and then returns the body', async function () {
		vi.useFakeTimers()
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(jsonResponse(
				{ error: 'too many requests' },
				429,
			))
			.mockResolvedValueOnce(jsonResponse({
				exchange_active: true,
				trading_active: false,
			}))
		const client = createClient(fetchImpl)
		const pending = client.getExchangeStatus()
		await vi.advanceTimersByTimeAsync(1_000)
		const status = await pending
		expect(status).toEqual({
			exchange_active: true,
			trading_active: false,
		})
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})

	it('retries a 503 and then returns the body', async function () {
		vi.useFakeTimers()
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(jsonResponse(
				{ error: 'unavailable' },
				503,
			))
			.mockResolvedValueOnce(jsonResponse({
				market: sampleMarket('ABC'),
			}))
		const client = createClient(fetchImpl)
		const pending = client.getMarket('ABC')
		await vi.advanceTimersByTimeAsync(1_000)
		const market = await pending
		expect(market.ticker).toBe('ABC')
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})

	it(
		'throws KalshiRateLimitError when retries are exhausted',
		async function () {
		const fetchImpl = vi.fn(async function () {
			return jsonResponse(
				{ error: 'too many requests' },
				429,
			)
		})
		const client = createClient(fetchImpl, 0)
		let caught: unknown
		try {
			await client.getExchangeStatus()
		} catch (err) {
			caught = err
		}
		expect(caught).toBeInstanceOf(KalshiRateLimitError)
		expect(caught).toBeInstanceOf(KalshiHttpError)
		if (caught instanceof KalshiRateLimitError) {
			expect(caught.status).toBe(429)
			expect(caught.bodySnippet).toContain('too many requests')
		}
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it(
		'throws KalshiHttpError with status 404 and does not retry',
		async function () {
		const fetchImpl = vi.fn(async function () {
			return jsonResponse({ message: 'not found' }, 404)
		})
		const client = createClient(fetchImpl)
		let caught: unknown
		try {
			await client.getMarket('MISSING')
		} catch (err) {
			caught = err
		}
		expect(caught).toBeInstanceOf(KalshiHttpError)
		expect(caught).not.toBeInstanceOf(KalshiRateLimitError)
		if (caught instanceof KalshiHttpError) {
			expect(caught.status).toBe(404)
			expect(caught.path).toBe('/markets/MISSING')
			expect(caught.bodySnippet).toContain('not found')
		}
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it('does not retry a 400', async function () {
		const fetchImpl = vi.fn(async function () {
			return jsonResponse({ error: 'bad' }, 400)
		})
		const client = createClient(fetchImpl)
		let caught: unknown
		try {
			await client.getMarket('X')
		} catch (err) {
			caught = err
		}
		expect(caught).toBeInstanceOf(KalshiHttpError)
		if (caught instanceof KalshiHttpError) {
			expect(caught.status).toBe(400)
		}
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it('wraps invalid JSON as KalshiHttpError', async function () {
		const fetchImpl = vi.fn(async function () {
			return new Response('not-json', { status: 200 })
		})
		const client = createClient(fetchImpl)
		let caught: unknown
		try {
			await client.getExchangeStatus()
		} catch (err) {
			caught = err
		}
		expect(caught).toBeInstanceOf(KalshiHttpError)
		if (caught instanceof KalshiHttpError) {
			expect(caught.status).toBe(200)
			expect(caught.bodySnippet).toContain('not-json')
		}
	})

	it('follows a market cursor and then stops', async function () {
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(jsonResponse({
				markets: [sampleMarket('A')],
				cursor: 'next',
			}))
			.mockResolvedValueOnce(jsonResponse({
				markets: [sampleMarket('B')],
				cursor: '',
			}))
		const client = createClient(fetchImpl)
		const result = await client.getAllMarkets({
			series_ticker: 'SER',
		})
		expect(result.markets.map(function (market) {
			return market.ticker
		})).toEqual(['A', 'B'])
		expect(result.cursor).toBeUndefined()
		expect(fetchImpl).toHaveBeenCalledTimes(2)

		const first = callUrl(fetchImpl, 0)
		expect(first.searchParams.get('limit')).toBe('1000')
		expect(first.searchParams.get('series_ticker')).toBe('SER')
		expect(first.searchParams.get('cursor')).toBeNull()

		const second = callUrl(fetchImpl, 1)
		expect(second.searchParams.get('cursor')).toBe('next')
		expect(second.searchParams.get('limit')).toBe('1000')
		expect(second.searchParams.get('series_ticker')).toBe('SER')
	})

	it('stops getAllMarkets after 50 pages', async function () {
		let page = 0
		const fetchImpl = vi.fn(async function () {
			page += 1
			return jsonResponse({
				markets: [sampleMarket(`M${page}`)],
				cursor: `c${page}`,
			})
		})
		const client = createClient(fetchImpl)
		const result = await client.getAllMarkets({})
		expect(fetchImpl).toHaveBeenCalledTimes(50)
		expect(result.markets).toHaveLength(50)
		expect(result.cursor).toBe('c50')
	})

	it('pages events with the Kalshi max page size', async function () {
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(jsonResponse({
				events: [{
					event_ticker: 'E1',
					series_ticker: 'S',
					title: 'A',
				}],
				milestones: [sampleMilestone('m1')],
				cursor: 'n',
			}))
			.mockResolvedValueOnce(jsonResponse({
				events: [{
					event_ticker: 'E2',
					series_ticker: 'S',
					title: 'B',
				}],
				milestones: [sampleMilestone('m2')],
			}))
		const client = createClient(fetchImpl)
		const result = await client.getAllEvents({
			with_nested_markets: true,
			with_milestones: true,
		})
		expect(result.events.map(function (event) {
			return event.event_ticker
		})).toEqual(['E1', 'E2'])
		expect(result.milestones?.map(function (row) {
			return row.id
		})).toEqual(['m1', 'm2'])
		expect(result.cursor).toBeUndefined()

		const first = callUrl(fetchImpl, 0)
		expect(first.pathname).toBe('/trade-api/v2/events')
		expect(first.searchParams.get('limit')).toBe('200')
		expect(first.searchParams.get('with_nested_markets')).toBe(
			'true',
		)
		expect(first.searchParams.get('with_milestones')).toBe('true')
		const second = callUrl(fetchImpl, 1)
		expect(second.searchParams.get('limit')).toBe('200')
		expect(second.searchParams.get('cursor')).toBe('n')
	})

	it('gets one event and forwards milestone flags', async function () {
		const fetchImpl = vi.fn(async function () {
			return jsonResponse({
				event: {
					event_ticker: 'EVT',
					series_ticker: 'KXNFLGAME',
					title: 'Game',
				},
			})
		})
		const client = createClient(fetchImpl)
		const event = await client.getEvent('EVT', {
			with_nested_markets: true,
			with_milestones: true,
		})
		expect(event.event_ticker).toBe('EVT')
		const url = callUrl(fetchImpl, 0)
		expect(url.pathname).toBe('/trade-api/v2/events/EVT')
		expect(url.searchParams.get('with_nested_markets')).toBe(
			'true',
		)
		expect(url.searchParams.get('with_milestones')).toBe('true')
	})

	it('gets one milestone by id', async function () {
		const fetchImpl = vi.fn(async function () {
			return jsonResponse({
				milestone: sampleMilestone('ms-1'),
			})
		})
		const client = createClient(fetchImpl)
		const row = await client.getMilestone('ms/1')
		expect(row.id).toBe('ms-1')
		const url = callUrl(fetchImpl, 0)
		expect(url.pathname).toBe(
			'/trade-api/v2/milestones/ms%2F1',
		)
	})

	it('pages milestones with a default limit of 500', async function () {
		const fetchImpl = vi.fn(async function () {
			return jsonResponse({ milestones: [] })
		})
		const client = createClient(fetchImpl)
		const result = await client.getAllMilestones({
			category: 'Sports',
		})
		expect(result.milestones).toEqual([])
		const url = callUrl(fetchImpl, 0)
		expect(url.pathname).toBe('/trade-api/v2/milestones')
		expect(url.searchParams.get('limit')).toBe('500')
		expect(url.searchParams.get('category')).toBe('Sports')
	})

	it('gets live data for one milestone', async function () {
		const fetchImpl = vi.fn(async function () {
			return jsonResponse({
				live_data: {
					type: 'football_game',
					milestone_id: 'ms-1',
					details: { status: 'live' },
				},
			})
		})
		const client = createClient(fetchImpl)
		const live = await client.getLiveData('ms-1', false)
		expect(live.details).toEqual({ status: 'live' })
		const url = callUrl(fetchImpl, 0)
		expect(url.pathname).toBe(
			'/trade-api/v2/live_data/milestone/ms-1',
		)
		expect(url.searchParams.get('include_player_stats')).toBe(
			'false',
		)
	})

	it('chunks live data batches above 100 ids', async function () {
		const ids = Array.from({ length: 101 }, function (_unused, index) {
			return `m${index}`
		})
		const fetchImpl = vi.fn(async function (
			input: RequestInfo | URL,
		) {
			const url = new URL(String(input))
			const requested = url.searchParams.getAll('milestone_ids')
			return jsonResponse({
				live_datas: requested.map(function (id) {
					return {
						type: 'game',
						milestone_id: id,
						details: {},
					}
				}),
			})
		})
		const client = createClient(fetchImpl)
		const result = await client.getLiveDataBatch(ids, true)
		expect(fetchImpl).toHaveBeenCalledTimes(2)
		expect(result.map(function (row) {
			return row.milestone_id
		})).toEqual(ids)

		const first = callUrl(fetchImpl, 0)
		expect(first.pathname).toBe('/trade-api/v2/live_data/batch')
		expect(first.searchParams.getAll('milestone_ids')).toEqual(
			ids.slice(0, 100),
		)
		expect(first.searchParams.get('include_player_stats')).toBe(
			'true',
		)
		const second = callUrl(fetchImpl, 1)
		expect(second.searchParams.getAll('milestone_ids')).toEqual([
			'm100',
		])
		expect(second.searchParams.get('include_player_stats')).toBe(
			'true',
		)
	})

	it('does not call fetch for an empty live data batch', async function () {
		const fetchImpl = vi.fn()
		const client = createClient(fetchImpl)
		await expect(client.getLiveDataBatch([])).resolves.toEqual([])
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('requests candlesticks with the full query', async function () {
		const fetchImpl = vi.fn(async function () {
			return jsonResponse({
				ticker: 'MKT',
				candlesticks: [{
					end_period_ts: 20,
					volume_fp: '1.00',
				}],
			})
		})
		const client = createClient(fetchImpl)
		const result = await client.getMarketCandlesticks(
			'SER',
			'MKT',
			{
				start_ts: 10,
				end_ts: 20,
				period_interval: 60,
			},
		)
		expect(result.ticker).toBe('MKT')
		expect(result.candlesticks).toHaveLength(1)
		const url = callUrl(fetchImpl, 0)
		expect(url.pathname).toBe(
			'/trade-api/v2/series/SER/markets/MKT/candlesticks',
		)
		expect(url.searchParams.get('start_ts')).toBe('10')
		expect(url.searchParams.get('end_ts')).toBe('20')
		expect(url.searchParams.get('period_interval')).toBe('60')
	})

	it('passes an abort signal on every attempt', async function () {
		const fetchImpl = vi.fn(async function () {
			return jsonResponse({ market: sampleMarket('ABC') })
		})
		const client = createClient(fetchImpl)
		await client.getMarket('ABC')
		const init = callInit(fetchImpl, 0)
		expect(init.signal).toBeInstanceOf(AbortSignal)
	})

	it('retries a timeout and then returns the body', async function () {
		vi.useFakeTimers()
		const fetchImpl = vi.fn()
			.mockRejectedValueOnce(
				new DOMException('timed out', 'TimeoutError'),
			)
			.mockResolvedValueOnce(jsonResponse({
				market: sampleMarket('ABC'),
			}))
		const client = createClient(fetchImpl)
		const pending = client.getMarket('ABC')
		await vi.advanceTimersByTimeAsync(1_000)
		const market = await pending
		expect(market.ticker).toBe('ABC')
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})

	it(
		'throws KalshiTimeoutError when every attempt times out',
		async function () {
		const fetchImpl = vi.fn(async function () {
			throw new DOMException('timed out', 'TimeoutError')
		})
		const client = createClient(fetchImpl, 0)
		let caught: unknown
		try {
			await client.getMarket('ABC')
		} catch (err) {
			caught = err
		}
		expect(caught).toBeInstanceOf(KalshiTimeoutError)
		expect(caught).toBeInstanceOf(KalshiHttpError)
		if (caught instanceof KalshiTimeoutError) {
			expect(caught.status).toBe(504)
			expect(caught.path).toBe('/markets/ABC')
		}
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it('aborts a request that never settles', async function () {
		const fetchImpl = vi.fn(function (
			_input: RequestInfo | URL,
			init?: RequestInit,
		) {
			return new Promise<Response>(function (_resolve, reject) {
				init?.signal?.addEventListener('abort', function () {
					reject(init.signal?.reason)
				})
			})
		})
		const client = createKalshiClient({
			baseUrl: BASE,
			fetchImpl: fetchImpl as typeof fetch,
			maxRetries: 0,
			timeoutMs: 20,
		})
		await expect(client.getMarket('ABC')).rejects.toBeInstanceOf(
			KalshiTimeoutError,
		)
	})

	it('retries a network failure and then returns', async function () {
		vi.useFakeTimers()
		const fetchImpl = vi.fn()
			.mockRejectedValueOnce(new TypeError('fetch failed'))
			.mockResolvedValueOnce(jsonResponse({
				market: sampleMarket('ABC'),
			}))
		const client = createClient(fetchImpl)
		const pending = client.getMarket('ABC')
		await vi.advanceTimersByTimeAsync(1_000)
		const market = await pending
		expect(market.ticker).toBe('ABC')
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})

	it(
		'throws KalshiNetworkError without leaking the cause',
		async function () {
		const fetchImpl = vi.fn(async function () {
			throw new TypeError('connect ECONNREFUSED 10.0.0.1:443')
		})
		const client = createClient(fetchImpl, 1)
		vi.useFakeTimers()
		const pending = client.getMarket('ABC').catch(
			function (err: unknown) {
				return err
			},
		)
		await vi.advanceTimersByTimeAsync(1_000)
		const caught = await pending
		expect(caught).toBeInstanceOf(KalshiNetworkError)
		expect(caught).toBeInstanceOf(KalshiHttpError)
		if (caught instanceof KalshiNetworkError) {
			expect(caught.status).toBe(0)
			expect(caught.message).not.toContain('ECONNREFUSED')
		}
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})

	it('rejects an invalid timeoutMs', function () {
		expect(function () {
			createKalshiClient({ baseUrl: BASE, timeoutMs: 0 })
		}).toThrow('timeoutMs')
	})

	it('honors Retry-After seconds on a 429', async function () {
		vi.useFakeTimers()
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(new Response('slow down', {
				status: 429,
				headers: { 'retry-after': '2' },
			}))
			.mockResolvedValueOnce(jsonResponse({
				exchange_active: true,
				trading_active: true,
			}))
		const client = createClient(fetchImpl)
		const pending = client.getExchangeStatus()
		await vi.advanceTimersByTimeAsync(1_900)
		expect(fetchImpl).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(200)
		await pending
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})

	it('caps Retry-After at 5 seconds', async function () {
		vi.useFakeTimers()
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(new Response('busy', {
				status: 503,
				headers: { 'retry-after': '120' },
			}))
			.mockResolvedValueOnce(jsonResponse({
				exchange_active: true,
				trading_active: true,
			}))
		const client = createClient(fetchImpl)
		const pending = client.getExchangeStatus()
		await vi.advanceTimersByTimeAsync(4_900)
		expect(fetchImpl).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(200)
		await pending
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})

	it('ignores a non-numeric Retry-After', async function () {
		vi.useFakeTimers()
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(new Response('busy', {
				status: 503,
				headers: {
					'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT',
				},
			}))
			.mockResolvedValueOnce(jsonResponse({
				exchange_active: true,
				trading_active: true,
			}))
		const client = createClient(fetchImpl)
		const pending = client.getExchangeStatus()
		await vi.advanceTimersByTimeAsync(400)
		await pending
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})

	it('clamps explicit limits to the Kalshi caps', async function () {
		const fetchImpl = vi.fn(async function (
			input: RequestInfo | URL,
		) {
			const path = new URL(String(input)).pathname
			if (path.endsWith('/events')) {
				return jsonResponse({ events: [] })
			}
			if (path.endsWith('/milestones')) {
				return jsonResponse({ milestones: [] })
			}
			if (path.endsWith('/trades')) {
				return jsonResponse({ trades: [] })
			}
			return jsonResponse({ markets: [] })
		})
		const client = createClient(fetchImpl)
		await client.getMarkets({ limit: 5000 })
		await client.getAllMarkets({ limit: 5000 })
		await client.getEvents({ limit: 5000 })
		await client.getAllEvents({ limit: 5000 })
		await client.getMilestones({ limit: 5000 })
		await client.getAllMilestones({ limit: 5000 })
		await client.getTrades({ limit: 5000 })
		await client.getMarkets({ limit: 7 })
		const limits = fetchImpl.mock.calls.map(
			function (_call, index) {
				return callUrl(fetchImpl, index)
					.searchParams.get('limit')
			},
		)
		expect(limits).toEqual([
			'1000',
			'1000',
			'200',
			'200',
			'500',
			'500',
			'1000',
			'7',
		])
	})

	it('stops getAllEvents at maxPages with a cursor', async function () {
		let page = 0
		const fetchImpl = vi.fn(async function () {
			page += 1
			return jsonResponse({
				events: [{
					event_ticker: `E${page}`,
					series_ticker: 'S',
					title: 'A',
				}],
				cursor: `c${page}`,
			})
		})
		const client = createClient(fetchImpl)
		const result = await client.getAllEvents({ maxPages: 3 })
		expect(fetchImpl).toHaveBeenCalledTimes(3)
		expect(result.events).toHaveLength(3)
		expect(result.cursor).toBe('c3')
		const url = callUrl(fetchImpl, 0)
		expect(url.searchParams.get('maxPages')).toBeNull()
	})

	it('bounds maxPages for markets and milestones', async function () {
		let page = 0
		const fetchImpl = vi.fn(async function (
			input: RequestInfo | URL,
		) {
			page += 1
			const isMilestones = new URL(String(input))
				.pathname.endsWith('/milestones')
			return jsonResponse(
				isMilestones
					? { milestones: [], cursor: `m${page}` }
					: { markets: [], cursor: `k${page}` },
			)
		})
		const client = createClient(fetchImpl)
		await client.getAllMarkets({ maxPages: 2 })
		expect(fetchImpl).toHaveBeenCalledTimes(2)
		await client.getAllMilestones({ maxPages: 1 })
		expect(fetchImpl).toHaveBeenCalledTimes(3)
		await client.getAllMarkets({ maxPages: 0 })
		expect(fetchImpl).toHaveBeenCalledTimes(4)
		await client.getAllMarkets({ maxPages: 500 })
		expect(fetchImpl).toHaveBeenCalledTimes(54)
	})

	it('fails with a timeout when the deadline passes', async function () {
		const fetchImpl = vi.fn(function (
			_input: RequestInfo | URL,
			init?: RequestInit,
		) {
			return new Promise<Response>(function (_resolve, reject) {
				init?.signal?.addEventListener('abort', function () {
					reject(init.signal?.reason)
				})
			})
		})
		const client = createKalshiClient({
			baseUrl: BASE,
			fetchImpl: fetchImpl as typeof fetch,
			timeoutMs: 5_000,
			deadlineMs: 30,
		})
		await expect(client.getMarket('ABC')).rejects.toBeInstanceOf(
			KalshiTimeoutError,
		)
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it('does not sleep past the deadline', async function () {
		vi.useFakeTimers()
		const fetchImpl = vi.fn(async function () {
			return new Response('busy', {
				status: 503,
				headers: { 'retry-after': '5' },
			})
		})
		const client = createKalshiClient({
			baseUrl: BASE,
			fetchImpl: fetchImpl as typeof fetch,
			deadlineMs: 2_000,
		})
		const pending = client.getMarket('ABC').catch(
			function (err: unknown) {
				return err
			},
		)
		await vi.advanceTimersByTimeAsync(0)
		const caught = await pending
		expect(caught).toBeInstanceOf(KalshiTimeoutError)
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it('rejects an invalid deadlineMs', function () {
		expect(function () {
			createKalshiClient({ baseUrl: BASE, deadlineMs: 0 })
		}).toThrow('deadlineMs')
	})

	it('lowers the retry budget per getEvent call', async function () {
		vi.useFakeTimers()
		const fetchImpl = vi.fn(async function () {
			return jsonResponse({ error: 'boom' }, 500)
		})
		const client = createClient(fetchImpl)
		const pending = client.getEvent('EVT', { maxRetries: 1 })
			.catch(function (err: unknown) {
				return err
			})
		await vi.advanceTimersByTimeAsync(2_000)
		expect(await pending).toBeInstanceOf(KalshiHttpError)
		expect(fetchImpl).toHaveBeenCalledTimes(2)
		const url = callUrl(fetchImpl, 0)
		expect(url.searchParams.get('maxRetries')).toBeNull()
	})

	it('keeps the system code on a network error', async function () {
		const cause = Object.assign(new Error('refused'), {
			code: 'ECONNREFUSED',
		})
		const fetchImpl = vi.fn(async function () {
			throw new TypeError('fetch failed', { cause })
		})
		const client = createClient(fetchImpl, 0)
		const caught = await client.getMarket('ABC').catch(
			function (err: unknown) {
				return err
			},
		)
		expect(caught).toBeInstanceOf(KalshiNetworkError)
		if (caught instanceof KalshiNetworkError) {
			expect(caught.code).toBe('ECONNREFUSED')
			expect(Object.keys(caught)).not.toContain('code')
		}
	})
})
