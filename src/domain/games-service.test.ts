import { describe, expect, it } from 'vitest'
import {
	KalshiHttpError,
	KalshiTimeoutError,
} from '../kalshi/errors.js'
import type {
	GetAllEventsParams,
	GetMilestonesParams,
	KalshiClient,
} from '../kalshi/kalshi-client.js'
import type { Event, Market, Milestone } from '../kalshi/types.js'
import {
	createGamesService,
	toKalshiDateToken,
} from './games-service.js'
import { seriesTickerFromEventTicker } from './market-classify.js'

const WAS = 'KXNFLGAME-26NOV12WASNYG'
const DET = 'KXNFLGAME-26NOV15NEDET'
const WAS_SPREAD = 'KXNFLSPREAD-26NOV12WASNYG'
const WAS_TOTAL = 'KXNFLTOTAL-26NOV12WASNYG'
const WAS_TEAM = 'KXNFLTEAMTOTAL-26NOV12WASNYG'
const DET_SPREAD = 'KXNFLSPREAD-26NOV15NEDET'

function market (
	ticker: string,
	overrides: Partial<Market> = {},
): Market {
	return {
		ticker,
		event_ticker: WAS,
		market_type: 'binary',
		yes_sub_title: 'Team',
		status: 'active',
		yes_bid_dollars: '0.5600',
		yes_ask_dollars: '0.5800',
		no_bid_dollars: '0.4200',
		no_ask_dollars: '0.4400',
		...overrides,
	}
}

function eventOf (
	eventTicker: string,
	seriesTicker: string,
	markets: Market[],
	title = eventTicker,
): Event {
	return {
		event_ticker: eventTicker,
		series_ticker: seriesTicker,
		title,
		markets,
	}
}

function milestoneOf (
	id: string,
	overrides: Partial<Milestone> = {},
): Milestone {
	return {
		id,
		category: 'Sports',
		type: 'football_game',
		start_date: '2026-11-12T18:00:00Z',
		title: 'Game',
		related_event_tickers: [],
		primary_event_tickers: [],
		details: {},
		...overrides,
	}
}

function listFixture () {
	const queries: GetAllEventsParams[] = []
	const eventTickers: string[] = []
	const liveCalls: string[] = []
	const events: Event[] = [
		{
			event_ticker: WAS,
			series_ticker: 'KXNFLGAME',
			title: 'Washington vs New York G',
			sub_title: 'WAS vs NYG (Nov 12)',
			markets: [
				market(`${WAS}-NYG`, {
					yes_sub_title: 'New York G',
				}),
				market(`${WAS}-WAS`, {
					yes_sub_title: 'Washington',
					yes_bid_dollars: '0.4200',
					yes_ask_dollars: '0.4400',
				}),
			],
		},
		{
			event_ticker: DET,
			series_ticker: 'KXNFLGAME',
			title: 'New England vs Detroit',
			sub_title: 'NE vs DET (Nov 15)',
			markets: [
				market(`${DET}-DET`, {
					event_ticker: DET,
					yes_sub_title: 'Detroit',
				}),
			],
		},
	]
	const milestones: Milestone[] = [
		milestoneOf('ms-decoy', {
			primary_event_tickers: ['KXNFLGAME-26DEC01XXX'],
			details: {
				status: 'scheduled',
				main_game_event_ticker: 'KXNFLGAME-26DEC01XXX',
			},
		}),
		milestoneOf('ms-det', {
			start_date: '2026-11-15T18:00:00Z',
			primary_event_tickers: [DET, DET_SPREAD],
			details: {
				status: 'scheduled',
				main_game_event_ticker: DET,
			},
		}),
		milestoneOf('ms-was', {
			primary_event_tickers: [
				WAS,
				WAS_SPREAD,
				WAS_TOTAL,
				WAS_TEAM,
			],
			details: {
				status: 'scheduled',
				league: 'NFL',
				main_game_event_ticker: WAS,
			},
		}),
	]
	const lines: Record<string, Event> = {
		[WAS_SPREAD]: eventOf(WAS_SPREAD, 'KXNFLSPREAD', [
			market(`${WAS_SPREAD}-NYG3`, {
				event_ticker: 'NOT-A-SERIES',
				yes_sub_title: 'New York G',
			}),
		]),
		[WAS_TOTAL]: eventOf(WAS_TOTAL, 'KXNFLTOTAL', [
			market(`${WAS_TOTAL}-43`, {
				yes_sub_title: 'Over 43.5',
			}),
		]),
		[DET_SPREAD]: eventOf(DET_SPREAD, 'KXNFLSPREAD', [
			market(`${DET_SPREAD}-DET3`, {
				yes_sub_title: 'Detroit',
			}),
		]),
	}
	const client = {
		getAllEvents: async function (
			params: GetAllEventsParams,
		) {
			queries.push(params)
			return { events, milestones }
		},
		getEvent: async function (ticker: string) {
			eventTickers.push(ticker)
			const found = lines[ticker]
			if (!found) {
				throw new Error(`unexpected event ${ticker}`)
			}
			return found
		},
		getLiveData: async function (id: string) {
			liveCalls.push(id)
			throw new Error('list must not fetch live data')
		},
	} as unknown as KalshiClient
	return {
		client,
		queries,
		eventTickers,
		liveCalls,
	}
}

