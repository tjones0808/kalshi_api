import { createHash, randomBytes } from 'node:crypto'
import type { Express } from 'express'
import type { Response } from 'supertest'
import request from 'supertest'
import {
	afterEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import { parseEnv } from '../config/env.js'
import type { GamesService } from '../domain/games-service.js'
import type { ParlayService } from '../domain/parlay-service.js'
import type { PortfolioService } from '../domain/portfolio-service.js'
import { createApp } from '../http/app.js'
import type { AppServices } from '../http/app.js'
import type { KalshiClient } from '../kalshi/kalshi-client.js'
import type { OAuthDeps } from './oauth-service.js'
import { signToken } from './oauth-tokens.js'

const base = 'https://kalshi.example.com'
const resource = `${base}/mcp`
const secret = 's'.repeat(40)
const keyOne = 'a'.repeat(32)
const keyTwo = 'b'.repeat(32)
const redirect =
	'https://chatgpt.com/connector_platform_oauth_redirect'
const cimdUrl = 'https://chatgpt.com/oauth/client.json'
const accept = 'application/json, text/event-stream'
const portfolioTools = [
	'get_balance',
	'get_fills',
	'get_orders',
	'get_positions',
	'get_settlements',
]

interface Pkce {
	verifier: string
	challenge: string
}

interface CodeOptions {
	key?: string
	state?: string
	resource?: string
	redirectUri?: string
	pkce?: Pkce
}

function makePkce (): Pkce {
	const verifier = randomBytes(32).toString('base64url')
	const challenge = createHash('sha256')
		.update(verifier)
		.digest('base64url')
	return { verifier, challenge }
}

function envWith (extra: Record<string, string> = {}) {
	return parseEnv({
		API_KEYS: `${keyOne},${keyTwo}`,
		OAUTH_TOKEN_SECRET: secret,
		PUBLIC_BASE_URL: base,
		RATE_LIMIT_MAX: '500',
		RATE_LIMIT_ANON_MAX: '500',
		...extra,
	})
}

function servicesWith (): AppServices {
	return {
		kalshi: {} as KalshiClient,
		games: {} as GamesService,
		parlay: {} as ParlayService,
		portfolio: {} as PortfolioService,
	}
}

function makeApp (
	extra: Record<string, string> = {},
	deps: OAuthDeps = {},
): Express {
	return createApp(envWith(extra), servicesWith(), {
		oauth: deps,
	})
}

function authorizeQuery (
	clientId: string,
	pkce: Pkce,
	options: CodeOptions = {},
): Record<string, string> {
	return {
		response_type: 'code',
		client_id: clientId,
		redirect_uri: options.redirectUri ?? redirect,
		code_challenge: pkce.challenge,
		code_challenge_method: 'S256',
		resource: options.resource ?? resource,
		...(options.state === undefined
			? {}
			: { state: options.state }),
	}
}

async function register (
	app: Express,
	body: Record<string, unknown> = {},
): Promise<string> {
	const res = await request(app)
		.post('/oauth/register')
		.send({
			redirect_uris: [redirect],
			client_name: 'Test Client',
			token_endpoint_auth_method: 'none',
			...body,
		})
	expect(res.status).toBe(201)
	return (res.body as { client_id: string }).client_id
}

function hiddenRequest (res: Response): string {
	const match = /name="request" value="([^"]+)"/.exec(res.text)
	expect(match).not.toBeNull()
	return match?.[1] ?? ''
}

async function getCode (
	app: Express,
	clientId: string,
	options: CodeOptions = {},
): Promise<{ code: string, location: URL }> {
	const pkce = options.pkce ?? makePkce()
	const page = await request(app)
		.get('/oauth/authorize')
		.query(authorizeQuery(clientId, pkce, options))
	expect(page.status).toBe(200)
	const res = await request(app)
		.post('/oauth/authorize')
		.type('form')
		.send({
			request: hiddenRequest(page),
			api_key: options.key ?? keyOne,
			decision: 'approve',
		})
	expect(res.status).toBe(302)
	const location = new URL(res.headers.location as string)
	return {
		code: location.searchParams.get('code') ?? '',
		location,
	}
}

function tokenRequest (
	app: Express,
	fields: Record<string, string>,
): Promise<Response> {
	return request(app)
		.post('/oauth/token')
		.type('form')
		.send(fields)
}

function codeGrant (
	clientId: string,
	code: string,
	pkce: Pkce,
	extra: Record<string, string> = {},
): Record<string, string> {
	return {
		grant_type: 'authorization_code',
		client_id: clientId,
		code,
		redirect_uri: redirect,
		code_verifier: pkce.verifier,
		resource,
		...extra,
	}
}

interface Tokens {
	clientId: string
	access: string
	refresh: string
}

async function signIn (
	app: Express,
	key = keyOne,
): Promise<Tokens> {
	const clientId = await register(app)
	const pkce = makePkce()
	const { code } = await getCode(app, clientId, { key, pkce })
	const res = await tokenRequest(
		app,
		codeGrant(clientId, code, pkce),
	)
	expect(res.status).toBe(200)
	const body = res.body as {
		access_token: string
		refresh_token: string
	}
	return {
		clientId,
		access: body.access_token,
		refresh: body.refresh_token,
	}
}

function callMcp (
	app: Express,
	token: string,
	method = 'tools/list',
): Promise<Response> {
	return request(app)
		.post('/mcp')
		.set('Accept', accept)
		.set('Content-Type', 'application/json')
		.set('Authorization', `Bearer ${token}`)
		.send({ jsonrpc: '2.0', id: 1, method, params: {} })
}

