import {
	createHash,
	randomUUID,
	timingSafeEqual,
} from 'node:crypto'
import type { OAuthConfig } from '../config/env.js'
import type { KeyMatcher, OAuthGate } from '../http/auth.js'
import { createExpiringSet } from './expiring-set.js'
import {
	createClientResolver,
	parseRegistration,
} from './oauth-clients.js'
import {
	OAUTH_SCOPE,
	resourceMetadataUrl,
	resourceUrl,
} from './oauth-metadata.js'
import type { DocumentFetcher } from './oauth-fetch.js'
import {
	createTokenService,
	keyFingerprint,
} from './oauth-tokens.js'

const codeTtlSeconds = 600
const requestTtlSeconds = 600
const accessTtlSeconds = 3600
const refreshTtlSeconds = 30 * 24 * 3600
const maxTrackedIds = 10_000
const maxStateLength = 512
const challengePattern = /^[A-Za-z0-9_-]{43,128}$/
const verifierPattern = /^[A-Za-z0-9._~-]{43,128}$/

/** Request parameters, string values only. */
export type Params = Readonly<Record<string, string>>

/** Token endpoint success body (RFC 6749 section 5.1). */
export interface TokenResponse {
	access_token: string
	token_type: 'Bearer'
	expires_in: number
	refresh_token: string
	scope: string
}

/** What the consent page needs to render. */
export interface ConsentState {
	clientName: string
	redirectUri: string
	request: string
}

/** Outcome of validating an authorization request. */
export type BeginResult =
	| { kind: 'error_page', message: string }
	| { kind: 'redirect', location: string }
	| ({ kind: 'consent' } & ConsentState)

/** Outcome of the consent form post. */
export type CompleteResult =
	| { kind: 'error_page', message: string }
	| { kind: 'redirect', location: string }
	| ({ kind: 'invalid_key' } & ConsentState)

/** Outcome of a token request. */
export type TokenResult =
	| { ok: true, body: TokenResponse }
	| {
		ok: false
		status: number
		error: string
		description: string
	}

/** Outcome of a dynamic client registration. */
export type RegisterResult =
	| { ok: true, body: Record<string, unknown> }
	| { ok: false, error: string, description: string }

/** The authorization server, free of HTTP. */
export interface OAuthService {
	config: OAuthConfig
	/** For the auth middleware. */
	gate: OAuthGate
	register: (body: unknown) => RegisterResult
	begin: (params: Params) => Promise<BeginResult>
	complete: (params: Params) => CompleteResult
	exchange: (params: Params) => TokenResult
}

/** Keep only the string values of a parsed form or query. */
export function readParams (raw: unknown): Params {
	const params: Record<string, string> = {}
	if (typeof raw !== 'object' || raw === null) {
		return params
	}
	for (const [name, value] of Object.entries(raw)) {
		if (typeof value === 'string' && value !== '') {
			params[name] = value
		}
	}
	return params
}

function tokenFailure (
	status: number,
	error: string,
	description: string,
): TokenResult {
	return { ok: false, status, error, description }
}

function sha256Base64Url (value: string): Buffer {
	return Buffer.from(
		createHash('sha256').update(value, 'utf8').digest('base64url'),
		'utf8',
	)
}

function pkceMatches (
	verifier: string,
	challenge: string,
): boolean {
	if (!verifierPattern.test(verifier)) {
		return false
	}
	const expected = Buffer.from(challenge, 'utf8')
	const actual = sha256Base64Url(verifier)
	return actual.length === expected.length
		&& timingSafeEqual(actual, expected)
}

/** Outside effects the service can be given, for tests. */
export interface OAuthDeps {
	/** Fetches client metadata documents. */
	fetchDocument?: DocumentFetcher
}

