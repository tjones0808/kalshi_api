import type {
	NextFunction,
	Request,
	Response,
} from 'express'
import { ZodError } from 'zod'
import {
	domainStatus,
	isSafeClientText,
	zodClientMessage,
} from './domain-errors.js'
import {
	KalshiAuthError,
	KalshiAuthNotConfiguredError,
	KalshiHttpError,
	KalshiNetworkError,
	KalshiRateLimitError,
	KalshiTimeoutError,
} from '../kalshi/errors.js'

const badRequest = 'bad_request'
const invalidRequest = 'Invalid request'
const internalError = 'internal_error'
const internalMessage = 'Internal server error'
const notFound = 'not_found'
const notFoundMessage = 'Not found'

function isRecord (
	value: unknown,
): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

function readStatusCode (
	err: Record<string, unknown>,
): number | undefined {
	const statusCode = err.statusCode
	if (typeof statusCode !== 'number') {
		return undefined
	}
	if (!Number.isInteger(statusCode)) {
		return undefined
	}
	if (statusCode < 400 || statusCode > 599) {
		return undefined
	}
	return statusCode
}

function readErrorCode (
	err: Record<string, unknown>,
	statusCode: number,
): string {
	const code = err.error
	if (
		typeof code === 'string'
		&& /^[a-z0-9_]+$/.test(code)
	) {
		return code
	}
	if (statusCode === 401) {
		return 'unauthorized'
	}
	if (statusCode === 403) {
		return 'forbidden'
	}
	if (statusCode === 404) {
		return notFound
	}
	if (statusCode === 429) {
		return 'rate_limited'
	}
	if (statusCode >= 500) {
		return internalError
	}
	return badRequest
}

function publicMessage (
	err: Record<string, unknown>,
	statusCode: number,
): string {
	if (statusCode >= 500) {
		return internalMessage
	}
	const message = err.message
	if (
		typeof message !== 'string'
		|| message.length === 0
	) {
		return invalidRequest
	}
	if (
		message.includes('\n')
		|| message.includes('    at ')
	) {
		return invalidRequest
	}
	return message
}

function domainMessage (
	message: string,
	statusCode: number,
): string {
	if (!isSafeClientText(message)) {
		if (statusCode === 404) {
			return notFoundMessage
		}
		return invalidRequest
	}
	return message
}

/**
 * One concise line per error. Kalshi failures log status and
 * path only (plus the system code for network errors), never
 * the response body.
 */
function logError (err: unknown): void {
	if (err instanceof KalshiNetworkError) {
		console.error(
			`kalshi error status=0 path=${err.path}`
			+ ` code=${err.code ?? 'unknown'}`,
		)
		return
	}
	if (err instanceof KalshiHttpError) {
		console.error(
			`kalshi error status=${err.status} path=${err.path}`,
		)
		return
	}
	if (err instanceof Error) {
		console.error(
			`${err.name}: ${err.message}`,
			err.stack ?? '',
		)
		return
	}
	console.error(`non-error thrown: ${typeof err}`)
}

function writeKalshiError (
	res: Response,
	err: KalshiHttpError,
): void {
	if (err.status === 404) {
		res.status(404).json({
			error: notFound,
			message: notFoundMessage,
		})
		return
	}
	if (err.status === 400) {
		res.status(400).json({
			error: badRequest,
			message: invalidRequest,
		})
		return
	}
	res.status(502).json({
		error: 'upstream_error',
		message: 'Upstream request failed',
	})
}

/**
 * JSON 404 for routes that no handler claimed.
 */
export function notFoundHandler (
	_req: Request,
	res: Response,
): void {
	res.status(404).json({
		error: notFound,
		message: notFoundMessage,
	})
}

/**
 * Last-resort error middleware.
 *
 * `KalshiRateLimitError` is 502 so it is not confused
 * with our own 429. `KalshiTimeoutError` is 504
 * `upstream_timeout`. Other `KalshiHttpError` values use
 * `.status`: 404 and 400 stay client errors, and the
 * rest are 502. A Kalshi 401 or 403 is 502
 * `upstream_auth_failed` with a fixed message, and a
 * portfolio call with no credentials is 503
 * `portfolio_not_configured`. Responses never include the Kalshi
 * path or body snippet.
 *
 * Zod failures are 400 and omit issue payloads. Issues from
 * our own `custom` refinements (such as the candle range
 * checks) keep their fixed message.
 * `date must be YYYY-MM-DD` and messages that start
 * with `Unknown league` are 400. A milestone with no
 * game event is 404. Errors that set `statusCode` use
 * that status. Anything else is 500 with a fixed
 * message. Unexpected errors are logged with name, message,
 * and stack; Kalshi errors log status and path only.
 * Responses omit stacks and unknown error messages.
 */
export function errorHandler (
	err: unknown,
	_req: Request,
	res: Response,
	next: NextFunction,
): void {
	logError(err)
	if (res.headersSent) {
		next(err)
		return
	}
	if (err instanceof ZodError) {
		res.status(400).json({
			error: badRequest,
			message: zodClientMessage(err, invalidRequest),
		})
		return
	}
	if (err instanceof KalshiTimeoutError) {
		res.status(504).json({
			error: 'upstream_timeout',
			message: 'Upstream request timed out',
		})
		return
	}
	if (err instanceof KalshiRateLimitError) {
		res.status(502).json({
			error: 'upstream_rate_limited',
			message: 'Kalshi rate limited the request',
		})
		return
	}
	if (err instanceof KalshiAuthError) {
		res.status(502).json({
			error: 'upstream_auth_failed',
			message: 'Kalshi rejected the API credentials',
		})
		return
	}
	if (err instanceof KalshiHttpError) {
		writeKalshiError(res, err)
		return
	}
	if (err instanceof KalshiAuthNotConfiguredError) {
		res.status(503).json({
			error: 'portfolio_not_configured',
			message: 'Portfolio access is not configured',
		})
		return
	}
	if (err instanceof Error) {
		const coded = isRecord(err)
			? readStatusCode(err)
			: undefined
		const statusCode = coded === undefined
			? domainStatus(err.message)
			: undefined
		if (statusCode !== undefined) {
			res.status(statusCode).json({
				error: statusCode === 404
					? notFound
					: badRequest,
				message: domainMessage(
					err.message,
					statusCode,
				),
			})
			return
		}
	}
	if (!isRecord(err)) {
		res.status(500).json({
			error: internalError,
			message: internalMessage,
		})
		return
	}
	const statusCode = readStatusCode(err)
	if (statusCode === undefined) {
		res.status(500).json({
			error: internalError,
			message: internalMessage,
		})
		return
	}
	res.status(statusCode).json({
		error: readErrorCode(err, statusCode),
		message: publicMessage(err, statusCode),
	})
}