function parseToolNames (res: Response): string[] {
	const lines = res.text.trim().split('\n')
	const data = lines.find(function (line) {
		return line.startsWith('data:')
	})
	const text = data === undefined
		? res.text.trim()
		: data.slice('data:'.length).trim()
	const body = JSON.parse(text) as {
		result?: { tools?: Array<{ name?: string }> }
	}
	return (body.result?.tools ?? []).map(function (tool) {
		return tool.name ?? ''
	})
}

function tamper (token: string): string {
	const parts = token.split('.')
	const body = JSON.parse(
		Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'),
	) as Record<string, unknown>
	body.kfp = 'ffffffffffffffff'
	const forged = Buffer.from(JSON.stringify(body))
		.toString('base64url')
	return `${parts[0]}.${forged}.${parts[2]}`
}

afterEach(function () {
	vi.useRealTimers()
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

describe('oauth metadata', function () {
	it('serves protected resource metadata', async function () {
		const app = makeApp()
		for (const path of [
			'/.well-known/oauth-protected-resource',
			'/.well-known/oauth-protected-resource/mcp',
		]) {
			const res = await request(app).get(path)
			expect(res.status).toBe(200)
			expect(res.body).toEqual({
				resource,
				authorization_servers: [base],
				scopes_supported: ['kalshi.read'],
				bearer_methods_supported: ['header'],
				resource_name: 'Kalshi Sports API',
			})
		}
	})

	it('serves authorization server metadata', async function () {
		const res = await request(makeApp())
			.get('/.well-known/oauth-authorization-server')
		expect(res.status).toBe(200)
		expect(res.body).toMatchObject({
			issuer: base,
			authorization_endpoint: `${base}/oauth/authorize`,
			token_endpoint: `${base}/oauth/token`,
			registration_endpoint: `${base}/oauth/register`,
			code_challenge_methods_supported: ['S256'],
			token_endpoint_auth_methods_supported: ['none'],
			authorization_response_iss_parameter_supported: true,
			client_id_metadata_document_supported: true,
		})
	})
})

describe('oauth registration', function () {
	it('registers a public client', async function () {
		const res = await request(makeApp())
			.post('/oauth/register')
			.send({
				redirect_uris: [redirect],
				client_name: 'ChatGPT',
			})
		expect(res.status).toBe(201)
		expect(res.headers['cache-control']).toBe('no-store')
		expect(res.body).toMatchObject({
			client_name: 'ChatGPT',
			redirect_uris: [redirect],
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code', 'refresh_token'],
		})
		const clientId = (res.body as { client_id: string }).client_id
		expect(clientId.startsWith('v1.')).toBe(true)
	})

	it('rejects a redirect host that is not allowed', async function () {
		const res = await request(makeApp())
			.post('/oauth/register')
			.send({ redirect_uris: ['https://evil.example/cb'] })
		expect(res.status).toBe(400)
		expect(res.body).toMatchObject({
			error: 'invalid_redirect_uri',
		})
		const plain = await request(makeApp())
			.post('/oauth/register')
			.send({ redirect_uris: ['http://chatgpt.com/cb'] })
		expect(plain.status).toBe(400)
	})

	it('honors OAUTH_ALLOWED_REDIRECT_HOSTS', async function () {
		const app = makeApp({
			OAUTH_ALLOWED_REDIRECT_HOSTS: 'example.org',
		})
		const denied = await request(app)
			.post('/oauth/register')
			.send({ redirect_uris: [redirect] })
		expect(denied.status).toBe(400)
		const allowed = await request(app)
			.post('/oauth/register')
			.send({ redirect_uris: ['https://example.org/cb'] })
		expect(allowed.status).toBe(201)
	})

	it('accepts a loopback redirect by default', async function () {
		const res = await request(makeApp())
			.post('/oauth/register')
			.send({ redirect_uris: ['http://localhost:6274/callback'] })
		expect(res.status).toBe(201)
	})

	it('rejects confidential or odd clients', async function () {
		const app = makeApp()
		const bodies = [
			{ token_endpoint_auth_method: 'client_secret_basic' },
			{ grant_types: ['client_credentials'] },
			{ response_types: ['token'] },
			{ redirect_uris: [] },
		]
		for (const extra of bodies) {
			const res = await request(app)
				.post('/oauth/register')
				.send({ redirect_uris: [redirect], ...extra })
			expect(res.status).toBe(400)
			expect(res.body).toMatchObject({
				error: 'invalid_client_metadata',
			})
		}
		const notJson = await request(app)
			.post('/oauth/register')
			.type('form')
			.send({ redirect_uris: redirect })
		expect(notJson.status).toBe(400)
		const broken = await request(app)
			.post('/oauth/register')
			.set('Content-Type', 'application/json')
			.send('{nope')
		expect(broken.status).toBe(400)
		expect(broken.body).toMatchObject({
			error: 'invalid_request',
		})
	})
})

describe('oauth authorization code flow', function () {
	it('runs end to end and reaches /mcp', async function () {
		const app = makeApp()
		const clientId = await register(app)
		const pkce = makePkce()
		const { code, location } = await getCode(app, clientId, {
			pkce,
			state: 'abc 123',
		})
		expect(location.origin + location.pathname).toBe(redirect)
		expect(location.searchParams.get('state')).toBe('abc 123')
		expect(location.searchParams.get('iss')).toBe(base)
		const res = await tokenRequest(
			app,
			codeGrant(clientId, code, pkce),
		)
		expect(res.status).toBe(200)
		expect(res.headers['cache-control']).toBe('no-store')
		expect(res.body).toMatchObject({
			token_type: 'Bearer',
			expires_in: 3600,
			scope: 'kalshi.read',
		})
		const body = res.body as {
			access_token: string
			refresh_token: string
		}
		const listed = await callMcp(app, body.access_token)
		expect(listed.status).toBe(200)
		expect(parseToolNames(listed)).toContain('list_games')
		const check = await request(app)
			.get('/v1/_auth-check')
			.set('Authorization', `Bearer ${body.access_token}`)
		expect(check.status).toBe(200)
	})

	it('shows the consent page with strict headers', async function () {
		const app = makeApp()
		const clientId = await register(app)
		const res = await request(app)
			.get('/oauth/authorize')
			.query(authorizeQuery(clientId, makePkce()))
		expect(res.status).toBe(200)
		expect(res.headers['cache-control']).toBe('no-store')
		expect(res.headers['x-frame-options']).toBe('DENY')
		const csp = res.headers['content-security-policy'] ?? ''
		expect(csp).toContain('default-src \'none\'')
		expect(csp).toContain(
			'form-action \'self\' https://chatgpt.com',
		)
		expect(csp).toContain('frame-ancestors \'none\'')
		expect(csp).not.toContain('script-src')
		expect(res.text).toContain('Test Client')
		expect(res.text).toContain('chatgpt.com')
		expect(res.text).toContain('type="password"')
		expect(res.text).not.toContain('<script')
	})

	it('escapes the client name', async function () {
		const app = makeApp()
		const clientId = await register(app, {
			client_name: '<script>alert(1)</script>"\'&',
		})
		const res = await request(app)
			.get('/oauth/authorize')
			.query(authorizeQuery(clientId, makePkce()))
		expect(res.status).toBe(200)
		expect(res.text).not.toContain('<script>alert')
		expect(res.text).toContain(
			'&lt;script&gt;alert(1)&lt;/script&gt;',
		)
		expect(res.text).toContain('&quot;&#39;&amp;')
	})

	it('re-renders with 401 for a wrong API key', async function () {
		const app = makeApp()
		const clientId = await register(app)
		const page = await request(app)
			.get('/oauth/authorize')
			.query(authorizeQuery(clientId, makePkce()))
		const res = await request(app)
			.post('/oauth/authorize')
			.type('form')
			.send({
				request: hiddenRequest(page),
				api_key: 'wrong-key-wrong-key-wrong-key-0000',
				decision: 'approve',
			})
		expect(res.status).toBe(401)
		expect(res.headers.location).toBeUndefined()
		expect(res.text).toContain('The API key was not accepted.')
		expect(res.text).not.toContain('wrong-key-wrong')
		expect(res.text).toContain('type="password"')
	})

	it('redirects access_denied when the user denies', async function () {
		const app = makeApp()
		const clientId = await register(app)
		const page = await request(app)
			.get('/oauth/authorize')
			.query(authorizeQuery(clientId, makePkce(), {
				state: 'st1',
			}))
		const res = await request(app)
			.post('/oauth/authorize')
			.type('form')
			.send({
				request: hiddenRequest(page),
				decision: 'deny',
			})
		expect(res.status).toBe(302)
		const location = new URL(res.headers.location as string)
		expect(location.searchParams.get('error')).toBe(
			'access_denied',
		)
		expect(location.searchParams.get('state')).toBe('st1')
		expect(location.searchParams.get('iss')).toBe(base)
	})

	it('rejects a tampered consent request', async function () {
		const app = makeApp()
		const clientId = await register(app)
		const page = await request(app)
			.get('/oauth/authorize')
			.query(authorizeQuery(clientId, makePkce()))
		const blob = hiddenRequest(page)
		const forged = tamper(blob)
		const res = await request(app)
			.post('/oauth/authorize')
			.type('form')
			.send({ request: forged, api_key: keyOne })
		expect(res.status).toBe(400)
		expect(res.headers.location).toBeUndefined()
	})

	it('refuses an unregistered redirect_uri', async function () {
		const app = makeApp()
		const clientId = await register(app)
		const res = await request(app)
			.get('/oauth/authorize')
			.query(authorizeQuery(clientId, makePkce(), {
				redirectUri: `${redirect}/other`,
			}))
		expect(res.status).toBe(400)
		expect(res.headers.location).toBeUndefined()
		expect(res.text).toContain('not registered')
	})

	it('refuses a forged client_id', async function () {
		const app = makeApp()
		const forged = signToken('x'.repeat(40), {
			typ: 'client',
			iat: 1,
			name: 'Evil',
			uris: [redirect],
		})
		const res = await request(app)
			.get('/oauth/authorize')
			.query(authorizeQuery(forged, makePkce()))
		expect(res.status).toBe(400)
		const unknown = await request(app)
			.get('/oauth/authorize')
			.query(authorizeQuery('plain-id', makePkce()))
		expect(unknown.status).toBe(400)
	})

	it('redirects request errors with state and iss', async function () {
		const app = makeApp()
		const clientId = await register(app)
		const pkce = makePkce()
		const cases: Array<[Record<string, string>, string]> = [
			[{ response_type: 'token' }, 'unsupported_response_type'],
			[{ code_challenge_method: 'plain' }, 'invalid_request'],
			[{ code_challenge: 'short' }, 'invalid_request'],
			[{ resource: 'https://other.example/mcp' }, 'invalid_target'],
			[{ scope: 'openid' }, 'invalid_scope'],
		]
		for (const [override, error] of cases) {
			const res = await request(app)
				.get('/oauth/authorize')
				.query({
					...authorizeQuery(clientId, pkce, { state: 's9' }),
					...override,
				})
			expect(res.status).toBe(302)
			const location = new URL(res.headers.location as string)
			expect(location.searchParams.get('error')).toBe(error)
			expect(location.searchParams.get('state')).toBe('s9')
			expect(location.searchParams.get('iss')).toBe(base)
		}
		const missing = await request(app)
			.get('/oauth/authorize')
			.query({
				...authorizeQuery(clientId, pkce),
				code_challenge: '',
			})
		expect(missing.status).toBe(302)
	})

	it('accepts the resource with a trailing slash', async function () {
		const app = makeApp()
		const clientId = await register(app)
		const pkce = makePkce()
		const { code } = await getCode(app, clientId, {
			pkce,
			resource: `${resource}/`,
		})
		const res = await tokenRequest(
			app,
			codeGrant(clientId, code, pkce, {
				resource: `${resource}/`,
			}),
		)
		expect(res.status).toBe(200)
	})

	it('rejects a wrong PKCE verifier but keeps the code', async function () {
		const app = makeApp()
		const clientId = await register(app)
		const pkce = makePkce()
		const { code } = await getCode(app, clientId, { pkce })
		const wrong = await tokenRequest(
			app,
			codeGrant(clientId, code, makePkce()),
		)
		expect(wrong.status).toBe(400)
		expect(wrong.body).toMatchObject({ error: 'invalid_grant' })
		const short = await tokenRequest(
			app,
			codeGrant(clientId, code, pkce, { code_verifier: 'abc' }),
		)
		expect(short.status).toBe(400)
		const ok = await tokenRequest(
			app,
			codeGrant(clientId, code, pkce),
		)
		expect(ok.status).toBe(200)
	})

	it('rejects a mismatched redirect_uri or client', async function () {
		const app = makeApp()
		const clientId = await register(app)
		const other = await register(app, { client_name: 'Other' })
		const pkce = makePkce()
		const { code } = await getCode(app, clientId, { pkce })
		const wrongRedirect = await tokenRequest(
			app,
			codeGrant(clientId, code, pkce, {
				redirect_uri: `${redirect}/x`,
			}),
		)
		expect(wrongRedirect.body).toMatchObject({
			error: 'invalid_grant',
		})
		const wrongClient = await tokenRequest(
			app,
			codeGrant(other, code, pkce),
		)
		expect(wrongClient.body).toMatchObject({
			error: 'invalid_grant',
		})
		const wrongResource = await tokenRequest(
			app,
			codeGrant(clientId, code, pkce, {
				resource: 'https://other.example/mcp',
			}),
		)
		expect(wrongResource.body).toMatchObject({
			error: 'invalid_target',
		})
	})

	it('allows a code to be used only once', async function () {
		const app = makeApp()
		const clientId = await register(app)
		const pkce = makePkce()
		const { code } = await getCode(app, clientId, { pkce })
		const first = await tokenRequest(
			app,
			codeGrant(clientId, code, pkce),
		)
		expect(first.status).toBe(200)
		const replay = await tokenRequest(
			app,
			codeGrant(clientId, code, pkce),
		)
		expect(replay.status).toBe(400)
		expect(replay.body).toMatchObject({ error: 'invalid_grant' })
	})

	it('validates token endpoint input', async function () {
		const app = makeApp()
		const grant = await tokenRequest(app, {
			grant_type: 'client_credentials',
		})
		expect(grant.status).toBe(400)
		expect(grant.body).toMatchObject({
			error: 'unsupported_grant_type',
		})
		const empty = await tokenRequest(app, {
			grant_type: 'authorization_code',
		})
		expect(empty.body).toMatchObject({ error: 'invalid_request' })
		const json = await request(app)
			.post('/oauth/token')
			.send({ grant_type: 'refresh_token' })
		expect(json.status).toBe(400)
		expect(json.body).toMatchObject({ error: 'invalid_request' })
	})
})

describe('oauth refresh tokens', function () {
	it('issues new tokens from a refresh token', async function () {
		const app = makeApp()
		const tokens = await signIn(app)
		const res = await tokenRequest(app, {
			grant_type: 'refresh_token',
			client_id: tokens.clientId,
			refresh_token: tokens.refresh,
			resource,
		})
		expect(res.status).toBe(200)
		expect(res.headers['cache-control']).toBe('no-store')
		const body = res.body as {
			access_token: string
			refresh_token: string
		}
		const listed = await callMcp(app, body.access_token)
		expect(listed.status).toBe(200)
		const again = await tokenRequest(app, {
			grant_type: 'refresh_token',
			client_id: tokens.clientId,
			refresh_token: body.refresh_token,
		})
		expect(again.status).toBe(200)
	})

	it('binds a refresh token to its client and resource', async function () {
		const app = makeApp()
		const tokens = await signIn(app)
		const other = await register(app, { client_name: 'Other' })
		const wrongClient = await tokenRequest(app, {
			grant_type: 'refresh_token',
			client_id: other,
			refresh_token: tokens.refresh,
		})
		expect(wrongClient.body).toMatchObject({
			error: 'invalid_grant',
		})
		const wrongResource = await tokenRequest(app, {
			grant_type: 'refresh_token',
			client_id: tokens.clientId,
			refresh_token: tokens.refresh,
			resource: 'https://other.example/mcp',
		})
		expect(wrongResource.body).toMatchObject({
			error: 'invalid_target',
		})
		const wrongScope = await tokenRequest(app, {
			grant_type: 'refresh_token',
			client_id: tokens.clientId,
			refresh_token: tokens.refresh,
			scope: 'admin',
		})
		expect(wrongScope.body).toMatchObject({
			error: 'invalid_scope',
		})
	})
})

describe('oauth token confusion and forgery', function () {
	it('rejects tampered and foreign tokens', async function () {
		const app = makeApp()
		const tokens = await signIn(app)
		const foreign = signToken('x'.repeat(40), {
			typ: 'access',
			iat: 1,
			exp: 99_999_999_999,
			iss: base,
			aud: resource,
			cid: tokens.clientId,
			sc: 'kalshi.read',
			kfp: 'ffffffffffffffff',
		})
		for (const token of [
			tamper(tokens.access),
			`${tokens.access}x`,
			foreign,
			'v1.e30.AAAA',
			'v1.only',
		]) {
			const res = await callMcp(app, token)
			expect(res.status).toBe(401)
			expect(res.body).toMatchObject({ error: 'invalid_token' })
		}
	})

	it('does not accept a refresh token or code as access', async function () {
		const app = makeApp()
		const clientId = await register(app)
		const pkce = makePkce()
		const { code } = await getCode(app, clientId, { pkce })
		const page = await request(app)
			.get('/oauth/authorize')
			.query(authorizeQuery(clientId, pkce))
		const blob = hiddenRequest(page)
		const res = await tokenRequest(
			app,
			codeGrant(clientId, code, pkce),
		)
		const body = res.body as {
			access_token: string
			refresh_token: string
		}
		for (const token of [body.refresh_token, code, blob, clientId]) {
			const rejected = await callMcp(app, token)
			expect(rejected.status).toBe(401)
		}
		const asRefresh = await tokenRequest(app, {
			grant_type: 'refresh_token',
			client_id: clientId,
			refresh_token: body.access_token,
		})
		expect(asRefresh.body).toMatchObject({ error: 'invalid_grant' })
		const asCode = await tokenRequest(
			app,
			codeGrant(clientId, body.access_token, pkce),
		)
		expect(asCode.body).toMatchObject({ error: 'invalid_grant' })
		const blobAsCode = await tokenRequest(
			app,
			codeGrant(clientId, blob, pkce),
		)
		expect(blobAsCode.body).toMatchObject({ error: 'invalid_grant' })
	})

	it('rejects an access token for another audience', async function () {
		const app = makeApp()
		const tokens = await signIn(app)
		const wrong = signToken(secret, {
			typ: 'access',
			iat: 1,
			exp: 99_999_999_999,
			iss: base,
			aud: 'https://other.example/mcp',
			cid: tokens.clientId,
			sc: 'kalshi.read',
			kfp: 'f'.repeat(32),
			fam: 'x',
		})
		const res = await callMcp(app, wrong)
		expect(res.status).toBe(401)
	})
})

describe('oauth expiry', function () {
	it('expires codes, access tokens, and refresh tokens', async function () {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date('2026-11-11T12:00:00Z'))
		const app = makeApp()
		const clientId = await register(app)
		const pkce = makePkce()
		const stale = await getCode(app, clientId, { pkce })
		vi.setSystemTime(new Date('2026-11-11T12:10:01Z'))
		const expired = await tokenRequest(
			app,
			codeGrant(clientId, stale.code, pkce),
		)
		expect(expired.body).toMatchObject({ error: 'invalid_grant' })
		const tokens = await signIn(app)
		vi.setSystemTime(new Date('2026-11-11T12:59:00Z'))
		const live = await callMcp(app, tokens.access)
		expect(live.status).toBe(200)
		vi.setSystemTime(new Date('2026-11-11T13:11:00Z'))
		const late = await callMcp(app, tokens.access)
		expect(late.status).toBe(401)
		expect(late.body).toMatchObject({ error: 'invalid_token' })
		const refreshed = await tokenRequest(app, {
			grant_type: 'refresh_token',
			client_id: tokens.clientId,
			refresh_token: tokens.refresh,
		})
		expect(refreshed.status).toBe(200)
		vi.setSystemTime(new Date('2026-12-20T12:00:00Z'))
		const gone = await tokenRequest(app, {
			grant_type: 'refresh_token',
			client_id: tokens.clientId,
			refresh_token: tokens.refresh,
		})
		expect(gone.body).toMatchObject({ error: 'invalid_grant' })
	})

	it('expires a consent request', async function () {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date('2026-11-11T12:00:00Z'))
		const app = makeApp()
		const clientId = await register(app)
		const page = await request(app)
			.get('/oauth/authorize')
			.query(authorizeQuery(clientId, makePkce()))
		vi.setSystemTime(new Date('2026-11-11T12:11:00Z'))
		const res = await request(app)
			.post('/oauth/authorize')
			.type('form')
			.send({ request: hiddenRequest(page), api_key: keyOne })
		expect(res.status).toBe(400)
		expect(res.text).toContain('expired')
	})
})

