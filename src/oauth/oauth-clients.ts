import { isIP } from 'node:net'
import { z } from 'zod'
import {
	fetchPublicText,
	type DocumentFetcher,
} from './oauth-fetch.js'
import type { TokenService } from './oauth-tokens.js'

const loopbackHosts = ['localhost', '127.0.0.1', '[::1]']
const maxRedirectUris = 5
const maxRedirectUriLength = 512
const maxClientNameLength = 100
const defaultClientName = 'MCP client'
const cimdMaxBytes = 16 * 1024
const cimdCacheMs = 60 * 60 * 1000
const cimdCacheMaxEntries = 50
const controlChars = /[\u0000-\u001f\u007f]/g

/** Which hosts clients may use. */
export interface ClientHosts {
	/** Hosts a redirect URI may point to. */
	redirectHosts: readonly string[]
	/** Hosts a client metadata document may be fetched from. */
	cimdHosts: readonly string[]
}

/** A client the authorization server has accepted. */
export interface ClientInfo {
	name: string
	redirectUris: string[]
}

/** A checked dynamic registration, ready to be signed. */
export interface RegistrationRequest {
	name: string
	redirectUris: string[]
}

/** Why a dynamic registration was refused (RFC 7591). */
export interface RegistrationFailure {
	error: 'invalid_redirect_uri' | 'invalid_client_metadata'
	description: string
}

/** Resolves a `client_id` to a client, or `undefined`. */
export type ClientResolver = (
	clientId: string,
) => Promise<ClientInfo | undefined>

const registrationSchema = z.object({
	redirect_uris: z.array(z.string()).min(1),
	client_name: z.string().optional(),
	token_endpoint_auth_method: z.string().optional(),
	grant_types: z.array(z.string()).optional(),
	response_types: z.array(z.string()).optional(),
})

const cimdSchema = z.object({
	client_id: z.string(),
	client_name: z.string().optional(),
	redirect_uris: z.array(z.string()).min(1),
	token_endpoint_auth_method: z.string().optional(),
	token_endpoint_auth_methods_supported: z
		.array(z.string())
		.optional(),
})

/** Whether `host` (as `URL.hostname` prints it) is loopback. */
export function isLoopbackHost (host: string): boolean {
	return loopbackHosts.includes(host)
}

/**
 * A redirect URI is allowed when it is https on a listed host,
 * or http on a listed loopback host (for local testing). It
 * may not carry credentials or a fragment.
 */
export function isAllowedRedirectUri (
	value: string,
	allowedHosts: readonly string[],
): boolean {
	if (value.length > maxRedirectUriLength) {
		return false
	}
	let url: URL
	try {
		url = new URL(value)
	} catch {
		return false
	}
	const hasExtras = url.username !== ''
		|| url.password !== ''
		|| url.hash !== ''
	if (hasExtras || !allowedHosts.includes(url.hostname)) {
		return false
	}
	if (url.protocol === 'https:') {
		return true
	}
	return url.protocol === 'http:' && isLoopbackHost(url.hostname)
}

/** Strip control characters and cap the length. */
export function cleanClientName (
	raw: string | undefined,
): string {
	const cleaned = (raw ?? '')
		.replace(controlChars, ' ')
		.trim()
		.slice(0, maxClientNameLength)
	return cleaned === '' ? defaultClientName : cleaned
}

function isSubset (
	values: readonly string[] | undefined,
	allowed: readonly string[],
): boolean {
	return values === undefined || values.every(
		function (value) {
			return allowed.includes(value)
		},
	)
}

/**
 * Check an RFC 7591 registration body. Only public clients
 * (`token_endpoint_auth_method: none`) that use the code and
 * refresh grants are accepted, and every redirect URI must
 * pass `isAllowedRedirectUri`.
 */
export function parseRegistration (
	body: unknown,
	allowedHosts: readonly string[],
): RegistrationRequest | RegistrationFailure {
	const parsed = registrationSchema.safeParse(body)
	if (!parsed.success) {
		return {
			error: 'invalid_client_metadata',
			description: 'redirect_uris is required',
		}
	}
	const data = parsed.data
	const method = data.token_endpoint_auth_method
	if (method !== undefined && method !== 'none') {
		return {
			error: 'invalid_client_metadata',
			description: 'Only token_endpoint_auth_method none '
				+ 'is supported',
		}
	}
	const grantsOk = isSubset(
		data.grant_types,
		['authorization_code', 'refresh_token'],
	)
	if (!grantsOk || !isSubset(data.response_types, ['code'])) {
		return {
			error: 'invalid_client_metadata',
			description: 'Unsupported grant_types or response_types',
		}
	}
	const uris = data.redirect_uris
	const urisOk = uris.length <= maxRedirectUris
		&& uris.every(function (uri) {
			return isAllowedRedirectUri(uri, allowedHosts)
		})
	if (!urisOk) {
		return {
			error: 'invalid_redirect_uri',
			description: 'A redirect_uri is not allowed',
		}
	}
	return {
		name: cleanClientName(data.client_name),
		redirectUris: [...new Set(uris)],
	}
}

