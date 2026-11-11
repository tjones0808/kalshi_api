import type {
	GetBalanceParams,
	GetFillsParams,
	GetOrdersParams,
	GetPositionsParams,
	GetSettlementsParams,
	KalshiClient,
} from '../kalshi/kalshi-client.js'
import type {
	EventPosition,
	Fill,
	GetBalanceResponse,
	IndexedBalance,
	MarketPosition,
	Order,
	Settlement,
} from '../kalshi/types.js'
import { parseDollars, roundTo } from './prices.js'

/**
 * Money is in dollars and counts are contracts, both as
 * numbers, like `prices.ts`. A value that is missing or not
 * numeric is null. Kalshi's integer cents are divided by 100.
 */
export interface BalanceView {
	/** Available cash in dollars. */
	balance: number | null
	/** Value of open positions in dollars. */
	portfolioValue: number | null
	/** Unix seconds of the last balance change. */
	updatedTs: number | null
	/** Cash per exchange index, or null when not reported. */
	byExchangeIndex: Array<{
		exchangeIndex: number
		balance: number | null
	}> | null
}

export interface MarketPositionView {
	ticker: string
	exchangeIndex: number | null
	/** Signed contracts: positive YES, negative NO. */
	position: number | null
	/** `yes` or `no`, or null when flat. */
	side: 'yes' | 'no' | null
	/** Cost basis of the open position, excluding fees. */
	marketExposure: number | null
	totalTraded: number | null
	realizedPnl: number | null
	feesPaid: number | null
	lastUpdated: string | null
	nettingEnabled: boolean | null
}

export interface EventPositionView {
	eventTicker: string
	totalCost: number | null
	totalCostShares: number | null
	eventExposure: number | null
	realizedPnl: number | null
	feesPaid: number | null
}

export interface PositionsView {
	marketPositions: MarketPositionView[]
	eventPositions: EventPositionView[]
	/** Pass back as `cursor` for the next page. */
	cursor: string | null
}

export interface FillView {
	fillId: string
	orderId: string
	ticker: string
	outcomeSide: string
	bookSide: string
	count: number | null
	yesPrice: number | null
	noPrice: number | null
	/** Price of `outcomeSide`. */
	price: number | null
	isTaker: boolean
	fee: number | null
	createdTime: string | null
	exchangeIndex: number | null
	subaccount: number | null
}

export interface FillsView {
	fills: FillView[]
	cursor: string | null
}

export interface OrderView {
	orderId: string
	clientOrderId: string | null
	ticker: string
	outcomeSide: string
	bookSide: string
	type: string
	status: string
	yesPrice: number | null
	noPrice: number | null
	/** Limit price of `outcomeSide`. */
	price: number | null
	initialCount: number | null
	fillCount: number | null
	remainingCount: number | null
	takerFillCost: number | null
	makerFillCost: number | null
	takerFees: number | null
	makerFees: number | null
	createdTime: string | null
	lastUpdateTime: string | null
	expirationTime: string | null
	orderGroupId: string | null
	exchangeIndex: number | null
	subaccount: number | null
}

export interface OrdersView {
	orders: OrderView[]
	cursor: string | null
}

export interface SettlementView {
	ticker: string
	eventTicker: string
	exchangeIndex: number | null
	/** `yes`, `no`, `scalar`, or empty when unknown. */
	marketResult: string
	yesCount: number | null
	yesTotalCost: number | null
	noCount: number | null
	noTotalCost: number | null
	/** Total payout in dollars. */
	revenue: number | null
	fees: number | null
	/** Payout of one YES contract in dollars. */
	value: number | null
	settledTime: string | null
}

export interface SettlementsView {
	settlements: SettlementView[]
	cursor: string | null
}

/**
 * Read-only view of the Kalshi account behind the configured
 * credentials. Every call goes to Kalshi; nothing is cached.
 */
export interface PortfolioService {
	getBalance (params?: GetBalanceParams): Promise<BalanceView>
	getPositions (
		params?: GetPositionsParams,
	): Promise<PositionsView>
	getFills (params?: GetFillsParams): Promise<FillsView>
	getOrders (params?: GetOrdersParams): Promise<OrdersView>
	getSettlements (
		params?: GetSettlementsParams,
	): Promise<SettlementsView>
}

function centsToDollars (
	cents: number | null | undefined,
): number | null {
	if (typeof cents !== 'number' || !Number.isFinite(cents)) {
		return null
	}
	return roundTo(cents / 100, 2)
}

function orNull<T> (value: T | null | undefined): T | null {
	return value ?? null
}

function sideOfPosition (
	position: number | null,
): 'yes' | 'no' | null {
	if (position === null || position === 0) {
		return null
	}
	return position > 0 ? 'yes' : 'no'
}

function sidePrice (
	side: string,
	yes: number | null,
	no: number | null,
): number | null {
	if (side === 'yes') {
		return yes
	}
	return side === 'no' ? no : null
}

function balanceView (raw: GetBalanceResponse): BalanceView {
	const breakdown = raw.balance_breakdown
	return {
		balance: parseDollars(raw.balance_dollars)
			?? centsToDollars(raw.balance),
		portfolioValue: centsToDollars(raw.portfolio_value),
		updatedTs: orNull(raw.updated_ts),
		byExchangeIndex: breakdown === undefined
			? null
			: breakdown.map(function (row: IndexedBalance) {
				return {
					exchangeIndex: row.exchange_index,
					balance: parseDollars(row.balance),
				}
			}),
	}
}