describe('oauth key binding', function () {
	it('revokes tokens when the key leaves API_KEYS', async function () {
		const tokens = await signIn(makeApp())
		const rotated = makeApp({ API_KEYS: keyTwo })
		const res = await callMcp(rotated, tokens.access)
		expect(res.status).toBe(401)
		const refresh = await tokenRequest(rotated, {
			grant_type: 'refresh_token',
			client_id: tokens.clientId,
			refresh_token: tokens.refresh,
		})
		expect(refresh.body).toMatchObject({ error: 'invalid_grant' })
	})

	it('revokes an unredeemed code too', async function () {
		const app = makeApp()
		const clientId = await register(app)
		const pkce = makePkce()
		const { code } = await getCode(app, clientId, { pkce })
		const rotated = makeApp({ API_KEYS: keyTwo })
		const res = await tokenRequest(
			rotated,
			codeGrant(clientId, code, pkce),
		)
		expect(res.body).toMatchObject({ error: 'invalid_grant' })
	})

	it('follows the key when API_KEYS is reordered', async function () {
		const tokens = await signIn(makeApp(), keyTwo)
		const reordered = makeApp({
			API_KEYS: `${keyTwo},${keyOne}`,
			PORTFOLIO_API_KEYS: keyTwo,
		})
		const res = await callMcp(reordered, tokens.access)
		expect(res.status).toBe(200)
		expect(parseToolNames(res)).toContain('get_balance')
	})

	it('gates portfolio tools by the key behind the token', async function () {
		const app = makeApp({ PORTFOLIO_API_KEYS: keyTwo })
		const allowed = await signIn(app, keyTwo)
		const denied = await signIn(app, keyOne)
		const withAccess = parseToolNames(
			await callMcp(app, allowed.access),
		)
		const without = parseToolNames(
			await callMcp(app, denied.access),
		)
		for (const tool of portfolioTools) {
			expect(withAccess).toContain(tool)
			expect(without).not.toContain(tool)
		}
		const viaRefresh = await tokenRequest(app, {
			grant_type: 'refresh_token',
			client_id: denied.clientId,
			refresh_token: denied.refresh,
		})
		const next = (viaRefresh.body as { access_token: string })
			.access_token
		expect(parseToolNames(await callMcp(app, next)))
			.not.toContain('get_balance')
	})

	it('still accepts static API keys', async function () {
		const app = makeApp()
		const res = await callMcp(app, keyOne)
		expect(res.status).toBe(200)
	})
})