/**
 * Create the authorization server.
 *
 * Tokens are stateless, and bound to an API key by
 * fingerprint, so they stop working when that key leaves
 * `API_KEYS`. Three things are kept in memory, all bounded:
 * used authorization code ids (single use), used refresh
 * token ids, and revoked token families. Presenting a refresh
 * token that was already used revokes its whole family:
 * every refresh and access token that came from the same
 * code. This assumes ONE server instance. A restart forgets
 * the state, so within a code's 10 minutes it could be
 * redeemed once more by someone with both the code and the
 * PKCE verifier, and a revoked family works again until its
 * tokens expire. Replicas would each hold their own state.
 *
 * `matchKey` is the constant-time API key check. `now`
 * returns epoch milliseconds.
 */
export function createOAuthService (
	config: OAuthConfig,
	apiKeys: readonly string[],
	matchKey: KeyMatcher,
	now: () => number = Date.now,
	deps: OAuthDeps = {},
): OAuthService {
	const tokens = createTokenService(config.tokenSecret, now)
	const resolveClient = createClientResolver(
		tokens,
		{
			redirectHosts: config.allowedRedirectHosts,
			cimdHosts: config.cimdHosts,
		},
		now,
		deps.fetchDocument,
	)
	const resource = resourceUrl(config)
	const issuer = config.baseUrl
	const fingerprints = apiKeys.map(function (key) {
		return keyFingerprint(config.tokenSecret, key)
	})
	const indexByFingerprint = new Map<string, number>()
	fingerprints.forEach(function (fingerprint, index) {
		if (!indexByFingerprint.has(fingerprint)) {
			indexByFingerprint.set(fingerprint, index)
		}
	})
	const usedCodes = createExpiringSet(maxTrackedIds, now)
	const usedRefresh = createExpiringSet(maxTrackedIds, now)
	const revokedFamilies = createExpiringSet(maxTrackedIds, now)

	function canonicalResource (value: string): string | undefined {
		let url: URL
		try {
			url = new URL(value)
		} catch {
			return undefined
		}
		if (url.search !== '' || url.hash !== '') {
			return undefined
		}
		const path = url.pathname.replace(/\/+$/, '')
		return `${url.origin}${path}`
	}

	function isOurResource (value: string): boolean {
		return canonicalResource(value) === resource
	}

	function grantScope (
		requested: string | undefined,
	): string | undefined {
		if (requested === undefined) {
			return OAUTH_SCOPE
		}
		return requested.split(/\s+/).includes(OAUTH_SCOPE)
			? OAUTH_SCOPE
			: undefined
	}

	function redirectTo (
		redirectUri: string,
		fields: Record<string, string | undefined>,
	): string {
		const url = new URL(redirectUri)
		for (const [name, value] of Object.entries(fields)) {
			if (value !== undefined) {
				url.searchParams.set(name, value)
			}
		}
		url.searchParams.set('iss', issuer)
		return url.toString()
	}

	function issueTokens (
		clientId: string,
		scope: string,
		fingerprint: string,
		family: string,
	): TokenResult {
		const claims = {
			iss: issuer,
			aud: resource,
			cid: clientId,
			sc: scope,
			kfp: fingerprint,
			fam: family,
		}
		return {
			ok: true,
			body: {
				access_token: tokens.issueAccess(
					claims,
					accessTtlSeconds,
				),
				token_type: 'Bearer',
				expires_in: accessTtlSeconds,
				refresh_token: tokens.issueRefresh(
					{ ...claims, jti: randomUUID() },
					refreshTtlSeconds,
				),
				scope,
			},
		}
	}

	function verifyAccessToken (token: string): number | undefined {
		const claims = tokens.readAccess(token)
		if (claims === undefined) {
			return undefined
		}
		if (claims.iss !== issuer || claims.aud !== resource) {
			return undefined
		}
		if (revokedFamilies.has(claims.fam)) {
			return undefined
		}
		return indexByFingerprint.get(claims.kfp)
	}

	function register (body: unknown): RegisterResult {
		const parsed = parseRegistration(
			body,
			config.allowedRedirectHosts,
		)
		if ('error' in parsed) {
			return {
				ok: false,
				error: parsed.error,
				description: parsed.description,
			}
		}
		return {
			ok: true,
			body: {
				client_id: tokens.issueClient(
					parsed.name,
					parsed.redirectUris,
				),
				client_id_issued_at: Math.floor(now() / 1000),
				client_name: parsed.name,
				redirect_uris: parsed.redirectUris,
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code'],
				token_endpoint_auth_method: 'none',
				scope: OAUTH_SCOPE,
			},
		}
	}

	async function begin (params: Params): Promise<BeginResult> {
		const clientId = params.client_id
		const redirectUri = params.redirect_uri
		if (clientId === undefined || redirectUri === undefined) {
			return {
				kind: 'error_page',
				message: 'The request is missing client_id or '
					+ 'redirect_uri.',
			}
		}
		const client = await resolveClient(clientId)
		if (client === undefined) {
			return { kind: 'error_page', message: 'Unknown client.' }
		}
		if (!client.redirectUris.includes(redirectUri)) {
			return {
				kind: 'error_page',
				message: 'This redirect_uri is not registered '
					+ 'for the client.',
			}
		}
		const state = params.state
		if (state !== undefined && state.length > maxStateLength) {
			return {
				kind: 'error_page',
				message: 'The state parameter is too long.',
			}
		}
		const reject = function (
			error: string,
			description: string,
		): BeginResult {
			return {
				kind: 'redirect',
				location: redirectTo(redirectUri, {
					error,
					error_description: description,
					state,
				}),
			}
		}
		if (params.response_type !== 'code') {
			return reject(
				'unsupported_response_type',
				'response_type must be code',
			)
		}
		const challenge = params.code_challenge
		if (
			challenge === undefined
			|| !challengePattern.test(challenge)
			|| params.code_challenge_method !== 'S256'
		) {
			return reject(
				'invalid_request',
				'A valid S256 code_challenge is required',
			)
		}
		const requestedResource = params.resource
		if (
			requestedResource !== undefined
			&& !isOurResource(requestedResource)
		) {
			return reject(
				'invalid_target',
				'resource must be this server\'s MCP endpoint',
			)
		}
		const scope = grantScope(params.scope)
		if (scope === undefined) {
			return reject(
				'invalid_scope',
				`Only the ${OAUTH_SCOPE} scope is supported`,
			)
		}
		return {
			kind: 'consent',
			clientName: client.name,
			redirectUri,
			request: tokens.issueAuthRequest(
				{
					cid: clientId,
					cn: client.name,
					ruri: redirectUri,
					cc: challenge,
					...(state === undefined ? {} : { st: state }),
					sc: scope,
					res: resource,
				},
				requestTtlSeconds,
			),
		}
	}

	function complete (params: Params): CompleteResult {
		const blob = params.request
		const claims = blob === undefined
			? undefined
			: tokens.readAuthRequest(blob)
		if (blob === undefined || claims === undefined) {
			return {
				kind: 'error_page',
				message: 'This request expired or is not valid.',
			}
		}
		if (params.decision === 'deny') {
			return {
				kind: 'redirect',
				location: redirectTo(claims.ruri, {
					error: 'access_denied',
					error_description: 'The user denied the request',
					state: claims.st,
				}),
			}
		}
		if (params.decision !== 'approve') {
			return {
				kind: 'error_page',
				message: 'Choose Approve or Deny.',
			}
		}
		const keyIndex = matchKey(params.api_key ?? '')
		const fingerprint = keyIndex < 0
			? undefined
			: fingerprints[keyIndex]
		if (fingerprint === undefined) {
			return {
				kind: 'invalid_key',
				clientName: claims.cn,
				redirectUri: claims.ruri,
				request: blob,
			}
		}
		const code = tokens.issueCode(
			{
				jti: randomUUID(),
				cid: claims.cid,
				ruri: claims.ruri,
				cc: claims.cc,
				res: claims.res,
				sc: claims.sc,
				kfp: fingerprint,
			},
			codeTtlSeconds,
		)
		return {
			kind: 'redirect',
			location: redirectTo(claims.ruri, {
				code,
				state: claims.st,
			}),
		}
	}

	function exchangeCode (params: Params): TokenResult {
		const code = params.code
		const clientId = params.client_id
		const redirectUri = params.redirect_uri
		const verifier = params.code_verifier
		if (
			code === undefined
			|| clientId === undefined
			|| redirectUri === undefined
			|| verifier === undefined
		) {
			return tokenFailure(
				400,
				'invalid_request',
				'code, client_id, redirect_uri and code_verifier '
					+ 'are required',
			)
		}
		const claims = tokens.readCode(code)
		if (
			claims === undefined
			|| claims.cid !== clientId
			|| claims.ruri !== redirectUri
		) {
			return tokenFailure(
				400,
				'invalid_grant',
				'The authorization code is invalid or expired',
			)
		}
		const requestedResource = params.resource
		if (
			requestedResource !== undefined
			&& canonicalResource(requestedResource) !== claims.res
		) {
			return tokenFailure(
				400,
				'invalid_target',
				'resource does not match the authorization request',
			)
		}
		const fingerprint = claims.kfp
		const isReady = pkceMatches(verifier, claims.cc)
			&& indexByFingerprint.has(fingerprint)
		if (!isReady || !usedCodes.reserve(claims.jti, claims.exp)) {
			return tokenFailure(
				400,
				'invalid_grant',
				'The authorization code is invalid or expired',
			)
		}
		return issueTokens(
			clientId,
			claims.sc,
			fingerprint,
			randomUUID(),
		)
	}

	function exchangeRefresh (params: Params): TokenResult {
		const refreshToken = params.refresh_token
		const clientId = params.client_id
		if (refreshToken === undefined || clientId === undefined) {
			return tokenFailure(
				400,
				'invalid_request',
				'refresh_token and client_id are required',
			)
		}
		const claims = tokens.readRefresh(refreshToken)
		if (
			claims === undefined
			|| claims.cid !== clientId
			|| claims.iss !== issuer
			|| claims.aud !== resource
			|| !indexByFingerprint.has(claims.kfp)
			|| revokedFamilies.has(claims.fam)
		) {
			return tokenFailure(
				400,
				'invalid_grant',
				'The refresh token is invalid or expired',
			)
		}
		const requestedResource = params.resource
		if (
			requestedResource !== undefined
			&& canonicalResource(requestedResource) !== claims.aud
		) {
			return tokenFailure(
				400,
				'invalid_target',
				'resource does not match the refresh token',
			)
		}
		if (grantScope(params.scope) === undefined) {
			return tokenFailure(
				400,
				'invalid_scope',
				`Only the ${OAUTH_SCOPE} scope is supported`,
			)
		}
		if (!usedRefresh.reserve(claims.jti, claims.exp)) {
			revokedFamilies.reserve(
				claims.fam,
				Math.floor(now() / 1000) + refreshTtlSeconds,
			)
			return tokenFailure(
				400,
				'invalid_grant',
				'The refresh token is invalid or expired',
			)
		}
		return issueTokens(
			clientId,
			claims.sc,
			claims.kfp,
			claims.fam,
		)
	}

	function exchange (params: Params): TokenResult {
		if (params.grant_type === 'authorization_code') {
			return exchangeCode(params)
		}
		if (params.grant_type === 'refresh_token') {
			return exchangeRefresh(params)
		}
		if (params.grant_type === undefined) {
			return tokenFailure(
				400,
				'invalid_request',
				'grant_type is required',
			)
		}
		return tokenFailure(
			400,
			'unsupported_grant_type',
			'Use authorization_code or refresh_token',
		)
	}

	return {
		config,
		gate: {
			verifyAccessToken,
			resourceMetadataUrl: resourceMetadataUrl(config),
			scope: OAUTH_SCOPE,
		},
		register,
		begin,
		complete,
		exchange,
	}
}