function marketPositionView (
	raw: MarketPosition,
): MarketPositionView {
	const position = parseDollars(raw.position_fp)
	return {
		ticker: raw.ticker,
		exchangeIndex: orNull(raw.exchange_index),
		position,
		side: sideOfPosition(position),
		marketExposure: parseDollars(raw.market_exposure_dollars),
		totalTraded: parseDollars(raw.total_traded_dollars),
		realizedPnl: parseDollars(raw.realized_pnl_dollars),
		feesPaid: parseDollars(raw.fees_paid_dollars),
		lastUpdated: orNull(raw.last_updated_ts),
		nettingEnabled: orNull(raw.netting_enabled),
	}
}

function eventPositionView (
	raw: EventPosition,
): EventPositionView {
	return {
		eventTicker: raw.event_ticker,
		totalCost: parseDollars(raw.total_cost_dollars),
		totalCostShares: parseDollars(raw.total_cost_shares_fp),
		eventExposure: parseDollars(raw.event_exposure_dollars),
		realizedPnl: parseDollars(raw.realized_pnl_dollars),
		feesPaid: parseDollars(raw.fees_paid_dollars),
	}
}

function fillView (raw: Fill): FillView {
	const yesPrice = parseDollars(raw.yes_price_dollars)
	const noPrice = parseDollars(raw.no_price_dollars)
	return {
		fillId: raw.fill_id,
		orderId: raw.order_id,
		ticker: raw.ticker,
		outcomeSide: raw.outcome_side,
		bookSide: raw.book_side,
		count: parseDollars(raw.count_fp),
		yesPrice,
		noPrice,
		price: sidePrice(raw.outcome_side, yesPrice, noPrice),
		isTaker: raw.is_taker,
		fee: parseDollars(raw.fee_cost),
		createdTime: orNull(raw.created_time),
		exchangeIndex: orNull(raw.exchange_index),
		subaccount: orNull(raw.subaccount_number),
	}
}

function orderView (raw: Order): OrderView {
	const yesPrice = parseDollars(raw.yes_price_dollars)
	const noPrice = parseDollars(raw.no_price_dollars)
	return {
		orderId: raw.order_id,
		clientOrderId: orNull(raw.client_order_id),
		ticker: raw.ticker,
		outcomeSide: raw.outcome_side,
		bookSide: raw.book_side,
		type: raw.type,
		status: raw.status,
		yesPrice,
		noPrice,
		price: sidePrice(raw.outcome_side, yesPrice, noPrice),
		initialCount: parseDollars(raw.initial_count_fp),
		fillCount: parseDollars(raw.fill_count_fp),
		remainingCount: parseDollars(raw.remaining_count_fp),
		takerFillCost: parseDollars(raw.taker_fill_cost_dollars),
		makerFillCost: parseDollars(raw.maker_fill_cost_dollars),
		takerFees: parseDollars(raw.taker_fees_dollars),
		makerFees: parseDollars(raw.maker_fees_dollars),
		createdTime: orNull(raw.created_time),
		lastUpdateTime: orNull(raw.last_update_time),
		expirationTime: orNull(raw.expiration_time),
		orderGroupId: orNull(raw.order_group_id),
		exchangeIndex: orNull(raw.exchange_index),
		subaccount: orNull(raw.subaccount_number),
	}
}

function settlementView (raw: Settlement): SettlementView {
	return {
		ticker: raw.ticker,
		eventTicker: raw.event_ticker,
		exchangeIndex: orNull(raw.exchange_index),
		marketResult: raw.market_result,
		yesCount: parseDollars(raw.yes_count_fp),
		yesTotalCost: parseDollars(raw.yes_total_cost_dollars),
		noCount: parseDollars(raw.no_count_fp),
		noTotalCost: parseDollars(raw.no_total_cost_dollars),
		revenue: centsToDollars(raw.revenue),
		fees: parseDollars(raw.fee_cost),
		value: centsToDollars(raw.value),
		settledTime: orNull(raw.settled_time),
	}
}

/**
 * Wrap a signed Kalshi client in the read-only portfolio
 * service. Pass the raw client, not the cached one: portfolio
 * data is private and must never share the TTL cache.
 */
export function createPortfolioService (
	client: KalshiClient,
): PortfolioService {
	return {
		getBalance: async function (params) {
			return balanceView(await client.getBalance(params))
		},

		getPositions: async function (params) {
			const page = await client.getPositions(params)
			return {
				marketPositions:
					page.market_positions.map(marketPositionView),
				eventPositions:
					page.event_positions.map(eventPositionView),
				cursor: orNull(page.cursor),
			}
		},

		getFills: async function (params) {
			const page = await client.getFills(params)
			return {
				fills: page.fills.map(fillView),
				cursor: orNull(page.cursor),
			}
		},

		getOrders: async function (params) {
			const page = await client.getOrders(params)
			return {
				orders: page.orders.map(orderView),
				cursor: orNull(page.cursor),
			}
		},

		getSettlements: async function (params) {
			const page = await client.getSettlements(params)
			return {
				settlements: page.settlements.map(settlementView),
				cursor: orNull(page.cursor),
			}
		},
	}
}
