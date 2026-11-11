import {
	KalshiAuthError,
	KalshiAuthNotConfiguredError,
	KalshiHttpError,
	KalshiNetworkError,
	KalshiRateLimitError,
	KalshiTimeoutError,
	networkErrorCode,
} from './errors.js'
import type { KalshiSigner } from './kalshi-signer.js'
import type { TtlCache } from './ttl-cache.js'
import type {
	Event,
	EventPosition,
	ExchangeStatus,
	Fill,
	GetBalanceResponse,
	GetEventsResponse,
	GetMarketCandlesticksResponse,
	GetMarketOrderbookResponse,
	GetMarketsResponse,
	GetFillsResponse,
	GetMilestonesResponse,
	GetOrdersResponse,
	GetPositionsResponse,
	GetSettlementsResponse,
	GetTradesResponse,
	LiveData,
	Market,
	MarketCandlestick,
	MarketPosition,
	Milestone,
	Order,
	OrderStatus,
	Series,
	Settlement,
	Trade,
} from './types.js'

const USER_AGENT = 'kalshi-sports-api/0.1'
const DEFAULT_MAX_RETRIES = 4
const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_DEADLINE_MS = 20_000
const MAX_RETRY_AFTER_MS = 5000
const MAX_PAGES = 50
const DEFAULT_MARKETS_LIMIT = 1000
const DEFAULT_EVENTS_LIMIT = 200
const DEFAULT_MILESTONES_LIMIT = 500
const MAX_MARKETS_LIMIT = 1000
const MAX_EVENTS_LIMIT = 200
const MAX_MILESTONES_LIMIT = 500
const MAX_TRADES_LIMIT = 1000
const MAX_PORTFOLIO_LIMIT = 1000
const LIVE_BATCH_SIZE = 100
const BODY_SNIPPET_LIMIT = 200

const RETRYABLE_STATUSES = new Set([
	429,
	500,
	502,
	503,
	504,
])

type ScalarParam = string | number | boolean

interface Query {
	[key: string]: ScalarParam | readonly string[] | undefined
}

/** Filters for `GET /series`. */
export interface GetSeriesListParams {
	category?: string
	tags?: string
}

/** Filters for one page of `GET /markets`. */
export interface GetMarketsParams {
	series_ticker?: string
	event_ticker?: string
	status?: string
	tickers?: string
	limit?: number
	cursor?: string
}

/** Paging bound shared by the `getAll*` methods. */
export interface PageLimitOption {
	/**
	 * Most pages to fetch, from 1 to 50. Defaults to 50. When the
	 * bound is hit, the response carries the next cursor.
	 */
	maxPages?: number
}

/** Filters for `getAllMarkets`. `cursor` is managed internally. */
export type GetAllMarketsParams =
	Omit<GetMarketsParams, 'cursor'> & PageLimitOption

/** Filters for one page of `GET /events`. */
export interface GetEventsParams {
	series_ticker?: string
	status?: string
	with_nested_markets?: boolean
	with_milestones?: boolean
	limit?: number
	cursor?: string
}

/** Filters for `getAllEvents`. `cursor` is managed internally. */
export type GetAllEventsParams =
	Omit<GetEventsParams, 'cursor'> & PageLimitOption

/** Optional flags for `GET /events/{event_ticker}`. */
export interface GetEventParams {
	with_nested_markets?: boolean
	/**
	 * Forwarded when set. The returned event does not include
	 * milestones; load those with `getMilestones`.
	 */
	with_milestones?: boolean
	/**
	 * Lower this call's retry budget. It can only reduce the
	 * client's `maxRetries`, and it is not sent to Kalshi.
	 */
	maxRetries?: number
}

/** Filters for `GET /markets/trades`. */
export interface GetTradesParams {
	ticker?: string
	limit?: number
	cursor?: string
	min_ts?: number
	max_ts?: number
}

/** Account scoping shared by the portfolio endpoints. */
export interface PortfolioScopeParams {
	/** 0 is the primary account, 1 to 63 are subaccounts. */
	subaccount?: number
	/** Restrict to one exchange shard. */
	exchange_index?: number
}

/** Filters for `GET /portfolio/balance`. */
export type GetBalanceParams = PortfolioScopeParams

/** Which positions `GET /portfolio/positions` returns. */
export type PositionSettlementStatus =
	| 'unsettled'
	| 'settled'
	| 'all'

/** Filters for one page of `GET /portfolio/positions`. */
export interface GetPositionsParams extends PortfolioScopeParams {
	cursor?: string
	/** Clamped to 1000. */
	limit?: number
	/** `position`, `total_traded`, or both comma-separated. */
	count_filter?: string
	settlement_status?: PositionSettlementStatus
	ticker?: string
	/** One event ticker only. */
	event_ticker?: string
}

/** Filters for one page of `GET /portfolio/fills`. */
export interface GetFillsParams extends PortfolioScopeParams {
	/** Up to 100 comma-separated market tickers. */
	ticker?: string
	order_id?: string
	min_ts?: number
	max_ts?: number
	/** Clamped to 1000. */
	limit?: number
	cursor?: string
}

