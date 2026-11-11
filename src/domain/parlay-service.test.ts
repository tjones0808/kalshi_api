import { describe, expect, it } from 'vitest'
import { KalshiHttpError } from '../kalshi/errors.js'
import type { KalshiClient } from '../kalshi/kalshi-client.js'
import type { Market } from '../kalshi/types.js'
import { seriesTickerFromEventTicker } from './market-classify.js'
import {
	americanOddsFromDecimal,
	combineProbabilities,
	createParlayService,
	decimalOddsFromProbability,
	detectWarnings,
} from './parlay-service.js'
import type {
	ParlayLegInput,
	PricedLeg,
} from './parlay-service.js'
import type { NormalizedQuote } from './prices.js'

const WAS = 'KXNFLGAME-26NOV12WASNYG'
const WAS_SPREAD = 'KXNFLSPREAD-26NOV12WASNYG'
const DET = 'KXNFLGAME-26NOV15NEDET'
const DET_TOTAL = 'KXNFLTOTAL-26NOV15NEDET'
const NYG = `${WAS}-NYG`
const WAS_SIDE = `${WAS}-WAS`
const DET_SIDE = `${DET}-DET`
const WAS_SPREAD_SIDE = `${WAS_SPREAD}-NYG3`

function quote (yesAsk: number | null): NormalizedQuote {
	return {
		yesBid: null,
		yesAsk,
		noBid: null,
		noAsk: null,
		impliedYes: yesAsk,
		impliedNo: null,
		mid: null,
		spread: null,
		yesBidSize: null,
		yesAskSize: null,
		noAskSize: null,
		noBidSize: null,
	}
}

function stub (
	ticker: string,
	eventTicker: string,
): PricedLeg {
	const ask = 0.4
	return {
		ticker,
		side: 'yes',
		eventTicker,
		seriesTicker: seriesTickerFromEventTicker(eventTicker),
		title: ticker,
		status: 'active',
		ask,
		impliedProbability: ask,
		quote: quote(ask),
	}
}

function market (
	ticker: string,
	eventTicker: string,
	overrides: Partial<Market> = {},
): Market {
	return {
		ticker,
		event_ticker: eventTicker,
		market_type: 'binary',
		yes_sub_title: 'Team',
		status: 'active',
		yes_bid_dollars: '0.3000',
		yes_ask_dollars: '0.4000',
		no_bid_dollars: '0.6000',
		no_ask_dollars: '0.7000',
		...overrides,
	}
}

function clientFor (
	markets: Record<string, Market>,
): KalshiClient {
	return {
		getMarket: async function (ticker: string) {
			const found = markets[ticker]
			if (!found) {
				throw new KalshiHttpError(
					404,
					`/markets/${ticker}`,
					'not found',
				)
			}
			return found
		},
	} as unknown as KalshiClient
}

function legsOf (
	tickers: readonly string[],
	side: 'yes' | 'no' = 'yes',
): ParlayLegInput[] {
	return tickers.map(function (ticker): ParlayLegInput {
		return { ticker, side }
	})
}

describe('decimalOddsFromProbability', function () {
	it('inverts probabilities in (0, 1]', function () {
		expect(decimalOddsFromProbability(0.2)).toBe(5)
		expect(decimalOddsFromProbability(1)).toBe(1)
	})

	it('rejects 0 and values above 1', function () {
		expect(decimalOddsFromProbability(0)).toBeNull()
		expect(decimalOddsFromProbability(-0.1)).toBeNull()
		expect(decimalOddsFromProbability(1.2)).toBeNull()
		expect(decimalOddsFromProbability(Number.NaN)).toBeNull()
	})
})

describe('americanOddsFromDecimal', function () {
	it(
		'converts p=0.8 to decimal 1.25 and american -400',
		function () {
			expect(decimalOddsFromProbability(0.8)).toBe(1.25)
			expect(americanOddsFromDecimal(1.25)).toBe(-400)
		},
	)

	it('converts an underdog decimal of 5 to 400', function () {
		expect(americanOddsFromDecimal(5)).toBe(400)
	})

	it('returns null when decimal odds are 1 or less', function () {
		expect(americanOddsFromDecimal(1)).toBeNull()
		expect(americanOddsFromDecimal(0.5)).toBeNull()
	})

	it('treats decimal 2 as 100 and 1.5 as -200', function () {
		expect(americanOddsFromDecimal(2)).toBe(100)
		expect(americanOddsFromDecimal(1.5)).toBe(-200)
	})
})

