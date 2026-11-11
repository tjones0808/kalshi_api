/**
 * Dollar OHLC for one side of a candlestick.
 * Prices are fixed-point dollar strings.
 */
export interface DollarOhlc {
	open_dollars?: string
	high_dollars?: string
	low_dollars?: string
	close_dollars?: string
}

/**
 * Trade-price summary for one candlestick.
 * Nulls mean that side had no prints.
 */
export interface CandlestickPrice {
	open_dollars?: string | null
	high_dollars?: string | null
	low_dollars?: string | null
	close_dollars?: string | null
	mean_dollars?: string | null
}

/** Lifecycle of a single binary market. */
export type MarketStatus =
	| 'initialized'
	| 'inactive'
	| 'active'
	| 'closed'
	| 'determined'
	| 'disputed'
	| 'amended'
	| 'finalized'

/** Status filter used by the events and markets list endpoints. */
export type EventListStatus =
	| 'unopened'
	| 'open'
	| 'closed'
	| 'settled'

/**
 * One tradable binary market.
 * Unknown Kalshi fields are kept so callers can read them.
 */
export interface Market {
	ticker: string
	event_ticker: string
	market_type: string
	yes_sub_title: string
	status: string
	yes_bid_dollars: string
	yes_ask_dollars: string
	no_bid_dollars: string
	no_ask_dollars: string
	yes_bid_size_fp?: string
	yes_ask_size_fp?: string
	last_price_dollars?: string
	volume_fp?: string
	volume_24h_fp?: string
	open_interest_fp?: string
	close_time?: string
	open_time?: string
	rules_primary?: string
	floor_strike?: number | null
	cap_strike?: number | null
	strike_type?: string
	custom_strike?: Record<string, unknown> | null
	// Allow extra fields from Kalshi.
	[key: string]: unknown
}

/** A real-world occurrence that contains one or more markets. */
export interface Event {
	event_ticker: string
	series_ticker: string
	title: string
	sub_title?: string
	category?: string
	mutually_exclusive?: boolean
	strike_date?: string | null
	strike_period?: string | null
	markets?: Market[]
}

/** A template for recurring events. */
export interface Series {
	ticker: string
	title: string
	frequency: string
	category: string
	categories?: string[]
	tags?: string[] | null
}

/** A scheduled occurrence Kalshi attaches live data to. */
export interface Milestone {
	id: string
	category: string
	type: string
	start_date: string
	end_date?: string | null
	title: string
	related_event_tickers: string[]
	primary_event_tickers: string[]
	details: Record<string, unknown>
	last_updated_ts?: string
}

/** Provider snapshot for one milestone. */
export interface LiveData {
	type: string
	milestone_id: string
	details: Record<string, unknown>
}

/** A completed trade. Prices are fixed-point dollar strings. */
export interface Trade {
	trade_id: string
	ticker: string
	count_fp: string
	yes_price_dollars: string
	no_price_dollars: string
	taker_outcome_side: 'yes' | 'no'
	taker_book_side: 'bid' | 'ask'
	created_time: string
	is_block_trade: boolean
}

/** One OHLCV bucket for a market. */
export interface MarketCandlestick {
	end_period_ts: number
	yes_bid?: DollarOhlc
	yes_ask?: DollarOhlc
	price?: CandlestickPrice
	volume_fp?: string
	open_interest_fp?: string
}

/**
 * Fixed-point order book.
 * Each level is `[priceDollars, count]`.
 */
export interface OrderbookFp {
	yes_dollars?: [string, string][]
	no_dollars?: [string, string][]
}

/** Trading state of one exchange index. */
export interface ExchangeIndexStatus {
	exchange_index: number
	description?: string
	exchange_active: boolean
	trading_active: boolean
}

/** Whether the exchange is accepting trades. */
export interface ExchangeStatus {
	exchange_active: boolean
	trading_active: boolean
	intra_exchange_transfers_active?: boolean
	exchange_index_statuses?: ExchangeIndexStatus[]
}

export interface GetMarketsResponse {
	markets: Market[]
	cursor?: string
}