function allowedUris (
	uris: readonly string[],
	allowedHosts: readonly string[],
): string[] {
	return uris.filter(function (uri) {
		return isAllowedRedirectUri(uri, allowedHosts)
	})
}

/**
 * A Client ID Metadata Document URL must be https with a path,
 * on a host in the fixed CIMD list (not the redirect list)
 * that is a DNS name. Only those hosts are ever fetched, and
 * the fetch itself refuses non-public addresses.
 */
function isFetchableClientUrl (
	clientId: string,
	cimdHosts: readonly string[],
): boolean {
	let url: URL
	try {
		url = new URL(clientId)
	} catch {
		return false
	}
	const isPlain = url.protocol === 'https:'
		&& url.username === ''
		&& url.password === ''
		&& url.hash === ''
		&& url.port === ''
		&& url.pathname !== '/'
	if (!isPlain) {
		return false
	}
	const host = url.hostname
	return cimdHosts.includes(host)
		&& !isLoopbackHost(host)
		&& !host.startsWith('[')
		&& isIP(host) === 0
}

function acceptsPublicClient (
	doc: z.infer<typeof cimdSchema>,
): boolean {
	const methods = doc.token_endpoint_auth_methods_supported
		?? (doc.token_endpoint_auth_method === undefined
			? ['none']
			: [doc.token_endpoint_auth_method])
	return methods.includes('none')
}

async function fetchClientDocument (
	clientId: string,
	allowedHosts: readonly string[],
	fetchDocument: DocumentFetcher,
): Promise<ClientInfo | undefined> {
	const text = await fetchDocument(clientId)
	if (text === undefined || text.length > cimdMaxBytes) {
		return undefined
	}
	const parsed = cimdSchema.safeParse(JSON.parse(text))
	if (!parsed.success) {
		return undefined
	}
	const doc = parsed.data
	if (doc.client_id !== clientId || !acceptsPublicClient(doc)) {
		return undefined
	}
	const redirectUris = allowedUris(
		doc.redirect_uris,
		allowedHosts,
	)
	if (redirectUris.length === 0) {
		return undefined
	}
	return {
		name: cleanClientName(
			doc.client_name ?? new URL(clientId).hostname,
		),
		redirectUris,
	}
}

interface CacheEntry {
	info: ClientInfo
	expiresAt: number
}

/**
 * Resolve a `client_id` two ways. A URL is a Client ID
 * Metadata Document: it is fetched through `fetchDocument`
 * (https only, no redirects, 5 s, 16 KiB, public addresses
 * only, CIMD hosts only) and cached for an hour. Anything
 * else must be a client registration blob this server signed.
 * Redirect URIs are filtered by the
 * allowlist on every resolve, so tightening it takes effect
 * at once. Fetch and parse failures resolve to `undefined`.
 */
export function createClientResolver (
	tokens: TokenService,
	hosts: ClientHosts,
	now: () => number = Date.now,
	fetchDocument: DocumentFetcher = fetchPublicText,
): ClientResolver {
	const allowedHosts = hosts.redirectHosts
	const cache = new Map<string, CacheEntry>()

	async function resolveDocument (
		clientId: string,
	): Promise<ClientInfo | undefined> {
		if (!isFetchableClientUrl(clientId, hosts.cimdHosts)) {
			return undefined
		}
		const cached = cache.get(clientId)
		if (cached !== undefined && cached.expiresAt > now()) {
			return cached.info
		}
		let info: ClientInfo | undefined
		try {
			info = await fetchClientDocument(
				clientId,
				allowedHosts,
				fetchDocument,
			)
		} catch {
			return undefined
		}
		if (info === undefined) {
			return undefined
		}
		cache.delete(clientId)
		cache.set(clientId, {
			info,
			expiresAt: now() + cimdCacheMs,
		})
		if (cache.size > cimdCacheMaxEntries) {
			const oldest = cache.keys().next().value
			if (oldest !== undefined) {
				cache.delete(oldest)
			}
		}
		return info
	}

	return async function resolveClient (clientId) {
		if (clientId.startsWith('https://')) {
			return resolveDocument(clientId)
		}
		const claims = tokens.readClient(clientId)
		if (claims === undefined) {
			return undefined
		}
		const redirectUris = allowedUris(claims.uris, allowedHosts)
		if (redirectUris.length === 0) {
			return undefined
		}
		return { name: claims.name, redirectUris }
	}
}