/** Filters for one page of `GET /portfolio/orders`. */
export interface GetOrdersParams extends PortfolioScopeParams {
	ticker?: string
	/** Up to 100 comma-separated event tickers. */
	event_ticker?: string
	min_ts?: number
	max_ts?: number
	status?: OrderStatus
	/** Clamped to 1000. */
	limit?: number
	cursor?: string
}

/** Filters for one page of `GET /portfolio/settlements`. */
export interface GetSettlementsParams {
	ticker?: string
	/** One event ticker only. */
	event_ticker?: string
	min_ts?: number
	max_ts?: number
	subaccount?: number
	/** Clamped to 1000. */
	limit?: number
	cursor?: string
}

/** Candlestick width in minutes. */
export type CandlestickPeriodInterval = 1 | 60 | 1440

/** Required window for market candlesticks. */
export interface GetMarketCandlesticksParams {
	start_ts: number
	end_ts: number
	period_interval: CandlestickPeriodInterval
}

/** Filters for one page of `GET /milestones`. `limit` is required. */
export interface GetMilestonesParams {
	limit: number
	category?: string
	competition?: string
	type?: string
	related_event_ticker?: string
	cursor?: string
	minimum_start_date?: string
}

/** Filters for `getAllMilestones`. Default `limit` is 500. */
export type GetAllMilestonesParams = Omit<
	GetMilestonesParams,
	'cursor' | 'limit'
> & PageLimitOption & {
	limit?: number
}

interface PageResult<T> {
	items: T[]
	cursor: string | undefined
	milestones: Milestone[] | undefined
}

interface Collected<T> {
	items: T[]
	cursor: string | undefined
	milestones: Milestone[] | undefined
}

/**
 * Kalshi Trade API v2 client.
 * Every method sends a GET. Market-data methods work with or
 * without a signer; the portfolio methods need one and throw
 * {@link KalshiAuthNotConfiguredError} without it. Portfolio
 * data is private, so never put it behind the shared cache.
 */
export interface KalshiClient {
	/** `GET /exchange/status`. */
	getExchangeStatus (): Promise<ExchangeStatus>

	/** `GET /series`. */
	getSeriesList (
		params?: GetSeriesListParams,
	): Promise<Series[]>

	/** `GET /series/{series_ticker}`. */
	getSeries (seriesTicker: string): Promise<Series>

	/** `GET /markets`. */
	getMarkets (
		params: GetMarketsParams,
	): Promise<GetMarketsResponse>

	/**
	 * Follow market cursors until they run out.
	 * Stops after `maxPages` (default 50) pages and returns the
	 * next cursor.
	 * Default page size is 1000.
	 */
	getAllMarkets (
		params: GetAllMarketsParams,
	): Promise<GetMarketsResponse>

	/** `GET /markets/{ticker}`. */
	getMarket (ticker: string): Promise<Market>

	/** `GET /events`. */
	getEvents (
		params: GetEventsParams,
	): Promise<GetEventsResponse>

	/**
	 * Follow event cursors until they run out.
	 * Stops after `maxPages` (default 50) pages and returns the
	 * next cursor.
	 * Default page size is 200.
	 */
	getAllEvents (
		params: GetAllEventsParams,
	): Promise<GetEventsResponse>

	/**
	 * `GET /events/{event_ticker}`.
	 * `with_milestones` is sent when set. Milestone rows are
	 * loaded with `getMilestones` or `getMilestone`.
	 */
	getEvent (
		eventTicker: string,
		params?: GetEventParams,
	): Promise<Event>

	/** `GET /markets/{ticker}/orderbook`. */
	getMarketOrderbook (
		ticker: string,
	): Promise<GetMarketOrderbookResponse>

	/** `GET /markets/trades`. */
	getTrades (
		params: GetTradesParams,
	): Promise<GetTradesResponse>

	/**
	 * `GET /series/{series}/markets/{ticker}/candlesticks`.
	 * `period_interval` is 1, 60, or 1440 minutes.
	 */
	getMarketCandlesticks (
		seriesTicker: string,
		ticker: string,
		params: GetMarketCandlesticksParams,
	): Promise<GetMarketCandlesticksResponse>

	/** `GET /milestones`. */
	getMilestones (
		params: GetMilestonesParams,
	): Promise<GetMilestonesResponse>

	/**
	 * Follow milestone cursors until they run out.
	 * Stops after `maxPages` (default 50) pages and returns the
	 * next cursor.
	 * Default page size is 500.
	 */
	getAllMilestones (
		params: GetAllMilestonesParams,
	): Promise<GetMilestonesResponse>

	/** `GET /milestones/{milestone_id}`. */
	getMilestone (milestoneId: string): Promise<Milestone>

	/** `GET /live_data/milestone/{milestone_id}`. */
	getLiveData (
		milestoneId: string,
		includePlayerStats?: boolean,
	): Promise<LiveData>

	/**
	 * `GET /live_data/batch`.
	 * Ids are sent in chunks of 100, one chunk at a time.
	 */
	getLiveDataBatch (
		milestoneIds: string[],
		includePlayerStats?: boolean,
	): Promise<LiveData[]>