describe('oauth challenges and limits', function () {
	const metadataUrl = `${base}/.well-known/oauth-protected-resource`

	it('challenges a missing token on /mcp and /v1', async function () {
		const app = makeApp()
		for (const path of ['/mcp', '/v1/_auth-check']) {
			const res = await request(app).get(path)
			expect(res.status).toBe(401)
			expect(res.headers['www-authenticate']).toBe(
				`Bearer resource_metadata="${metadataUrl}", `
				+ 'scope="kalshi.read"',
			)
			expect(res.body).toEqual({
				error: 'unauthorized',
				message: 'Missing or invalid Authorization header',
			})
		}
	})

	it('names invalid_token for a bad bearer', async function () {
		const app = makeApp()
		const res = await request(app)
			.get('/mcp')
			.set('Authorization', 'Bearer nope')
		expect(res.status).toBe(401)
		expect(res.headers['www-authenticate']).toBe(
			'Bearer error="invalid_token", '
			+ 'error_description="Invalid or expired access token", '
			+ `resource_metadata="${metadataUrl}", scope="kalshi.read"`,
		)
		expect(res.body).toMatchObject({ error: 'invalid_token' })
	})

	it('skips the anonymous limit for OAuth tokens', async function () {
		const app = makeApp({ RATE_LIMIT_ANON_MAX: '20' })
		const tokens = await signIn(app)
		for (let i = 0; i < 25; i += 1) {
			const res = await request(app)
				.get('/v1/_auth-check')
				.set('Authorization', `Bearer ${tokens.access}`)
			expect(res.status).toBe(200)
		}
	})

	it('counts OAuth routes against the anonymous limit', async function () {
		const app = makeApp({ RATE_LIMIT_ANON_MAX: '2' })
		const statuses: number[] = []
		for (let i = 0; i < 3; i += 1) {
			const res = await request(app)
				.get('/.well-known/oauth-authorization-server')
			statuses.push(res.status)
		}
		expect(statuses).toEqual([200, 200, 429])
	})

	it('never logs tokens, codes, keys, or the secret', async function () {
		const spies = [
			vi.spyOn(console, 'log'),
			vi.spyOn(console, 'error'),
			vi.spyOn(console, 'warn'),
			vi.spyOn(console, 'info'),
			vi.spyOn(console, 'debug'),
		]
		const app = makeApp()
		const tokens = await signIn(app)
		await callMcp(app, tokens.access)
		await callMcp(app, tamper(tokens.access))
		const logged = spies
			.flatMap(function (spy) {
				return spy.mock.calls
			})
			.map(function (args) {
				return args.map(String).join(' ')
			})
			.join('\n')
		for (const value of [
			secret,
			keyOne,
			tokens.access,
			tokens.refresh,
		]) {
			expect(logged).not.toContain(value)
		}
	})
})

