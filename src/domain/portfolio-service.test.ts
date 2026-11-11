import { describe, expect, it, vi } from 'vitest'
import type { KalshiClient } from '../kalshi/kalshi-client.js'
import { createPortfolioService } from './portfolio-service.js'

function clientWith (parts: Partial<KalshiClient>): KalshiClient {
	return parts as KalshiClient
}

describe('createPortfolioService', function () {
	it('turns cents and dollar strings into dollars', async function () {
		const getBalance = vi.fn(async function () {
			return {
				balance: 1234,
				balance_dollars: '12.3400',
				portfolio_value: 505,
				updated_ts: 1_731_000_000,
				balance_breakdown: [
					{ exchange_index: 0, balance: '12.340000' },
				],
			}
		})
		const service = createPortfolioService(
			clientWith({ getBalance }),
		)
		const view = await service.getBalance({ subaccount: 0 })
		expect(view).toEqual({
			balance: 12.34,
			portfolioValue: 5.05,
			updatedTs: 1_731_000_000,
			byExchangeIndex: [{ exchangeIndex: 0, balance: 12.34 }],
		})
		expect(getBalance).toHaveBeenCalledWith({ subaccount: 0 })
	})

	it('falls back to cents when dollars are missing', async function () {
		const service = createPortfolioService(clientWith({
			getBalance: async function () {
				return { balance: 99, portfolio_value: 0 }
			},
		}))
		expect(await service.getBalance()).toEqual({
			balance: 0.99,
			portfolioValue: 0,
			updatedTs: null,
			byExchangeIndex: null,
		})
	})

	it('normalizes positions and signs the side', async function () {
		const service = createPortfolioService(clientWith({
			getPositions: async function () {
				return {
					market_positions: [{
						ticker: 'KXNBAGAME-26NOV11BOSNYK-BOS',
						exchange_index: 0,
						total_traded_dollars: '10.500000',
						position_fp: '-4.00',
						market_exposure_dollars: '2.2000',
						realized_pnl_dollars: '-0.1000',
						fees_paid_dollars: '0.0300',
						last_updated_ts: '2026-11-11T00:00:00Z',
						netting_enabled: false,
					}, {
						ticker: 'FLAT',
						total_traded_dollars: '1.00',
						position_fp: '0.00',
						market_exposure_dollars: '0.00',
						realized_pnl_dollars: '0.50',
						fees_paid_dollars: '0.00',
					}],
					event_positions: [{
						event_ticker: 'KXNBAGAME-26NOV11BOSNYK',
						total_cost_dollars: '10.50',
						total_cost_shares_fp: '20.00',
						event_exposure_dollars: '2.20',
						realized_pnl_dollars: '-0.10',
						fees_paid_dollars: '0.03',
					}],
					cursor: 'next',
				}
			},
		}))
		const view = await service.getPositions()
		expect(view.cursor).toBe('next')
		expect(view.marketPositions[0]).toEqual({
			ticker: 'KXNBAGAME-26NOV11BOSNYK-BOS',
			exchangeIndex: 0,
			position: -4,
			side: 'no',
			marketExposure: 2.2,
			totalTraded: 10.5,
			realizedPnl: -0.1,
			feesPaid: 0.03,
			lastUpdated: '2026-11-11T00:00:00Z',
			nettingEnabled: false,
		})
		expect(view.marketPositions[1]?.side).toBeNull()
		expect(view.marketPositions[1]?.exchangeIndex).toBeNull()
		expect(view.eventPositions).toEqual([{
			eventTicker: 'KXNBAGAME-26NOV11BOSNYK',
			totalCost: 10.5,
			totalCostShares: 20,
			eventExposure: 2.2,
			realizedPnl: -0.1,
			feesPaid: 0.03,
		}])
	})

	it('normalizes fills with the price of the side', async function () {
		const service = createPortfolioService(clientWith({
			getFills: async function () {
				return {
					fills: [{
						fill_id: 'f1',
						order_id: 'o1',
						ticker: 'T',
						outcome_side: 'no',
						book_side: 'ask',
						count_fp: '3.00',
						yes_price_dollars: '0.400000',
						no_price_dollars: '0.600000',
						is_taker: true,
						fee_cost: '0.0200',
						created_time: '2026-11-11T01:00:00Z',
						exchange_index: 0,
						subaccount_number: 0,
						side: 'no',
						action: 'buy',
					}],
				}
			},
		}))
		const view = await service.getFills()
		expect(view.cursor).toBeNull()
		expect(view.fills).toEqual([{
			fillId: 'f1',
			orderId: 'o1',
			ticker: 'T',
			outcomeSide: 'no',
			bookSide: 'ask',
			count: 3,
			yesPrice: 0.4,
			noPrice: 0.6,
			price: 0.6,
			isTaker: true,
			fee: 0.02,
			createdTime: '2026-11-11T01:00:00Z',
			exchangeIndex: 0,
			subaccount: 0,
		}])
	})

	it('normalizes orders', async function () {
		const service = createPortfolioService(clientWith({
			getOrders: async function () {
				return {
					orders: [{
						order_id: 'o1',
						user_id: 'private-user',
						client_order_id: 'c1',
						ticker: 'T',
						outcome_side: 'yes',
						book_side: 'bid',
						type: 'limit',
						status: 'resting',
						yes_price_dollars: '0.5500',
						no_price_dollars: '0.4500',
						initial_count_fp: '10.00',
						fill_count_fp: '4.00',
						remaining_count_fp: '6.00',
						taker_fill_cost_dollars: '1.0000',
						maker_fill_cost_dollars: '1.2000',
						taker_fees_dollars: '0.0100',
						maker_fees_dollars: '0.0000',
						created_time: null,
						expiration_time: null,
					}],
					cursor: 'o2',
				}
			},
		}))
		const view = await service.getOrders({ status: 'resting' })
		expect(view.cursor).toBe('o2')
		const order = view.orders[0]
		expect(order).toMatchObject({
			orderId: 'o1',
			clientOrderId: 'c1',
			status: 'resting',
			yesPrice: 0.55,
			noPrice: 0.45,
			price: 0.55,
			initialCount: 10,
			fillCount: 4,
			remainingCount: 6,
			takerFillCost: 1,
			makerFillCost: 1.2,
			takerFees: 0.01,
			makerFees: 0,
			createdTime: null,
			expirationTime: null,
			orderGroupId: null,
		})
		expect(JSON.stringify(view)).not.toContain('private-user')
	})

	it('converts settlement cents to dollars', async function () {
		const service = createPortfolioService(clientWith({
			getSettlements: async function () {
				return {
					settlements: [{
						ticker: 'T',
						event_ticker: 'E',
						exchange_index: 0,
						market_result: 'yes',
						yes_count_fp: '5.00',
						yes_total_cost_dollars: '2.500000',
						no_count_fp: '0.00',
						no_total_cost_dollars: '0.000000',
						revenue: 500,
						settled_time: '2026-11-12T00:00:00Z',
						fee_cost: '0.1700',
						value: 100,
					}, {
						ticker: 'U',
						event_ticker: 'E',
						market_result: '',
						yes_count_fp: 'abc',
						yes_total_cost_dollars: '0',
						no_count_fp: '0',
						no_total_cost_dollars: '0',
						revenue: 0,
						settled_time: '2026-11-12T00:00:00Z',
						fee_cost: '0',
						value: null,
					}],
				}
			},
		}))
		const view = await service.getSettlements()
		expect(view.settlements[0]).toEqual({
			ticker: 'T',
			eventTicker: 'E',
			exchangeIndex: 0,
			marketResult: 'yes',
			yesCount: 5,
			yesTotalCost: 2.5,
			noCount: 0,
			noTotalCost: 0,
			revenue: 5,
			fees: 0.17,
			value: 1,
			settledTime: '2026-11-12T00:00:00Z',
		})
		expect(view.settlements[1]?.yesCount).toBeNull()
		expect(view.settlements[1]?.value).toBeNull()
	})
})
