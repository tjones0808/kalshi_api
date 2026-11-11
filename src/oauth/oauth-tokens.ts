import {
	createHmac,
	timingSafeEqual,
} from 'node:crypto'
import { z } from 'zod'

const tokenVersion = 'v1'
const maxTokenLength = 8192
const fingerprintLength = 32

const clientSchema = z.object({
	typ: z.literal('client'),
	iat: z.number().int(),
	name: z.string(),
	uris: z.array(z.string()).min(1),
})

const authRequestSchema = z.object({
	typ: z.literal('authreq'),
	exp: z.number().int(),
	cid: z.string(),
	cn: z.string(),
	ruri: z.string(),
	cc: z.string(),
	st: z.string().optional(),
	sc: z.string(),
	res: z.string(),
})

const codeSchema = z.object({
	typ: z.literal('code'),
	exp: z.number().int(),
	jti: z.string(),
	cid: z.string(),
	ruri: z.string(),
	cc: z.string(),
	res: z.string(),
	sc: z.string(),
	kfp: z.string(),
})

const accessSchema = z.object({
	typ: z.literal('access'),
	exp: z.number().int(),
	iat: z.number().int(),
	iss: z.string(),
	aud: z.string(),
	cid: z.string(),
	sc: z.string(),
	kfp: z.string(),
	fam: z.string(),
})

const refreshSchema = z.object({
	typ: z.literal('refresh'),
	exp: z.number().int(),
	iat: z.number().int(),
	iss: z.string(),
	aud: z.string(),
	cid: z.string(),
	sc: z.string(),
	kfp: z.string(),
	fam: z.string(),
	jti: z.string(),
})

/** Claims of a dynamically registered public client. */
export type ClientClaims = z.infer<typeof clientSchema>
/** Claims that carry a consent request through the form. */
export type AuthRequestClaims = z.infer<typeof authRequestSchema>
/** Claims of a single-use authorization code. */
export type CodeClaims = z.infer<typeof codeSchema>
/** Claims of an access token. */
export type AccessClaims = z.infer<typeof accessSchema>
/** Claims of a refresh token. */
export type RefreshClaims = z.infer<typeof refreshSchema>

function mac (secret: string, signingInput: string): Buffer {
	return createHmac('sha256', secret)
		.update(signingInput, 'utf8')
		.digest()
}

/**
 * Sign a payload as `v1.<base64url json>.<base64url hmac>`.
 * The payload is readable by whoever holds the token. It is
 * signed, not encrypted, so keep secrets out of it.
 */
export function signToken (
	secret: string,
	payload: object,
): string {
	const body = Buffer
		.from(JSON.stringify(payload), 'utf8')
		.toString('base64url')
	const input = `${tokenVersion}.${body}`
	return `${input}.${mac(secret, input).toString('base64url')}`
}

/**
 * Check the signature in constant time and return the parsed
 * payload, or `undefined` when the token is malformed, too
 * long, or not signed with `secret`.
 */
export function openToken (
	secret: string,
	token: string,
): unknown {
	if (token.length > maxTokenLength) {
		return undefined
	}
	const parts = token.split('.')
	const version = parts[0]
	const body = parts[1]
	const signature = parts[2]
	if (
		parts.length !== 3
		|| version !== tokenVersion
		|| body === undefined
		|| signature === undefined
	) {
		return undefined
	}
	const expected = mac(secret, `${version}.${body}`)
	const presented = Buffer.from(signature, 'base64url')
	if (
		presented.length !== expected.length
		|| !timingSafeEqual(presented, expected)
	) {
		return undefined
	}
	try {
		return JSON.parse(
			Buffer.from(body, 'base64url').toString('utf8'),
		) as unknown
	} catch {
		return undefined
	}
}

/**
 * Opaque id for an API key: the first 32 hex characters (128 bits) of an
 * HMAC of the key under the token secret. Tokens carry it so
 * that dropping or rotating a key in `API_KEYS` revokes the
 * tokens made with it. Keying it with the secret keeps the
 * key's own hash out of tokens.
 */
export function keyFingerprint (
	secret: string,
	apiKey: string,
): string {
	return createHmac('sha256', secret)
		.update(`kfp\0${apiKey}`, 'utf8')
		.digest('hex')
		.slice(0, fingerprintLength)
}

/** Issue and read the five token types with one secret. */
export interface TokenService {
	issueClient: (name: string, uris: string[]) => string
	readClient: (token: string) => ClientClaims | undefined
	issueAuthRequest: (
		claims: Omit<AuthRequestClaims, 'typ' | 'exp'>,
		ttlSeconds: number,
	) => string
	readAuthRequest: (
		token: string,
	) => AuthRequestClaims | undefined
	issueCode: (
		claims: Omit<CodeClaims, 'typ' | 'exp'>,
		ttlSeconds: number,
	) => string
	readCode: (token: string) => CodeClaims | undefined
	issueAccess: (
		claims: Omit<AccessClaims, 'typ' | 'exp' | 'iat'>,
		ttlSeconds: number,
	) => string
	readAccess: (token: string) => AccessClaims | undefined
	issueRefresh: (
		claims: Omit<RefreshClaims, 'typ' | 'exp' | 'iat'>,
		ttlSeconds: number,
	) => string
	readRefresh: (token: string) => RefreshClaims | undefined
}

/**
 * Create a token service. `now` returns epoch milliseconds
 * and is read on every call, so tests can move the clock.
 * Readers return `undefined` for a bad signature, the wrong
 * type, an unexpected shape, or an expired token.
 */
export function createTokenService (
	secret: string,
	now: () => number = Date.now,
): TokenService {
	function seconds (): number {
		return Math.floor(now() / 1000)
	}

	function read<T> (
		schema: z.ZodType<T>,
		token: string,
	): T | undefined {
		const parsed = schema.safeParse(openToken(secret, token))
		if (!parsed.success) {
			return undefined
		}
		const exp = (parsed.data as { exp?: unknown }).exp
		if (typeof exp === 'number' && seconds() >= exp) {
			return undefined
		}
		return parsed.data
	}

	return {
		issueClient (name, uris) {
			return signToken(secret, {
				typ: 'client',
				iat: seconds(),
				name,
				uris,
			})
		},
		readClient (token) {
			return read(clientSchema, token)
		},
		issueAuthRequest (claims, ttlSeconds) {
			return signToken(secret, {
				...claims,
				typ: 'authreq',
				exp: seconds() + ttlSeconds,
			})
		},
		readAuthRequest (token) {
			return read(authRequestSchema, token)
		},
		issueCode (claims, ttlSeconds) {
			return signToken(secret, {
				...claims,
				typ: 'code',
				exp: seconds() + ttlSeconds,
			})
		},
		readCode (token) {
			return read(codeSchema, token)
		},
		issueAccess (claims, ttlSeconds) {
			const iat = seconds()
			return signToken(secret, {
				...claims,
				typ: 'access',
				iat,
				exp: iat + ttlSeconds,
			})
		},
		readAccess (token) {
			return read(accessSchema, token)
		},
		issueRefresh (claims, ttlSeconds) {
			const iat = seconds()
			return signToken(secret, {
				...claims,
				typ: 'refresh',
				iat,
				exp: iat + ttlSeconds,
			})
		},
		readRefresh (token) {
			return read(refreshSchema, token)
		},
	}
}
