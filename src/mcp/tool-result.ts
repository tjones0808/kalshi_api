import type { CallToolResult } from '@modelcontextprotocol/server'
import { ZodError } from 'zod'
import {
	domainStatus,
	isSafeClientText,
	zodClientMessage,
} from '../http/domain-errors.js'
import {
	KalshiAuthError,
	KalshiAuthNotConfiguredError,
	KalshiHttpError,
	KalshiRateLimitError,
	KalshiTimeoutError,
} from '../kalshi/errors.js'

const notFoundMessage = 'Not found'
const invalidMessage = 'Invalid request'
const upstreamMessage = 'Upstream request failed'
const timeoutMessage = 'Upstream request timed out'
const internalMessage = 'Internal server error'
const rateLimitMessage =
	'Kalshi rate limited the request'
const authFailedMessage = 'Kalshi rejected the API credentials'
const notConfiguredMessage = 'Portfolio access is not configured'

/**
 * Short tool-error text.
 * A Kalshi 404 is `Not found`. A Kalshi 429 is the
 * rate-limit sentence. A Kalshi 401 or 403 is a fixed
 * credentials sentence. Other Kalshi failures do not
 * include the path or body snippet. Only our own domain
 * messages (bad date, unknown league, milestone with no game
 * event) and custom candle-range messages pass through; any
 * other error is the generic internal message.
 */
export function safeToolMessage (err: unknown): string {
	if (err instanceof KalshiRateLimitError) {
		return rateLimitMessage
	}
	if (err instanceof KalshiTimeoutError) {
		return timeoutMessage
	}
	if (err instanceof KalshiAuthError) {
		return authFailedMessage
	}
	if (err instanceof KalshiAuthNotConfiguredError) {
		return notConfiguredMessage
	}
	if (err instanceof KalshiHttpError) {
		if (err.status === 404) {
			return notFoundMessage
		}
		if (err.status === 400) {
			return invalidMessage
		}
		return upstreamMessage
	}
	if (err instanceof ZodError) {
		return zodClientMessage(err, invalidMessage)
	}
	if (
		err instanceof Error
		&& domainStatus(err.message) !== undefined
		&& isSafeClientText(err.message)
	) {
		return err.message
	}
	return internalMessage
}

function compactJson (value: unknown): string {
	return JSON.stringify(value) ?? 'null'
}

function toolText (value: unknown): CallToolResult {
	return {
		content: [{
			type: 'text',
			text: compactJson(value),
		}],
	}
}

function toolFailure (message: string): CallToolResult {
	return {
		isError: true,
		content: [{
			type: 'text',
			text: message,
		}],
	}
}

/**
 * Run a tool body. The result is compact JSON text; a thrown
 * error becomes an `isError` result with a safe message.
 */
export async function runTool (
	work: () => Promise<unknown>,
): Promise<CallToolResult> {
	try {
		return toolText(await work())
	} catch (err) {
		return toolFailure(safeToolMessage(err))
	}
}
