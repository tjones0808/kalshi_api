import type {
	NextFunction,
	Request,
	RequestHandler,
	Response,
} from 'express'
import {
	toNodeHandler,
	type NodeIncomingMessageLike,
} from '@modelcontextprotocol/node'
import {
	McpServer,
	createMcpHandler,
} from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { ListGamesParams } from '../domain/games-service.js'
import { seriesTickerFromEventTicker } from '../domain/market-classify.js'
import { quoteFromMarket } from '../domain/prices.js'
import type { AppServices } from '../http/app.js'
import type { PortfolioAccess } from '../http/auth.js'
import { refineCandleRange } from '../http/candles-schema.js'
import type {
	GetMarketCandlesticksParams,
	GetTradesParams,
} from '../kalshi/kalshi-client.js'
import type { Market } from '../kalshi/types.js'
import { registerPortfolioTools } from './portfolio-tools.js'
import { runTool } from './tool-result.js'

const datePattern = /^\d{4}-\d{2}-\d{2}$/

const emptyInput = z.object({})

const listGamesInput = z.object({
	league: z.enum(['nba', 'nfl']),
	date: z.string().regex(datePattern).optional(),
	status: z.enum(['open', 'all']).default('open'),
})

const eventKeyInput = z.object({
	eventKey: z.string().min(1),
})

const tickerInput = z.object({
	ticker: z.string().min(1),
})

const candlesInput = z.object({
	ticker: z.string().min(1),
	interval: z.union([
		z.literal(1),
		z.literal(60),
		z.literal(1440),
	]),
	start_ts: z.number().int().nonnegative(),
	end_ts: z.number().int().nonnegative(),
}).superRefine(refineCandleRange)

const tradesInput = z.object({
	ticker: z.string().min(1),
	limit: z.number().int().min(1).max(1000).optional(),
	cursor: z.string().min(1).optional(),
	min_ts: z.number().int().nonnegative().optional(),
	max_ts: z.number().int().nonnegative().optional(),
})

const liveInput = z.object({
	milestoneId: z.string().min(1),
})

const parlayInput = z.object({
	legs: z.array(z.object({
		ticker: z.string().min(1),
		side: z.enum(['yes', 'no']),
	})).min(1).max(12),
})

type ListGamesInput = z.infer<typeof listGamesInput>
type CandlesInput = z.infer<typeof candlesInput>
type TradesInput = z.infer<typeof tradesInput>

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

function listGamesParams (
	args: ListGamesInput,
): ListGamesParams {
	const params: ListGamesParams = {
		league: args.league,
		status: args.status,
	}
	if (args.date !== undefined) {
		params.date = args.date
	}
	return params
}

function candlesParams (
	args: CandlesInput,
): GetMarketCandlesticksParams {
	return {
		start_ts: args.start_ts,
		end_ts: args.end_ts,
		period_interval: args.interval,
	}
}

function tradesParams (
	args: TradesInput,
): GetTradesParams {
	const params: GetTradesParams = {
		ticker: args.ticker,
	}
	if (args.limit !== undefined) {
		params.limit = args.limit
	}
	if (args.cursor !== undefined) {
		params.cursor = args.cursor
	}
	if (args.min_ts !== undefined) {
		params.min_ts = args.min_ts
	}
	if (args.max_ts !== undefined) {
		params.max_ts = args.max_ts
	}
	return params
}

function registerExchangeStatus (
	server: McpServer,
	services: AppServices,
): void {
	server.registerTool(
		'exchange_status',
		{
			description:
				'Whether the Kalshi exchange is accepting trades.',
			inputSchema: emptyInput,
		},
		async function () {
			return runTool(function () {
				return services.kalshi.getExchangeStatus()
			})
		},
	)
}

function registerListGames (
	server: McpServer,
	services: AppServices,
): void {
	server.registerTool(
		'list_games',
		{
			description:
				'List NBA or NFL games. date is YYYY-MM-DD. '
				+ 'status defaults to open. truncated is true '
				+ 'when the list may be incomplete.',
			inputSchema: listGamesInput,
		},
		async function (args) {
			return runTool(async function () {
				const list = await services.games.listGames(
					listGamesParams(args),
				)
				return {
					league: args.league,
					games: list.games,
					truncated: list.truncated,
				}
			})
		},
	)
}

function registerGameMarkets (
	server: McpServer,
	services: AppServices,
): void {
	server.registerTool(
		'get_game_markets',
		{
			description:
				'Load one game by GAME ticker or milestone '
				+ 'UUID, with markets grouped by category.',
			inputSchema: eventKeyInput,
		},
		async function (args) {
			return runTool(function () {
				return services.games.getGame(args.eventKey)
			})
		},
	)
}

