import {
	createHash,
	timingSafeEqual,
} from 'node:crypto'
import type {
	NextFunction,
	Request,
	RequestHandler,
	Response,
} from 'express'
import rateLimit, {
	ipKeyGenerator,
} from 'express-rate-limit'
import type { AppEnv } from '../config/env.js'

declare global {
	namespace Express {
		interface Request {
			auth?: {
				keyIndex: number
			}
			apiKeyId?: string
		}
	}
}

const healthPath = '/health'
const missingAuthMessage =
	'Missing or invalid Authorization header'
const invalidKeyMessage = 'Invalid API key'
const bearerToken = /^Bearer\s+(\S+)\s*$/i

const invalidTokenMessage = 'Invalid or expired access token'

interface KeyDigest {
	index: number
	digest: Buffer
}

/**
 * The resource-server half of OAuth, handed to the auth
 * middleware when OAuth is on.
 */
export interface OAuthGate {
	/** Key index an access token stands for, or `undefined`. */
	verifyAccessToken: (token: string) => number | undefined
	/** URL a 401 advertises in `WWW-Authenticate`. */
	resourceMetadataUrl: string
	/** Scope a 401 asks the client to request. */
	scope: string
}

/** Position of the matching key in `API_KEYS`, or -1. */
export type KeyMatcher = (token: string) => number

function sha256 (value: string): Buffer {
	return createHash('sha256')
		.update(value, 'utf8')
		.digest()
}

function digestKeys (
	keys: readonly string[],
): KeyDigest[] {
	const digests: KeyDigest[] = []
	for (let index = 0; index < keys.length; index += 1) {
		const key = keys[index]
		if (key === undefined) {
			continue
		}
		digests.push({
			index,
			digest: sha256(key),
		})
	}
	return digests
}

/**
 * Compare sha256 digests so lengths always match.
 * Every configured key is checked. The loop does not
 * return on the first hit, so match position does not
 * leak through an early exit.
 */
function matchKeyIndex (
	token: string,
	digests: readonly KeyDigest[],
): number {
	const presented = sha256(token)
	let matched = 0
	let foundIndex = -1
	for (let i = 0; i < digests.length; i += 1) {
		const entry = digests[i]
		if (entry === undefined) {
			continue
		}
		let bit = 0
		if (presented.length === entry.digest.length) {
			bit = timingSafeEqual(
				presented,
				entry.digest,
			) ? 1 : 0
		}
		matched |= bit
		if (bit === 1 && foundIndex < 0) {
			foundIndex = entry.index
		}
	}
	if (matched === 0) {
		return -1
	}
	return foundIndex
}

function isHealthCheck (req: Request): boolean {
	if (req.path !== healthPath) {
		return false
	}
	return req.method === 'GET' || req.method === 'HEAD'
}

function readBearerToken (
	header: string | undefined,
): string | undefined {
	if (header === undefined) {
		return undefined
	}
	const match = bearerToken.exec(header.trim())
	const token = match?.[1]
	if (token === undefined || token.length === 0) {
		return undefined
	}
	return token
}

/**
 * Match a presented key against every configured key in
 * constant time. Used by the OAuth consent step, so the API
 * key check there is the same one `requireApiKey` makes.
 */
export function createKeyMatcher (env: AppEnv): KeyMatcher {
	const digests = digestKeys(env.apiKeys)
	return function matchKey (token) {
		return matchKeyIndex(token, digests)
	}
}

function bearerChallenge (
	gate: OAuthGate,
	hasRejectedToken: boolean,
): string {
	const fields: string[] = []
	if (hasRejectedToken) {
		fields.push(
			'error="invalid_token"',
			`error_description="${invalidTokenMessage}"`,
		)
	}
	fields.push(
		`resource_metadata="${gate.resourceMetadataUrl}"`,
		`scope="${gate.scope}"`,
	)
	return `Bearer ${fields.join(', ')}`
}

function sendUnauthorized (
	res: Response,
	message: string,
	gate?: OAuthGate,
	hasRejectedToken = false,
): void {
	if (gate !== undefined) {
		res.set(
			'WWW-Authenticate',
			bearerChallenge(gate, hasRejectedToken),
		)
	}
	const isTokenError = gate !== undefined && hasRejectedToken
	res.status(401).json({
		error: isTokenError ? 'invalid_token' : 'unauthorized',
		message: isTokenError ? invalidTokenMessage : message,
	})
}

/** A static API key, else an OAuth access token; -1 if neither. */
function resolveKeyIndex (
	token: string,
	digests: readonly KeyDigest[],
	gate: OAuthGate | undefined,
): number {
	const keyIndex = matchKeyIndex(token, digests)
	if (keyIndex >= 0 || gate === undefined) {
		return keyIndex
	}
	return gate.verifyAccessToken(token) ?? -1
}

