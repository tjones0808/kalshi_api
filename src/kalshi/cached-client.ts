import type { KalshiClient } from './kalshi-client.js'
import type { TtlCache } from './ttl-cache.js'

/** How long exchange status stays cached. */
const EXCHANGE_STATUS_TTL_MS = 10_000

/**
 * TTLs for {@link createCachedKalshiClient}.
 * Names match `AppEnv` so parsed env can be passed through.
 */
export interface KalshiCacheTtls {
	cacheTtlSeriesMs: number
	cacheTtlMarketsMs: number
	cacheTtlOrderbookMs: number
	cacheTtlLiveMs: number
	cacheTtlTradesMs: number
}

/**
 * Cache public Kalshi reads.
 *
 * Keys are the method name plus a stable JSON form of the
 * arguments. Candlesticks use the full query and the markets
 * TTL. Trades are cached only when `cursor` is absent or empty.
 * Exchange status is cached for 10 seconds. Milestones use the
 * live TTL. A TTL of 0 skips that group. Portfolio methods
 * are private per account and always pass straight through.
 */
export function createCachedKalshiClient (
	client: KalshiClient,
	cache: TtlCache,
	ttls: KalshiCacheTtls,
): KalshiClient {
	function remember<T> (
		method: string,
		params: unknown,
		ttlMs: number,
		fn: () => Promise<T>,
	): Promise<T> {
		return cache.wrap(cacheKey(method, params), ttlMs, fn)
	}

	const cached: KalshiClient = {
		getExchangeStatus: function () {
			return remember(
				'getExchangeStatus',
				{},
				EXCHANGE_STATUS_TTL_MS,
				function () {
					return client.getExchangeStatus()
				},
			)
		},

		getSeriesList: function (params) {
			return remember(
				'getSeriesList',
				params ?? {},
				ttls.cacheTtlSeriesMs,
				function () {
					return client.getSeriesList(params)
				},
			)
		},

		getSeries: function (seriesTicker) {
			return remember(
				'getSeries',
				{ seriesTicker },
				ttls.cacheTtlSeriesMs,
				function () {
					return client.getSeries(seriesTicker)
				},
			)
		},

		getMarkets: function (params) {
			return remember(
				'getMarkets',
				params,
				ttls.cacheTtlMarketsMs,
				function () {
					return client.getMarkets(params)
				},
			)
		},

		getAllMarkets: function (params) {
			return remember(
				'getAllMarkets',
				params,
				ttls.cacheTtlMarketsMs,
				function () {
					return client.getAllMarkets(params)
				},
			)
		},

		getMarket: function (ticker) {
			return remember(
				'getMarket',
				{ ticker },
				ttls.cacheTtlMarketsMs,
				function () {
					return client.getMarket(ticker)
				},
			)
		},

		getEvents: function (params) {
			return remember(
				'getEvents',
				params,
				ttls.cacheTtlMarketsMs,
				function () {
					return client.getEvents(params)
				},
			)
		},

		getAllEvents: function (params) {
			return remember(
				'getAllEvents',
				params,
				ttls.cacheTtlMarketsMs,
				function () {
					return client.getAllEvents(params)
				},
			)
		},

		getEvent: function (eventTicker, params) {
			return remember(
				'getEvent',
				{
					eventTicker,
					with_nested_markets: params?.with_nested_markets,
					with_milestones: params?.with_milestones,
				},
				ttls.cacheTtlMarketsMs,
				function () {
					return client.getEvent(eventTicker, params)
				},
			)
		},

		getMarketOrderbook: function (ticker) {
			return remember(
				'getMarketOrderbook',
				{ ticker },
				ttls.cacheTtlOrderbookMs,
				function () {
					return client.getMarketOrderbook(ticker)
				},
			)
		},

		getTrades: function (params) {
			if (hasCursor(params.cursor)) {
				return client.getTrades(params)
			}
			return remember(
				'getTrades',
				tradesKeyParams(params),
				ttls.cacheTtlTradesMs,
				function () {
					return client.getTrades(params)
				},
			)
		},

		getMarketCandlesticks: function (
			seriesTicker,
			ticker,
			params,
		) {
			return remember(
				'getMarketCandlesticks',
				{ seriesTicker, ticker, params },
				ttls.cacheTtlMarketsMs,
				function () {
					return client.getMarketCandlesticks(
						seriesTicker,
						ticker,
						params,
					)
				},
			)
		},

		getMilestones: function (params) {
			return remember(
				'getMilestones',
				params,
				ttls.cacheTtlLiveMs,
				function () {
					return client.getMilestones(params)
				},
			)
		},

		getAllMilestones: function (params) {
			return remember(
				'getAllMilestones',
				params,
				ttls.cacheTtlLiveMs,
				function () {
					return client.getAllMilestones(params)
				},
			)
		},

		getMilestone: function (milestoneId) {
			return remember(
				'getMilestone',
				{ milestoneId },
				ttls.cacheTtlLiveMs,
				function () {
					return client.getMilestone(milestoneId)
				},
			)
		},

		getLiveData: function (milestoneId, includePlayerStats) {
			return remember(
				'getLiveData',
				{ milestoneId, includePlayerStats },
				ttls.cacheTtlLiveMs,
				function () {
					return client.getLiveData(
						milestoneId,
						includePlayerStats,
					)
				},
			)
		},

		getLiveDataBatch: function (
			milestoneIds,
			includePlayerStats,
		) {
			return remember(
				'getLiveDataBatch',
				{ milestoneIds, includePlayerStats },
				ttls.cacheTtlLiveMs,
				function () {
					return client.getLiveDataBatch(
						milestoneIds,
						includePlayerStats,
					)
				},
			)
		},

		getBalance: function (params) {
			return client.getBalance(params)
		},

		getPositions: function (params) {
			return client.getPositions(params)
		},

		getFills: function (params) {
			return client.getFills(params)
		},

		getOrders: function (params) {
			return client.getOrders(params)
		},

		getSettlements: function (params) {
			return client.getSettlements(params)
		},
	}

	return cached
}

function hasCursor (cursor: string | undefined): boolean {
	return typeof cursor === 'string' && cursor.length > 0
}

function tradesKeyParams (
	params: {
		ticker?: string
		limit?: number
		min_ts?: number
		max_ts?: number
	},
): Record<string, string | number> {
	const key: Record<string, string | number> = {}
	if (params.ticker !== undefined) {
		key.ticker = params.ticker
	}
	if (params.limit !== undefined) {
		key.limit = params.limit
	}
	if (params.min_ts !== undefined) {
		key.min_ts = params.min_ts
	}
	if (params.max_ts !== undefined) {
		key.max_ts = params.max_ts
	}
	return key
}

function cacheKey (method: string, params: unknown): string {
	return `${method}:${stableStringify(params)}`
}

function stableStringify (value: unknown): string {
	if (value === undefined) {
		return 'null'
	}
	if (Array.isArray(value)) {
		const parts = value.map(function (item) {
			return stableStringify(item)
		})
		return `[${parts.join(',')}]`
	}
	if (typeof value === 'object' && value !== null) {
		const record = value as Record<string, unknown>
		const keys = Object.keys(record).sort()
		const parts: string[] = []
		for (const key of keys) {
			const item = record[key]
			if (item === undefined) {
				continue
			}
			parts.push(
				`${JSON.stringify(key)}:${stableStringify(item)}`,
			)
		}
		return `{${parts.join(',')}}`
	}
	const encoded = JSON.stringify(value)
	if (encoded === undefined) {
		return 'null'
	}
	return encoded
}
