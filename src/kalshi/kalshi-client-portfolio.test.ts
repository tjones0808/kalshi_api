import {
	constants,
	generateKeyPairSync,
	verify,
	type KeyObject,
} from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	KalshiAuthError,
	KalshiAuthNotConfiguredError,
} from './errors.js'
import { createKalshiClient } from './kalshi-client.js'
import { createKalshiSigner } from './kalshi-signer.js'

const BASE = 'https://example.test/trade-api/v2/'
const KEY_ID = 'abcd1234-0000-4000-8000-000000000000'
const START = 1_731_000_000_000

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })

function jsonResponse (body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function signedClient (
	fetchImpl: ReturnType<typeof vi.fn>,
	maxRetries?: number,
) {
	return createKalshiClient({
		baseUrl: BASE,
		fetchImpl: fetchImpl as typeof fetch,
		signer: createKalshiSigner({
			keyId: KEY_ID,
			privateKey: pair.privateKey,
		}),
		...(typeof maxRetries === 'number' ? { maxRetries } : {}),
	})
}

function callAt (
	fetchImpl: ReturnType<typeof vi.fn>,
	index: number,
): { url: URL, headers: Record<string, string> } {
	const call = fetchImpl.mock.calls[index] as unknown[] | undefined
	if (!call) {
		throw new Error(`missing fetch call ${index}`)
	}
	const init = call[1] as RequestInit
	return {
		url: new URL(String(call[0])),
		headers: init.headers as Record<string, string>,
	}
}

function isSignedFor (
	publicKey: KeyObject,
	headers: Record<string, string>,
	pathname: string,
): boolean {
	const timestamp = headers['KALSHI-ACCESS-TIMESTAMP'] ?? ''
	const signature = headers['KALSHI-ACCESS-SIGNATURE'] ?? ''
	return verify(
		'sha256',
		Buffer.from(`${timestamp}GET${pathname}`, 'utf8'),
		{
			key: publicKey,
			padding: constants.RSA_PKCS1_PSS_PADDING,
			saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
		},
		Buffer.from(signature, 'base64'),
	)
}

describe('signed kalshi client', function () {
	afterEach(function () {
		vi.useRealTimers()
	})

	it('signs market-data requests too', async function () {
		const fetchImpl = vi.fn(async function () {
			return jsonResponse({
				market: { ticker: 'ABC', event_ticker: 'EVT' },
			})
		})
		await signedClient(fetchImpl).getMarket('ABC')
		const { url, headers } = callAt(fetchImpl, 0)
		expect(headers['KALSHI-ACCESS-KEY']).toBe(KEY_ID)
		expect(url.pathname).toBe('/trade-api/v2/markets/ABC')
		expect(isSignedFor(
			pair.publicKey,
			headers,
			'/trade-api/v2/markets/ABC',
		)).toBe(true)
	})

	it('signs the pathname without the query', async function () {
		const fetchImpl = vi.fn(async function () {
			return jsonResponse({ markets: [] })
		})
		await signedClient(fetchImpl).getMarkets({
			series_ticker: 'KXNBAGAME',
			limit: 5,
		})
		const { url, headers } = callAt(fetchImpl, 0)
		expect(url.search).not.toBe('')
		expect(isSignedFor(
			pair.publicKey,
			headers,
			'/trade-api/v2/markets',
		)).toBe(true)
	})

	it('re-signs every retry with a fresh timestamp', async function () {
		vi.useFakeTimers()
		vi.setSystemTime(START)
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(jsonResponse({}, 503))
			.mockResolvedValueOnce(jsonResponse({}, 429))
			.mockResolvedValueOnce(jsonResponse({
				balance: 100,
				portfolio_value: 0,
			}))
		const pending = signedClient(fetchImpl).getBalance({
			subaccount: 1,
		})
		await vi.advanceTimersByTimeAsync(5_000)
		await pending
		expect(fetchImpl).toHaveBeenCalledTimes(3)
		const stamps = [0, 1, 2].map(function (index) {
			const { headers, url } = callAt(fetchImpl, index)
			expect(url.pathname).toBe('/trade-api/v2/portfolio/balance')
			expect(isSignedFor(
				pair.publicKey,
				headers,
				'/trade-api/v2/portfolio/balance',
			)).toBe(true)
			return headers['KALSHI-ACCESS-TIMESTAMP']
		})
		expect(new Set(stamps).size).toBe(3)
		expect(stamps[0]).toBe(String(START))
	})

	it('maps 401 and 403 to KalshiAuthError', async function () {
		for (const status of [401, 403]) {
			const fetchImpl = vi.fn(async function () {
				return jsonResponse(
					{ error: { message: 'secret-body' } },
					status,
				)
			})
			const err = await signedClient(fetchImpl)
				.getBalance()
				.catch(function (caught: unknown) {
					return caught
				})
			expect(err).toBeInstanceOf(KalshiAuthError)
			expect((err as KalshiAuthError).status).toBe(status)
			expect((err as Error).message).not.toContain('secret-body')
			expect(fetchImpl).toHaveBeenCalledTimes(1)
		}
	})
})

describe('portfolio methods', function () {
	it('throw without a signer and never fetch', async function () {
		const fetchImpl = vi.fn()
		const client = createKalshiClient({
			baseUrl: BASE,
			fetchImpl: fetchImpl as typeof fetch,
		})
		const calls = [
			client.getBalance(),
			client.getPositions(),
			client.getFills(),
			client.getOrders(),
			client.getSettlements(),
		]
		for (const call of calls) {
			await expect(call).rejects.toBeInstanceOf(
				KalshiAuthNotConfiguredError,
			)
		}
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('reads the balance', async function () {
		const body = {
			balance: 1234,
			balance_dollars: '12.3400',
			portfolio_value: 500,
			updated_ts: 1_731_000_000,
		}
		const fetchImpl = vi.fn(async function () {
			return jsonResponse(body)
		})
		const result = await signedClient(fetchImpl).getBalance({
			subaccount: 2,
			exchange_index: 0,
		})
		expect(result).toEqual(body)
		const { url } = callAt(fetchImpl, 0)
		expect(url.pathname).toBe('/trade-api/v2/portfolio/balance')
		expect(url.searchParams.get('subaccount')).toBe('2')
		expect(url.searchParams.get('exchange_index')).toBe('0')
	})

	it('rejects a balance body without numbers', async function () {
		const fetchImpl = vi.fn(async function () {
			return jsonResponse({ nope: true })
		})
		await expect(
			signedClient(fetchImpl).getBalance(),
		).rejects.toMatchObject({ status: 200 })
	})

	it('sends position filters and clamps the limit', async function () {
		const fetchImpl = vi.fn(async function () {
			return jsonResponse({
				market_positions: [{ ticker: 'T' }],
				cursor: '',
			})
		})
		const result = await signedClient(fetchImpl).getPositions({
			limit: 5000,
			cursor: 'c1',
			count_filter: 'position',
			settlement_status: 'all',
			ticker: 'T',
			event_ticker: 'E',
		})
		expect(result.market_positions).toHaveLength(1)
		expect(result.event_positions).toEqual([])
		expect(result.cursor).toBeUndefined()
		const { url } = callAt(fetchImpl, 0)
		expect(url.pathname)
			.toBe('/trade-api/v2/portfolio/positions')
		expect(Object.fromEntries(url.searchParams)).toEqual({
			limit: '1000',
			cursor: 'c1',
			count_filter: 'position',
			settlement_status: 'all',
			ticker: 'T',
			event_ticker: 'E',
		})
	})

	it('pages fills, orders and settlements', async function () {
		const fetchImpl = vi.fn(async function (
			input: RequestInfo | URL,
		) {
			const path = new URL(String(input)).pathname
			if (path.endsWith('/fills')) {
				return jsonResponse({ fills: [], cursor: 'f2' })
			}
			if (path.endsWith('/orders')) {
				return jsonResponse({ orders: [], cursor: 'o2' })
			}
			return jsonResponse({ settlements: [] })
		})
		const client = signedClient(fetchImpl)
		const fills = await client.getFills({
			ticker: 'A,B',
			order_id: 'o1',
			min_ts: 1,
			max_ts: 9,
			limit: 2000,
		})
		const orders = await client.getOrders({
			status: 'resting',
			event_ticker: 'E1,E2',
			limit: 10,
		})
		const settlements = await client.getSettlements({
			ticker: 'T',
			min_ts: 3,
		})
		expect(fills).toEqual({ fills: [], cursor: 'f2' })
		expect(orders).toEqual({ orders: [], cursor: 'o2' })
		expect(settlements).toEqual({ settlements: [] })
		const fillQuery = callAt(fetchImpl, 0).url.searchParams
		expect(fillQuery.get('limit')).toBe('1000')
		expect(fillQuery.get('ticker')).toBe('A,B')
		expect(fillQuery.get('order_id')).toBe('o1')
		expect(fillQuery.get('min_ts')).toBe('1')
		const orderQuery = callAt(fetchImpl, 1).url.searchParams
		expect(orderQuery.get('status')).toBe('resting')
		expect(orderQuery.get('event_ticker')).toBe('E1,E2')
		const settleUrl = callAt(fetchImpl, 2).url
		expect(settleUrl.pathname)
			.toBe('/trade-api/v2/portfolio/settlements')
		expect(settleUrl.searchParams.get('min_ts')).toBe('3')
	})
})