	/** `GET /portfolio/balance`. Needs a signer. */
	getBalance (
		params?: GetBalanceParams,
	): Promise<GetBalanceResponse>

	/** `GET /portfolio/positions`. Needs a signer. */
	getPositions (
		params?: GetPositionsParams,
	): Promise<GetPositionsResponse>

	/** `GET /portfolio/fills`. Needs a signer. */
	getFills (
		params?: GetFillsParams,
	): Promise<GetFillsResponse>

	/** `GET /portfolio/orders`. Needs a signer. */
	getOrders (
		params?: GetOrdersParams,
	): Promise<GetOrdersResponse>

	/** `GET /portfolio/settlements`. Needs a signer. */
	getSettlements (
		params?: GetSettlementsParams,
	): Promise<GetSettlementsResponse>
}

/**
 * Options for {@link createKalshiClient}.
 * The raw client does not cache, even when `cache` is set.
 */
export interface KalshiClientOptions {
	/** API origin plus `/trade-api/v2`. A trailing slash is ignored. */
	baseUrl: string
	/** Override for tests. Defaults to the global `fetch`. */
	fetchImpl?: typeof fetch
	/**
	 * Extra attempts after the first response for HTTP 429 and
	 * 500/502/503/504. Defaults to 4. Other 4xx responses are
	 * not retried.
	 */
	maxRetries?: number
	/**
	 * Per-attempt timeout in milliseconds, covering the response
	 * headers and body. Defaults to 8000. A timed-out attempt is
	 * retried like a 5xx.
	 */
	timeoutMs?: number
	/**
	 * Overall budget in milliseconds for one call, across every
	 * attempt and backoff sleep. Defaults to 20000. A retry that
	 * would end past it is not started, and the call fails with
	 * {@link KalshiTimeoutError}.
	 */
	deadlineMs?: number
	/**
	 * Accepted so callers can pass a cache alongside the client.
	 * Use {@link createCachedKalshiClient} to actually cache.
	 */
	cache?: TtlCache
	/**
	 * Signs every request with Kalshi key-auth headers, market
	 * data included. A fresh timestamp and signature are made
	 * for each attempt, so retries are re-signed. Required for
	 * the portfolio methods.
	 */
	signer?: KalshiSigner
}

/**
 * Create a Kalshi Trade API v2 client.
 *
 * Requests are GETs. They carry auth headers only when a
 * `signer` is given. HTTP 429 and
 * 500/502/503/504 use exponential backoff of
 * `200ms * 2^attempt` plus 0–100ms of jitter, where `attempt`
 * starts at 0. A numeric `Retry-After` on 429/503 replaces
 * that delay, capped at 5s. Each attempt aborts after
 * `timeoutMs` and is retried, and the whole call is bounded
 * by `deadlineMs`; the last attempt (or the deadline) throws
 * {@link KalshiTimeoutError}. Connection failures (reset,
 * refused, DNS) are retried the same way and end in
 * {@link KalshiNetworkError}. A JSON body that fails to parse becomes
 * {@link KalshiHttpError}. Explicit `limit` values are
 * clamped to Kalshi's page caps.
 */