describe('oauth disabled', function () {
	const message = {
		error: 'unauthorized',
		message: 'Missing or invalid Authorization header',
	}

	function disabledApps (): Express[] {
		const plain = {
			API_KEYS: keyOne,
			RATE_LIMIT_ANON_MAX: '500',
		}
		return [
			createApp(parseEnv(plain), servicesWith()),
			createApp(
				parseEnv({ ...plain, OAUTH_TOKEN_SECRET: secret }),
				servicesWith(),
			),
			createApp(
				parseEnv({ ...plain, PUBLIC_BASE_URL: base }),
				servicesWith(),
			),
		]
	}

	it('keeps every OAuth path behind the API key', async function () {
		const paths = [
			'/.well-known/oauth-protected-resource',
			'/.well-known/oauth-authorization-server',
			'/oauth/authorize',
			'/oauth/token',
			'/oauth/register',
		]
		for (const app of disabledApps()) {
			for (const path of paths) {
				const anon = await request(app).post(path)
				expect(anon.status).toBe(401)
				expect(anon.body).toEqual(message)
				const keyed = await request(app)
					.post(path)
					.set('Authorization', `Bearer ${keyOne}`)
				expect(keyed.status).toBe(404)
				const got = await request(app)
					.get(path)
					.set('Authorization', `Bearer ${keyOne}`)
				expect(got.status).toBe(404)
			}
		}
	})

	it('leaves 401s without a challenge and keys working', async function () {
		for (const app of disabledApps()) {
			const res = await request(app).get('/mcp')
			expect(res.status).toBe(401)
			expect(res.headers['www-authenticate']).toBeUndefined()
			const bad = await request(app)
				.get('/v1/_auth-check')
				.set('Authorization', 'Bearer nope')
			expect(bad.body).toEqual({
				error: 'unauthorized',
				message: 'Invalid API key',
			})
			const ok = await callMcp(app, keyOne)
			expect(ok.status).toBe(200)
		}
	})
})

