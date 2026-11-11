import { describe, expect, it } from 'vitest'
import type { Market } from '../kalshi/types.js'
import {
	parseDollars,
	quoteFromMarket,
	sideAsk,
} from './prices.js'

function market (overrides: Partial<Market> = {}): Market {
	return {
		ticker: 'MKT',
		event_ticker: 'KXNFLGAME-26NOV12WASNYG',
		market_type: 'binary',
		yes_sub_title: 'New York G',
		status: 'active',
		yes_bid_dollars: '0.5600',
		yes_ask_dollars: '0.5800',
		no_bid_dollars: '0.4200',
		no_ask_dollars: '0.4400',
		yes_bid_size_fp: '100.00',
		yes_ask_size_fp: '12.50',
		...overrides,
	}
}

describe('parseDollars', function () {
	it('parses fixed-point dollar strings', function () {
		expect(parseDollars('0.5600')).toBe(0.56)
		expect(parseDollars(' 0.5600 ')).toBe(0.56)
		expect(parseDollars('0')).toBe(0)
	})

	it('rejects blank and non-numeric values', function () {
		expect(parseDollars(null)).toBeNull()
		expect(parseDollars(undefined)).toBeNull()
		expect(parseDollars('')).toBeNull()
		expect(parseDollars('   ')).toBeNull()
		expect(parseDollars('nope')).toBeNull()
		expect(parseDollars('Infinity')).toBeNull()
	})
})

describe('quoteFromMarket', function () {
	it('normalizes bids, asks, sizes, and the mid', function () {
		const quote = quoteFromMarket(market())
		expect(quote.yesBid).toBe(0.56)
		expect(quote.yesAsk).toBe(0.58)
		expect(quote.noBid).toBe(0.42)
		expect(quote.noAsk).toBe(0.44)
		expect(quote.impliedYes).toBe(0.58)
		expect(quote.impliedNo).toBe(0.44)
		expect(quote.mid).toBeCloseTo(0.57)
		expect(quote.spread).toBeCloseTo(0.02)
		expect(quote.yesBidSize).toBe(100)
		expect(quote.yesAskSize).toBe(12.5)
		expect(sideAsk(quote, 'yes')).toBe(0.58)
		expect(sideAsk(quote, 'no')).toBe(0.44)
	})

	it('rounds mid and spread to 4 decimals', function () {
		const quote = quoteFromMarket(market({
			yes_bid_dollars: '0.4900',
			yes_ask_dollars: '0.5000',
			yes_bid_size_fp: '5',
			yes_ask_size_fp: '5',
		}))
		expect(quote.spread).toBe(0.01)
		expect(quote.mid).toBe(0.495)
	})

	it('rounds the 1 - yesBid fallback to 4 decimals', function () {
		const quote = quoteFromMarket(market({
			yes_bid_dollars: '0.5700',
			yes_ask_dollars: '0.6000',
			no_bid_dollars: '',
			no_ask_dollars: '',
		}))
		expect(quote.noAsk).toBe(0.43)
		expect(quote.impliedNo).toBe(0.43)
	})

	it('falls back impliedNo to 1 - yesBid', function () {
		const quote = quoteFromMarket(market({
			yes_bid_dollars: '0.4000',
			yes_ask_dollars: '0.4500',
			no_bid_dollars: '',
			no_ask_dollars: '',
			yes_bid_size_fp: undefined,
			yes_ask_size_fp: '',
		}))
		expect(quote.noAsk).toBeCloseTo(0.6)
		expect(quote.impliedNo).toBeCloseTo(0.6)
		expect(quote.noBid).toBeNull()
		expect(quote.impliedYes).toBe(0.45)
		expect(quote.mid).toBeCloseTo(0.425)
		expect(quote.spread).toBeCloseTo(0.05)
		expect(quote.yesBidSize).toBeNull()
		expect(quote.yesAskSize).toBeNull()
		expect(sideAsk(quote, 'no')).toBeCloseTo(0.6)
		expect(sideAsk(quote, 'yes')).toBe(0.45)
	})

	it('mirrors YES sizes onto the NO side', function () {
		const quote = quoteFromMarket(market())
		expect(quote.noAskSize).toBe(100)
		expect(quote.noBidSize).toBe(12.5)
	})

	it('nulls the NO ask when nothing bids YES', function () {
		const quote = quoteFromMarket(market({
			ticker: 'KXNBA3QTOTAL-26NOV11ORLUTA-66',
			event_ticker: 'KXNBA3QTOTAL-26NOV11ORLUTA',
			yes_bid_dollars: '0.0000',
			yes_ask_dollars: '0.0200',
			no_bid_dollars: '0.9800',
			no_ask_dollars: '1.0000',
			yes_bid_size_fp: '0.00',
			yes_ask_size_fp: '40.00',
		}))
		expect(quote.yesBid).toBeNull()
		expect(quote.noAsk).toBeNull()
		expect(quote.impliedNo).toBeNull()
		expect(quote.noAskSize).toBe(0)
		expect(quote.yesAsk).toBe(0.02)
		expect(quote.noBid).toBe(0.98)
		expect(quote.mid).toBeNull()
		expect(quote.spread).toBeNull()
		expect(sideAsk(quote, 'no')).toBeNull()
		expect(sideAsk(quote, 'yes')).toBe(0.02)
	})

	it('nulls the YES ask when nothing bids NO', function () {
		const quote = quoteFromMarket(market({
			ticker: 'KXNBAASTPROT-26NOV11BOSTOR-TORIQUICKLEY5-2',
			event_ticker: 'KXNBAASTPROT-26NOV11BOSTOR',
			yes_bid_dollars: '0.9500',
			yes_ask_dollars: '1.0000',
			no_bid_dollars: '0.0000',
			no_ask_dollars: '0.0500',
			yes_bid_size_fp: '30.00',
			yes_ask_size_fp: '0.00',
		}))
		expect(quote.yesAsk).toBeNull()
		expect(quote.impliedYes).toBeNull()
		expect(quote.noBid).toBeNull()
		expect(quote.noBidSize).toBe(0)
		expect(quote.yesBid).toBe(0.95)
		expect(quote.noAsk).toBe(0.05)
		expect(quote.mid).toBeNull()
		expect(quote.spread).toBeNull()
		expect(sideAsk(quote, 'yes')).toBeNull()
		expect(sideAsk(quote, 'no')).toBe(0.05)
	})

	it('nulls every price on a finalized market', function () {
		const quote = quoteFromMarket(market({
			status: 'finalized',
			yes_bid_dollars: '0.0000',
			yes_ask_dollars: '1.0000',
			no_bid_dollars: '0.0000',
			no_ask_dollars: '1.0000',
			yes_bid_size_fp: '0.00',
			yes_ask_size_fp: '0.00',
		}))
		expect(quote.yesBid).toBeNull()
		expect(quote.yesAsk).toBeNull()
		expect(quote.noBid).toBeNull()
		expect(quote.noAsk).toBeNull()
		expect(quote.impliedYes).toBeNull()
		expect(quote.impliedNo).toBeNull()
		expect(quote.mid).toBeNull()
		expect(quote.spread).toBeNull()
	})

	it('nulls an ask with zero size even at a real price', function () {
		const quote = quoteFromMarket(market({
			yes_ask_size_fp: '0.00',
		}))
		expect(quote.yesAsk).toBeNull()
		expect(quote.noBid).toBeNull()
		expect(quote.noAsk).toBe(0.44)
	})
})