function registerMarket (
	server: McpServer,
	services: AppServices,
): void {
	server.registerTool(
		'get_market',
		{
			description:
				'Compact quote for one market ticker.',
			inputSchema: tickerInput,
		},
		async function (args) {
			return runTool(async function () {
				const market = await services.kalshi.getMarket(
					args.ticker,
				)
				return compactMarket(market)
			})
		},
	)
}

function registerOrderbook (
	server: McpServer,
	services: AppServices,
): void {
	server.registerTool(
		'get_orderbook',
		{
			description:
				'Fixed-point order book for one market ticker.',
			inputSchema: tickerInput,
		},
		async function (args) {
			return runTool(async function () {
				const book = await services.kalshi
					.getMarketOrderbook(args.ticker)
				return {
					orderbook_fp: book.orderbook_fp ?? null,
				}
			})
		},
	)
}

function registerCandlesticks (
	server: McpServer,
	services: AppServices,
): void {
	server.registerTool(
		'get_candlesticks',
		{
			description:
				'Candlesticks for one market. interval is 1, '
				+ '60, or 1440 minutes. start_ts and end_ts '
				+ 'are unix seconds.',
			inputSchema: candlesInput,
		},
		async function (args) {
			return runTool(async function () {
				const market = await services.kalshi.getMarket(
					args.ticker,
				)
				const seriesTicker = seriesTickerFromEventTicker(
					market.event_ticker,
				)
				return services.kalshi.getMarketCandlesticks(
					seriesTicker,
					args.ticker,
					candlesParams(args),
				)
			})
		},
	)
}

function registerTrades (
	server: McpServer,
	services: AppServices,
): void {
	server.registerTool(
		'get_trades',
		{
			description: 'Trades for one market ticker.',
			inputSchema: tradesInput,
		},
		async function (args) {
			return runTool(function () {
				return services.kalshi.getTrades(
					tradesParams(args),
				)
			})
		},
	)
}

function registerLiveGame (
	server: McpServer,
	services: AppServices,
): void {
	server.registerTool(
		'get_live_game',
		{
			description: 'Live snapshot for one milestone.',
			inputSchema: liveInput,
		},
		async function (args) {
			return runTool(function () {
				return services.games.getLive(
					args.milestoneId,
				)
			})
		},
	)
}

function registerParlay (
	server: McpServer,
	services: AppServices,
): void {
	server.registerTool(
		'price_parlay',
		{
			description:
				'Price to buy a parlay, from current asks. '
				+ 'Includes the spread and assumes the legs '
				+ 'are independent. One to twelve legs.',
			inputSchema: parlayInput,
		},
		async function (args) {
			return runTool(function () {
				return services.parlay.priceParlay(args.legs)
			})
		},
	)
}

/**
 * MCP server for one request.
 * Tools return compact JSON text. Kalshi and domain
 * failures become `isError` results with a short message
 * and no stack. The portfolio tools are registered only when
 * `includePortfolio` is true and `services.portfolio` exists,
 * so a caller who may not read the account does not even
 * see them.
 */
export function createKalshiMcpServer (
	services: AppServices,
	includePortfolio = false,
): McpServer {
	const server = new McpServer({
		name: 'kalshi-sports-api',
		version: '0.1.0',
	})
	registerExchangeStatus(server, services)
	registerListGames(server, services)
	registerGameMarkets(server, services)
	registerMarket(server, services)
	registerOrderbook(server, services)
	registerCandlesticks(server, services)
	registerTrades(server, services)
	registerLiveGame(server, services)
	registerParlay(server, services)
	if (includePortfolio && services.portfolio !== undefined) {
		registerPortfolioTools(server, services.portfolio)
	}
	return server
}

/**
 * Streamable HTTP handler for `/mcp`.
 *
 * `createMcpHandler` builds a fresh server per request. Two
 * handlers are made once: one with the portfolio tools and one
 * without. Each request picks by its API key index, so the
 * five portfolio tools exist only for keys that
 * `canUsePortfolio` allows and only when credentials are
 * configured. `req.body` is forwarded because `express.json`
 * already consumed the stream. A rejected adapter promise is
 * passed to `next`. This does not check Host or Origin
 * and does not add a second OAuth layer.
 */
export function createMcpExpressHandler (
	services: AppServices,
	canUsePortfolio: PortfolioAccess = function () {
		return false
	},
): RequestHandler {
	const publicNode = toNodeHandler(
		createMcpHandler(function () {
			return createKalshiMcpServer(services, false)
		}),
	)
	const portfolioNode = toNodeHandler(
		createMcpHandler(function () {
			return createKalshiMcpServer(services, true)
		}),
	)
	return function (
		req: Request,
		res: Response,
		next: NextFunction,
	): void {
		const node = canUsePortfolio(req.auth?.keyIndex)
			? portfolioNode
			: publicNode
		// `req.auth` is our key index, not MCP AuthInfo.
		const incoming =
			req as unknown as NodeIncomingMessageLike
		node(incoming, res, req.body).catch(
			function (err: unknown) {
				next(err)
			},
		)
	}
}
