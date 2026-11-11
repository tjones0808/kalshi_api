/** Most candlesticks one request may span. */
export const MAX_CANDLES = 5000

/** Fixed client messages. They never echo user input. */
export const CANDLE_ORDER_MESSAGE = 'end_ts must be after start_ts'
export const CANDLE_COUNT_MESSAGE =
	`range spans more than ${MAX_CANDLES} candles`

interface RefinementCtx {
	addIssue (issue: {
		code: 'custom'
		message: string
		path: string[]
	}): void
}

interface CandleRange {
	start_ts: number
	end_ts: number
	interval: number | string
}

/**
 * Zod `superRefine` callback shared by REST and MCP candle
 * inputs. Requires `end_ts > start_ts` and at most
 * {@link MAX_CANDLES} candles at the given interval in minutes.
 * `interval` may be a numeric string, as in query params.
 *
 * @example
 * z.object({ ... }).superRefine(refineCandleRange)
 */
export function refineCandleRange (
	value: CandleRange,
	ctx: RefinementCtx,
): void {
	if (value.end_ts <= value.start_ts) {
		ctx.addIssue({
			code: 'custom',
			message: CANDLE_ORDER_MESSAGE,
			path: ['end_ts'],
		})
		return
	}
	const seconds = Number(value.interval) * 60
	const candles = (value.end_ts - value.start_ts) / seconds
	if (candles > MAX_CANDLES) {
		ctx.addIssue({
			code: 'custom',
			message: CANDLE_COUNT_MESSAGE,
			path: ['end_ts'],
		})
	}
}
