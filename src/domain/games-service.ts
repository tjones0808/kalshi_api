import { KalshiHttpError } from '../kalshi/errors.js'
import type {
	GetAllEventsParams,
	KalshiClient,
} from '../kalshi/kalshi-client.js'
import type {
	Event,
	LiveData,
	Market,
	Milestone,
} from '../kalshi/types.js'
import {
	LEAGUES,
	leagueFromSeriesTicker,
} from './leagues.js'
import type { LeagueConfig, LeagueId } from './leagues.js'
import {
	classifySeriesTicker,
	seriesTickerFromEventTicker,
} from './market-classify.js'
import type { MarketCategory } from './market-classify.js'
import { quoteFromMarket } from './prices.js'
import type { NormalizedQuote } from './prices.js'

const FETCH_CONCURRENCY = 4

/** Most events `getGame` loads: the root plus extras. */
const MAX_GAME_EVENTS = 100

/** Most games `listGames` prices when `status` is `all`. */
const MAX_ALL_GAMES = 100

/** Event pages `listGames` loads when `status` is `all` (200 each). */
const MAX_ALL_PAGES = 3

/** Retries for one related event, which is optional data. */
const RELATED_EVENT_RETRIES = 1

const MONTHS = [
	'JAN',
	'FEB',
	'MAR',
	'APR',
	'MAY',
	'JUN',
	'JUL',
	'AUG',
	'SEP',
	'OCT',
	'NOV',
	'DEC',
] as const

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

const DATE_TOKEN = new RegExp(
	`\\d{2}(?:${MONTHS.join('|')})\\d{2}`,
)

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One moneyline side on a game event. */
export interface MoneylineQuote {
	ticker: string
	team: string
	quote: NormalizedQuote
	status: string
}

/** One priced line that is not a moneyline side. */
export interface LineQuote {
	ticker: string
	label: string
	quote: NormalizedQuote
	status: string
}

/**
 * Compact game row from `listGames`.
 * `gameStatus` is the milestone `details.status`.
 * This list does not call live data. `getGame` and `getLive`
 * prefer the live snapshot.
 */
export interface GameSummary {
	league: LeagueId
	eventTicker: string
	milestoneId: string | null
	title: string
	subTitle: string | null
	startTime: string | null
	gameStatus: string | null
	moneyline: MoneylineQuote[]
	/** Null when no spread event was on the milestone. */
	spread: LineQuote[] | null
	/** Null when no total event was on the milestone. */
	total: LineQuote[] | null
}

/** Sanitized live snapshot for one milestone. */
export interface GameLive {
	milestoneId: string
	type: string
	status: string | null
	homePoints: number | null
	awayPoints: number | null
	/**
	 * `clock`, else `period_remaining_time`, else `game_clock`.
	 */
	clock: string | null
	/** `quarter`, then `period`, then `half`. */
	period: string | number | null
	winner: string | null
	delayed: boolean
	lastUpdatedTs?: number
	/**
	 * Milestone live details without `*_mapping` objects
	 * such as `player_id_mapping`.
	 */
	raw: Record<string, unknown>
}

/** Full game with related markets grouped by category. */
export interface GameDetail {
	league: LeagueId
	eventTicker: string
	milestoneId: string | null
	title: string
	subTitle: string | null
	startTime: string | null
	/**
	 * Live `details.status` when a snapshot was loaded.
	 * Otherwise the milestone status.
	 */
	gameStatus: string | null
	moneyline: MoneylineQuote[]
	spread: LineQuote[]
	total: LineQuote[]
	teamTotal: LineQuote[]
	period: LineQuote[]
	props: LineQuote[]
	other: LineQuote[]
	/** Null when there is no milestone or live data failed. */
	live: GameLive | null
	/**
	 * True when the milestone listed more than
	 * 100 events and the rest were not loaded, or when a related
	 * event failed to load (404, timeout, upstream error) and
	 * was skipped. Primary events are loaded before related ones.
	 */
	truncated?: true
}

/** Result of `listGames`. */
export interface GameList {
	games: GameSummary[]
	/**
	 * True when games may be missing: Kalshi still had more event
	 * pages after the page bound, or more than 100 matched games
	 * were cut for `status=all`.
	 */
	truncated: boolean
}