export function createKalshiClient (
	options: KalshiClientOptions,
): KalshiClient {
	const baseUrl = options.baseUrl
	if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
		throw new Error('baseUrl is required')
	}
	const doFetch = options.fetchImpl ?? globalThis.fetch
	const signer = options.signer
	const maxRetries = resolveMaxRetries(options.maxRetries)
	const timeoutMs = resolveTimeoutMs(options.timeoutMs)
	const deadlineMs = resolveDeadlineMs(options.deadlineMs)

	/**
	 * GET `path` and return the parsed JSON body.
	 * `retryCap` can only lower the retry budget for this call.
	 */
	async function request (
		path: string,
		query?: Query,
		retryCap?: number,
	): Promise<unknown> {
		const params = buildParams(query)
		const qs = params.toString()
		const target = qs.length === 0 ? path : `${path}?${qs}`
		const url = `${stripTrailingSlashes(baseUrl)}${target}`
		const pathname = new URL(url).pathname
		const retries = Math.min(
			Math.max(retryCap ?? maxRetries, 0),
			maxRetries,
		)
		const deadlineAt = Date.now() + deadlineMs
		const deadline = AbortSignal.timeout(deadlineMs)

		/** Sleep unless the wait would run past the deadline. */
		async function pause (ms: number): Promise<void> {
			if (Date.now() + ms >= deadlineAt) {
				throw new KalshiTimeoutError(target)
			}
			await delay(ms)
		}

		for (
			let attempt = 0;
			attempt <= retries;
			attempt += 1
		) {
			if (Date.now() >= deadlineAt) {
				throw new KalshiTimeoutError(target)
			}
			let response: Response
			let text: string
			const authHeaders = signer?.('GET', pathname)
			try {
				response = await doFetch(url, {
					method: 'GET',
					headers: {
						Accept: 'application/json',
						'User-Agent': USER_AGENT,
						...authHeaders,
					},
					signal: AbortSignal.any([
						AbortSignal.timeout(timeoutMs),
						deadline,
					]),
				})
				text = await response.text()
			} catch (err) {
				if (deadline.aborted) {
					throw new KalshiTimeoutError(target)
				}
				if (attempt >= retries) {
					throw isAbortError(err)
						? new KalshiTimeoutError(target)
						: new KalshiNetworkError(
							target,
							networkErrorCode(err),
						)
				}
				await pause(backoffMs(attempt))
				continue
			}
			if (response.ok) {
				return parseJson(text, response.status, target)
			}
			const error = httpError(
				response.status,
				target,
				text,
			)
			const canRetry = RETRYABLE_STATUSES.has(response.status)
				&& attempt < retries
			if (!canRetry) {
				throw error
			}
			await pause(retryDelayMs(response, attempt))
		}

		throw new KalshiHttpError(0, target, 'request failed')
	}

	async function getExchangeStatus (): Promise<ExchangeStatus> {
		const path = '/exchange/status'
		return asPayload<ExchangeStatus>(
			readObject(await request(path), path),
		)
	}

	async function getSeriesList (
		params?: GetSeriesListParams,
	): Promise<Series[]> {
		const path = '/series'
		const query = definedQuery([
			['category', params?.category],
			['tags', params?.tags],
		])
		return asPayload<Series[]>(
			readRequiredArray(
				readObject(await request(path, query), path),
				'series',
				path,
			),
		)
	}

	async function getSeries (
		seriesTicker: string,
	): Promise<Series> {
		const path = `/series/${encodeURIComponent(seriesTicker)}`
		return readWrapped<Series>(
			await request(path),
			'series',
			path,
		)
	}

	async function getMarkets (
		params: GetMarketsParams,
	): Promise<GetMarketsResponse> {
		const path = '/markets'
		const query = definedQuery([
			['series_ticker', params.series_ticker],
			['event_ticker', params.event_ticker],
			['status', params.status],
			['tickers', params.tickers],
			['limit', clampLimit(params.limit, MAX_MARKETS_LIMIT)],
			['cursor', params.cursor],
		])
		return readMarketsResponse(
			await request(path, query),
			path,
		)
	}

	async function getAllMarkets (
		params: GetAllMarketsParams,
	): Promise<GetMarketsResponse> {
		const limit = Math.min(
			params.limit ?? DEFAULT_MARKETS_LIMIT,
			MAX_MARKETS_LIMIT,
		)
		const collected = await collectPages(
			params.maxPages,
			async function (cursor) {
				const page = await getMarkets(
					marketsPageParams(params, limit, cursor),
				)
				return pageFrom(
					page.markets,
					page.cursor,
					undefined,
				)
			},
		)
		return marketsFromCollected(collected)
	}

	async function getMarket (ticker: string): Promise<Market> {
		const path = `/markets/${encodeURIComponent(ticker)}`
		return readWrapped<Market>(
			await request(path),
			'market',
			path,
		)
	}

	async function getEvents (
		params: GetEventsParams,
	): Promise<GetEventsResponse> {
		const path = '/events'
		const query = eventsQuery(
			params,
			clampLimit(params.limit, MAX_EVENTS_LIMIT),
			params.cursor,
		)
		return readEventsResponse(
			await request(path, query),
			path,
		)
	}

	async function getAllEvents (
		params: GetAllEventsParams,
	): Promise<GetEventsResponse> {
		const limit = Math.min(
			params.limit ?? DEFAULT_EVENTS_LIMIT,
			MAX_EVENTS_LIMIT,
		)
		const collected = await collectPages(
			params.maxPages,
			async function (cursor) {
				const path = '/events'
				const page = readEventsResponse(
					await request(
						path,
						eventsQuery(params, limit, cursor),
					),
					path,
				)
				return pageFrom(
					page.events,
					page.cursor,
					page.milestones,
				)
			},
		)
		return eventsFromCollected(collected)
	}

	async function getEvent (
		eventTicker: string,
		params?: GetEventParams,
	): Promise<Event> {
		const path = `/events/${encodeURIComponent(eventTicker)}`
		const query = definedQuery([
			['with_nested_markets', params?.with_nested_markets],
			['with_milestones', params?.with_milestones],
		])
		return readWrapped<Event>(
			await request(path, query, params?.maxRetries),
			'event',
			path,
		)
	}

	async function getMarketOrderbook (
		ticker: string,
	): Promise<GetMarketOrderbookResponse> {
		const path =
			`/markets/${encodeURIComponent(ticker)}/orderbook`
		return asPayload<GetMarketOrderbookResponse>(
			readObject(await request(path), path),
		)
	}

	async function getTrades (
		params: GetTradesParams,
	): Promise<GetTradesResponse> {
		const path = '/markets/trades'
		const query = definedQuery([
			['ticker', params.ticker],
			['limit', clampLimit(params.limit, MAX_TRADES_LIMIT)],
			['cursor', params.cursor],
			['min_ts', params.min_ts],
			['max_ts', params.max_ts],
		])
		return readTradesResponse(
			await request(path, query),
			path,
		)
	}

	async function getMarketCandlesticks (
		seriesTicker: string,
		ticker: string,
		params: GetMarketCandlesticksParams,
	): Promise<GetMarketCandlesticksResponse> {
		const path = '/series/'
			+ encodeURIComponent(seriesTicker)
			+ '/markets/'
			+ encodeURIComponent(ticker)
			+ '/candlesticks'
		const query = definedQuery([
			['start_ts', params.start_ts],
			['end_ts', params.end_ts],
			['period_interval', params.period_interval],
		])
		return readCandlesticks(
			await request(path, query),
			path,
			ticker,
		)
	}

	async function getMilestones (
		params: GetMilestonesParams,
	): Promise<GetMilestonesResponse> {
		const path = '/milestones'
		return readMilestonesResponse(
			await request(
				path,
				milestoneQuery(
					params,
					clampLimit(params.limit, MAX_MILESTONES_LIMIT),
					params.cursor,
				),
			),
			path,
		)
	}

	async function getAllMilestones (
		params: GetAllMilestonesParams,
	): Promise<GetMilestonesResponse> {
		const limit = Math.min(
			params.limit ?? DEFAULT_MILESTONES_LIMIT,
			MAX_MILESTONES_LIMIT,
		)
		const collected = await collectPages(
			params.maxPages,
			async function (cursor) {
				const path = '/milestones'
				const page = readMilestonesResponse(
					await request(
						path,
						milestoneQuery(params, limit, cursor),
					),
					path,
				)
				return pageFrom(
					page.milestones,
					page.cursor,
					undefined,
				)
			},
		)
		return milestonesFromCollected(collected)
	}

	async function getMilestone (
		milestoneId: string,
	): Promise<Milestone> {
		const path = `/milestones/${encodeURIComponent(milestoneId)}`
		return readWrapped<Milestone>(
			await request(path),
			'milestone',
			path,
		)
	}

	async function getLiveData (
		milestoneId: string,
		includePlayerStats?: boolean,
	): Promise<LiveData> {
		const path = '/live_data/milestone/'
			+ encodeURIComponent(milestoneId)
		const query = definedQuery([
			['include_player_stats', includePlayerStats],
		])
		return readWrapped<LiveData>(
			await request(path, query),
			'live_data',
			path,
		)
	}

	async function getLiveDataBatch (
		milestoneIds: string[],
		includePlayerStats?: boolean,
	): Promise<LiveData[]> {
		if (milestoneIds.length === 0) {
			return []
		}
		const rows: LiveData[] = []
		const chunks = chunkIds(milestoneIds, LIVE_BATCH_SIZE)
		for (const ids of chunks) {
			const path = '/live_data/batch'
			const query = definedQuery([
				['milestone_ids', ids],
				['include_player_stats', includePlayerStats],
			])
			const page = readLiveDatas(
				await request(path, query),
				path,
			)
			rows.push(...page)
		}
		return rows
	}

	function requireSigner (): void {
		if (signer === undefined) {
			throw new KalshiAuthNotConfiguredError()
		}
	}

	async function getBalance (
		params?: GetBalanceParams,
	): Promise<GetBalanceResponse> {
		requireSigner()
		const path = '/portfolio/balance'
		const query = definedQuery([
			['subaccount', params?.subaccount],
			['exchange_index', params?.exchange_index],
		])
		return readBalanceResponse(
			await request(path, query),
			path,
		)
	}

	async function getPositions (
		params?: GetPositionsParams,
	): Promise<GetPositionsResponse> {
		requireSigner()
		const path = '/portfolio/positions'
		const query = definedQuery([
			['cursor', params?.cursor],
			['limit', clampLimit(
				params?.limit,
				MAX_PORTFOLIO_LIMIT,
			)],
			['count_filter', params?.count_filter],
			['settlement_status', params?.settlement_status],
			['ticker', params?.ticker],
			['event_ticker', params?.event_ticker],
			['subaccount', params?.subaccount],
			['exchange_index', params?.exchange_index],
		])
		return readPositionsResponse(
			await request(path, query),
			path,
		)
	}

	async function getFills (
		params?: GetFillsParams,
	): Promise<GetFillsResponse> {
		requireSigner()
		const path = '/portfolio/fills'
		const query = definedQuery([
			['ticker', params?.ticker],
			['order_id', params?.order_id],
			['min_ts', params?.min_ts],
			['max_ts', params?.max_ts],
			['limit', clampLimit(
				params?.limit,
				MAX_PORTFOLIO_LIMIT,
			)],
			['cursor', params?.cursor],
			['subaccount', params?.subaccount],
			['exchange_index', params?.exchange_index],
		])
		return readListResponse<Fill, GetFillsResponse>(
			await request(path, query),
			path,
			'fills',
		)
	}

	async function getOrders (
		params?: GetOrdersParams,
	): Promise<GetOrdersResponse> {
		requireSigner()
		const path = '/portfolio/orders'
		const query = definedQuery([
			['ticker', params?.ticker],
			['event_ticker', params?.event_ticker],
			['min_ts', params?.min_ts],
			['max_ts', params?.max_ts],
			['status', params?.status],
			['limit', clampLimit(
				params?.limit,
				MAX_PORTFOLIO_LIMIT,
			)],
			['cursor', params?.cursor],
			['subaccount', params?.subaccount],
			['exchange_index', params?.exchange_index],
		])
		return readListResponse<Order, GetOrdersResponse>(
			await request(path, query),
			path,
			'orders',
		)
	}

	async function getSettlements (
		params?: GetSettlementsParams,
	): Promise<GetSettlementsResponse> {
		requireSigner()
		const path = '/portfolio/settlements'
		const query = definedQuery([
			['ticker', params?.ticker],
			['event_ticker', params?.event_ticker],
			['min_ts', params?.min_ts],
			['max_ts', params?.max_ts],
			['subaccount', params?.subaccount],
			['limit', clampLimit(
				params?.limit,
				MAX_PORTFOLIO_LIMIT,
			)],
			['cursor', params?.cursor],
		])
		return readListResponse<
			Settlement,
			GetSettlementsResponse
		>(
			await request(path, query),
			path,
			'settlements',
		)
	}

	return {
		getExchangeStatus,
		getSeriesList,
		getSeries,
		getMarkets,
		getAllMarkets,
		getMarket,
		getEvents,
		getAllEvents,
		getEvent,
		getMarketOrderbook,
		getTrades,
		getMarketCandlesticks,
		getMilestones,
		getAllMilestones,
		getMilestone,
		getLiveData,
		getLiveDataBatch,
		getBalance,
		getPositions,
		getFills,
		getOrders,
		getSettlements,
	}
}

