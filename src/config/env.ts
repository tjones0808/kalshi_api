import { readFileSync } from 'node:fs'
import type { KeyObject } from 'node:crypto'
import dotenv from 'dotenv'
import { z } from 'zod'
import { parsePrivateKey } from './private-key.js'

const apiKeysMessage =
	'API_KEYS is required. The server must not start without keys.'
const shortKeyMessage =
	'Each API key in API_KEYS must be at least 32 characters.'
const minApiKeyLength = 32
const placeholderMarker = 'replace-me'
const placeholderKeyMessage =
	'API_KEYS contains the placeholder from .env.example. '
	+ 'Generate a real key as shown in the README.'

function readApiKeys (value: unknown): string {
	return typeof value === 'string' ? value : ''
}

function splitApiKeys (value: string): string[] {
	return value
		.split(',')
		.map(function (key) {
			return key.trim()
		})
		.filter(function (key) {
			return key.length > 0
		})
}

function hasKeys (keys: string[]): boolean {
	return keys.length > 0
}

function keysAreLongEnough (keys: string[]): boolean {
	return keys.every(function (key) {
		return key.length >= minApiKeyLength
	})
}

function hasNoPlaceholder (keys: string[]): boolean {
	return keys.every(function (key) {
		return !key.toLowerCase().includes(placeholderMarker)
	})
}

const apiKeysSchema = z.preprocess(
	readApiKeys,
	z
		.string()
		.transform(splitApiKeys)
		.refine(hasKeys, {
			message: apiKeysMessage,
		})
		.refine(keysAreLongEnough, {
			message: shortKeyMessage,
		})
		.refine(hasNoPlaceholder, {
			message: placeholderKeyMessage,
		}),
)

function blankToUndefined (value: unknown): unknown {
	if (value === undefined || value === '') {
		return undefined
	}
	return value
}

function envInt (
	defaultValue: number,
	min: number,
	max?: number,
) {
	const bounded = z.coerce.number().int().min(min)
	return z.preprocess(
		blankToUndefined,
		(max === undefined ? bounded : bounded.max(max))
			.default(defaultValue),
	)
}

const kalshiBaseUrlDefault =
	'https://external-api.kalshi.com/trade-api/v2'

const envSchema = z.object({
	PORT: envInt(3000, 0),
	API_KEYS: apiKeysSchema,
	KALSHI_BASE_URL: z.preprocess(
		blankToUndefined,
		z.url().default(kalshiBaseUrlDefault),
	),
	KALSHI_TIMEOUT_MS: envInt(8000, 1000, 60000),
	KALSHI_DEADLINE_MS: envInt(20000, 2000, 120000),
	CACHE_MAX_ENTRIES: envInt(5000, 100, 100000),
	CACHE_TTL_SERIES_MS: envInt(3600000, 0),
	CACHE_TTL_MARKETS_MS: envInt(15000, 0),
	CACHE_TTL_ORDERBOOK_MS: envInt(5000, 0),
	CACHE_TTL_LIVE_MS: envInt(5000, 0),
	CACHE_TTL_TRADES_MS: envInt(10000, 0),
	RATE_LIMIT_WINDOW_MS: envInt(60000, 1),
	RATE_LIMIT_MAX: envInt(120, 1),
	RATE_LIMIT_ANON_MAX: envInt(30, 1),
})

/** Parsed Kalshi credentials used to sign requests. */
export interface KalshiAuthConfig {
	keyId: string
	privateKey: KeyObject
}

export interface AppEnv {
	port: number
	apiKeys: string[]
	/**
	 * Keys (a subset of `apiKeys`) allowed to read the portfolio,
	 * or `null` when every API key may.
	 */
	portfolioApiKeys: string[] | null
	/** `null` when no Kalshi credentials are configured. */
	kalshiAuth: KalshiAuthConfig | null
	kalshiBaseUrl: string
	kalshiTimeoutMs: number
	kalshiDeadlineMs: number
	cacheMaxEntries: number
	cacheTtlSeriesMs: number
	cacheTtlMarketsMs: number
	cacheTtlOrderbookMs: number
	cacheTtlLiveMs: number
	cacheTtlTradesMs: number
	rateLimitWindowMs: number
	rateLimitMax: number
	rateLimitAnonMax: number
}

function readOptional (
	processEnv: NodeJS.ProcessEnv,
	name: string,
): string | undefined {
	const value = processEnv[name]
	if (value === undefined || value.trim() === '') {
		return undefined
	}
	return value
}

function readKeyFile (path: string): string {
	try {
		return readFileSync(path, 'utf8')
	} catch {
		throw new Error('KALSHI_PRIVATE_KEY_PATH could not be read')
	}
}

/**
 * Kalshi credentials: both the key id and a private key, or
 * neither. The key comes from `KALSHI_PRIVATE_KEY` or from the
 * file at `KALSHI_PRIVATE_KEY_PATH`, not both.
 */