describe('oauth single use and rotation', function () {
	function refreshWith (
		app: Express,
		tokens: { clientId: string },
		refreshToken: string,
	): Promise<Response> {
		return tokenRequest(app, {
			grant_type: 'refresh_token',
			client_id: tokens.clientId,
			refresh_token: refreshToken,
		})
	}

	it('lets only one of three concurrent exchanges win', async function () {
		const app = makeApp()
		const clientId = await register(app)
		const pkce = makePkce()
		const { code } = await getCode(app, clientId, { pkce })
		const results = await Promise.all([
			tokenRequest(app, codeGrant(clientId, code, pkce)),
			tokenRequest(app, codeGrant(clientId, code, pkce)),
			tokenRequest(app, codeGrant(clientId, code, pkce)),
		])
		const statuses = results.map(function (res) {
			return res.status
		})
		expect(statuses.filter(function (status) {
			return status === 200
		})).toHaveLength(1)
		expect(statuses.filter(function (status) {
			return status === 400
		})).toHaveLength(2)
	})

	it('revokes the family on refresh reuse', async function () {
		const app = makeApp()
		const tokens = await signIn(app)
		const first = await refreshWith(app, tokens, tokens.refresh)
		expect(first.status).toBe(200)
		const rotated = first.body as {
			access_token: string
			refresh_token: string
		}
		expect((await callMcp(app, rotated.access_token)).status)
			.toBe(200)
		const reuse = await refreshWith(app, tokens, tokens.refresh)
		expect(reuse.status).toBe(400)
		expect(reuse.body).toMatchObject({ error: 'invalid_grant' })
		const successor = await refreshWith(
			app,
			tokens,
			rotated.refresh_token,
		)
		expect(successor.status).toBe(400)
		expect(successor.body).toMatchObject({ error: 'invalid_grant' })
		expect((await callMcp(app, tokens.access)).status).toBe(401)
		expect((await callMcp(app, rotated.access_token)).status)
			.toBe(401)
	})

	it('leaves other families alone', async function () {
		const app = makeApp()
		const doomed = await signIn(app)
		const healthy = await signIn(app)
		await refreshWith(app, doomed, doomed.refresh)
		await refreshWith(app, doomed, doomed.refresh)
		expect((await callMcp(app, healthy.access)).status).toBe(200)
		const res = await refreshWith(app, healthy, healthy.refresh)
		expect(res.status).toBe(200)
	})

	it('keeps rotating through a legitimate chain', async function () {
		const app = makeApp()
		const tokens = await signIn(app)
		let refresh = tokens.refresh
		for (let i = 0; i < 4; i += 1) {
			const res = await refreshWith(app, tokens, refresh)
			expect(res.status).toBe(200)
			refresh = (res.body as { refresh_token: string })
				.refresh_token
		}
	})

	it('forgets used ids after a restart', async function () {
		const tokens = await signIn(makeApp())
		const restarted = makeApp()
		const res = await refreshWith(
			restarted,
			tokens,
			tokens.refresh,
		)
		expect(res.status).toBe(200)
	})
})

