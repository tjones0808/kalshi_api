import { describe, expect, it } from 'vitest'
import type { Market } from '../kalshi/types.js'
import {
	classifyMarket,
	classifySeriesTicker,
	seriesTickerFromEventTicker,
} from './market-classify.js'
import type { MarketCategory } from './market-classify.js'
import {
	LEAGUES,
	isLeagueSeries,
	leagueFromSeriesTicker,
} from './leagues.js'

function market (eventTicker: string): Market {
	return {
		ticker: `${eventTicker}-M`,
		event_ticker: eventTicker,
		market_type: 'binary',
		yes_sub_title: 'Line',
		status: 'active',
		yes_bid_dollars: '0.4000',
		yes_ask_dollars: '0.4300',
		no_bid_dollars: '0.5700',
		no_ask_dollars: '0.6000',
	}
}

describe('series classification', function () {
	it('reads the series from the event ticker', function () {
		expect(seriesTickerFromEventTicker(
			'KXNFLGAME-26NOV12WASNYG',
		)).toBe('KXNFLGAME')
		expect(seriesTickerFromEventTicker('KXNFLGAME')).toBe(
			'KXNFLGAME',
		)
	})

	it('classifies game, spread, total, and props', function () {
		expect(classifySeriesTicker(seriesTickerFromEventTicker(
			'KXNFLGAME-26NOV12WASNYG',
		))).toBe('moneyline')
		expect(classifySeriesTicker(seriesTickerFromEventTicker(
			'KXNFLSPREAD-26NOV12WASNYG',
		))).toBe('spread')
		expect(classifySeriesTicker(seriesTickerFromEventTicker(
			'KXNFLTOTAL-26NOV12WASNYG',
		))).toBe('total')
		expect(classifySeriesTicker(seriesTickerFromEventTicker(
			'KXNFLTEAMTOTAL-26NOV12WASNYG',
		))).toBe('team_total')
		expect(classifySeriesTicker(seriesTickerFromEventTicker(
			'KXNFL1HTOTAL-26NOV12WASNYG',
		))).toBe('period')
		expect(classifySeriesTicker(seriesTickerFromEventTicker(
			'KXNFL1HSPREAD-26NOV12WASNYG',
		))).toBe('period')
		expect(classifySeriesTicker(seriesTickerFromEventTicker(
			'KXNBA1Q-26NOV12BOSNYK',
		))).toBe('period')
		expect(classifySeriesTicker(seriesTickerFromEventTicker(
			'KXNFLPASSYDS-26NOV12WASNYG',
		))).toBe('prop')
		expect(classifySeriesTicker(seriesTickerFromEventTicker(
			'KXNBA3PT-26NOV12BOSNYK',
		))).toBe('prop')
		expect(classifySeriesTicker(seriesTickerFromEventTicker(
			'KXNBAPRA-26NOV12BOSNYK',
		))).toBe('prop')
		expect(classifySeriesTicker(seriesTickerFromEventTicker(
			'KXNFLGAMEPROPS-26NOV12WASNYG',
		))).toBe('prop')
		expect(classifySeriesTicker(seriesTickerFromEventTicker(
			'KXNFLFIRSTTD-26NOV12WASNYG',
		))).toBe('prop')
		expect(classifySeriesTicker(seriesTickerFromEventTicker(
			'KXNBA2D-26NOV12BOSNYK',
		))).toBe('prop')
		expect(classifySeriesTicker(seriesTickerFromEventTicker(
			'KXNBA3D-26NOV12BOSNYK',
		))).toBe('prop')
		expect(classifySeriesTicker(seriesTickerFromEventTicker(
			'KXNBASTOCK-26NOV12BOSNYK',
		))).toBe('prop')
		expect(classifySeriesTicker(seriesTickerFromEventTicker(
			'KXNBAPTSPROT-26NOV12BOSNYK',
		))).toBe('prop')
		expect(classifySeriesTicker(seriesTickerFromEventTicker(
			'KXNBAPTSLEADER-26NOV12BOSNYK',
		))).toBe('prop')
		expect(classifySeriesTicker(seriesTickerFromEventTicker(
			'KXNBA3PTPROT-26NOV12BOSNYK',
		))).toBe('prop')
		expect(classifySeriesTicker(seriesTickerFromEventTicker(
			'KXNBAOT-26NOV12BOSNYK',
		))).toBe('period')
		expect(classifySeriesTicker(seriesTickerFromEventTicker(
			'KXNBAOTSPREAD-26NOV12BOSNYK',
		))).toBe('period')
		expect(classifySeriesTicker(seriesTickerFromEventTicker(
			'KXNFLRACE-26NOV12WASNYG',
		))).toBe('other')
		expect(classifySeriesTicker(seriesTickerFromEventTicker(
			'KXNBASHOT-26NOV12BOSNYK',
		))).toBe('other')
		expect(classifySeriesTicker(seriesTickerFromEventTicker(
			'KXNFLCUSTOM-26NOV12WASNYG',
		))).toBe('other')
	})

	const TABLE: Array<[string, MarketCategory]> = [
		['KXNFLGAME', 'moneyline'],
		['KXNBAGAME', 'moneyline'],
		['KXNFLSPREAD', 'spread'],
		['KXNFLTOTAL', 'total'],
		['KXNBATOTAL', 'total'],
		['KXNFLTOTALPRECISE', 'total'],
		['KXNFLTEAMTOTAL', 'team_total'],
		['KXNFL1H', 'period'],
		['KXNBA1Q', 'period'],
		['KXNBAOT', 'period'],
		['KXNFL1HSPREAD', 'period'],
		['KXNBA2QTOTAL', 'period'],
		['KXNFL1HFT', 'period'],
		['KXNBAPTS', 'prop'],
		['KXNBA3PT', 'prop'],
		['KXNBAREB', 'prop'],
		['KXNBAAST', 'prop'],
		['KXNBAPRA', 'prop'],
		['KXNBAPTSPROT', 'prop'],
		['KXNBAASTPROT', 'prop'],
		['KXNBA2D', 'prop'],
		['KXNBA3D', 'prop'],
		['KXNBASTL', 'prop'],
		['KXNBABLK', 'prop'],
		['KXNBASTOCK', 'prop'],
		['KXNBAESCALATOR', 'prop'],
		['KXNBAPTSLEADER', 'prop'],
		['KXNBAFIRSTBASKET', 'prop'],
		['KXNBAFTM', 'prop'],
		['KXNFLPASSYDS', 'prop'],
		['KXNFLRECYDS', 'prop'],
		['KXNFLRSHYDS', 'prop'],
		['KXNFLLONGRSH', 'prop'],
		['KXNFLRSHATT', 'prop'],
		['KXNFLFFPTS', 'prop'],
		['KXNFLFFPTSLADDER', 'prop'],
		['KXNFLFG', 'prop'],
		['KXNFLGAMEFG', 'prop'],
		['KXNFLPA', 'prop'],
		['KXNFLPR', 'prop'],
		['KXNFLRA', 'prop'],
		['KXNFLTKL', 'prop'],
		['KXNFLTO', 'prop'],
		['KXNFLGAMETO', 'prop'],
		['KXNFLTD', 'prop'],
		['KXNFLFIRSTTD', 'prop'],
		['KXNFLPASSTDS', 'prop'],
		['KXNFLTEAMFIRSTTD', 'prop'],
		['KXNFLTEAMYDS', 'prop'],
		['KXNFLTEAMSACK', 'prop'],
		['KXNFLDSTTD', 'prop'],
		['KXNBAEAST', 'other'],
		['KXNFLRECORD', 'other'],
		['KXNBAINTL', 'other'],
		['KXNFLREC', 'prop'],
		['KXNFLINT', 'prop'],
		['KXNBAPTSREBAST', 'prop'],
		['KXNBARACE', 'other'],
		['KXNFLWINMARGIN', 'other'],
		['KXNFLTIE', 'other'],
		['KXNFLDELAY', 'other'],
		['KXNFLSFTY', 'other'],
	]

	it.each(TABLE)('classifies %s as %s', function (series, expected) {
		expect(classifySeriesTicker(series)).toBe(expected)
	})

	it('does not match short tokens inside longer series', function () {
		expect(classifySeriesTicker('KXNFLTOTAL')).toBe('total')
		expect(classifySeriesTicker('KXNBAPRA')).toBe('prop')
		expect(classifySeriesTicker('KXNFLTOTALPRECISE')).toBe('total')
		expect(classifySeriesTicker('KXNFLPAT')).toBe('other')
		expect(classifySeriesTicker('KXNFLTOP')).toBe('other')
	})

	it('keeps WNBA series out of the NBA league', function () {
		const nba = LEAGUES.nba
		expect(isLeagueSeries(nba, 'KXWNBAGAME')).toBe(false)
		expect(isLeagueSeries(nba, 'KXNBAGAME')).toBe(true)
		expect(leagueFromSeriesTicker('KXWNBAGAME')).toBeUndefined()
	})

	it('prefers an explicit series over the market ticker', function () {
		const row = market('KXNFLGAME-26NOV12WASNYG')
		expect(classifyMarket(row)).toBe('moneyline')
		expect(classifyMarket(row, 'KXNFLTOTAL')).toBe('total')
	})
})
