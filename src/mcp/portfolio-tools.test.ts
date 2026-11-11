import type { Response } from 'supertest'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { parseEnv } from '../config/env.js'
import type { GamesService } from '../domain/games-service.js'
import type { ParlayService } from '../domain/parlay-service.js'
import type { PortfolioService } from '../domain/portfolio-service.js'
import { createApp } from '../http/app.js'
import type { AppServices } from '../http/app.js'
import {
	KalshiAuthError,
	KalshiAuthNotConfiguredError,
} from '../kalshi/errors.js'
import type { KalshiClient } from '../kalshi/kalshi-client.js'

const keyOne = 'a'.repeat(32)
const keyTwo = 'b'.repeat(32)
const accept = 'application/json, text/event-stream'
const portfolioTools = [
	'get_balance',
	'get_fills',
	'get_orders',
	'get_positions',
	'get_settlements',
]

interface RpcBody {
	jsonrpc?: string
	result?: {
		isError?: boolean
		content?: Array<{ text?: string }>
		tools?: Array<{ name?: string }>
	}
	error?: { message?: string }
}

function parseRpc (text: string): RpcBody {
	const trimmed = text.trim()
	if (trimmed.startsWith('{')) {
		return JSON.parse(trimmed) as RpcBody
	}
	for (const line of trimmed.split('\n')) {
		if (line.startsWith('data:')) {
			const payload = line.slice('data:'.length).trim()
			if (payload.length > 0) {
				return JSON.parse(payload) as RpcBody
			}
		}
	}
	throw new Error(`No JSON-RPC message in ${trimmed}`)
}

function envWith (extra: Record<string, string> = {}) {
	return parseEnv({
		API_KEYS: `${keyOne},${keyTwo}`,
		RATE_LIMIT_MAX: '100',
		RATE_LIMIT_ANON_MAX: '100',
		...extra,
	})
}

function portfolioStub (
	parts: Partial<PortfolioService> = {},
): PortfolioService {
	return {
		getBalance: vi.fn(async function () {
			return {
				balance: 12.34,
				portfolioValue: 5,
				updatedTs: 1,
				byExchangeIndex: null,
			}
		}),
		getPositions: vi.fn(async function () {
			return {
				marketPositions: [],
				eventPositions: [],
				cursor: null,
			}
		}),
		getFills: vi.fn(async function () {
			return { fills: [], cursor: null }
		}),
		getOrders: vi.fn(async function () {
			return { orders: [], cursor: null }
		}),
		getSettlements: vi.fn(async function () {
			return { settlements: [], cursor: null }
		}),
		...parts,
	}
}

function servicesWith (
	portfolio: PortfolioService | undefined,
): AppServices {
	return {
		kalshi: {} as KalshiClient,
		games: {} as GamesService,
		parlay: {} as ParlayService,
		...(portfolio === undefined ? {} : { portfolio }),
	}
}

async function rpc (
	app: ReturnType<typeof createApp>,
	key: string,
	body: unknown,
): Promise<Response> {
	return request(app)
		.post('/mcp')
		.set('Accept', accept)
		.set('Content-Type', 'application/json')
		.set('Authorization', `Bearer ${key}`)
		.send(body)
}

async function listTools (
	app: ReturnType<typeof createApp>,
	key: string,
): Promise<string[]> {
	const res = await rpc(app, key, {
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/list',
		params: {},
	})
	expect(res.status).toBe(200)
	return (parseRpc(res.text).result?.tools ?? [])
		.map(function (tool) {
			return tool.name ?? ''
		})
		.sort()
}

async function callTool (
	app: ReturnType<typeof createApp>,
	key: string,
	name: string,
	args: Record<string, unknown>,
): Promise<RpcBody> {
	const res = await rpc(app, key, {
		jsonrpc: '2.0',
		id: 2,
		method: 'tools/call',
		params: { name, arguments: args },
	})
	return parseRpc(res.text)
}

