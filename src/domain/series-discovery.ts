import type { KalshiClient } from '../kalshi/kalshi-client.js'
import type { Series } from '../kalshi/types.js'
import {
	isLeagueSeries,
	type LeagueConfig,
} from './leagues.js'

/**
 * List Sports series that belong to one league.
 * WNBA series are excluded from the NBA config.
 * A cached Kalshi client may already cache this read.
 */
export async function discoverLeagueSeries (
	client: KalshiClient,
	league: LeagueConfig,
): Promise<Series[]> {
	const series = await client.getSeriesList({
		category: 'Sports',
	})
	return series.filter(function (row) {
		return isLeagueSeries(league, row.ticker)
	})
}
