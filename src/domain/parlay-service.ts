import type { KalshiClient } from '../kalshi/kalshi-client.js'
import { KalshiHttpError } from '../kalshi/errors.js'
import type { Market } from '../kalshi/types.js'
import { seriesTickerFromEventTicker } from './market-classify.js'
import { quoteFromMarket, roundTo, sideAsk } from './prices.js'
import type { NormalizedQuote } from './prices.js'

const FETCH_CONCURRENCY = 5

const NEEDS_LEGS = 'Parlay needs at least two legs'

/** A side of a binary market to buy. */
export type ParlaySide = 'yes' | 'no'

/** One contract the bettor wants in the parlay. */
export interface ParlayLegInput {
	ticker: string
	side: ParlaySide
}

/** A leg priced from the live ask. */
export interface PricedLeg {
	ticker: string
	side: ParlaySide
	eventTicker: string
	seriesTicker: string
	/** `yes_sub_title`, or the market ticker when that is blank. */
	title: string
	status: string
	ask: number | null
	/**
	 * Price of a $1 binary contract.
	 * Same as `ask` when the ask is present.
	 */
	impliedProbability: number | null
	quote: NormalizedQuote
}

/**
 * Ask-based price of a parlay, plus data-quality warnings.
 * Odds are the price to buy. They include the spread and are
 * not vig-free fair odds.
 */
export interface ParlayPrice {
	legs: PricedLeg[]
	/**
	 * Product of leg asks.
	 * Null when any leg is missing, has no buyable ask, or
	 * has an ask outside `(0, 1)`.
	 */
	combinedProbability: number | null
	/**
	 * Reciprocal of `combinedProbability`: the price to buy,
	 * not vig-free odds.
	 */
	decimalOdds: number | null
	/**
	 * Integer American odds for `decimalOdds`.
	 * Null when decimal odds are null or exactly 1.
	 */
	americanOdds: number | null
	/**
	 * Total return per $1 staked, including the stake.
	 * Equal to `decimalOdds`.
	 */
	payoutPerDollar: number | null
	/** Profit per $1 staked. `decimalOdds - 1`. */
	profitPerDollar: number | null
	warnings: string[]
}

/** Prices parlays from a Kalshi client's market asks. */
export interface ParlayService {
	/**
	 * Buy each leg at its side ask and multiply those prices.
	 * A 404 is omitted from `legs`, added to `warnings`, and
	 * clears the combined price. Other client errors throw.
	 * Correlation warnings do not change the product.
	 */
	priceParlay (
		legs: ParlayLegInput[],
	): Promise<ParlayPrice>
}

interface OddsFields {
	decimalOdds: number | null
	americanOdds: number | null
	payoutPerDollar: number | null
	profitPerDollar: number | null
}

interface LoadedLeg {
	ticker: string
	leg: PricedLeg | null
}

/**
 * American odds for decimal odds.
 * At least 2 becomes `round((decimal - 1) * 100)`.
 * Between 1 and 2 becomes `round(-100 / (decimal - 1))`.
 * Decimal odds of 1 or less are null.
 */
export function americanOddsFromDecimal (
	decimal: number,
): number | null {
	if (!Number.isFinite(decimal) || decimal <= 1) {
		return null
	}
	if (decimal >= 2) {
		return Math.round((decimal - 1) * 100)
	}
	return Math.round(-100 / (decimal - 1))
}

/**
 * Decimal odds for a probability in `(0, 1]`.
 * `1` stays `1`. Zero and values outside that range are null.
 */
export function decimalOddsFromProbability (
	p: number,
): number | null {
	if (!Number.isFinite(p) || p <= 0 || p > 1) {
		return null
	}
	return 1 / p
}

/**
 * Product of independent probabilities.
 * Null when the list is empty or any value is missing
 * or outside `(0, 1)`. A price of 1 is Kalshi's placeholder
 * for no ask, so it never produces a combined price.
 */
export function combineProbabilities (
	probs: Array<number | null>,
): number | null {
	if (probs.length === 0) {
		return null
	}
	let product = 1
	for (const prob of probs) {
		if (
			prob === null
			|| !Number.isFinite(prob)
			|| prob <= 0
			|| prob >= 1
		) {
			return null
		}
		product *= prob
	}
	return product
}

