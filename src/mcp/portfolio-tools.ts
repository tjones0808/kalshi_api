import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { PortfolioService } from '../domain/portfolio-service.js'
import { omitUndefined } from '../http/query-helpers.js'
import { runTool } from './tool-result.js'

const MAX_LIMIT = 1000

const subaccount = z.number().int().min(0).optional()
const exchangeIndex = z.number().int().min(0).optional()
const timestamp = z.number().int().min(0).optional()
const limit = z.number().int().min(1).max(MAX_LIMIT).optional()
const cursor = z.string().min(1).optional()
const text = z.string().min(1).optional()

const balanceInput = z.object({
	subaccount,
	exchange_index: exchangeIndex,
})

const positionsInput = z.object({
	cursor,
	limit,
	count_filter: z.string()
		.regex(/^(position|total_traded)(,(position|total_traded))*$/)
		.optional(),
	settlement_status: z.enum(['unsettled', 'settled', 'all'])
		.optional(),
	ticker: text,
	event_ticker: text,
	subaccount,
	exchange_index: exchangeIndex,
})

const fillsInput = z.object({
	ticker: text,
	order_id: text,
	min_ts: timestamp,
	max_ts: timestamp,
	limit,
	cursor,
	subaccount,
	exchange_index: exchangeIndex,
})

const ordersInput = z.object({
	ticker: text,
	event_ticker: text,
	min_ts: timestamp,
	max_ts: timestamp,
	status: z.enum(['resting', 'canceled', 'executed']).optional(),
	limit,
	cursor,
	subaccount,
	exchange_index: exchangeIndex,
})

const settlementsInput = z.object({
	ticker: text,
	event_ticker: text,
	min_ts: timestamp,
	max_ts: timestamp,
	subaccount,
	limit,
	cursor,
})

/**
 * Register the read-only account tools: `get_balance`,
 * `get_positions`, `get_fills`, `get_orders` and
 * `get_settlements`. There are no tools that place, amend or
 * cancel orders. Call this only for callers allowed to read
 * the portfolio.
 */
export function registerPortfolioTools (
	server: McpServer,
	portfolio: PortfolioService,
): void {
	server.registerTool(
		'get_balance',
		{
			description:
				'Kalshi account cash balance and portfolio value, '
				+ 'in dollars.',
			inputSchema: balanceInput,
		},
		async function (args) {
			return runTool(function () {
				return portfolio.getBalance(omitUndefined(args))
			})
		},
	)

	server.registerTool(
		'get_positions',
		{
			description:
				'Open positions by market and event. position is '
				+ 'signed contracts: positive YES, negative NO. '
				+ 'Pass the returned cursor back for the next page.',
			inputSchema: positionsInput,
		},
		async function (args) {
			return runTool(function () {
				return portfolio.getPositions(omitUndefined(args))
			})
		},
	)

	server.registerTool(
		'get_fills',
		{
			description:
				'Matched trades (fills) for the account. min_ts '
				+ 'and max_ts are unix seconds. Pass the returned '
				+ 'cursor back for the next page.',
			inputSchema: fillsInput,
		},
		async function (args) {
			return runTool(function () {
				return portfolio.getFills(omitUndefined(args))
			})
		},
	)

	server.registerTool(
		'get_orders',
		{
			description:
				'Orders for the account. status is resting, '
				+ 'canceled, or executed. min_ts and max_ts are '
				+ 'unix seconds. Pass the returned cursor back '
				+ 'for the next page.',
			inputSchema: ordersInput,
		},
		async function (args) {
			return runTool(function () {
				return portfolio.getOrders(omitUndefined(args))
			})
		},
	)

	server.registerTool(
		'get_settlements',
		{
			description:
				'Settled markets and their payouts for the '
				+ 'account. min_ts and max_ts are unix seconds. '
				+ 'Pass the returned cursor back for the next '
				+ 'page.',
			inputSchema: settlementsInput,
		},
		async function (args) {
			return runTool(function () {
				return portfolio.getSettlements(omitUndefined(args))
			})
		},
	)
}
