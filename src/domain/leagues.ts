/** Supported sports leagues. */
export type LeagueId = 'nba' | 'nfl'

/** Kalshi series names and milestone type for one league. */
export interface LeagueConfig {
	id: LeagueId
	name: string
	/** Shared prefix, such as `KXNBA` or `KXNFL`. */
	tickerPrefix: string
	gameSeries: string
	spreadSeries: string
	totalSeries: string
	teamTotalSeries: string
	/**
	 * Series that start with `tickerPrefix` but belong to
	 * another league. NBA excludes `KXWNBA`.
	 */
	excludePrefixes: string[]
	/** Kalshi milestone `type`, such as `football_game`. */
	milestoneType: string
}

const LEAGUE_IDS: readonly LeagueId[] = ['nba', 'nfl']

/** NFL and NBA ticker layout used by game discovery. */
export const LEAGUES: Record<LeagueId, LeagueConfig> = {
	nba: {
		id: 'nba',
		name: 'NBA',
		tickerPrefix: 'KXNBA',
		gameSeries: 'KXNBAGAME',
		spreadSeries: 'KXNBASPREAD',
		totalSeries: 'KXNBATOTAL',
		teamTotalSeries: 'KXNBATEAMTOTAL',
		excludePrefixes: ['KXWNBA'],
		milestoneType: 'basketball_game',
	},
	nfl: {
		id: 'nfl',
		name: 'NFL',
		tickerPrefix: 'KXNFL',
		gameSeries: 'KXNFLGAME',
		spreadSeries: 'KXNFLSPREAD',
		totalSeries: 'KXNFLTOTAL',
		teamTotalSeries: 'KXNFLTEAMTOTAL',
		excludePrefixes: [],
		milestoneType: 'football_game',
	},
}

/**
 * Parse `nba` or `nfl`.
 * Matching is case-insensitive. Any other value throws.
 */
export function parseLeagueId (value: string): LeagueId {
	const normalized = value.trim().toLowerCase()
	for (const id of LEAGUE_IDS) {
		if (id === normalized) {
			return id
		}
	}
	throw new Error(`Unknown league "${value}"`)
}

/**
 * League whose prefix matches a series ticker.
 * A longer matching prefix wins. Excluded prefixes do not match.
 */
export function leagueFromSeriesTicker (
	ticker: string,
): LeagueId | undefined {
	let found: LeagueConfig | undefined
	for (const id of LEAGUE_IDS) {
		const league = LEAGUES[id]
		if (!isLeagueSeries(league, ticker)) {
			continue
		}
		if (
			!found
			|| league.tickerPrefix.length > found.tickerPrefix.length
		) {
			found = league
		}
	}
	return found?.id
}

/**
 * True when `seriesTicker` belongs to `league`.
 * It must start with `tickerPrefix` and must not start with
 * any `excludePrefixes` entry.
 */
export function isLeagueSeries (
	league: LeagueConfig,
	seriesTicker: string,
): boolean {
	if (!seriesTicker.startsWith(league.tickerPrefix)) {
		return false
	}
	for (const prefix of league.excludePrefixes) {
		if (prefix.length > 0 && seriesTicker.startsWith(prefix)) {
			return false
		}
	}
	return true
}
