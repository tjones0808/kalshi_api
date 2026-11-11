import type { Market } from '../kalshi/types.js'

/**
 * Normalized book for one binary market, in dollars.
 * Kalshi never omits a price: an empty ask is `1.0000` and
 * an empty bid is `0.0000`. Those placeholders, and any side
 * with zero size, are null here.
 */
export interface NormalizedQuote {
	/** Null when there is no real YES bid. */
	yesBid: number | null
	/** Null when YES cannot be bought. */
	yesAsk: number | null
	/** Null when there is no real NO bid. */
	noBid: number | null
	/** Null when NO cannot be bought. */
	noAsk: number | null
	/** Yes ask: the cost to buy YES. Null when unbuyable. */
	impliedYes: number | null
	/** No ask: the cost to buy NO. Null when unbuyable. */
	impliedNo: number | null
	/** Only when both a real yes bid and yes ask exist. */
	mid: number | null
	/** `yesAsk - yesBid` when both sides are present. */
	spread: number | null
	yesBidSize: number | null
	yesAskSize: number | null
	/** Contracts for sale at the NO ask. Equals `yesBidSize`. */
	noAskSize: number | null
	/** Contracts bid on NO. Equals `yesAskSize`. */
	noBidSize: number | null
}

/**
 * Parse a Kalshi fixed-point dollar string.
 * Blank and non-numeric values are null. `0` stays `0`.
 */
export function parseDollars (
	value: string | undefined | null,
): number | null {
	if (value === undefined || value === null) {
		return null
	}
	const trimmed = value.trim()
	if (trimmed.length === 0) {
		return null
	}
	const parsed = Number(trimmed)
	if (!Number.isFinite(parsed)) {
		return null
	}
	return parsed
}

/**
 * Build a quote from a market.
 * A parlay leg uses the ask of the chosen side (`sideAsk`),
 * not the mid. A NO ask is `1 - yes_bid` when the field is
 * blank, and NO sizes mirror the YES sizes.
 */
export function quoteFromMarket (market: Market): NormalizedQuote {
	const yesBidSize = parseDollars(market.yes_bid_size_fp)
	const yesAskSize = parseDollars(market.yes_ask_size_fp)
	const rawYesBid = parseDollars(market.yes_bid_dollars)
	const rawNoAsk = parseDollars(market.no_ask_dollars)
		?? (rawYesBid === null ? null : roundDollars(1 - rawYesBid))
	const yesBid = realBid(rawYesBid, yesBidSize)
	const yesAsk = realAsk(
		parseDollars(market.yes_ask_dollars),
		yesAskSize,
	)
	const noBid = realBid(
		parseDollars(market.no_bid_dollars),
		yesAskSize,
	)
	const noAsk = realAsk(rawNoAsk, yesBidSize)
	const hasBook = yesBid !== null && yesAsk !== null
	return {
		yesBid,
		yesAsk,
		noBid,
		noAsk,
		impliedYes: yesAsk,
		impliedNo: noAsk,
		mid: hasBook ? roundDollars((yesBid + yesAsk) / 2) : null,
		spread: hasBook ? roundDollars(yesAsk - yesBid) : null,
		yesBidSize,
		yesAskSize,
		noAskSize: yesBidSize,
		noBidSize: yesAskSize,
	}
}

/**
 * Ask for `yes` or `no`.
 * This is the price paid to buy that side. Null means
 * that side cannot be bought.
 */
export function sideAsk (
	quote: NormalizedQuote,
	side: 'yes' | 'no',
): number | null {
	if (side === 'yes') {
		return quote.yesAsk
	}
	return quote.noAsk
}

/**
 * Round to `digits` decimals so float noise such as
 * `0.009999999999999898` never reaches a client.
 */
export function roundTo (value: number, digits: number): number {
	const factor = 10 ** digits
	return Math.round(value * factor) / factor
}

function roundDollars (value: number): number {
	return roundTo(value, 4)
}

function realAsk (
	price: number | null,
	size: number | null,
): number | null {
	if (price === null || price <= 0 || price >= 1) {
		return null
	}
	return size === 0 ? null : price
}

function realBid (
	price: number | null,
	size: number | null,
): number | null {
	if (price === null || price <= 0) {
		return null
	}
	return size === 0 ? null : price
}