describe('combineProbabilities', function () {
	it('multiplies probabilities in (0, 1)', function () {
		expect(combineProbabilities([0.4, 0.5])).toBe(0.2)
		expect(combineProbabilities([0.4])).toBe(0.4)
	})

	it('returns null when any probability is unusable', function () {
		expect(combineProbabilities([])).toBeNull()
		expect(combineProbabilities([0.4, null])).toBeNull()
		expect(combineProbabilities([0.4, 0])).toBeNull()
		expect(combineProbabilities([0.4, 1])).toBeNull()
		expect(combineProbabilities([0.4, 1.2])).toBeNull()
	})
})

describe('detectWarnings', function () {
	it('warns when fewer than two legs are priced', function () {
		expect(detectWarnings([])).toEqual([
			'Parlay needs at least two legs',
		])
		const only = stub('A', WAS)
		expect(detectWarnings([only])).toEqual([
			'Parlay needs at least two legs',
		])
	})

	it('accepts active and open legs on different games', function () {
		const open = stub('B', DET)
		open.status = 'open'
		expect(detectWarnings([
			stub('A', WAS),
			open,
		])).toEqual([])
	})

	it('warns once for a repeated ticker', function () {
		expect(detectWarnings([
			stub('A', WAS),
			stub('A', WAS),
			stub('A', WAS),
		])).toEqual([
			'Duplicate ticker A',
			`Correlated legs share event ${WAS}`,
			'Correlated legs share game 26NOV12WASNYG',
		])
	})

	it('warns on status before a missing ask', function () {
		const closed = stub('A', WAS)
		closed.status = 'closed'
		closed.ask = null
		closed.impliedProbability = null
		expect(detectWarnings([
			closed,
			stub('B', DET),
		])).toEqual([
			'Leg A is closed',
			'Leg A has no liquidity on yes',
		])
	})

	it('warns when the ask is the 1.0 placeholder', function () {
		const dead = stub('A', WAS)
		dead.ask = 1
		dead.impliedProbability = 1
		expect(detectWarnings([
			dead,
			stub('B', DET),
		])).toEqual([
			'Leg A has no liquidity on yes',
		])
	})

	it('warns when the ask is zero', function () {
		const dead = stub('A', WAS)
		dead.ask = 0
		dead.impliedProbability = 0
		expect(detectWarnings([
			dead,
			stub('B', DET),
		])).toEqual([
			'Leg A has no liquidity on yes',
		])
	})

	it('warns once per shared game key', function () {
		expect(detectWarnings([
			stub('A', WAS),
			stub('B', WAS_SPREAD),
			stub('C', `${WAS.replace('GAME', 'TOTAL')}`),
			stub('D', DET),
			stub('E', DET_TOTAL),
		])).toEqual([
			'Correlated legs share game 26NOV12WASNYG',
			'Correlated legs share game 26NOV15NEDET',
		])
	})

	it('warns when a RACE leg and a GAME leg share a game', function () {
		expect(detectWarnings([
			stub('A', 'KXNBARACE-26NOV11BOSTOR-10'),
			stub('B', 'KXNBAGAME-26NOV11BOSTOR'),
		])).toEqual([
			'Correlated legs share game 26NOV11BOSTOR',
		])
	})

	it('warns when two RACE legs share a game', function () {
		expect(detectWarnings([
			stub('A', 'KXNBARACE-26NOV11BOSTOR-10'),
			stub('B', 'KXNBARACE-26NOV11BOSTOR-20'),
		])).toEqual([
			'Correlated legs share game 26NOV11BOSTOR',
		])
	})

	it('does not link suffixes across different games', function () {
		expect(detectWarnings([
			stub('A', 'KXNFLTEAMFIRSTTD-26NOV12WASNYG-NYG'),
			stub('B', 'KXNFLTEAMFIRSTTD-26NOV15NEDET-NYG'),
		])).toEqual([])
	})

	it(
		'warns for a shared event and a related spread',
		function () {
			expect(detectWarnings([
				stub(NYG, WAS),
				stub(WAS_SIDE, WAS),
				stub(WAS_SPREAD_SIDE, WAS_SPREAD),
			])).toEqual([
				`Correlated legs share event ${WAS}`,
				'Correlated legs share game 26NOV12WASNYG',
			])
		},
	)
})