describe('toKalshiDateToken', function () {
	it('formats a calendar day as a ticker token', function () {
		expect(toKalshiDateToken('2026-11-12')).toBe('26NOV12')
		expect(toKalshiDateToken('2026-11-02')).toBe('26NOV02')
		expect(function () {
			toKalshiDateToken('2026-13-01')
		}).toThrow(/YYYY-MM-DD/)
		expect(function () {
			toKalshiDateToken('2026-02-31')
		}).toThrow(/^date must be YYYY-MM-DD/)
		expect(function () {
			toKalshiDateToken('2026-04-31')
		}).toThrow(/^date must be YYYY-MM-DD/)
		expect(function () {
			toKalshiDateToken('2026-00-10')
		}).toThrow(/^date must be YYYY-MM-DD/)
		expect(function () {
			toKalshiDateToken('2026-11-00')
		}).toThrow(/^date must be YYYY-MM-DD/)
		expect(function () {
			toKalshiDateToken('2025-02-29')
		}).toThrow(/^date must be YYYY-MM-DD/)
		expect(toKalshiDateToken('2028-02-29')).toBe('28FEB29')
		expect(function () {
			toKalshiDateToken('11/12/2026')
		}).toThrow(/YYYY-MM-DD/)
	})
})

describe('createGamesService', function () {
	it(
		'groups moneyline, matches milestones, and filters by date',
		async function () {
			const fx = listFixture()
			const service = createGamesService(fx.client)
			const listed = await service.listGames({ league: 'nfl' })
			expect(listed.truncated).toBe(false)
			const all = listed.games
			expect(all.map(function (game) {
				return game.eventTicker
			})).toEqual([WAS, DET])
			expect(all[0]?.milestoneId).toBe('ms-was')
			expect(all[1]?.milestoneId).toBe('ms-det')
			expect(all[0]?.title).toBe('Washington vs New York G')
			expect(all[0]?.subTitle).toBe('WAS vs NYG (Nov 12)')
			expect(all[0]?.startTime).toBe('2026-11-12T18:00:00Z')
			expect(all[0]?.gameStatus).toBe('scheduled')
			expect(all[0]?.moneyline.map(function (side) {
				return side.team
			})).toEqual(['New York G', 'Washington'])
			expect(all[0]?.moneyline[0]?.status).toBe('active')
			expect(all[0]?.moneyline[0]?.quote.yesBid).toBe(0.56)
			expect(all[0]?.moneyline[0]?.quote.impliedYes).toBe(0.58)
			expect(all[0]?.spread?.[0]?.label).toBe('New York G')
			expect(all[0]?.spread?.[0]?.ticker).toBe(
				`${WAS_SPREAD}-NYG3`,
			)
			expect(all[0]?.total?.[0]?.ticker).toBe(`${WAS_TOTAL}-43`)
			expect(fx.liveCalls).toEqual([])
			expect(fx.queries[0]?.status).toBe('open')
			expect(fx.queries[0]?.series_ticker).toBe('KXNFLGAME')
			expect(fx.queries[0]?.with_nested_markets).toBe(true)
			expect(fx.queries[0]?.with_milestones).toBe(true)
			expect(fx.queries[0]?.maxPages).toBeUndefined()
			expect(fx.eventTickers.slice().sort()).toEqual([
				DET_SPREAD,
				WAS_SPREAD,
				WAS_TOTAL,
			].sort())
			expect(fx.eventTickers).not.toContain(WAS_TEAM)

			fx.eventTickers.length = 0
			const filtered = (await service.listGames({
				league: 'nfl',
				date: '2026-11-12',
			})).games
			expect(filtered.map(function (game) {
				return game.eventTicker
			})).toEqual([WAS])
			expect(fx.eventTickers.slice().sort()).toEqual([
				WAS_SPREAD,
				WAS_TOTAL,
			].sort())
		},
	)

	it('limits event paging to 3 pages when status is all', async function () {
		const fx = listFixture()
		const service = createGamesService(fx.client)
		await service.listGames({ league: 'nfl', status: 'all' })
		expect(fx.queries[0]?.maxPages).toBe(3)
		expect(fx.queries[0]?.status).toBeUndefined()
	})

	it('keeps at most 100 games when status is all', async function () {
		const events = Array.from({ length: 150 }, function (_, i) {
			const ticker = `KXNFLGAME-26NOV12T${i}`
			return eventOf(ticker, 'KXNFLGAME', [])
		})
		const client = {
			getAllEvents: async function () {
				return { events, milestones: [] }
			},
		} as unknown as KalshiClient
		const service = createGamesService(client)
		const all = await service.listGames({
			league: 'nfl',
			status: 'all',
		})
		expect(all.games).toHaveLength(100)
		expect(all.truncated).toBe(true)
		const open = await service.listGames({ league: 'nfl' })
		expect(open.games).toHaveLength(150)
		expect(open.truncated).toBe(false)
	})

	it('flags truncated when Kalshi has more event pages', async function () {
		const client = {
			getAllEvents: async function () {
				return { events: [], milestones: [], cursor: 'more' }
			},
		} as unknown as KalshiClient
		const service = createGamesService(client)
		const open = await service.listGames({ league: 'nfl' })
		expect(open).toEqual({ games: [], truncated: true })
	})

	it('omits the open filter when status is all', async function () {
		const fx = listFixture()
		const service = createGamesService(fx.client)
		await service.listGames({
			league: 'nfl',
			status: 'all',
		})
		expect(fx.queries[0]?.status).toBeUndefined()
		expect(fx.queries[0]?.with_milestones).toBe(true)
	})

	it(
		'filters by ticker token or milestone UTC day',
		async function () {
			const tokenGame = 'KXNFLGAME-26NOV12WASNYG'
			const utcGame = 'KXNFLGAME-WASNYG'
			const other = 'KXNFLGAME-LALBOS'
			const events: Event[] = [
				eventOf(tokenGame, 'KXNFLGAME', [], 'Token'),
				eventOf(utcGame, 'KXNFLGAME', [], 'Utc'),
				eventOf(other, 'KXNFLGAME', [], 'Other'),
			]
			const milestones = [
				milestoneOf('ms-token', {
					start_date: '2026-11-13T04:00:00Z',
					details: {
						main_game_event_ticker: tokenGame,
						status: 'scheduled',
					},
				}),
				milestoneOf('ms-utc', {
					start_date: '2026-11-12T18:00:00Z',
					details: {
						main_game_event_ticker: utcGame,
						status: 'scheduled',
					},
				}),
				milestoneOf('ms-other', {
					start_date: '2026-11-15T18:00:00Z',
					details: {
						main_game_event_ticker: other,
						status: 'scheduled',
					},
				}),
			]
			const eventTickers: string[] = []
			const client = {
				getAllEvents: async function () {
					return { events, milestones }
				},
				getEvent: async function (ticker: string) {
					eventTickers.push(ticker)
					throw new Error(`unexpected ${ticker}`)
				},
			} as unknown as KalshiClient
			const service = createGamesService(client)
			const rows = (await service.listGames({
				league: 'nfl',
				date: '2026-11-12',
			})).games
			expect(rows.map(function (game) {
				return game.eventTicker
			})).toEqual([tokenGame, utcGame])
			expect(rows[0]?.milestoneId).toBe('ms-token')
			expect(rows[1]?.milestoneId).toBe('ms-utc')
			expect(rows[0]?.spread).toBeNull()
			expect(rows[0]?.total).toBeNull()
			expect(eventTickers).toEqual([])
		},
	)

	it(
		'keeps a ticker date off the UTC start day',
		async function () {
			const ticker = 'KXNBAGAME-26NOV11BOSTOR'
			const events: Event[] = [
				eventOf(ticker, 'KXNBAGAME', [], 'Celtics'),
			]
			const milestones = [
				milestoneOf('ms-bos', {
					start_date: '2026-11-12T00:00:00Z',
					details: {
						main_game_event_ticker: ticker,
						status: 'scheduled',
					},
				}),
			]
			const client = {
				getAllEvents: async function () {
					return { events, milestones }
				},
				getEvent: async function () {
					throw new Error('no extra events')
				},
			} as unknown as KalshiClient
			const service = createGamesService(client)
			const nov11 = (await service.listGames({
				league: 'nba',
				date: '2026-11-11',
			})).games
			const nov12 = (await service.listGames({
				league: 'nba',
				date: '2026-11-12',
			})).games
			expect(nov11.map(function (game) {
				return game.eventTicker
			})).toEqual([ticker])
			expect(nov12).toEqual([])
		},
	)

	it(
		'hydrates related events into categories',
		async function () {
			const spread = 'KXNFLSPREAD-26NOV12WASNYG'
			const total = 'KXNFLTOTAL-26NOV12WASNYG'
			const team = 'KXNFLTEAMTOTAL-26NOV12WASNYG'
			const half = 'KXNFL1HTOTAL-26NOV12WASNYG'
			const prop = 'KXNFLPASSYDS-26NOV12WASNYG'
			const anyTd = 'KXNFLANYTD-26NOV12WASNYG'
			const other = 'KXNFLCUSTOM-26NOV12WASNYG'
			const related = [
				WAS,
				spread,
				total,
				team,
				half,
				prop,
				other,
			]
			const catalog = new Map<string, Event>()
			catalog.set(WAS, {
				event_ticker: WAS,
				series_ticker: 'KXNFLGAME',
				title: 'Washington vs New York G',
				sub_title: 'WAS vs NYG (Nov 12)',
				markets: [
					market(`${WAS}-NYG`, {
						yes_sub_title: 'New York G',
					}),
					market(`${WAS}-WAS`, {
						yes_sub_title: 'Washington',
					}),
				],
			})
			for (const ticker of related) {
				if (ticker === WAS) {
					continue
				}
				catalog.set(ticker, eventOf(
					ticker,
					seriesTickerFromEventTicker(ticker),
					[
						market(`${ticker}-M`, {
							event_ticker: 'NOT-A-SERIES',
							yes_sub_title: ticker,
						}),
					],
				))
			}
			catalog.set(anyTd, eventOf(
				anyTd,
				seriesTickerFromEventTicker(anyTd),
				[
					market(`${anyTd}-M`, {
						event_ticker: 'NOT-A-SERIES',
						yes_sub_title: 'First score',
					}),
				],
			))
			const milestoneQueries: GetMilestonesParams[] = []
			const client = {
				getEvent: async function (ticker: string) {
					const found = catalog.get(ticker)
					if (!found) {
						throw new Error(`missing ${ticker}`)
					}
					return found
				},
				getMilestones: async function (
					params: GetMilestonesParams,
				) {
					milestoneQueries.push(params)
					return {
						milestones: [
							milestoneOf('ms-was', {
								related_event_tickers: related,
								primary_event_tickers: [
									WAS,
									spread,
									total,
									team,
									anyTd,
								],
								details: {
									status: 'scheduled',
									main_game_event_ticker: WAS,
									player_id_mapping: { p: 1 },
								},
							}),
						],
					}
				},
				getMilestone: async function () {
					throw new Error('event key is not a uuid')
				},
				getLiveData: async function (id: string) {
					return {
						type: 'football_game',
						milestone_id: id,
						details: {
							status: 'in_progress',
							home_points: 21,
							away_points: 17,
							clock: '02:05',
							quarter: 4,
							winner: '',
							live_data_delayed: false,
							last_updated_ts: 100,
							last_play: 'pass',
							player_id_mapping: { p: 1 },
							series_to_stat_mapping: { x: 'yds' },
						},
					}
				},
			} as unknown as KalshiClient
			const service = createGamesService(client)
			const game = await service.getGame(WAS)
			expect(milestoneQueries).toEqual([{
				related_event_ticker: WAS,
				limit: 50,
			}])
			expect(game.league).toBe('nfl')
			expect(game.milestoneId).toBe('ms-was')
			expect(game.gameStatus).toBe('in_progress')
			expect(game.moneyline.map(function (side) {
				return side.ticker
			})).toEqual([`${WAS}-NYG`, `${WAS}-WAS`])
			expect(game.spread.map(function (line) {
				return line.ticker
			})).toEqual([`${spread}-M`])
			expect(game.total.map(function (line) {
				return line.ticker
			})).toEqual([`${total}-M`])
			expect(game.teamTotal.map(function (line) {
				return line.ticker
			})).toEqual([`${team}-M`])
			expect(game.period.map(function (line) {
				return line.ticker
			})).toEqual([`${half}-M`])
			expect(game.props.map(function (line) {
				return line.ticker
			})).toEqual([`${anyTd}-M`, `${prop}-M`])
			expect(game.other.map(function (line) {
				return line.ticker
			})).toEqual([`${other}-M`])
			expect(game.live?.homePoints).toBe(21)
			expect(game.live?.awayPoints).toBe(17)
			expect(game.live?.clock).toBe('02:05')
			expect(game.live?.period).toBe(4)
			expect(game.live?.winner).toBeNull()
			expect(game.live?.delayed).toBe(false)
			expect(game.live?.lastUpdatedTs).toBe(100)
			expect(game.live?.raw.last_play).toBe('pass')
			expect(game.live?.raw.player_id_mapping).toBeUndefined()
			expect(
				game.live?.raw.series_to_stat_mapping,
			).toBeUndefined()
		},
	)

	it('limits related event fetches to four at a time', async function () {
		const extras = [1, 2, 3, 4, 5, 6].map(function (index) {
			return `KXNFLPASSYDS-G${index}`
		})
		let active = 0
		let maxActive = 0
		let eventCalls = 0
		const client = {
			getEvent: async function (ticker: string) {
				eventCalls += 1
				active += 1
				if (active > maxActive) {
					maxActive = active
				}
				await Promise.resolve()
				active -= 1
				return eventOf(
					ticker,
					seriesTickerFromEventTicker(ticker),
					[],
				)
			},
			getMilestones: async function () {
				return {
					milestones: [
						milestoneOf('ms-was', {
							related_event_tickers: extras,
							details: {
								main_game_event_ticker: WAS,
								status: 'scheduled',
							},
						}),
					],
				}
			},
			getLiveData: async function (id: string) {
				return {
					type: 'football_game',
					milestone_id: id,
					details: { status: 'scheduled' },
				}
			},
		} as unknown as KalshiClient
		const service = createGamesService(client)
		const game = await service.getGame(WAS)
		expect(eventCalls).toBe(7)
		expect(maxActive).toBe(4)
		expect(game.eventTicker).toBe(WAS)
		expect(game.props).toEqual([])
		expect(game.truncated).toBeUndefined()
	})

	describe('getGame failure tolerance', function () {
		const failing = 'KXNFLPASSYDS-BAD'
		const timing = 'KXNFLRECYDS-SLOW'
		const good = 'KXNFLANYTD-OK'

		function toleranceClient (
			live: () => Promise<unknown>,
			root: () => Promise<Event>,
		): KalshiClient {
			return {
				getEvent: async function (ticker: string) {
					if (ticker === WAS) {
						return root()
					}
					if (ticker === failing) {
						throw new KalshiHttpError(404, `/events/${ticker}`, '')
					}
					if (ticker === timing) {
						throw new KalshiTimeoutError(`/events/${ticker}`)
					}
					return eventOf(
						ticker,
						seriesTickerFromEventTicker(ticker),
						[],
					)
				},
				getMilestones: async function () {
					return {
						milestones: [
							milestoneOf('ms-was', {
								related_event_tickers: [failing, timing, good],
								details: {
									main_game_event_ticker: WAS,
									status: 'scheduled',
								},
							}),
						],
					}
				},
				getLiveData: live,
			} as unknown as KalshiClient
		}

		async function rootEvent (): Promise<Event> {
			return eventOf(WAS, 'KXNFLGAME', [])
		}

		it('skips failed related events', async function () {
			const client = toleranceClient(async function () {
				return {
					type: 'football_game',
					milestone_id: 'ms-was',
					details: { status: 'scheduled' },
				}
			}, rootEvent)
			const game = await createGamesService(client).getGame(WAS)
			expect(game.truncated).toBe(true)
			expect(game.live?.status).toBe('scheduled')
		})

		it('returns live null when live data fails', async function () {
			const client = toleranceClient(async function () {
				throw new KalshiHttpError(404, '/live_data/x', '')
			}, rootEvent)
			const game = await createGamesService(client).getGame(WAS)
			expect(game.live).toBeNull()
			expect(game.gameStatus).toBe('scheduled')
		})

		it('rethrows a non-Kalshi related error', async function () {
			const started: string[] = []
			const related = Array.from({ length: 20 }, function (_, i) {
				return `KXNFLPASSYDS-T${i}`
			})
			const client = {
				getEvent: async function (ticker: string) {
					started.push(ticker)
					if (ticker === WAS) {
						return eventOf(WAS, 'KXNFLGAME', [])
					}
					throw new TypeError('bad shape')
				},
				getMilestones: async function () {
					return {
						milestones: [
							milestoneOf('ms-was', {
								related_event_tickers: related,
								details: {
									main_game_event_ticker: WAS,
									status: 'scheduled',
								},
							}),
						],
					}
				},
				getLiveData: async function () {
					throw new Error('not reached')
				},
			} as unknown as KalshiClient
			await expect(
				createGamesService(client).getGame(WAS),
			).rejects.toBeInstanceOf(TypeError)
			expect(started.length).toBeLessThanOrEqual(1 + 4)
		})

		it('rethrows a non-Kalshi error from live data', async function () {
			const client = toleranceClient(async function () {
				throw new TypeError('bad live shape')
			}, rootEvent)
			await expect(
				createGamesService(client).getGame(WAS),
			).rejects.toBeInstanceOf(TypeError)
		})

		it('still fails when the root event fails', async function () {
			const client = toleranceClient(
				async function () {
					return { type: 'x', milestone_id: 'ms-was', details: {} }
				},
				async function () {
					throw new KalshiTimeoutError(`/events/${WAS}`)
				},
			)
			await expect(
				createGamesService(client).getGame(WAS),
			).rejects.toBeInstanceOf(KalshiTimeoutError)
		})
	})

	it('caps loaded events at 100, primary first', async function () {
		const primary = Array.from({ length: 60 }, function (_, i) {
			return `KXNFLPASSYDS-P${i}`
		})
		const related = Array.from({ length: 60 }, function (_, i) {
			return `KXNFLRECYDS-R${i}`
		})
		const loaded: string[] = []
		const client = {
			getEvent: async function (ticker: string) {
				loaded.push(ticker)
				return eventOf(
					ticker,
					seriesTickerFromEventTicker(ticker),
					[],
				)
			},
			getMilestones: async function () {
				return {
					milestones: [
						milestoneOf('ms-was', {
							related_event_tickers: related,
							primary_event_tickers: primary,
							details: {
								main_game_event_ticker: WAS,
								status: 'scheduled',
							},
						}),
					],
				}
			},
			getLiveData: async function (id: string) {
				return {
					type: 'football_game',
					milestone_id: id,
					details: { status: 'scheduled' },
				}
			},
		} as unknown as KalshiClient
		const service = createGamesService(client)
		const game = await service.getGame(WAS)
		expect(loaded).toHaveLength(100)
		expect(loaded[0]).toBe(WAS)
		expect(loaded.slice(1, 61).slice().sort()).toEqual(
			primary.slice().sort(),
		)
		expect(loaded.filter(function (ticker) {
			return ticker.startsWith('KXNFLRECYDS')
		})).toHaveLength(39)
		expect(game.truncated).toBe(true)
	})

	it(
		'reports the main GAME event for a SPREAD ticker',
		async function () {
			const client = {
				getEvent: async function (ticker: string) {
					if (ticker === WAS_SPREAD) {
						return eventOf(
							WAS_SPREAD,
							'KXNFLSPREAD',
							[],
							'Spread title',
						)
					}
					return eventOf(
						WAS,
						'KXNFLGAME',
						[],
						'Washington vs New York G',
					)
				},
				getMilestones: async function () {
					return {
						milestones: [
							milestoneOf('ms-was', {
								primary_event_tickers: [
									WAS,
									WAS_SPREAD,
								],
								details: {
									main_game_event_ticker: WAS,
									status: 'scheduled',
								},
							}),
						],
					}
				},
				getLiveData: async function (id: string) {
					return {
						type: 'football_game',
						milestone_id: id,
						details: { status: 'scheduled' },
					}
				},
			} as unknown as KalshiClient
			const service = createGamesService(client)
			const game = await service.getGame(WAS_SPREAD)
			expect(game.eventTicker).toBe(WAS)
			expect(game.title).toBe('Washington vs New York G')
		},
	)

	it('loads a game from a milestone id', async function () {
		const id = '11111111-1111-4111-8111-111111111111'
		let milestoneReads = 0
		const client = {
			getMilestone: async function (milestoneId: string) {
				expect(milestoneId).toBe(id)
				return milestoneOf(id, {
					primary_event_tickers: [WAS],
					details: {
						status: 'scheduled',
						main_game_event_ticker: WAS,
					},
				})
			},
			getMilestones: async function () {
				milestoneReads += 1
				throw new Error('uuid path skips milestone search')
			},
			getEvent: async function (ticker: string) {
				return {
					...eventOf(ticker, 'KXNFLGAME', [
						market(`${ticker}-NYG`, {
							yes_sub_title: 'New York G',
						}),
					], 'Washington vs New York G'),
					sub_title: 'WAS vs NYG (Nov 12)',
				}
			},
			getLiveData: async function () {
				return {
					type: 'football_game',
					milestone_id: id,
					details: {
						status: 'in_progress',
						home_points: 7,
						away_points: 3,
						quarter: 1,
					},
				}
			},
		} as unknown as KalshiClient
		const service = createGamesService(client)
		const game = await service.getGame(id)
		expect(milestoneReads).toBe(0)
		expect(game.eventTicker).toBe(WAS)
		expect(game.milestoneId).toBe(id)
		expect(game.gameStatus).toBe('in_progress')
		expect(game.moneyline[0]?.team).toBe('New York G')
		expect(game.subTitle).toBe('WAS vs NYG (Nov 12)')
	})

	it('rejects a series outside nba and nfl', async function () {
		const client = {
			getEvent: async function () {
				return eventOf(
					'KXWNBAGAME-26NOV12',
					'KXWNBAGAME',
					[],
				)
			},
		} as unknown as KalshiClient
		const service = createGamesService(client)
		await expect(service.getGame('KXWNBAGAME-26NOV12'))
			.rejects.toThrow(/Unknown league series/)
	})

	it('sanitizes live data and batches', async function () {
		const client = {
			getLiveData: async function (id: string) {
				return {
					type: 'football_game',
					milestone_id: id,
					details: {
						status: 'in_progress',
						home_points: 14,
						away_points: 10,
						clock: '08:12',
						quarter: 2,
						winner: 'NYG',
						live_data_delayed: true,
						last_updated_ts: 1731340800,
						last_play: 'run',
						player_id_mapping: { a: 1 },
						series_to_stat_mapping: { b: 'pts' },
					},
				}
			},
			getLiveDataBatch: async function (ids: string[]) {
				return [
					{
						type: 'football_game',
						milestone_id: ids[0],
						details: {
							status: 'live',
							home_points: '21',
							away_points: 0,
							player_id_mapping: { a: 1 },
						},
					},
					{
						type: 'basketball_game',
						milestone_id: ids[1],
						details: {
							status: 'in_progress',
							home_points: 10,
							away_points: 8,
							period: 'H1',
							live_data_delayed: 'true',
						},
					},
				]
			},
		} as unknown as KalshiClient
		const service = createGamesService(client)
		const live = await service.getLive('ms-1')
		expect(live.milestoneId).toBe('ms-1')
		expect(live.type).toBe('football_game')
		expect(live.status).toBe('in_progress')
		expect(live.homePoints).toBe(14)
		expect(live.awayPoints).toBe(10)
		expect(live.clock).toBe('08:12')
		expect(live.period).toBe(2)
		expect(live.winner).toBe('NYG')
		expect(live.delayed).toBe(true)
		expect(live.lastUpdatedTs).toBe(1731340800)
		expect(live.raw.last_play).toBe('run')
		expect(live.raw.player_id_mapping).toBeUndefined()
		expect(live.raw.series_to_stat_mapping).toBeUndefined()

		const batch = await service.getLiveBatch(['a', 'b'])
		expect(batch[0]?.homePoints).toBe(21)
		expect(batch[0]?.awayPoints).toBe(0)
		expect(batch[0]?.raw.player_id_mapping).toBeUndefined()
		expect(batch[0]?.lastUpdatedTs).toBeUndefined()
		expect(batch[1]?.type).toBe('basketball_game')
		expect(batch[1]?.period).toBe('H1')
		expect(batch[1]?.delayed).toBe(true)
	})

	it('reads a basketball clock and period', async function () {
		const client = {
			getLiveData: async function (id: string) {
				if (id === 'prefer-clock') {
					return {
						type: 'basketball_game',
						milestone_id: id,
						details: {
							clock: '1:00',
							period_remaining_time: '9:99',
							game_clock: '0:01',
							period: 1,
						},
					}
				}
				if (id === 'game-clock') {
					return {
						type: 'basketball_game',
						milestone_id: id,
						details: {
							game_clock: '7:05',
							period: 2,
						},
					}
				}
				return {
					type: 'basketball_game',
					milestone_id: id,
					details: {
						status: 'in_progress',
						home_points: 88,
						away_points: 84,
						period: 3,
						period_remaining_time: '4:12',
					},
				}
			},
		} as unknown as KalshiClient
		const service = createGamesService(client)
		const live = await service.getLive('ms-nba')
		expect(live.type).toBe('basketball_game')
		expect(live.status).toBe('in_progress')
		expect(live.homePoints).toBe(88)
		expect(live.awayPoints).toBe(84)
		expect(live.clock).toBe('4:12')
		expect(live.period).toBe(3)
		const preferred = await service.getLive('prefer-clock')
		expect(preferred.clock).toBe('1:00')
		expect(preferred.period).toBe(1)
		const fallback = await service.getLive('game-clock')
		expect(fallback.clock).toBe('7:05')
		expect(fallback.period).toBe(2)
	})
})