describe('oauth consent decision and limits', function () {
	async function postAuthorize (
		app: Express,
		clientId: string,
		fields: Record<string, string>,
	): Promise<Response> {
		const page = await request(app)
			.get('/oauth/authorize')
			.query(authorizeQuery(clientId, makePkce()))
		return request(app)
			.post('/oauth/authorize')
			.type('form')
			.send({ request: hiddenRequest(page), ...fields })
	}

	it('requires an explicit approve', async function () {
		const app = makeApp()
		const clientId = await register(app)
		for (const decision of [undefined, '', 'maybe']) {
			const res = await postAuthorize(app, clientId, {
				api_key: keyOne,
				...(decision === undefined ? {} : { decision }),
			})
			expect(res.status).toBe(400)
			expect(res.headers.location).toBeUndefined()
		}
	})

	it('limits failed consent attempts per IP', async function () {
		const app = makeApp()
		const clientId = await register(app)
		const statuses: number[] = []
		for (let i = 0; i < 12; i += 1) {
			const res = await postAuthorize(app, clientId, {
				api_key: 'wrong',
				decision: 'approve',
			})
			statuses.push(res.status)
		}
		expect(statuses).toEqual([
			...Array.from({ length: 10 }, function () {
				return 401
			}),
			429,
			429,
		])
		const blocked = await postAuthorize(app, clientId, {
			api_key: keyOne,
			decision: 'approve',
		})
		expect(blocked.status).toBe(429)
		expect(blocked.text).toContain('Too many failed attempts')
	})

	it('does not count approvals or denials', async function () {
		const app = makeApp()
		const clientId = await register(app)
		for (let i = 0; i < 12; i += 1) {
			const res = await postAuthorize(app, clientId, {
				api_key: keyOne,
				decision: 'approve',
			})
			expect(res.status).toBe(302)
			const denied = await postAuthorize(app, clientId, {
				decision: 'deny',
			})
			expect(denied.status).toBe(302)
		}
		const wrong = await postAuthorize(app, clientId, {
			api_key: 'wrong',
			decision: 'approve',
		})
		expect(wrong.status).toBe(401)
	})
})