describe('mcp portfolio tools', function () {
	it('hides the tools without credentials', async function () {
		const app = createApp(envWith(), servicesWith(undefined))
		const names = await listTools(app, keyOne)
		for (const tool of portfolioTools) {
			expect(names).not.toContain(tool)
		}
		expect(names).toContain('list_games')
		const called = await callTool(app, keyOne, 'get_balance', {})
		const failed = called.error !== undefined
			|| called.result?.isError === true
		expect(failed).toBe(true)
	})

	it('lists the tools when credentials exist', async function () {
		const app = createApp(
			envWith(),
			servicesWith(portfolioStub()),
		)
		const names = await listTools(app, keyOne)
		for (const tool of portfolioTools) {
			expect(names).toContain(tool)
		}
		expect(names).toHaveLength(14)
	})

	it('lists the tools only for allowed keys', async function () {
		const portfolio = portfolioStub()
		const app = createApp(
			envWith({ PORTFOLIO_API_KEYS: keyTwo }),
			servicesWith(portfolio),
		)
		const denied = await listTools(app, keyOne)
		for (const tool of portfolioTools) {
			expect(denied).not.toContain(tool)
		}
		const allowed = await listTools(app, keyTwo)
		for (const tool of portfolioTools) {
			expect(allowed).toContain(tool)
		}
		const refused = await callTool(app, keyOne, 'get_fills', {})
		const failed = refused.error !== undefined
			|| refused.result?.isError === true
		expect(failed).toBe(true)
		expect(portfolio.getFills).not.toHaveBeenCalled()
	})

	it('has no order-writing tools', async function () {
		const app = createApp(
			envWith(),
			servicesWith(portfolioStub()),
		)
		const names = await listTools(app, keyOne)
		for (const name of names) {
			expect(name).not.toMatch(
				/create|place|cancel|amend|decrease|delete/,
			)
		}
	})

	it('calls each tool with typed arguments', async function () {
		const portfolio = portfolioStub()
		const app = createApp(envWith(), servicesWith(portfolio))
		const balance = await callTool(
			app,
			keyOne,
			'get_balance',
			{ subaccount: 1 },
		)
		const text = balance.result?.content?.[0]?.text ?? ''
		expect(JSON.parse(text).balance).toBe(12.34)
		await callTool(app, keyOne, 'get_positions', {
			settlement_status: 'all',
			limit: 10,
		})
		await callTool(app, keyOne, 'get_fills', {
			ticker: 'A,B',
			min_ts: 1,
		})
		await callTool(app, keyOne, 'get_orders', {
			status: 'executed',
		})
		await callTool(app, keyOne, 'get_settlements', {
			event_ticker: 'E',
		})
		expect(portfolio.getBalance).toHaveBeenCalledWith({
			subaccount: 1,
		})
		expect(portfolio.getPositions).toHaveBeenCalledWith({
			settlement_status: 'all',
			limit: 10,
		})
		expect(portfolio.getFills).toHaveBeenCalledWith({
			ticker: 'A,B',
			min_ts: 1,
		})
		expect(portfolio.getOrders).toHaveBeenCalledWith({
			status: 'executed',
		})
		expect(portfolio.getSettlements).toHaveBeenCalledWith({
			event_ticker: 'E',
		})
	})

	it('reports errors through the safe message path', async function () {
		vi.spyOn(console, 'error').mockImplementation(function () {})
		const getBalance = vi.fn(async function () {
			throw new KalshiAuthError(401, '/portfolio/balance')
		})
		const getOrders = vi.fn(async function () {
			throw new KalshiAuthNotConfiguredError()
		})
		const getFills = vi.fn(async function () {
			throw new TypeError('secret internal detail')
		})
		const app = createApp(
			envWith(),
			servicesWith(portfolioStub({
				getBalance,
				getOrders,
				getFills,
			})),
		)
		const auth = await callTool(app, keyOne, 'get_balance', {})
		expect(auth.result?.isError).toBe(true)
		expect(auth.result?.content?.[0]?.text).toBe(
			'Kalshi rejected the API credentials',
		)
		const missing = await callTool(app, keyOne, 'get_orders', {})
		expect(missing.result?.content?.[0]?.text).toBe(
			'Portfolio access is not configured',
		)
		const internal = await callTool(app, keyOne, 'get_fills', {})
		expect(internal.result?.content?.[0]?.text).toBe(
			'Internal server error',
		)
		expect(JSON.stringify(internal)).not.toContain('secret')
	})

	it('rejects out-of-range arguments', async function () {
		const portfolio = portfolioStub()
		const app = createApp(envWith(), servicesWith(portfolio))
		const res = await callTool(app, keyOne, 'get_fills', {
			limit: 5000,
		})
		const failed = res.error !== undefined
			|| res.result?.isError === true
		expect(failed).toBe(true)
		expect(portfolio.getFills).not.toHaveBeenCalled()
	})
})
