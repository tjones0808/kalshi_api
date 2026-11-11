import type { Market } from '../kalshi/types.js'

/** Bucket a sports market falls into. */
export type MarketCategory =
	| 'moneyline'
	| 'spread'
	| 'total'
	| 'team_total'
	| 'period'
	| 'prop'
	| 'other'

/** Longer prefixes first so `KXWNBA` is not read as `KXNBA`. */
const STRIP_PREFIXES = ['KXWNBA', 'KXNFL', 'KXNBA']

/**
 * Period codes are a whole body, or that code plus a line
 * type (`1HTOTAL`, `OTSPREAD`). `OT` must not match `SHOT`.
 */
const PERIOD_TOKENS = ['1H', '2H', '1Q', '2Q', '3Q', '4Q', 'OT']

const PERIOD_TAILS = [
	'',
	'TOTAL',
	'SPREAD',
	'GAME',
	'TEAMTOTAL',
	'FT',
]

/**
 * Short prop tokens. They match only the whole body, after an
 * optional `GAME` prefix and `PROT` suffix, because as
 * substrings they would hit `TOTAL` (`TO`) or `PRA` (`PR`).
 */
const SHORT_PROP_TOKENS = ['FG', 'TO', 'PA', 'PR', 'RA']

/**
 * Tokens that are props only as a whole body, optionally
 * followed by `PROT`. As a prefix or suffix they would hit
 * `EAST`, `RECORD`, and `INTL`.
 */
const WHOLE_PROP_TOKENS = ['AST', 'REC', 'INT']

/** Box-score stats stacked into one series (`PTSREBAST`). */
const COMBO_PROP = /^(?:PTS|REB|AST|STL|BLK)+(?:PROT)?$/

/**
 * Prop bodies, longest first. A body matches when it starts
 * or ends with a token (`PTSPROT`, `PASSYDS`). `REC` does
 * not hit `RACE`.
 */
const PROP_SUFFIXES = [
	'FIRSTBASKET',
	'ESCALATOR',
	'LONGRSH',
	'FIRSTTD',
	'RSHATT',
	'PASSYDS',
	'RSHYDS',
	'RECYDS',
	'FFPTS',
	'ANYTD',
	'PROPS',
	'STOCK',
	'3PT',
	'FTM',
	'PRA',
	'PTS',
	'REB',
	'STL',
	'BLK',
	'TOV',
	'YDS',
	'TKL',
	'SACK',
	'RUSH',
	'PASS',
	'PROP',
	'TD',
	'2D',
	'3D',
]

/**
 * Series ticker is the event ticker before the first hyphen.
 * `KXNFLGAME-26NOV12WASNYG` is `KXNFLGAME`.
 */
export function seriesTickerFromEventTicker (
	eventTicker: string,
): string {
	const hyphen = eventTicker.indexOf('-')
	if (hyphen === -1) {
		return eventTicker
	}
	return eventTicker.slice(0, hyphen)
}

/**
 * Classify a series ticker.
 * `KXNFL1HTOTAL` is `period`, not `total`.
 * `KXNFLTEAMTOTAL` is `team_total`, not `total`.
 * Moneyline is an exact `GAME` body (`KXNFLGAME`), not a
 * longer series that merely contains `GAME`.
 * Prop tokens match the start or end of the body after
 * `KXNBA` / `KXNFL`, not a substring in the middle. Short
 * tokens such as `FG` and `TO` match the whole body only,
 * as do `AST`, `REC`, and `INT` (`KXNBAEAST` is `other`).
 * `KXNFLTOTALPRECISE` is `total`.
 */
export function classifySeriesTicker (
	seriesTicker: string,
): MarketCategory {
	const body = seriesBody(seriesTicker)
	if (hasPeriodToken(body)) {
		return 'period'
	}
	if (body.endsWith('TEAMTOTAL')) {
		return 'team_total'
	}
	if (body.endsWith('TOTAL') || body.startsWith('TOTAL')) {
		return 'total'
	}
	if (body.endsWith('SPREAD')) {
		return 'spread'
	}
	if (body === 'GAME') {
		return 'moneyline'
	}
	if (isPropBody(body)) {
		return 'prop'
	}
	return 'other'
}

/**
 * Classify one market.
 * Pass the event `series_ticker` when it is known. Otherwise
 * the series is taken from `market.event_ticker`.
 */
export function classifyMarket (
	market: Market,
	seriesTicker?: string,
): MarketCategory {
	const series = seriesTicker
		?? seriesTickerFromEventTicker(market.event_ticker)
	return classifySeriesTicker(series)
}

function hasPeriodToken (body: string): boolean {
	for (const token of PERIOD_TOKENS) {
		for (const tail of PERIOD_TAILS) {
			if (body === `${token}${tail}`) {
				return true
			}
		}
	}
	return false
}

function isPropBody (body: string): boolean {
	if (body.length === 0) {
		return false
	}
	if (SHORT_PROP_TOKENS.includes(shortPropBody(body))) {
		return true
	}
	if (WHOLE_PROP_TOKENS.includes(withoutProt(body))) {
		return true
	}
	if (COMBO_PROP.test(body)) {
		return true
	}
	for (const suffix of PROP_SUFFIXES) {
		if (
			body === suffix
			|| body.startsWith(suffix)
			|| body.endsWith(suffix)
		) {
			return true
		}
	}
	return false
}

function withoutProt (body: string): string {
	return body.endsWith('PROT')
		? body.slice(0, -'PROT'.length)
		: body
}

function shortPropBody (body: string): string {
	const core = body.startsWith('GAME')
		? body.slice('GAME'.length)
		: body
	return withoutProt(core)
}

function seriesBody (seriesTicker: string): string {
	const upper = seriesTicker.toUpperCase()
	for (const prefix of STRIP_PREFIXES) {
		if (upper.startsWith(prefix)) {
			return upper.slice(prefix.length)
		}
	}
	return upper
}