export interface GetEventsResponse {
	events: Event[]
	cursor?: string
	milestones?: Milestone[]
}

export interface GetSeriesListResponse {
	series: Series[]
}

export interface GetSeriesResponse {
	series: Series
}

export interface GetMarketResponse {
	market: Market
}

export interface GetEventResponse {
	event: Event
}

export interface GetMilestonesResponse {
	milestones: Milestone[]
	cursor?: string
}

export interface GetLiveDataResponse {
	live_data: LiveData
}

export interface GetLiveDatasResponse {
	live_datas: LiveData[]
}

export interface GetTradesResponse {
	trades: Trade[]
	cursor?: string
}

export interface GetMarketCandlesticksResponse {
	ticker: string
	candlesticks: MarketCandlestick[]
}

export interface GetMarketOrderbookResponse {
	orderbook_fp?: OrderbookFp
	orderbook?: unknown
}

/** Balance for one exchange index, in fixed-point dollars. */
export interface IndexedBalance {
	exchange_index: number
	balance: string
}

/**
 * `GET /portfolio/balance`. `balance` and `portfolio_value` are
 * integer cents; `balance_dollars` is a fixed-point string.
 */
export interface GetBalanceResponse {
	balance: number
	balance_dollars?: string
	portfolio_value: number
	updated_ts?: number
	balance_breakdown?: IndexedBalance[]
}

/** Net position in one market. `position_fp` is signed. */
export interface MarketPosition {
	ticker: string
	exchange_index?: number
	total_traded_dollars: string
	position_fp: string
	market_exposure_dollars: string
	realized_pnl_dollars: string
	fees_paid_dollars: string
	last_updated_ts?: string
	netting_enabled?: boolean
}

/** Aggregate position across the markets of one event. */
export interface EventPosition {
	event_ticker: string
	total_cost_dollars: string
	total_cost_shares_fp: string
	event_exposure_dollars: string
	realized_pnl_dollars: string
	fees_paid_dollars: string
}

export interface GetPositionsResponse {
	market_positions: MarketPosition[]
	event_positions: EventPosition[]
	cursor?: string
}

/** One matched trade of the member. */
export interface Fill {
	fill_id: string
	order_id: string
	ticker: string
	outcome_side: string
	book_side: string
	count_fp: string
	yes_price_dollars: string
	no_price_dollars: string
	is_taker: boolean
	fee_cost: string
	created_time?: string
	exchange_index?: number
	subaccount_number?: number | null
	// Allow legacy and extra fields from Kalshi.
	[key: string]: unknown
}

export interface GetFillsResponse {
	fills: Fill[]
	cursor?: string
}

/** Lifecycle of a member order. */
export type OrderStatus = 'resting' | 'canceled' | 'executed'

/** One member order. */
export interface Order {
	order_id: string
	client_order_id?: string
	ticker: string
	outcome_side: string
	book_side: string
	type: string
	status: string
	yes_price_dollars: string
	no_price_dollars: string
	fill_count_fp: string
	remaining_count_fp: string
	initial_count_fp: string
	taker_fill_cost_dollars: string
	maker_fill_cost_dollars: string
	taker_fees_dollars: string
	maker_fees_dollars: string
	created_time?: string | null
	last_update_time?: string | null
	expiration_time?: string | null
	order_group_id?: string | null
	exchange_index?: number
	subaccount_number?: number | null
	// Allow legacy and extra fields from Kalshi.
	[key: string]: unknown
}

export interface GetOrdersResponse {
	orders: Order[]
	cursor?: string
}

/** One settled market. `revenue` and `value` are cents. */
export interface Settlement {
	ticker: string
	event_ticker: string
	exchange_index?: number
	market_result: string
	yes_count_fp: string
	yes_total_cost_dollars: string
	no_count_fp: string
	no_total_cost_dollars: string
	revenue: number
	settled_time: string
	fee_cost: string
	value?: number | null
}

export interface GetSettlementsResponse {
	settlements: Settlement[]
	cursor?: string
}