/**
 * Warnings for priced legs, in a stable order.
 * Two legs on one event ticker produce
 * `Correlated legs share event {eventTicker}`.
 * A game key is the second hyphen segment of the event
 * ticker. Two legs with that key produce one
 * `Correlated legs share game {gameKey}`, including a
 * moneyline, a spread, or two events of one series with
 * different suffixes. Each game key is warned once.
 */
export function detectWarnings (legs: PricedLeg[]): string[] {
	const warnings: string[] = []
	if (legs.length < 2) {
		warnings.push(NEEDS_LEGS)
	}
	warnings.push(...duplicateWarnings(legs))
	warnings.push(...statusWarnings(legs))
	warnings.push(...liquidityWarnings(legs))
	warnings.push(...eventWarnings(legs))
	warnings.push(...gameWarnings(legs))
	return warnings
}

/**
 * Create a parlay pricer.
 * Markets are loaded five at a time.
 */
export function createParlayService (
	client: KalshiClient,
): ParlayService {
	async function priceParlay (
		legs: ParlayLegInput[],
	): Promise<ParlayPrice> {
		const loaded = await mapPool(
			legs,
			FETCH_CONCURRENCY,
			function (input) {
				return loadLeg(client, input)
			},
		)
		const priced: PricedLeg[] = []
		const missingTickers: string[] = []
		for (const row of loaded) {
			if (row.leg === null) {
				missingTickers.push(row.ticker)
				continue
			}
			priced.push(row.leg)
		}
		const combined = missingTickers.length === 0
			? combineProbabilities(probabilities(priced))
			: null
		return {
			legs: priced,
			combinedProbability: combined === null
				? null
				: roundTo(combined, 6),
			...oddsFromProbability(combined),
			warnings: warningsFor(
				legs,
				priced,
				missingTickers,
			),
		}
	}

	return {
		priceParlay,
	}
}

function oddsFromProbability (
	combined: number | null,
): OddsFields {
	const decimal = combined === null
		? null
		: decimalOddsFromProbability(combined)
	const decimalOdds = decimal === null
		? null
		: roundTo(decimal, 4)
	const americanOdds = decimal === null
		? null
		: americanOddsFromDecimal(decimal)
	const profitPerDollar = decimal === null
		? null
		: roundTo(decimal - 1, 4)
	return {
		decimalOdds,
		americanOdds,
		payoutPerDollar: decimalOdds,
		profitPerDollar,
	}
}

function probabilities (
	legs: readonly PricedLeg[],
): Array<number | null> {
	return legs.map(function (leg) {
		return leg.impliedProbability
	})
}

function warningsFor (
	inputs: readonly ParlayLegInput[],
	priced: PricedLeg[],
	missingTickers: readonly string[],
): string[] {
	const warnings = detectWarnings(priced).filter(
		function (warning) {
			return !(
				inputs.length >= 2
				&& warning === NEEDS_LEGS
			)
		},
	)
	for (const ticker of missingTickers) {
		warnings.push(`Leg ${ticker} was not found`)
	}
	const unbuyable = priced.filter(function (leg) {
		return !isBuyable(leg)
	})
	if (unbuyable.length > 0) {
		warnings.push(
			'Parlay not priced: no buyable ask for '
			+ unbuyable.map(function (leg) {
				return `${leg.ticker} ${leg.side}`
			}).join(', '),
		)
	}
	return warnings
}

async function loadLeg (
	client: KalshiClient,
	input: ParlayLegInput,
): Promise<LoadedLeg> {
	try {
		const market = await client.getMarket(input.ticker)
		return {
			ticker: input.ticker,
			leg: priceLeg(input, market),
		}
	} catch (err) {
		if (isMissingMarket(err)) {
			return {
				ticker: input.ticker,
				leg: null,
			}
		}
		throw err
	}
}

function isMissingMarket (err: unknown): boolean {
	return err instanceof KalshiHttpError
		&& err.status === 404
}

