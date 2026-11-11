import { describe, expect, it } from 'vitest'
import {
	LEAGUES,
	isLeagueSeries,
	leagueFromSeriesTicker,
	parseLeagueId,
} from './leagues.js'
import type { LeagueConfig } from './leagues.js'

describe('leagues', function () {
	it('parses nba and nfl', function () {
		expect(parseLeagueId('nfl')).toBe('nfl')
		expect(parseLeagueId(' NBA ')).toBe('nba')
		expect(function () {
			parseLeagueId('mlb')
		}).toThrow(/Unknown league/)
	})

	it('maps series tickers and skips WNBA', function () {
		expect(leagueFromSeriesTicker('KXNBAGAME')).toBe('nba')
		expect(leagueFromSeriesTicker('KXNBATEAMTOTAL')).toBe('nba')
		expect(leagueFromSeriesTicker('KXNFLSPREAD')).toBe('nfl')
		expect(leagueFromSeriesTicker('KXWNBAGAME')).toBeUndefined()
		expect(isLeagueSeries(LEAGUES.nba, 'KXNBAGAME')).toBe(true)
		expect(isLeagueSeries(LEAGUES.nba, 'KXWNBAGAME')).toBe(false)
		expect(LEAGUES.nba.excludePrefixes).toEqual(['KXWNBA'])
	})

	it('applies exclude prefixes before a wide prefix', function () {
		const wide: LeagueConfig = {
			...LEAGUES.nba,
			tickerPrefix: 'KX',
			excludePrefixes: ['KXWNBA'],
		}
		expect(isLeagueSeries(wide, 'KXWNBAGAME')).toBe(false)
		expect(isLeagueSeries(wide, 'KXNBAGAME')).toBe(true)
	})
})
