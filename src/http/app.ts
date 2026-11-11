import express, {
	type Express,
	type Request,
	type Response,
} from 'express'
import helmet from 'helmet'
import type { AppEnv } from '../config/env.js'
import type { GamesService } from '../domain/games-service.js'
import type { ParlayService } from '../domain/parlay-service.js'
import type { PortfolioService } from '../domain/portfolio-service.js'
import type { KalshiClient } from '../kalshi/kalshi-client.js'
import {
	createAnonRateLimit,
	createKeyMatcher,
	createKeyRateLimit,
	createPortfolioAccess,
	requireApiKey,
} from './auth.js'
import {
	errorHandler,
	notFoundHandler,
} from './error-handler.js'
import { createMcpExpressHandler } from '../mcp/server.js'
import { createOAuthRouter } from '../oauth/oauth-router.js'
import {
	createOAuthService,
	type OAuthDeps,
} from '../oauth/oauth-service.js'
import { createPortfolioRouter } from './routes/portfolio.js'
import { createV1Router } from './routes/v1.js'

/** Kalshi-backed services used by `/v1` routes. */
export interface AppServices {
	kalshi: KalshiClient
	games: GamesService
	parlay: ParlayService
	/**
	 * Read-only account service. Leave it out when no Kalshi
	 * credentials are configured: `/v1/portfolio/*` then
	 * answers 503 and the MCP portfolio tools are not listed.
	 */
	portfolio?: PortfolioService
}

/** Extras for `createApp`, mainly seams for tests. */
export interface AppOptions {
	/** Passed to the OAuth service when OAuth is on. */
	oauth?: OAuthDeps
}

function handleHealth (_req: Request, res: Response): void {
	res.status(200).json({
		status: 'ok',
		service: 'kalshi-sports-api',
	})
}

function handleAuthCheck (
	_req: Request,
	res: Response,
): void {
	res.status(200).json({ ok: true })
}

/**
 * Create the Express app.
 *
 * Railway terminates TLS in front of this process, so
 * `trust proxy` is 1 (one hop). Failed auth is
 * limited by client IP before the API key check.
 * Requests with a valid key skip that bucket.
 * Authenticated limits then use the API key index. Bodies
 * are parsed last, so only authenticated callers reach the
 * JSON parser.
 *
 * With `env.oauth` set, the OAuth router is mounted after the
 * anonymous limiter and before the key check, so its routes
 * are public and share the per-IP bucket. A valid OAuth
 * access token then passes the key check and the anonymous
 * limiter skip like an API key. Without `env.oauth` none of
 * this exists and behavior is unchanged.
 *
 * API keys stay inside middleware closures. They are not
 * copied onto `app.locals`.
 *
 * Pass `services` to mount `/v1` and `/mcp`. Auth tests
 * omit them, so those routes stay unmounted. `/mcp`
 * uses the same bearer API key as `/v1`.
 *
 * `/v1/portfolio` is mounted ahead of the rest of `/v1`. It and
 * the MCP portfolio tools are open to every API key unless
 * `PORTFOLIO_API_KEYS` narrows them.
 */
export function createApp (
	env: AppEnv,
	services?: AppServices,
	options: AppOptions = {},
): Express {
	const app = express()
	app.use(helmet())
	// Railway: trust one proxy hop.
	app.set('trust proxy', 1)
	app.get('/health', handleHealth)
	const oauth = env.oauth === null
		? undefined
		: createOAuthService(
			env.oauth,
			env.apiKeys,
			createKeyMatcher(env),
			Date.now,
			options.oauth ?? {},
		)
	app.use(createAnonRateLimit(env, oauth?.gate))
	if (oauth !== undefined) {
		app.use(createOAuthRouter(oauth, {
			windowMs: env.rateLimitWindowMs,
		}))
	}
	app.use(requireApiKey(env, oauth?.gate))
	app.use(createKeyRateLimit(env))
	app.use(express.json({ limit: '32kb' }))
	app.get('/v1/_auth-check', handleAuthCheck)
	if (services) {
		const portfolioAccess = createPortfolioAccess(env)
		app.use(
			'/v1/portfolio',
			createPortfolioRouter(
				services.portfolio,
				portfolioAccess,
			),
		)
		app.use('/v1', createV1Router(services))
		app.all(
			'/mcp',
			createMcpExpressHandler(services, portfolioAccess),
		)
	}
	app.use(notFoundHandler)
	app.use(errorHandler)
	return app
}