function parseKalshiAuth (
	processEnv: NodeJS.ProcessEnv,
): KalshiAuthConfig | null {
	const keyId = readOptional(processEnv, 'KALSHI_API_KEY_ID')
	const inline = readOptional(processEnv, 'KALSHI_PRIVATE_KEY')
	const path = readOptional(processEnv, 'KALSHI_PRIVATE_KEY_PATH')
	if (inline !== undefined && path !== undefined) {
		throw new Error(
			'Set only one of KALSHI_PRIVATE_KEY and '
			+ 'KALSHI_PRIVATE_KEY_PATH.',
		)
	}
	const keySource = inline ?? path
	if (keyId === undefined && keySource === undefined) {
		return null
	}
	if (keyId === undefined || keySource === undefined) {
		throw new Error(
			'KALSHI_API_KEY_ID and a private key '
			+ '(KALSHI_PRIVATE_KEY or KALSHI_PRIVATE_KEY_PATH) '
			+ 'must be set together.',
		)
	}
	const privateKey = inline === undefined
		? parsePrivateKey(
			readKeyFile(keySource.trim()),
			'KALSHI_PRIVATE_KEY_PATH file',
		)
		: parsePrivateKey(inline, 'KALSHI_PRIVATE_KEY')
	return { keyId: keyId.trim(), privateKey }
}

/**
 * `PORTFOLIO_API_KEYS`: unset means every API key may read the
 * portfolio. A variable that is present but blank or without
 * keys is an error, not "unset", so a typo never opens access.
 */
function parsePortfolioKeys (
	processEnv: NodeJS.ProcessEnv,
	apiKeys: readonly string[],
): string[] | null {
	const raw = processEnv.PORTFOLIO_API_KEYS
	if (raw === undefined) {
		return null
	}
	const keys = splitApiKeys(raw)
	if (!hasKeys(keys)) {
		throw new Error(
			'PORTFOLIO_API_KEYS is set but contains no keys.',
		)
	}
	if (!keysAreLongEnough(keys)) {
		throw new Error(
			'Each key in PORTFOLIO_API_KEYS must be at least '
			+ '32 characters.',
		)
	}
	if (!hasNoPlaceholder(keys)) {
		throw new Error(
			'PORTFOLIO_API_KEYS contains the placeholder from '
			+ '.env.example. Use real keys from API_KEYS.',
		)
	}
	const unknown = keys.some(function (key) {
		return !apiKeys.includes(key)
	})
	if (unknown) {
		throw new Error(
			'Every key in PORTFOLIO_API_KEYS must also be '
			+ 'listed in API_KEYS.',
		)
	}
	return keys
}

/**
 * Parse a process environment into typed application config.
 * Throws when `API_KEYS` is missing, empty, holds the
 * `.env.example` placeholder, or any key is shorter than
 * 32 characters. Also throws on a partial or unreadable Kalshi
 * credential setup and on an invalid `PORTFOLIO_API_KEYS`;
 * those messages never include key material.
 */
export function parseEnv (
	processEnv: NodeJS.ProcessEnv,
): AppEnv {
	const result = envSchema.safeParse(processEnv)
	if (!result.success) {
		const keyIssues = result.error.issues.filter(
			function (issue) {
				return issue.path[0] === 'API_KEYS'
			},
		)
		const hasPlaceholder = keyIssues.some(function (issue) {
			return issue.message === placeholderKeyMessage
		})
		if (hasPlaceholder) {
			throw new Error(placeholderKeyMessage)
		}
		const hasShortKey = keyIssues.some(function (issue) {
			return issue.message === shortKeyMessage
		})
		if (hasShortKey) {
			throw new Error(shortKeyMessage)
		}
		if (keyIssues.length > 0) {
			throw new Error(apiKeysMessage)
		}
		const detail = result.error.issues
			.map(function (issue) {
				return issue.message
			})
			.join('; ')
		throw new Error(`Invalid environment: ${detail}`)
	}

	const data = result.data
	return {
		port: data.PORT,
		apiKeys: data.API_KEYS,
		portfolioApiKeys: parsePortfolioKeys(
			processEnv,
			data.API_KEYS,
		),
		kalshiAuth: parseKalshiAuth(processEnv),
		kalshiBaseUrl: data.KALSHI_BASE_URL,
		kalshiTimeoutMs: data.KALSHI_TIMEOUT_MS,
		kalshiDeadlineMs: data.KALSHI_DEADLINE_MS,
		cacheMaxEntries: data.CACHE_MAX_ENTRIES,
		cacheTtlSeriesMs: data.CACHE_TTL_SERIES_MS,
		cacheTtlMarketsMs: data.CACHE_TTL_MARKETS_MS,
		cacheTtlOrderbookMs: data.CACHE_TTL_ORDERBOOK_MS,
		cacheTtlLiveMs: data.CACHE_TTL_LIVE_MS,
		cacheTtlTradesMs: data.CACHE_TTL_TRADES_MS,
		rateLimitWindowMs: data.RATE_LIMIT_WINDOW_MS,
		rateLimitMax: data.RATE_LIMIT_MAX,
		rateLimitAnonMax: data.RATE_LIMIT_ANON_MAX,
	}
}

/**
 * Load `.env`, then parse `process.env`.
 */
export function loadEnv (): AppEnv {
	dotenv.config({ quiet: true })
	return parseEnv(process.env)
}
