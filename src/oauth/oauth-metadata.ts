import type { OAuthConfig } from '../config/env.js'

/** The one scope: read access to the Kalshi data. */
export const OAUTH_SCOPE = 'kalshi.read'

/** Path of the protected MCP endpoint, the OAuth resource. */
export const MCP_PATH = '/mcp'

/** Canonical resource identifier and token audience. */
export function resourceUrl (config: OAuthConfig): string {
	return `${config.baseUrl}${MCP_PATH}`
}

/** URL of the root protected resource metadata document. */
export function resourceMetadataUrl (
	config: OAuthConfig,
): string {
	return `${config.baseUrl}/.well-known/oauth-protected-resource`
}

/**
 * RFC 9728 protected resource metadata. The authorization
 * server is this same origin.
 */
export function protectedResourceMetadata (
	config: OAuthConfig,
): Record<string, unknown> {
	return {
		resource: resourceUrl(config),
		authorization_servers: [config.baseUrl],
		scopes_supported: [OAUTH_SCOPE],
		bearer_methods_supported: ['header'],
		resource_name: 'Kalshi Sports API',
	}
}

/**
 * RFC 8414 authorization server metadata. It advertises S256
 * PKCE, public clients only, registration by DCR or by
 * Client ID Metadata Document, and the RFC 9207 `iss`
 * response parameter, which ChatGPT needs to use its stable
 * redirect URI.
 */
export function authorizationServerMetadata (
	config: OAuthConfig,
): Record<string, unknown> {
	return {
		issuer: config.baseUrl,
		authorization_endpoint: `${config.baseUrl}/oauth/authorize`,
		token_endpoint: `${config.baseUrl}/oauth/token`,
		registration_endpoint: `${config.baseUrl}/oauth/register`,
		response_types_supported: ['code'],
		grant_types_supported: [
			'authorization_code',
			'refresh_token',
		],
		code_challenge_methods_supported: ['S256'],
		token_endpoint_auth_methods_supported: ['none'],
		scopes_supported: [OAUTH_SCOPE],
		authorization_response_iss_parameter_supported: true,
		client_id_metadata_document_supported: true,
	}
}