/** Filters for `listGames`. */
export interface ListGamesParams {
	league: LeagueId
	/** Calendar day `YYYY-MM-DD`. */
	date?: string
	/**
	 * `open` keeps the events list filter. `all` omits it and
	 * keeps at most 100 games. The default is `open`.
	 */
	status?: 'open' | 'all'
}

/** Game reads on top of a Kalshi client. */
export interface GamesService {
	/**
	 * List GAME events for one league.
	 * When the ticker contains a Kalshi date token
	 * (`26NOV11`), only that token is compared to `date`.
	 * The milestone UTC day is used only when the ticker
	 * has no date token. Spread and total events come from
	 * `primary_event_tickers` only. `truncated` flags a list that
	 * hit a page or game cap.
	 */
	listGames (params: ListGamesParams): Promise<GameList>

	/**
	 * Load one game by GAME event ticker or milestone UUID.
	 * A non-GAME event ticker resolves to the milestone's
	 * main GAME event ticker when one is known.
	 * Primary, then related, events are fetched with nested
	 * markets, four at a time, up to 100 events in all, and
	 * classified. `truncated` is set when events were skipped or
	 * failed to load. A failed live lookup gives `live: null`.
	 * Only the root event's errors propagate.
	 * Live details drop `player_id_mapping` and other
	 * `*_mapping` fields.
	 */
	getGame (eventKey: string): Promise<GameDetail>

	/** Live snapshot for one milestone. */
	getLive (milestoneId: string): Promise<GameLive>

	/** Live snapshots for many milestones. */
	getLiveBatch (milestoneIds: string[]): Promise<GameLive[]>
}

interface MatchedGame {
	event: Event
	milestone: Milestone | null
}

interface LoadedLine {
	ticker: string
	event: Event
}

interface Buckets {
	moneyline: MoneylineQuote[]
	spread: LineQuote[]
	total: LineQuote[]
	teamTotal: LineQuote[]
	period: LineQuote[]
	props: LineQuote[]
	other: LineQuote[]
}

/**
 * Create game list, detail, and live-data helpers.
 * `listGames` uses milestone status. `getGame` and `getLive`
 * use live data for the current status when a milestone exists.
 */
export function createGamesService (
	client: KalshiClient,
): GamesService {
	async function listGames (
		params: ListGamesParams,
	): Promise<GameList> {
		const league = LEAGUES[params.league]
		if (params.date !== undefined) {
			toKalshiDateToken(params.date)
		}
		const query: GetAllEventsParams = {
			series_ticker: league.gameSeries,
			with_nested_markets: true,
			with_milestones: true,
		}
		if (params.status === 'all') {
			query.maxPages = MAX_ALL_PAGES
		} else {
			query.status = 'open'
		}
		const page = await client.getAllEvents(query)
		const milestones = page.milestones ?? []
		const matched = page.events.map(function (event) {
			return {
				event,
				milestone: pickMilestone(
					milestones,
					event.event_ticker,
					league.milestoneType,
				),
			}
		})
		const date = params.date
		let included = matched
		if (date !== undefined) {
			included = matched.filter(function (row) {
				return matchesDate(
					row.event.event_ticker,
					row.milestone,
					date,
				)
			})
		}
		let truncated = page.cursor !== undefined
		if (params.status === 'all' && included.length > MAX_ALL_GAMES) {
			included = included.slice(0, MAX_ALL_GAMES)
			truncated = true
		}
		const lines = await loadListLines(client, league, included)
		const games = included.map(function (row) {
			const spreadTicker = row.milestone
				? primaryTickerForSeries(
					row.milestone,
					league.spreadSeries,
				)
				: null
			const totalTicker = row.milestone
				? primaryTickerForSeries(
					row.milestone,
					league.totalSeries,
				)
				: null
			return toSummary(
				params.league,
				row.event,
				row.milestone,
				spreadTicker
					? linesFromEvent(lines.get(spreadTicker))
					: null,
				totalTicker
					? linesFromEvent(lines.get(totalTicker))
					: null,
			)
		})
		return { games, truncated }
	}

	async function getGame (eventKey: string): Promise<GameDetail> {
		if (isUuid(eventKey)) {
			const milestone = await client.getMilestone(eventKey)
			const ticker = gameTickerFromMilestone(milestone)
			return loadGame(client, ticker, milestone)
		}
		return loadGame(client, eventKey, null)
	}

	async function getLive (milestoneId: string): Promise<GameLive> {
		const live = await client.getLiveData(milestoneId)
		return gameLiveFrom(live)
	}

	async function getLiveBatch (
		milestoneIds: string[],
	): Promise<GameLive[]> {
		const rows = await client.getLiveDataBatch(milestoneIds)
		return rows.map(gameLiveFrom)
	}

	return {
		listGames,
		getGame,
		getLive,
		getLiveBatch,
	}
}

