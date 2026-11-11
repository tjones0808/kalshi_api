import express, {
	type Request,
	type Response,
	type Router,
} from 'express'
import { z } from 'zod'
import type { AppServices } from '../app.js'
import { refineCandleRange } from '../candles-schema.js'
import { optionalInt, optionalText } from '../query-helpers.js'
import type { ListGamesParams } from '../../domain/games-service.js'
import {
	LEAGUES,
	parseLeagueId,
} from '../../domain/leagues.js'
import type { LeagueId } from '../../domain/leagues.js'
import { seriesTickerFromEventTicker } from '../../domain/market-classify.js'
import { quoteFromMarket } from '../../domain/prices.js'
import { discoverLeagueSeries } from '../../domain/series-discovery.js'
import type { CandlestickPeriodInterval } from '../../kalshi/kalshi-client.js'
import type { GetTradesParams } from '../../kalshi/kalshi-client.js'
import type {
	Market,
	OrderbookFp,
	Series,
} from '../../kalshi/types.js'

const datePattern = /^\d{4}-\d{2}-\d{2}$/

const gamesQuerySchema = z.object({
	date: z.string().regex(datePattern).optional(),
	status: z.enum(['open', 'all']).default('open'),
})

const tradesQuerySchema = z.object({
	limit: optionalInt(1, 1000),
	cursor: optionalText(),
	min_ts: optionalInt(0),
	max_ts: optionalInt(0),
})

const candlesQuerySchema = z.object({
	interval: z.enum(['1', '60', '1440']),
	start_ts: z.coerce.number().int().nonnegative(),
	end_ts: z.coerce.number().int().nonnegative(),
}).superRefine(refineCandleRange)

const liveBatchSchema = z.object({
	milestoneIds: z.array(z.string().min(1)).min(1).max(100),
})

const parlayPriceSchema = z.object({
	legs: z.array(z.object({
		ticker: z.string().min(1),
		side: z.enum(['yes', 'no']),
	})).min(1).max(12),
})

interface BidLevel {
	price: string
	count: string
}

interface OrderbookView {
	orderbook_fp: OrderbookFp | null
	best_yes_bid: BidLevel | null
	best_no_bid: BidLevel | null
}

function readParam (
	params: Request['params'],
	name: string,
): string {
	return z.string().min(1).parse(params[name])
}

/**
 * `nba` or `nfl`, case-insensitive.
 * Any other value becomes the fixed client error
 * `Unknown league`.
 */
function readLeague (value: string): LeagueId {
	try {
		return parseLeagueId(value)
	} catch (err) {
		if (
			err instanceof Error
			&& err.message.startsWith('Unknown league')
		) {
			throw new Error('Unknown league')
		}
		throw err
	}
}

function periodInterval (
	interval: '1' | '60' | '1440',
): CandlestickPeriodInterval {
	if (interval === '1') {
		return 1
	}
	if (interval === '60') {
		return 60
	}
	return 1440
}

function compactSeries (row: Series) {
	return {
		ticker: row.ticker,
		title: row.title,
		category: row.category,
		tags: row.tags ?? [],
		frequency: row.frequency,
	}
}

function compactMarket (market: Market) {
	return {
		ticker: market.ticker,
		event_ticker: market.event_ticker,
		status: market.status,
		yes_sub_title: market.yes_sub_title,
		quote: quoteFromMarket(market),
		volume_fp: market.volume_fp ?? null,
		close_time: market.close_time ?? null,
	}
}

/**
 * Highest bid on one side of a fixed-point book.
 * Levels are `[priceDollars, count]`. A missing or
 * empty side has no best bid.
 */
function bestBid (
	levels: readonly [string, string][] | undefined,
): BidLevel | null {
	if (levels === undefined || levels.length === 0) {
		return null
	}
	let best: BidLevel | null = null
	let bestPrice = Number.NEGATIVE_INFINITY
	for (const level of levels) {
		const price = level[0]
		const count = level[1]
		if (price === undefined || count === undefined) {
			continue
		}
		const numeric = Number(price)
		if (!Number.isFinite(numeric)) {
			continue
		}
		if (numeric <= bestPrice) {
			continue
		}
		bestPrice = numeric
		best = {
			price,
			count,
		}
	}
	return best
}

function orderbookView (
	book: { orderbook_fp?: OrderbookFp },
): OrderbookView {
	const fp = book.orderbook_fp
	return {
		orderbook_fp: fp ?? null,
		best_yes_bid: bestBid(fp?.yes_dollars),
		best_no_bid: bestBid(fp?.no_dollars),
	}
}

function gamesParams (
	league: LeagueId,
	query: z.infer<typeof gamesQuerySchema>,
): ListGamesParams {
	const params: ListGamesParams = {
		league,
		status: query.status,
	}
	if (query.date !== undefined) {
		params.date = query.date
	}
	return params
}