function resolveMaxRetries (value: number | undefined): number {
	if (value === undefined) {
		return DEFAULT_MAX_RETRIES
	}
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(
			'maxRetries must be a non-negative integer',
		)
	}
	return value
}

function resolveTimeoutMs (value: number | undefined): number {
	if (value === undefined) {
		return DEFAULT_TIMEOUT_MS
	}
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error('timeoutMs must be a positive integer')
	}
	return value
}

/** `AbortSignal.timeout` rejects with `TimeoutError`. */
function isAbortError (err: unknown): boolean {
	return typeof err === 'object'
		&& err !== null
		&& 'name' in err
		&& (err.name === 'TimeoutError' || err.name === 'AbortError')
}

function clampLimit (
	limit: number | undefined,
	cap: number,
): number | undefined {
	return limit === undefined ? undefined : Math.min(limit, cap)
}

function resolveMaxPages (value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) {
		return MAX_PAGES
	}
	return Math.min(Math.max(Math.floor(value), 1), MAX_PAGES)
}

function resolveDeadlineMs (value: number | undefined): number {
	if (value === undefined) {
		return DEFAULT_DEADLINE_MS
	}
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error('deadlineMs must be a positive integer')
	}
	return value
}

function stripTrailingSlashes (baseUrl: string): string {
	return baseUrl.replace(/\/+$/, '')
}