/**
 * Require `Authorization: Bearer <token>` except on
 * GET and HEAD `/health`.
 *
 * The token is hashed and compared with `timingSafeEqual`.
 * It is not logged. The raw key is not stored on the
 * request. `req.auth.keyIndex` is the position in
 * `API_KEYS`, and `req.apiKeyId` is `key-0`, `key-1`, ...
 *
 * With an `OAuthGate`, a valid OAuth access token is accepted
 * too and resolves to the key index it was issued for, so
 * rate limits and portfolio access work the same. Each 401
 * then carries a `WWW-Authenticate: Bearer` challenge that
 * points at the protected resource metadata.
 */
export function requireApiKey (
	env: AppEnv,
	gate?: OAuthGate,
): RequestHandler {
	const digests = digestKeys(env.apiKeys)
	return function apiKeyMiddleware (
		req: Request,
		res: Response,
		next: NextFunction,
	): void {
		if (isHealthCheck(req)) {
			next()
			return
		}
		const token = readBearerToken(
			req.get('authorization'),
		)
		if (token === undefined) {
			sendUnauthorized(res, missingAuthMessage, gate)
			return
		}
		const keyIndex = resolveKeyIndex(token, digests, gate)
		if (keyIndex < 0) {
			sendUnauthorized(res, invalidKeyMessage, gate, true)
			return
		}
		req.auth = { keyIndex }
		req.apiKeyId = `key-${keyIndex}`
		next()
	}
}

function rateLimitKey (req: Request): string {
	const keyIndex = req.auth?.keyIndex
	if (typeof keyIndex === 'number') {
		return `key-${keyIndex}`
	}
	return ipKeyGenerator(req.ip ?? '')
}

function sendRateLimited (
	_req: Request,
	res: Response,
): void {
	res.status(429).json({
		error: 'rate_limited',
		message: 'Too many requests',
	})
}

function anonRateLimitKey (req: Request): string {
	return ipKeyGenerator(req.ip ?? '')
}

function hasValidBearer (
	req: Request,
	digests: readonly KeyDigest[],
	gate: OAuthGate | undefined,
): boolean {
	const token = readBearerToken(req.get('authorization'))
	if (token === undefined) {
		return false
	}
	return resolveKeyIndex(token, digests, gate) >= 0
}

function createLimiter (
	env: AppEnv,
	max: number,
	keyGenerator: (req: Request) => string,
	skip: (req: Request) => boolean,
): RequestHandler {
	return rateLimit({
		windowMs: env.rateLimitWindowMs,
		max,
		standardHeaders: true,
		legacyHeaders: false,
		keyGenerator,
		skip,
		handler: sendRateLimited,
		validate: {
			xForwardedForHeader: false,
		},
	})
}

/**
 * Rate limit requests that lack a valid API key, by client
 * IP. Requests with a valid key are skipped before they are
 * counted, so concurrent or long-lived authenticated calls
 * never use this bucket and an IP that is limited here can
 * still call with a valid key. Health checks are skipped.
 * A valid OAuth access token counts as a valid key when
 * `gate` is given. Mount this before `requireApiKey`.
 * `createApp` sets `trust proxy` to 1.
 */
export function createAnonRateLimit (
	env: AppEnv,
	gate?: OAuthGate,
): RequestHandler {
	const digests = digestKeys(env.apiKeys)
	return createLimiter(
		env,
		env.rateLimitAnonMax,
		anonRateLimitKey,
		function (req) {
			return isHealthCheck(req)
				|| hasValidBearer(req, digests, gate)
		},
	)
}

/**
 * Rate limit by API key index so callers that share an IP
 * do not share a quota. Health checks are skipped. The IP
 * fallback uses `ipKeyGenerator` and applies only when
 * `req.auth` is missing.
 *
 * Mount this after `requireApiKey`. X-Forwarded-For
 * validation is disabled because authenticated buckets
 * are not IP addresses.
 */
export function createKeyRateLimit (
	env: AppEnv,
): RequestHandler {
	return createLimiter(
		env,
		env.rateLimitMax,
		rateLimitKey,
		isHealthCheck,
	)
}

/** Whether the API key at `keyIndex` may read the portfolio. */
export type PortfolioAccess = (
	keyIndex: number | undefined,
) => boolean

/**
 * Decide portfolio access by key index. With no
 * `PORTFOLIO_API_KEYS` every key may. Otherwise the allowed
 * indexes in `API_KEYS` are worked out once here, so a request
 * only needs the index that `requireApiKey` already matched in
 * constant time. A request with no index is never allowed.
 */
export function createPortfolioAccess (
	env: AppEnv,
): PortfolioAccess {
	const allowed = env.portfolioApiKeys
	if (allowed === null) {
		return function (keyIndex) {
			return keyIndex !== undefined
		}
	}
	const indexes = new Set<number>()
	env.apiKeys.forEach(function (key, index) {
		if (allowed.includes(key)) {
			indexes.add(index)
		}
	})
	return function (keyIndex) {
		return keyIndex !== undefined && indexes.has(keyIndex)
	}
}