function tradesParams (
	ticker: string,
	query: z.infer<typeof tradesQuerySchema>,
): GetTradesParams {
	const params: GetTradesParams = {
		ticker,
	}
	if (query.limit !== undefined) {
		params.limit = query.limit
	}
	if (query.cursor !== undefined) {
		params.cursor = query.cursor
	}
	if (query.min_ts !== undefined) {
		params.min_ts = query.min_ts
	}
	if (query.max_ts !== undefined) {
		params.max_ts = query.max_ts
	}
	return params
}

/**
 * Business routes mounted at `/v1`.
 *
 * The app has already required an API key. Query and
 * body values are checked with zod. Kalshi and domain
 * failures propagate to the error handler.
 */
export function createV1Router (
	services: AppServices,
): Router {
	const router = express.Router()

	router.get('/exchange/status', getExchangeStatus)
	router.get('/leagues/:league/series', getLeagueSeries)
	router.get('/leagues/:league/games', getLeagueGames)
	router.get('/games/:eventKey', getGame)
	router.get('/markets/:ticker/orderbook', getOrderbook)
	router.get('/markets/:ticker/trades', getTrades)
	router.get(
		'/markets/:ticker/candlesticks',
		getCandlesticks,
	)
	router.get('/markets/:ticker', getMarket)
	router.post('/live/batch', postLiveBatch)
	router.get('/live/:milestoneId', getLive)
	router.post('/parlays/price', postParlayPrice)

	async function getExchangeStatus (
		_req: Request,
		res: Response,
	): Promise<void> {
		const status = await services.kalshi.getExchangeStatus()
		res.status(200).json(status)
	}

	async function getLeagueSeries (
		req: Request,
		res: Response,
	): Promise<void> {
		const league = readLeague(
			readParam(req.params, 'league'),
		)
		const rows = await discoverLeagueSeries(
			services.kalshi,
			LEAGUES[league],
		)
		res.status(200).json({
			league,
			series: rows.map(compactSeries),
		})
	}

	async function getLeagueGames (
		req: Request,
		res: Response,
	): Promise<void> {
		const league = readLeague(
			readParam(req.params, 'league'),
		)
		const query = gamesQuerySchema.parse(req.query)
		const list = await services.games.listGames(
			gamesParams(league, query),
		)
		res.status(200).json({
			league,
			games: list.games,
			truncated: list.truncated,
		})
	}

	async function getGame (
		req: Request,
		res: Response,
	): Promise<void> {
		const eventKey = readParam(req.params, 'eventKey')
		const game = await services.games.getGame(eventKey)
		res.status(200).json(game)
	}

	async function getMarket (
		req: Request,
		res: Response,
	): Promise<void> {
		const ticker = readParam(req.params, 'ticker')
		const market = await services.kalshi.getMarket(ticker)
		res.status(200).json(compactMarket(market))
	}

	async function getOrderbook (
		req: Request,
		res: Response,
	): Promise<void> {
		const ticker = readParam(req.params, 'ticker')
		const book = await services.kalshi.getMarketOrderbook(
			ticker,
		)
		res.status(200).json(orderbookView(book))
	}

	async function getTrades (
		req: Request,
		res: Response,
	): Promise<void> {
		const ticker = readParam(req.params, 'ticker')
		const query = tradesQuerySchema.parse(req.query)
		const trades = await services.kalshi.getTrades(
			tradesParams(ticker, query),
		)
		res.status(200).json(trades)
	}

	async function getCandlesticks (
		req: Request,
		res: Response,
	): Promise<void> {
		const ticker = readParam(req.params, 'ticker')
		const query = candlesQuerySchema.parse(req.query)
		const market = await services.kalshi.getMarket(ticker)
		const seriesTicker = seriesTickerFromEventTicker(
			market.event_ticker,
		)
		const candles = await services.kalshi
			.getMarketCandlesticks(
				seriesTicker,
				ticker,
				{
					start_ts: query.start_ts,
					end_ts: query.end_ts,
					period_interval: periodInterval(
						query.interval,
					),
				},
			)
		res.status(200).json(candles)
	}

	async function getLive (
		req: Request,
		res: Response,
	): Promise<void> {
		const milestoneId = readParam(
			req.params,
			'milestoneId',
		)
		const live = await services.games.getLive(milestoneId)
		res.status(200).json(live)
	}

	async function postLiveBatch (
		req: Request,
		res: Response,
	): Promise<void> {
		const body = liveBatchSchema.parse(req.body)
		const live = await services.games.getLiveBatch(
			body.milestoneIds,
		)
		res.status(200).json(live)
	}

	async function postParlayPrice (
		req: Request,
		res: Response,
	): Promise<void> {
		const body = parlayPriceSchema.parse(req.body)
		const price = await services.parlay.priceParlay(
			body.legs,
		)
		res.status(200).json(price)
	}

	return router
}