/**
 * Kalshi date token for a calendar day.
 * `2026-11-12` becomes `26NOV12`. The day stays two digits.
 */
export function toKalshiDateToken (isoDate: string): string {
	const match = ISO_DATE.exec(isoDate)
	const year = match?.[1]
	const monthText = match?.[2]
	const day = match?.[3]
	if (!year || !monthText || !day) {
		throw new Error('date must be YYYY-MM-DD')
	}
	const month = MONTHS[Number(monthText) - 1]
	if (!month || !isRealDay(year, monthText, day)) {
		throw new Error('date must be YYYY-MM-DD')
	}
	return `${year.slice(2)}${month}${day}`
}

/** Reject `2026-02-31` and other days that do not exist. */
function isRealDay (
	year: string,
	month: string,
	day: string,
): boolean {
	const parsed = new Date(
		Date.UTC(Number(year), Number(month) - 1, Number(day)),
	)
	return parsed.getUTCFullYear() === Number(year)
		&& parsed.getUTCMonth() === Number(month) - 1
		&& parsed.getUTCDate() === Number(day)
}

async function loadGame (
	client: KalshiClient,
	eventTicker: string,
	known: Milestone | null,
): Promise<GameDetail> {
	const event = await client.getEvent(eventTicker, {
		with_nested_markets: true,
	})
	const series = seriesOf(event)
	const leagueId = leagueFromSeriesTicker(series)
	if (!leagueId) {
		throw new Error(`Unknown league series "${series}"`)
	}
	const league = LEAGUES[leagueId]
	let milestone = known
	if (!milestone) {
		const page = await client.getMilestones({
			related_event_ticker: event.event_ticker,
			limit: 50,
		})
		milestone = pickMilestone(
			page.milestones,
			event.event_ticker,
			league.milestoneType,
		)
	}
	const tickerOrder = milestone
		? eventTickersToLoad(milestone)
		: []
	const unique = tickerOrder.filter(function (ticker) {
		return ticker !== event.event_ticker
	})
	const budget = Math.max(0, MAX_GAME_EVENTS - 1)
	const pending = unique.slice(0, budget)
	const loadedExtras = await mapPool(
		pending,
		FETCH_CONCURRENCY,
		function (ticker) {
			return loadRelatedEvent(client, ticker)
		},
	)
	const extras = loadedExtras.filter(isEvent)
	const truncated = unique.length > pending.length
		|| extras.length < loadedExtras.length
	const buckets = classifyEvents(event, extras, tickerOrder)
	const live = milestone
		? await loadLive(client, milestone.id)
		: null
	const liveStatus = live ? live.status : null
	const milestoneStatus = milestone
		? statusFromDetails(milestone.details)
		: null
	const mainTicker = milestone
		? mainGameTicker(milestone)
		: null
	const main = mainTicker === null
		? undefined
		: [event, ...extras].find(function (row) {
			return row.event_ticker === mainTicker
		})
	const head = main ?? event
	const detail: GameDetail = {
		league: leagueId,
		eventTicker: mainTicker ?? event.event_ticker,
		milestoneId: milestone ? milestone.id : null,
		title: head.title,
		subTitle: head.sub_title ?? null,
		startTime: milestone ? milestone.start_date : null,
		gameStatus: liveStatus ?? milestoneStatus,
		moneyline: buckets.moneyline,
		spread: buckets.spread,
		total: buckets.total,
		teamTotal: buckets.teamTotal,
		period: buckets.period,
		props: buckets.props,
		other: buckets.other,
		live,
	}
	if (truncated) {
		detail.truncated = true
	}
	return detail
}