function priceLeg (
	input: ParlayLegInput,
	market: Market,
): PricedLeg {
	const quote = quoteFromMarket(market)
	const ask = sideAsk(quote, input.side)
	const eventTicker = market.event_ticker
	const title = market.yes_sub_title.length > 0
		? market.yes_sub_title
		: market.ticker
	return {
		ticker: input.ticker,
		side: input.side,
		eventTicker,
		seriesTicker: seriesTickerFromEventTicker(eventTicker),
		title,
		status: market.status,
		ask,
		impliedProbability: ask,
		quote,
	}
}

function duplicateWarnings (
	legs: readonly PricedLeg[],
): string[] {
	const counts = new Map<string, number>()
	for (const leg of legs) {
		const count = counts.get(leg.ticker) ?? 0
		counts.set(leg.ticker, count + 1)
	}
	const warnings: string[] = []
	for (const [ticker, count] of counts) {
		if (count < 2) {
			continue
		}
		warnings.push(`Duplicate ticker ${ticker}`)
	}
	return warnings
}

function statusWarnings (
	legs: readonly PricedLeg[],
): string[] {
	const warnings: string[] = []
	for (const leg of legs) {
		if (isTradableStatus(leg.status)) {
			continue
		}
		warnings.push(`Leg ${leg.ticker} is ${leg.status}`)
	}
	return warnings
}

function liquidityWarnings (
	legs: readonly PricedLeg[],
): string[] {
	const warnings: string[] = []
	for (const leg of legs) {
		if (isBuyable(leg)) {
			continue
		}
		warnings.push(
			`Leg ${leg.ticker} has no liquidity on ${leg.side}`,
		)
	}
	return warnings
}

function eventWarnings (
	legs: readonly PricedLeg[],
): string[] {
	const counts = new Map<string, number>()
	for (const leg of legs) {
		if (leg.eventTicker.length === 0) {
			continue
		}
		const count = counts.get(leg.eventTicker) ?? 0
		counts.set(leg.eventTicker, count + 1)
	}
	const warnings: string[] = []
	for (const [eventTicker, count] of counts) {
		if (count < 2) {
			continue
		}
		warnings.push(
			`Correlated legs share event ${eventTicker}`,
		)
	}
	return warnings
}

function gameWarnings (
	legs: readonly PricedLeg[],
): string[] {
	const counts = new Map<string, number>()
	for (const leg of legs) {
		const key = gameKeyFromEventTicker(leg.eventTicker)
		if (key === null) {
			continue
		}
		const count = counts.get(key) ?? 0
		counts.set(key, count + 1)
	}
	const warnings: string[] = []
	for (const [gameKey, count] of counts) {
		if (count < 2) {
			continue
		}
		warnings.push(
			`Correlated legs share game ${gameKey}`,
		)
	}
	return warnings
}

/**
 * Date and teams token after the series prefix.
 * `KXNFLGAME-26NOV12WASNYG` and
 * `KXNFLSPREAD-26NOV12WASNYG` both yield `26NOV12WASNYG`.
 * A trailing suffix such as `-10` or `-NYG` is ignored.
 */
function gameKeyFromEventTicker (
	eventTicker: string,
): string | null {
	const key = eventTicker.split('-')[1]
	if (key === undefined || key.length === 0) {
		return null
	}
	return key
}

function isBuyable (leg: PricedLeg): boolean {
	return leg.ask !== null && leg.ask > 0 && leg.ask < 1
}

function isTradableStatus (status: string): boolean {
	return status === 'active' || status === 'open'
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 * Results stay in input order.
 */
async function mapPool<T, R> (
	items: readonly T[],
	limit: number,
	worker: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length)
	if (items.length === 0) {
		return results
	}
	let next = 0
	const workers = Math.max(
		1,
		Math.min(limit, items.length),
	)

	async function run (): Promise<void> {
		while (next < items.length) {
			const index = next
			next += 1
			const item = items[index]
			if (item === undefined) {
				continue
			}
			results[index] = await worker(item)
		}
	}

	const tasks: Promise<void>[] = []
	for (let slot = 0; slot < workers; slot += 1) {
		tasks.push(run())
	}
	await Promise.all(tasks)
	return results
}