function backoffMs (attempt: number): number {
	const exponential = 200 * (2 ** attempt)
	const jitter = Math.random() * 100
	return exponential + jitter
}

/**
 * A numeric `Retry-After` (seconds) on 429/503 wins over
 * the exponential backoff, capped at 5s.
 */
function retryDelayMs (
	response: Response,
	attempt: number,
): number {
	if (response.status === 429 || response.status === 503) {
		const header = response.headers.get('retry-after')?.trim()
		const seconds = header ? Number(header) : Number.NaN
		if (Number.isFinite(seconds) && seconds >= 0) {
			return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
		}
	}
	return backoffMs(attempt)
}

function delay (ms: number): Promise<void> {
	return new Promise(function (resolve) {
		setTimeout(resolve, ms)
	})
}

function bodySnippet (text: string): string {
	const compact = text
		.slice(0, 500)
		.replace(/\s+/g, ' ')
		.trim()
	if (compact.length === 0) {
		return '(empty body)'
	}
	if (compact.length <= BODY_SNIPPET_LIMIT) {
		return compact
	}
	return `${compact.slice(0, BODY_SNIPPET_LIMIT)}...`
}

function httpError (
	status: number,
	path: string,
	text: string,
): KalshiHttpError {
	if (status === 401 || status === 403) {
		return new KalshiAuthError(status, path)
	}
	const snippet = bodySnippet(text)
	if (status === 429) {
		return new KalshiRateLimitError(path, snippet)
	}
	return new KalshiHttpError(status, path, snippet)
}

function parseJson (
	text: string,
	status: number,
	path: string,
): unknown {
	try {
		return JSON.parse(text) as unknown
	} catch {
		throw new KalshiHttpError(
			status,
			path,
			bodySnippet(text),
		)
	}
}

function isRecord (
	value: unknown,
): value is Record<string, unknown> {
	return typeof value === 'object'
		&& value !== null
		&& !Array.isArray(value)
}

function readObject (
	value: unknown,
	path: string,
): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new KalshiHttpError(
			200,
			path,
			'response was not a JSON object',
		)
	}
	return value
}

function asPayload<T> (value: unknown): T {
	return value as T
}