/**
 * A related event that Kalshi cannot serve (404, timeout,
 * upstream failure) is skipped so one bad event does not fail
 * the game.
 */
async function loadRelatedEvent (
	client: KalshiClient,
	ticker: string,
): Promise<Event | null> {
	try {
		return await client.getEvent(ticker, {
			with_nested_markets: true,
			maxRetries: RELATED_EVENT_RETRIES,
		})
	} catch (err) {
		if (err instanceof KalshiHttpError) {
			return null
		}
		throw err
	}
}

/** Live data is optional: a Kalshi failure gives `null`. */
async function loadLive (
	client: KalshiClient,
	milestoneId: string,
): Promise<GameLive | null> {
	try {
		return gameLiveFrom(await client.getLiveData(milestoneId))
	} catch (err) {
		if (err instanceof KalshiHttpError) {
			return null
		}
		throw err
	}
}

function isEvent (value: Event | null): value is Event {
	return value !== null
}

async function loadListLines (
	client: KalshiClient,
	league: LeagueConfig,
	rows: readonly MatchedGame[],
): Promise<Map<string, Event>> {
	const seen = new Set<string>()
	const tickers: string[] = []

	function add (ticker: string | null): void {
		if (!ticker || seen.has(ticker)) {
			return
		}
		seen.add(ticker)
		tickers.push(ticker)
	}

	for (const row of rows) {
		if (!row.milestone) {
			continue
		}
		add(primaryTickerForSeries(
			row.milestone,
			league.spreadSeries,
		))
		add(primaryTickerForSeries(
			row.milestone,
			league.totalSeries,
		))
	}
	const loaded = await mapPool(
		tickers,
		FETCH_CONCURRENCY,
		function (ticker) {
			return loadLine(client, ticker)
		},
	)
	const byTicker = new Map<string, Event>()
	for (const row of loaded) {
		byTicker.set(row.ticker, row.event)
	}
	return byTicker
}

async function loadLine (
	client: KalshiClient,
	ticker: string,
): Promise<LoadedLine> {
	const event = await client.getEvent(ticker, {
		with_nested_markets: true,
	})
	return {
		ticker,
		event,
	}
}

function toSummary (
	league: LeagueId,
	event: Event,
	milestone: Milestone | null,
	spread: LineQuote[] | null,
	total: LineQuote[] | null,
): GameSummary {
	return {
		league,
		eventTicker: event.event_ticker,
		milestoneId: milestone ? milestone.id : null,
		title: event.title,
		subTitle: event.sub_title ?? null,
		startTime: milestone ? milestone.start_date : null,
		gameStatus: milestone
			? statusFromDetails(milestone.details)
			: null,
		moneyline: moneylineFromEvent(event),
		spread,
		total,
	}
}

function moneylineFromEvent (event: Event): MoneylineQuote[] {
	return (event.markets ?? []).map(function (market) {
		return {
			ticker: market.ticker,
			team: market.yes_sub_title,
			quote: quoteFromMarket(market),
			status: market.status,
		}
	})
}

function linesFromEvent (
	event: Event | undefined,
): LineQuote[] {
	if (!event) {
		return []
	}
	return (event.markets ?? []).map(function (market) {
		return lineFromMarket(market)
	})
}

function lineFromMarket (market: Market): LineQuote {
	const label = market.yes_sub_title.length > 0
		? market.yes_sub_title
		: market.ticker
	return {
		ticker: market.ticker,
		label,
		quote: quoteFromMarket(market),
		status: market.status,
	}
}

