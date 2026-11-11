import { describe, expect, it } from 'vitest'
import type { KalshiClient } from '../kalshi/kalshi-client.js'
import type { Series } from '../kalshi/types.js'
import { LEAGUES } from './leagues.js'
import { discoverLeagueSeries } from './series-discovery.js'

function series (ticker: string): Series {
	return {
		ticker,
		title: ticker,
		frequency: 'custom',
		category: 'Sports',
	}
}

describe('discoverLeagueSeries', function () {
	it('keeps NBA series and drops WNBA and NFL', async function () {
		let params: unknown
		const client = {
			getSeriesList: async function (query: unknown) {
				params = query
				return [
					series('KXNBAGAME'),
					series('KXWNBAGAME'),
					series('KXNBASPREAD'),
					series('KXNFLGAME'),
				]
			},
		} as KalshiClient
		const rows = await discoverLeagueSeries(client, LEAGUES.nba)
		expect(rows.map(function (row) {
			return row.ticker
		})).toEqual(['KXNBAGAME', 'KXNBASPREAD'])
		expect(params).toEqual({ category: 'Sports' })
	})
})