function readWrapped<T> (
	value: unknown,
	field: string,
	path: string,
): T {
	const body = readObject(value, path)
	const wrapped = body[field]
	if (!isRecord(wrapped)) {
		throw new KalshiHttpError(
			200,
			path,
			`response missing ${field}`,
		)
	}
	return asPayload<T>(wrapped)
}

function readArray (
	body: Record<string, unknown>,
	field: string,
	path: string,
	required: boolean,
): unknown[] | undefined {
	if (
		!Object.prototype.hasOwnProperty.call(body, field)
		|| body[field] === null
	) {
		if (required) {
			throw new KalshiHttpError(
				200,
				path,
				`response missing ${field}`,
			)
		}
		return undefined
	}
	const value = body[field]
	if (!Array.isArray(value)) {
		throw new KalshiHttpError(
			200,
			path,
			`response field ${field} was not an array`,
		)
	}
	return value
}

function readRequiredArray (
	body: Record<string, unknown>,
	field: string,
	path: string,
): unknown[] {
	const value = readArray(body, field, path, true)
	if (!value) {
		throw new KalshiHttpError(
			200,
			path,
			`response missing ${field}`,
		)
	}
	return value
}

function readCursor (
	body: Record<string, unknown>,
): string | undefined {
	const cursor = body.cursor
	if (typeof cursor !== 'string' || cursor.length === 0) {
		return undefined
	}
	return cursor
}

function readMarketsResponse (
	value: unknown,
	path: string,
): GetMarketsResponse {
	const body = readObject(value, path)
	const markets = readRequiredArray(body, 'markets', path)
	const response: GetMarketsResponse = {
		markets: asPayload<Market[]>(markets),
	}
	const cursor = readCursor(body)
	if (cursor) {
		response.cursor = cursor
	}
	return response
}

function readEventsResponse (
	value: unknown,
	path: string,
): GetEventsResponse {
	const body = readObject(value, path)
	const events = readRequiredArray(body, 'events', path)
	const response: GetEventsResponse = {
		events: asPayload<Event[]>(events),
	}
	const cursor = readCursor(body)
	if (cursor) {
		response.cursor = cursor
	}
	const milestones = readArray(body, 'milestones', path, false)
	if (milestones) {
		response.milestones = asPayload<Milestone[]>(milestones)
	}
	return response
}

function readTradesResponse (
	value: unknown,
	path: string,
): GetTradesResponse {
	const body = readObject(value, path)
	const trades = readRequiredArray(body, 'trades', path)
	const response: GetTradesResponse = {
		trades: asPayload<Trade[]>(trades),
	}
	const cursor = readCursor(body)
	if (cursor) {
		response.cursor = cursor
	}
	return response
}

function readMilestonesResponse (
	value: unknown,
	path: string,
): GetMilestonesResponse {
	const body = readObject(value, path)
	const milestones = readRequiredArray(
		body,
		'milestones',
		path,
	)
	const response: GetMilestonesResponse = {
		milestones: asPayload<Milestone[]>(milestones),
	}
	const cursor = readCursor(body)
	if (cursor) {
		response.cursor = cursor
	}
	return response
}

function readCandlesticks (
	value: unknown,
	path: string,
	ticker: string,
): GetMarketCandlesticksResponse {
	const body = readObject(value, path)
	const candlesticks = readRequiredArray(
		body,
		'candlesticks',
		path,
	)
	const bodyTicker = body.ticker
	return {
		ticker: typeof bodyTicker === 'string'
			? bodyTicker
			: ticker,
		candlesticks: asPayload<MarketCandlestick[]>(
			candlesticks,
		),
	}
}

function readBalanceResponse (
	value: unknown,
	path: string,
): GetBalanceResponse {
	const body = readObject(value, path)
	if (
		typeof body.balance !== 'number'
		|| typeof body.portfolio_value !== 'number'
	) {
		throw new KalshiHttpError(
			200,
			path,
			'response missing balance',
		)
	}
	return asPayload<GetBalanceResponse>(body)
}

function readPositionsResponse (
	value: unknown,
	path: string,
): GetPositionsResponse {
	const body = readObject(value, path)
	const response: GetPositionsResponse = {
		market_positions: asPayload<MarketPosition[]>(
			readRequiredArray(body, 'market_positions', path),
		),
		event_positions: asPayload<EventPosition[]>(
			readArray(body, 'event_positions', path, false) ?? [],
		),
	}
	const cursor = readCursor(body)
	if (cursor) {
		response.cursor = cursor
	}
	return response
}

/** `{ [field]: T[], cursor? }` for a portfolio list endpoint. */
function readListResponse<
	T,
	R extends { cursor?: string },
> (
	value: unknown,
	path: string,
	field: string,
): R {
	const body = readObject(value, path)
	const rows = readRequiredArray(body, field, path)
	const response: Record<string, unknown> = {
		[field]: asPayload<T[]>(rows),
	}
	const cursor = readCursor(body)
	if (cursor) {
		response.cursor = cursor
	}
	return asPayload<R>(response)
}

function readLiveDatas (
	value: unknown,
	path: string,
): LiveData[] {
	const body = readObject(value, path)
	return asPayload<LiveData[]>(
		readRequiredArray(body, 'live_datas', path),
	)
}