function classifyEvents (
	root: Event,
	extras: readonly Event[],
	tickerOrder: readonly string[],
): Buckets {
	const byTicker = new Map<string, Event>()
	byTicker.set(root.event_ticker, root)
	for (const extra of extras) {
		byTicker.set(extra.event_ticker, extra)
	}
	const buckets = emptyBuckets()
	const seen = new Set<string>()

	function take (event: Event | undefined): void {
		if (!event || seen.has(event.event_ticker)) {
			return
		}
		seen.add(event.event_ticker)
		const series = seriesOf(event)
		for (const market of event.markets ?? []) {
			pushClassified(buckets, market, series)
		}
	}

	take(root)
	for (const ticker of tickerOrder) {
		take(byTicker.get(ticker))
	}
	for (const extra of extras) {
		take(extra)
	}
	return buckets
}

function pushClassified (
	buckets: Buckets,
	market: Market,
	series: string,
): void {
	const category = classifySeriesTicker(series)
	if (category === 'moneyline') {
		buckets.moneyline.push({
			ticker: market.ticker,
			team: market.yes_sub_title,
			quote: quoteFromMarket(market),
			status: market.status,
		})
		return
	}
	const line = lineFromMarket(market)
	const key = bucketKey(category)
	buckets[key].push(line)
}

function bucketKey (
	category: Exclude<MarketCategory, 'moneyline'>,
): keyof Omit<Buckets, 'moneyline'> {
	if (category === 'spread') {
		return 'spread'
	}
	if (category === 'total') {
		return 'total'
	}
	if (category === 'team_total') {
		return 'teamTotal'
	}
	if (category === 'period') {
		return 'period'
	}
	if (category === 'prop') {
		return 'props'
	}
	return 'other'
}

function emptyBuckets (): Buckets {
	return {
		moneyline: [],
		spread: [],
		total: [],
		teamTotal: [],
		period: [],
		props: [],
		other: [],
	}
}

function seriesOf (event: Event): string {
	if (event.series_ticker.length > 0) {
		return event.series_ticker
	}
	return seriesTickerFromEventTicker(event.event_ticker)
}

/**
 * A milestone belongs to an event when the ticker is listed
 * on it, or `details.main_game_event_ticker` equals it.
 * Callers must not pair rows by array index.
 */
function milestoneMatches (
	milestone: Milestone,
	eventTicker: string,
): boolean {
	if (tickerList(milestone.primary_event_tickers)
		.includes(eventTicker)) {
		return true
	}
	if (tickerList(milestone.related_event_tickers)
		.includes(eventTicker)) {
		return true
	}
	return milestone.details.main_game_event_ticker === eventTicker
}

function pickMilestone (
	milestones: readonly Milestone[],
	eventTicker: string,
	milestoneType: string,
): Milestone | null {
	const matches = milestones.filter(function (row) {
		return milestoneMatches(row, eventTicker)
	})
	if (matches.length === 0) {
		return null
	}
	const byMain = matches.find(function (row) {
		return row.details.main_game_event_ticker === eventTicker
	})
	if (byMain) {
		return byMain
	}
	const byType = matches.find(function (row) {
		return row.type === milestoneType
	})
	if (byType) {
		return byType
	}
	return matches[0] ?? null
}

function primaryTickerForSeries (
	milestone: Milestone,
	series: string,
): string | null {
	for (const ticker of tickerList(milestone.primary_event_tickers)) {
		if (seriesTickerFromEventTicker(ticker) === series) {
			return ticker
		}
	}
	return null
}

/** Primary then related event tickers, de-duplicated. */
function eventTickersToLoad (milestone: Milestone): string[] {
	return uniqueTickers([
		...tickerList(milestone.primary_event_tickers),
		...tickerList(milestone.related_event_tickers),
	])
}

function mainGameTicker (milestone: Milestone): string | null {
	const main = milestone.details.main_game_event_ticker
	if (typeof main === 'string' && main.length > 0) {
		return main
	}
	return null
}

function gameTickerFromMilestone (milestone: Milestone): string {
	const main = mainGameTicker(milestone)
	if (main !== null) {
		return main
	}
	const tickers = [
		...tickerList(milestone.primary_event_tickers),
		...tickerList(milestone.related_event_tickers),
	]
	for (const ticker of tickers) {
		const series = seriesTickerFromEventTicker(ticker)
		if (classifySeriesTicker(series) === 'moneyline') {
			return ticker
		}
	}
	throw new Error(
		`Milestone ${milestone.id} has no game event`,
	)
}

