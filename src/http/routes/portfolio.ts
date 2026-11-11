import express, {
	type NextFunction,
	type Request,
	type RequestHandler,
	type Response,
	type Router,
} from 'express'
import { z } from 'zod'
import type { PortfolioService } from '../../domain/portfolio-service.js'
import type { PortfolioAccess } from '../auth.js'
import {
	omitUndefined,
	optionalInt,
	optionalText,
} from '../query-helpers.js'

const MAX_LIMIT = 1000

const balanceQuerySchema = z.object({
	subaccount: optionalInt(0),
	exchange_index: optionalInt(0),
})

const positionsQuerySchema = z.object({
	cursor: optionalText(),
	limit: optionalInt(1, MAX_LIMIT),
	count_filter: z.preprocess(
		blankToUndefined,
		z.string()
			.regex(/^(position|total_traded)(,(position|total_traded))*$/)
			.optional(),
	),
	settlement_status: z.preprocess(
		blankToUndefined,
		z.enum(['unsettled', 'settled', 'all']).optional(),
	),
	ticker: optionalText(),
	event_ticker: optionalText(),
	subaccount: optionalInt(0),
	exchange_index: optionalInt(0),
})

const fillsQuerySchema = z.object({
	ticker: optionalText(),
	order_id: optionalText(),
	min_ts: optionalInt(0),
	max_ts: optionalInt(0),
	limit: optionalInt(1, MAX_LIMIT),
	cursor: optionalText(),
	subaccount: optionalInt(0),
	exchange_index: optionalInt(0),
})

const ordersQuerySchema = z.object({
	ticker: optionalText(),
	event_ticker: optionalText(),
	min_ts: optionalInt(0),
	max_ts: optionalInt(0),
	status: z.preprocess(
		blankToUndefined,
		z.enum(['resting', 'canceled', 'executed']).optional(),
	),
	limit: optionalInt(1, MAX_LIMIT),
	cursor: optionalText(),
	subaccount: optionalInt(0),
	exchange_index: optionalInt(0),
})

const settlementsQuerySchema = z.object({
	ticker: optionalText(),
	event_ticker: optionalText(),
	min_ts: optionalInt(0),
	max_ts: optionalInt(0),
	subaccount: optionalInt(0),
	limit: optionalInt(1, MAX_LIMIT),
	cursor: optionalText(),
})

function blankToUndefined (value: unknown): unknown {
	return value === '' ? undefined : value
}

function noStore (
	_req: Request,
	res: Response,
	next: NextFunction,
): void {
	res.set('Cache-Control', 'no-store')
	next()
}

function sendNotConfigured (
	_req: Request,
	res: Response,
): void {
	res.status(503).json({
		error: 'portfolio_not_configured',
		message: 'Portfolio access is not configured',
	})
}

function requireAccess (access: PortfolioAccess): RequestHandler {
	return function portfolioAccessMiddleware (
		req: Request,
		res: Response,
		next: NextFunction,
	): void {
		if (!access(req.auth?.keyIndex)) {
			res.status(403).json({
				error: 'forbidden',
				message: 'This API key cannot access the portfolio',
			})
			return
		}
		next()
	}
}

/**
 * Read-only portfolio routes, mounted at `/v1/portfolio`.
 *
 * Every response, errors included, carries
 * `Cache-Control: no-store`. With no `portfolio` service (no
 * Kalshi credentials) every path is 503
 * `portfolio_not_configured`. Otherwise a key outside
 * `PORTFOLIO_API_KEYS` gets 403 `forbidden`. Only GET routes
 * exist; there is no way to place, amend or cancel an order.
 */
export function createPortfolioRouter (
	portfolio: PortfolioService | undefined,
	access: PortfolioAccess,
): Router {
	const router = express.Router()
	router.use(noStore)
	if (portfolio === undefined) {
		router.use(sendNotConfigured)
		return router
	}
	router.use(requireAccess(access))
	const service = portfolio

	router.get('/balance', getBalance)
	router.get('/positions', getPositions)
	router.get('/fills', getFills)
	router.get('/orders', getOrders)
	router.get('/settlements', getSettlements)

	async function getBalance (
		req: Request,
		res: Response,
	): Promise<void> {
		const query = balanceQuerySchema.parse(req.query)
		res.status(200).json(
			await service.getBalance(omitUndefined(query)),
		)
	}

	async function getPositions (
		req: Request,
		res: Response,
	): Promise<void> {
		const query = positionsQuerySchema.parse(req.query)
		res.status(200).json(
			await service.getPositions(omitUndefined(query)),
		)
	}

	async function getFills (
		req: Request,
		res: Response,
	): Promise<void> {
		const query = fillsQuerySchema.parse(req.query)
		res.status(200).json(
			await service.getFills(omitUndefined(query)),
		)
	}

	async function getOrders (
		req: Request,
		res: Response,
	): Promise<void> {
		const query = ordersQuerySchema.parse(req.query)
		res.status(200).json(
			await service.getOrders(omitUndefined(query)),
		)
	}

	async function getSettlements (
		req: Request,
		res: Response,
	): Promise<void> {
		const query = settlementsQuerySchema.parse(req.query)
		res.status(200).json(
			await service.getSettlements(omitUndefined(query)),
		)
	}

	return router
}