describe('createParlayService', function () {
	it('rounds probability, odds, and payout', async function () {
		const service = createParlayService(clientFor({
			[NYG]: market(NYG, WAS, { yes_ask_dollars: '0.3300' }),
			[DET_SIDE]: market(DET_SIDE, DET, {
				yes_ask_dollars: '0.3700',
			}),
		}))
		const price = await service.priceParlay([
			{ ticker: NYG, side: 'yes' },
			{ ticker: DET_SIDE, side: 'yes' },
		])
		expect(price.combinedProbability).toBe(0.1221)
		expect(price.decimalOdds).toBe(8.1900)
		expect(price.payoutPerDollar).toBe(price.decimalOdds)
		expect(price.profitPerDollar).toBe(7.19)
		expect(Number.isInteger(price.americanOdds)).toBe(true)
	})

	it(
		'prices two independent yes legs at 0.4 and 0.5',
		async function () {
			const service = createParlayService(clientFor({
				[NYG]: market(NYG, WAS, {
					yes_sub_title: 'New York G',
					yes_ask_dollars: '0.4000',
				}),
				[DET_SIDE]: market(DET_SIDE, DET, {
					yes_sub_title: '',
					yes_ask_dollars: '0.5000',
				}),
			}))
			const price = await service.priceParlay([
				{ ticker: NYG, side: 'yes' },
				{ ticker: DET_SIDE, side: 'yes' },
			])
			expect(price.combinedProbability).toBe(0.2)
			expect(price.decimalOdds).toBe(5)
			expect(price.americanOdds).toBe(400)
			expect(price.payoutPerDollar).toBe(5)
			expect(price.profitPerDollar).toBe(4)
			expect(price.warnings).toEqual([])
			expect(price.legs[0]).toMatchObject({
				ticker: NYG,
				side: 'yes',
				eventTicker: WAS,
				seriesTicker: 'KXNFLGAME',
				title: 'New York G',
				status: 'active',
				ask: 0.4,
				impliedProbability: 0.4,
			})
			expect(price.legs[0]?.quote.yesAsk).toBe(0.4)
			expect(price.legs[1]).toMatchObject({
				ticker: DET_SIDE,
				side: 'yes',
				eventTicker: DET,
				seriesTicker: 'KXNFLGAME',
				title: DET_SIDE,
				ask: 0.5,
				impliedProbability: 0.5,
			})
		},
	)

	it(
		'prices a combined 0.4 at decimal 2.5 and +150',
		async function () {
			const first = 'KXNBAGAME-26NOV20BOSLAL-BOS'
			const second = 'KXNBAGAME-26NOV21NYKMIA-NYK'
			const service = createParlayService(clientFor({
				[first]: market(
					first,
					'KXNBAGAME-26NOV20BOSLAL',
					{ yes_ask_dollars: '0.8000' },
				),
				[second]: market(
					second,
					'KXNBAGAME-26NOV21NYKMIA',
					{ yes_ask_dollars: '0.5000' },
				),
			}))
			const price = await service.priceParlay([
				{ ticker: first, side: 'yes' },
				{ ticker: second, side: 'yes' },
			])
			expect(price.warnings).toEqual([])
			expect(price.combinedProbability).toBe(0.4)
			expect(price.decimalOdds).toBe(2.5)
			expect(price.americanOdds).toBe(150)
			expect(price.payoutPerDollar).toBe(2.5)
			expect(price.profitPerDollar).toBe(1.5)
		},
	)

	it('does not price a NO leg nobody is selling', async function () {
		const dead = 'KXNBA3QTOTAL-26NOV11ORLUTA-66'
		const service = createParlayService(clientFor({
			[dead]: market(dead, 'KXNBA3QTOTAL-26NOV11ORLUTA', {
				yes_bid_dollars: '0.0000',
				yes_ask_dollars: '0.0200',
				no_bid_dollars: '0.9800',
				no_ask_dollars: '1.0000',
				yes_bid_size_fp: '0.00',
				yes_ask_size_fp: '40.00',
			}),
			[DET_SIDE]: market(DET_SIDE, DET),
		}))
		const price = await service.priceParlay([
			{ ticker: dead, side: 'no' },
			{ ticker: DET_SIDE, side: 'yes' },
		])
		expect(price.warnings).toEqual([
			`Leg ${dead} has no liquidity on no`,
			`Parlay not priced: no buyable ask for ${dead} no`,
		])
		expect(price.legs[0]?.ask).toBeNull()
		expect(price.legs[0]?.impliedProbability).toBeNull()
		expect(price.legs[0]?.quote.yesAsk).toBe(0.02)
		expect(price.combinedProbability).toBeNull()
		expect(price.decimalOdds).toBeNull()
		expect(price.americanOdds).toBeNull()
		expect(price.payoutPerDollar).toBeNull()
		expect(price.profitPerDollar).toBeNull()
	})

	it('does not price a YES leg nobody is selling', async function () {
		const dead = 'KXNBAASTPROT-26NOV11BOSTOR-TORIQUICKLEY5-2'
		const service = createParlayService(clientFor({
			[dead]: market(dead, 'KXNBAASTPROT-26NOV11BOSTOR', {
				yes_bid_dollars: '0.9500',
				yes_ask_dollars: '1.0000',
				no_bid_dollars: '0.0000',
				no_ask_dollars: '0.0500',
				yes_bid_size_fp: '30.00',
				yes_ask_size_fp: '0.00',
			}),
			[DET_SIDE]: market(DET_SIDE, DET),
		}))
		const price = await service.priceParlay([
			{ ticker: dead, side: 'yes' },
			{ ticker: DET_SIDE, side: 'yes' },
		])
		expect(price.warnings).toEqual([
			`Leg ${dead} has no liquidity on yes`,
			`Parlay not priced: no buyable ask for ${dead} yes`,
		])
		expect(price.legs[0]?.ask).toBeNull()
		expect(price.combinedProbability).toBeNull()
		expect(price.decimalOdds).toBeNull()
		expect(price.americanOdds).toBeNull()
		expect(price.payoutPerDollar).toBeNull()
		expect(price.profitPerDollar).toBeNull()
	})

	it('does not price a finalized leg', async function () {
		const done = `${WAS}-NYG`
		const service = createParlayService(clientFor({
			[done]: market(done, WAS, {
				status: 'finalized',
				yes_bid_dollars: '0.0000',
				yes_ask_dollars: '1.0000',
				no_bid_dollars: '0.0000',
				no_ask_dollars: '1.0000',
				yes_bid_size_fp: '0.00',
				yes_ask_size_fp: '0.00',
			}),
			[DET_SIDE]: market(DET_SIDE, DET),
		}))
		const price = await service.priceParlay([
			{ ticker: done, side: 'yes' },
			{ ticker: DET_SIDE, side: 'yes' },
		])
		expect(price.combinedProbability).toBeNull()
		expect(price.decimalOdds).toBeNull()
		expect(price.warnings).toContain(
			`Leg ${done} is finalized`,
		)
		expect(price.warnings).toContain(
			`Leg ${done} has no liquidity on yes`,
		)
	})

	it(
		'warns when a moneyline and spread share a game',
		async function () {
			const service = createParlayService(clientFor({
				[NYG]: market(NYG, WAS, {
					yes_ask_dollars: '0.4000',
				}),
				[WAS_SPREAD_SIDE]: market(
					WAS_SPREAD_SIDE,
					WAS_SPREAD,
					{ yes_ask_dollars: '0.5000' },
				),
			}))
			const price = await service.priceParlay([
				{ ticker: NYG, side: 'yes' },
				{ ticker: WAS_SPREAD_SIDE, side: 'yes' },
			])
			expect(price.warnings).toEqual([
				'Correlated legs share game 26NOV12WASNYG',
			])
			expect(price.legs.map(function (leg) {
				return leg.seriesTicker
			})).toEqual(['KXNFLGAME', 'KXNFLSPREAD'])
			expect(price.combinedProbability).toBe(0.2)
		},
	)

	it(
		'warns when two legs share an event ticker',
		async function () {
			const service = createParlayService(clientFor({
				[NYG]: market(NYG, WAS),
				[WAS_SIDE]: market(WAS_SIDE, WAS, {
					yes_ask_dollars: '0.5000',
				}),
			}))
			const price = await service.priceParlay([
				{ ticker: NYG, side: 'yes' },
				{ ticker: WAS_SIDE, side: 'yes' },
			])
			expect(price.warnings).toEqual([
				`Correlated legs share event ${WAS}`,
				'Correlated legs share game 26NOV12WASNYG',
			])
			expect(price.combinedProbability).toBe(0.2)
		},
	)

	it('warns when a parlay has one leg', async function () {
		const service = createParlayService(clientFor({
			[NYG]: market(NYG, WAS, {
				yes_ask_dollars: '0.5000',
			}),
		}))
		const price = await service.priceParlay([
			{ ticker: NYG, side: 'yes' },
		])
		expect(price.warnings).toEqual([
			'Parlay needs at least two legs',
		])
		expect(price.legs).toHaveLength(1)
		expect(price.combinedProbability).toBe(0.5)
		expect(price.decimalOdds).toBe(2)
		expect(price.americanOdds).toBe(100)
	})

	it('warns when a market is missing', async function () {
		const service = createParlayService(clientFor({
			[NYG]: market(NYG, WAS, {
				yes_ask_dollars: '0.4000',
			}),
		}))
		const price = await service.priceParlay([
			{ ticker: 'MISSING', side: 'yes' },
			{ ticker: NYG, side: 'yes' },
		])
		expect(price.warnings).toEqual([
			'Leg MISSING was not found',
		])
		expect(price.legs.map(function (leg) {
			return leg.ticker
		})).toEqual([NYG])
		expect(price.combinedProbability).toBeNull()
		expect(price.decimalOdds).toBeNull()
		expect(price.americanOdds).toBeNull()
		expect(price.payoutPerDollar).toBeNull()
		expect(price.profitPerDollar).toBeNull()
	})

	it('warns when a market is closed', async function () {
		const service = createParlayService(clientFor({
			[NYG]: market(NYG, WAS, {
				status: 'closed',
				yes_ask_dollars: '0.4000',
			}),
			[DET_SIDE]: market(DET_SIDE, DET, {
				yes_ask_dollars: '0.5000',
			}),
		}))
		const price = await service.priceParlay([
			{ ticker: NYG, side: 'yes' },
			{ ticker: DET_SIDE, side: 'yes' },
		])
		expect(price.warnings).toEqual([
			`Leg ${NYG} is closed`,
		])
		expect(price.legs[0]?.status).toBe('closed')
		expect(price.combinedProbability).toBe(0.2)
		expect(price.americanOdds).toBe(400)
	})

	it('rethrows errors that are not a 404', async function () {
		const client = {
			getMarket: async function () {
				throw new KalshiHttpError(
					500,
					'/markets/A',
					'down',
				)
			},
		} as unknown as KalshiClient
		const service = createParlayService(client)
		let caught: unknown
		try {
			await service.priceParlay(legsOf(['A', 'B']))
		} catch (err) {
			caught = err
		}
		expect(caught).toBeInstanceOf(KalshiHttpError)
		if (caught instanceof KalshiHttpError) {
			expect(caught.status).toBe(500)
		}
	})

	it(
		'fetches at most five markets at once, in order',
		async function () {
			const tickers = ['A', 'B', 'C', 'D', 'E', 'F']
			let active = 0
			let maxActive = 0
			const client = {
				getMarket: async function (ticker: string) {
					active += 1
					if (active > maxActive) {
						maxActive = active
					}
					await new Promise(function (resolve) {
						setTimeout(resolve, 20)
					})
					active -= 1
					return market(ticker, `EVT-${ticker}`)
				},
			} as unknown as KalshiClient
			const service = createParlayService(client)
			const price = await service.priceParlay(
				legsOf(tickers),
			)
			expect(maxActive).toBe(5)
			expect(price.legs.map(function (leg) {
				return leg.ticker
			})).toEqual(tickers)
		},
	)
})