describe('oauth client id metadata documents', function () {
	function stubDocs (document: Record<string, unknown>) {
		return vi.fn(async function (_url: string) {
			return JSON.stringify(document)
		})
	}

	const document = {
		client_id: cimdUrl,
		client_name: 'ChatGPT',
		redirect_uris: [redirect],
		token_endpoint_auth_method: 'none',
		token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
	}

	function authorizeCimd (
		app: Express,
		clientId = cimdUrl,
		options: CodeOptions = {},
	): Promise<Response> {
		return request(app)
			.get('/oauth/authorize')
			.query(authorizeQuery(clientId, makePkce(), options))
	}

	it('completes the flow with a CIMD client_id', async function () {
		const mock = stubDocs(document)
		const app = makeApp({}, { fetchDocument: mock })
		const pkce = makePkce()
		const { code } = await getCode(app, cimdUrl, { pkce })
		const res = await tokenRequest(
			app,
			codeGrant(cimdUrl, code, pkce),
		)
		expect(res.status).toBe(200)
		const body = res.body as { access_token: string }
		expect((await callMcp(app, body.access_token)).status)
			.toBe(200)
		expect(mock).toHaveBeenCalledTimes(1)
		expect(mock).toHaveBeenCalledWith(cimdUrl)
	})

	it('caches the document', async function () {
		const mock = stubDocs(document)
		const app = makeApp({}, { fetchDocument: mock })
		for (let i = 0; i < 3; i += 1) {
			await authorizeCimd(app)
		}
		expect(mock).toHaveBeenCalledTimes(1)
	})

	it('rejects a document whose client_id differs', async function () {
		const mock = stubDocs({
			...document,
			client_id: `${cimdUrl}?x=1`,
		})
		const res = await authorizeCimd(
			makeApp({}, { fetchDocument: mock }),
		)
		expect(res.status).toBe(400)
		expect(res.headers.location).toBeUndefined()
	})

	it('drops redirect URIs on hosts that are not allowed', async function () {
		const evil = 'https://evil.example/cb'
		const only = stubDocs({ ...document, redirect_uris: [evil] })
		const none = await authorizeCimd(
			makeApp({}, { fetchDocument: only }),
		)
		expect(none.status).toBe(400)
		const mixed = stubDocs({
			...document,
			redirect_uris: [evil, redirect],
		})
		const res = await authorizeCimd(
			makeApp({}, { fetchDocument: mixed }),
			cimdUrl,
			{ redirectUri: evil },
		)
		expect(res.status).toBe(400)
		expect(res.headers.location).toBeUndefined()
	})

	it('only fetches hosts in OAUTH_CIMD_HOSTS', async function () {
		const mock = stubDocs(document)
		const app = makeApp({
			OAUTH_ALLOWED_REDIRECT_HOSTS: 'chatgpt.com,other.example',
		}, { fetchDocument: mock })
		const urls = [
			'https://other.example/client.json',
			'https://evil.example/client.json',
			'http://chatgpt.com/oauth/client.json',
			'https://chatgpt.com/',
			'https://127.0.0.1/client.json',
			'https://localhost/client.json',
			'https://user@chatgpt.com/client.json',
			'https://chatgpt.com:8443/client.json',
		]
		for (const url of urls) {
			const res = await authorizeCimd(app, url)
			expect(res.status).toBe(400)
		}
		expect(mock).not.toHaveBeenCalled()
	})

	it('honors an OAUTH_CIMD_HOSTS override', async function () {
		const url = 'https://other.example/client.json'
		const mock = stubDocs({ ...document, client_id: url })
		const app = makeApp({
			OAUTH_CIMD_HOSTS: 'other.example',
		}, { fetchDocument: mock })
		const res = await authorizeCimd(app, url)
		expect(res.status).toBe(200)
		expect(mock).toHaveBeenCalledWith(url)
		const denied = await authorizeCimd(app, cimdUrl)
		expect(denied.status).toBe(400)
	})

	it('fails closed when the fetch fails', async function () {
		const broken = vi.fn(async function (_url: string) {
			throw new Error('network down')
		})
		const res = await authorizeCimd(
			makeApp({}, { fetchDocument: broken }),
		)
		expect(res.status).toBe(400)
		const empty = vi.fn(async function (_url: string) {
			return undefined
		})
		const none = await authorizeCimd(
			makeApp({}, { fetchDocument: empty }),
		)
		expect(none.status).toBe(400)
	})

	it('rejects an oversized document', async function () {
		const mock = stubDocs({
			...document,
			client_name: 'x'.repeat(40_000),
		})
		const res = await authorizeCimd(
			makeApp({}, { fetchDocument: mock }),
		)
		expect(res.status).toBe(400)
	})

	it('rejects a client that needs client authentication', async function () {
		const mock = stubDocs({
			...document,
			token_endpoint_auth_method: 'private_key_jwt',
			token_endpoint_auth_methods_supported: ['private_key_jwt'],
		})
		const res = await authorizeCimd(
			makeApp({}, { fetchDocument: mock }),
		)
		expect(res.status).toBe(400)
	})
})