function tickerList (
	value: readonly string[] | undefined,
): readonly string[] {
	return value ?? []
}

function uniqueTickers (tickers: readonly string[]): string[] {
	const seen = new Set<string>()
	const result: string[] = []
	for (const ticker of tickers) {
		if (ticker.length === 0 || seen.has(ticker)) {
			continue
		}
		seen.add(ticker)
		result.push(ticker)
	}
	return result
}

function matchesDate (
	eventTicker: string,
	milestone: Milestone | null,
	date: string,
): boolean {
	const embedded = tickerDateToken(eventTicker)
	if (embedded) {
		return embedded === toKalshiDateToken(date)
	}
	if (!milestone) {
		return false
	}
	return utcDay(milestone.start_date) === date
}

function tickerDateToken (eventTicker: string): string | null {
	const match = DATE_TOKEN.exec(eventTicker.toUpperCase())
	const token = match?.[0]
	return token ?? null
}

function utcDay (iso: string): string | null {
	const parsed = new Date(iso)
	if (Number.isNaN(parsed.getTime())) {
		return null
	}
	const year = parsed.getUTCFullYear()
	const month = parsed.getUTCMonth() + 1
	const day = parsed.getUTCDate()
	const monthText = month < 10 ? `0${month}` : String(month)
	const dayText = day < 10 ? `0${day}` : String(day)
	return `${year}-${monthText}-${dayText}`
}

function isUuid (value: string): boolean {
	return UUID_RE.test(value)
}

function statusFromDetails (
	details: Record<string, unknown>,
): string | null {
	return readString(details.status)
}

function gameLiveFrom (live: LiveData): GameLive {
	const details = live.details
	const snapshot: GameLive = {
		milestoneId: live.milestone_id,
		type: live.type,
		status: readString(details.status),
		homePoints: readNumber(details.home_points),
		awayPoints: readNumber(details.away_points),
		clock: readString(details.clock)
			?? readString(details.period_remaining_time)
			?? readString(details.game_clock),
		period: readPeriod(details),
		winner: readString(details.winner),
		delayed: readDelayed(details),
		raw: omitMappings(details),
	}
	const updated = readNumber(details.last_updated_ts)
	if (updated !== null) {
		snapshot.lastUpdatedTs = updated
	}
	return snapshot
}

function readPeriod (
	details: Record<string, unknown>,
): string | number | null {
	const value = details.quarter
		?? details.period
		?? details.half
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value
	}
	if (typeof value === 'string' && value.length > 0) {
		return value
	}
	return null
}

function readDelayed (details: Record<string, unknown>): boolean {
	const value = details.live_data_delayed
	return value === true || value === 'true'
}

function omitMappings (
	details: Record<string, unknown>,
): Record<string, unknown> {
	const raw: Record<string, unknown> = {}
	for (const key of Object.keys(details)) {
		if (key.endsWith('_mapping')) {
			continue
		}
		const value = details[key]
		if (value !== undefined) {
			raw[key] = value
		}
	}
	return raw
}

function readString (value: unknown): string | null {
	if (typeof value !== 'string' || value.length === 0) {
		return null
	}
	return value
}

function readNumber (value: unknown): number | null {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : null
	}
	if (typeof value !== 'string') {
		return null
	}
	const trimmed = value.trim()
	if (trimmed.length === 0) {
		return null
	}
	const parsed = Number(trimmed)
	return Number.isFinite(parsed) ? parsed : null
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 * Results stay in input order. After the first rejection no
 * new item starts.
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
	let failed = false
	const workers = Math.max(
		1,
		Math.min(limit, items.length),
	)

	async function run (): Promise<void> {
		while (!failed && next < items.length) {
			const index = next
			next += 1
			const item = items[index]
			if (item === undefined) {
				continue
			}
			try {
				results[index] = await worker(item)
			} catch (err) {
				failed = true
				throw err
			}
		}
	}

	const tasks: Promise<void>[] = []
	for (let slot = 0; slot < workers; slot += 1) {
		tasks.push(run())
	}
	await Promise.all(tasks)
	return results
}