function definedQuery (
	entries: ReadonlyArray<
		readonly [
			string,
			ScalarParam | readonly string[] | undefined,
		]
	>,
): Query {
	const query: Query = {}
	for (const entry of entries) {
		const key = entry[0]
		const value = entry[1]
		if (value !== undefined) {
			query[key] = value
		}
	}
	return query
}

function buildParams (query: Query | undefined): URLSearchParams {
	const params = new URLSearchParams()
	if (!query) {
		return params
	}
	const keys = Object.keys(query).sort()
	for (const key of keys) {
		appendParam(params, key, query[key])
	}
	return params
}

function appendParam (
	params: URLSearchParams,
	key: string,
	value: ScalarParam | readonly string[] | undefined,
): void {
	if (value === undefined) {
		return
	}
	if (
		typeof value === 'string'
		|| typeof value === 'number'
		|| typeof value === 'boolean'
	) {
		params.append(key, String(value))
		return
	}
	for (const item of value) {
		params.append(key, item)
	}
}

function marketsPageParams (
	params: GetAllMarketsParams,
	limit: number,
	cursor: string | undefined,
): GetMarketsParams {
	const next: GetMarketsParams = { limit }
	if (params.series_ticker !== undefined) {
		next.series_ticker = params.series_ticker
	}
	if (params.event_ticker !== undefined) {
		next.event_ticker = params.event_ticker
	}
	if (params.status !== undefined) {
		next.status = params.status
	}
	if (params.tickers !== undefined) {
		next.tickers = params.tickers
	}
	if (cursor !== undefined) {
		next.cursor = cursor
	}
	return next
}

function eventsQuery (
	params: GetAllEventsParams,
	limit: number | undefined,
	cursor: string | undefined,
): Query {
	return definedQuery([
		['series_ticker', params.series_ticker],
		['status', params.status],
		['with_nested_markets', params.with_nested_markets],
		['with_milestones', params.with_milestones],
		['limit', limit],
		['cursor', cursor],
	])
}

interface MilestoneFilters {
	category?: string
	competition?: string
	type?: string
	related_event_ticker?: string
	minimum_start_date?: string
}

function milestoneQuery (
	params: MilestoneFilters,
	limit: number | undefined,
	cursor: string | undefined,
): Query {
	return definedQuery([
		['limit', limit],
		['category', params.category],
		['competition', params.competition],
		['type', params.type],
		['related_event_ticker', params.related_event_ticker],
		['minimum_start_date', params.minimum_start_date],
		['cursor', cursor],
	])
}

function pageFrom<T> (
	items: T[],
	cursor: string | undefined,
	milestones: Milestone[] | undefined,
): PageResult<T> {
	return {
		items,
		cursor,
		milestones,
	}
}

function finish<T> (
	items: T[],
	cursor: string | undefined,
	milestones: Milestone[] | undefined,
): Collected<T> {
	return {
		items,
		cursor,
		milestones,
	}
}

async function collectPages<T> (
	maxPages: number | undefined,
	fetchPage: (
		cursor: string | undefined,
	) => Promise<PageResult<T>>,
): Promise<Collected<T>> {
	const items: T[] = []
	const milestones: Milestone[] = []
	let sawMilestones = false
	let cursor: string | undefined
	const seen = new Set<string>()

	const pageBound = resolveMaxPages(maxPages)

	for (let page = 0; page < pageBound; page += 1) {
		const result = await fetchPage(cursor)
		items.push(...result.items)
		if (result.milestones !== undefined) {
			sawMilestones = true
			milestones.push(...result.milestones)
		}
		const next = result.cursor
		const milestoneRows = sawMilestones
			? milestones
			: undefined
		if (!next) {
			return finish(items, undefined, milestoneRows)
		}
		if (seen.has(next)) {
			return finish(items, next, milestoneRows)
		}
		seen.add(next)
		cursor = next
	}

	return finish(
		items,
		cursor,
		sawMilestones ? milestones : undefined,
	)
}

function marketsFromCollected (
	collected: Collected<Market>,
): GetMarketsResponse {
	const response: GetMarketsResponse = {
		markets: collected.items,
	}
	if (collected.cursor) {
		response.cursor = collected.cursor
	}
	return response
}

function eventsFromCollected (
	collected: Collected<Event>,
): GetEventsResponse {
	const response: GetEventsResponse = {
		events: collected.items,
	}
	if (collected.cursor) {
		response.cursor = collected.cursor
	}
	if (collected.milestones !== undefined) {
		response.milestones = collected.milestones
	}
	return response
}

function milestonesFromCollected (
	collected: Collected<Milestone>,
): GetMilestonesResponse {
	const response: GetMilestonesResponse = {
		milestones: collected.items,
	}
	if (collected.cursor) {
		response.cursor = collected.cursor
	}
	return response
}

function chunkIds (
	ids: readonly string[],
	size: number,
): string[][] {
	const chunks: string[][] = []
	for (let index = 0; index < ids.length; index += size) {
		chunks.push(ids.slice(index, index + size))
	}
	return chunks
}
