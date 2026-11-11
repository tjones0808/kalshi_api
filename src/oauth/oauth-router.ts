import express, {
	type NextFunction,
	type Request,
	type Response,
	type Router,
} from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import {
	consentCsp,
	renderConsentPage,
	renderErrorPage,
} from './consent-page.js'
import {
	MCP_PATH,
	authorizationServerMetadata,
	protectedResourceMetadata,
} from './oauth-metadata.js'
import {
	readParams,
	type ConsentState,
	type OAuthService,
} from './oauth-service.js'

const bodyLimit = '8kb'
const metadataCacheControl = 'public, max-age=300'
const wrongKeyMessage = 'The API key was not accepted.'
const authorizeFailureMax = 10

/** Settings for `createOAuthRouter`. */
export interface OAuthRouterOptions {
	/** Window for the failed consent attempt limit. */
	windowMs: number
}

function sendOAuthError (
	res: Response,
	status: number,
	error: string,
	description: string,
): void {
	res.set('Cache-Control', 'no-store')
	res.status(status).json({
		error,
		error_description: description,
	})
}

function sendHtml (
	res: Response,
	status: number,
	html: string,
	redirectUri?: string,
): void {
	res.set({
		'Cache-Control': 'no-store',
		'Content-Security-Policy': consentCsp(redirectUri),
		'X-Frame-Options': 'DENY',
	})
	res.status(status).type('html').send(html)
}

function sendConsent (
	res: Response,
	status: number,
	state: ConsentState,
	errorMessage?: string,
): void {
	const html = renderConsentPage({
		...state,
		...(errorMessage === undefined ? {} : { errorMessage }),
	})
	sendHtml(res, status, html, state.redirectUri)
}

function sendRedirect (res: Response, location: string): void {
	res.set('Cache-Control', 'no-store')
	res.redirect(302, location)
}

function isClientError (err: unknown): boolean {
	if (typeof err !== 'object' || err === null) {
		return false
	}
	const status = (err as { statusCode?: unknown }).statusCode
	return typeof status === 'number'
		&& status >= 400
		&& status < 500
}

/**
 * Router for the OAuth authorization server and its discovery
 * documents. Mount it before the API key check: every route
 * here is public. Each form route parses its own small
 * body, so no other route gains a parser.
 *
 * Routes: both protected resource metadata paths, the
 * authorization server metadata, `POST /oauth/register`,
 * `GET` and `POST /oauth/authorize`, and `POST /oauth/token`.
 * `POST /oauth/authorize` also has its own limit of 10 failed
 * attempts (a wrong key or bad form) per IP per window, on top
 * of the anonymous limiter; approvals and denials do not count.
 * Token responses and consent pages are `no-store`. Nothing
 * here logs a token, code, or key.
 */
export function createOAuthRouter (
	service: OAuthService,
	options: OAuthRouterOptions,
): Router {
	const router = express.Router()
	const config = service.config
	const form = express.urlencoded({
		extended: false,
		limit: bodyLimit,
	})
	const json = express.json({ limit: bodyLimit })
	const failedAttempts = rateLimit({
		windowMs: options.windowMs,
		max: authorizeFailureMax,
		standardHeaders: true,
		legacyHeaders: false,
		skipSuccessfulRequests: true,
		keyGenerator: function (req) {
			return ipKeyGenerator(req.ip ?? '')
		},
		handler: function (_req, res) {
			sendHtml(
				res,
				429,
				renderErrorPage('Too many failed attempts. Try again later.'),
			)
		},
		validate: { xForwardedForHeader: false },
	})

	function sendResourceMetadata (
		_req: Request,
		res: Response,
	): void {
		res.set('Cache-Control', metadataCacheControl)
		res.json(protectedResourceMetadata(config))
	}

	function sendServerMetadata (
		_req: Request,
		res: Response,
	): void {
		res.set('Cache-Control', metadataCacheControl)
		res.json(authorizationServerMetadata(config))
	}

	function handleRegister (req: Request, res: Response): void {
		const result = service.register(req.body)
		if (!result.ok) {
			sendOAuthError(res, 400, result.error, result.description)
			return
		}
		res.set('Cache-Control', 'no-store')
		res.status(201).json(result.body)
	}

	async function handleAuthorizeGet (
		req: Request,
		res: Response,
	): Promise<void> {
		const result = await service.begin(readParams(req.query))
		if (result.kind === 'redirect') {
			sendRedirect(res, result.location)
			return
		}
		if (result.kind === 'error_page') {
			sendHtml(res, 400, renderErrorPage(result.message))
			return
		}
		sendConsent(res, 200, result)
	}

	function handleAuthorizePost (
		req: Request,
		res: Response,
	): void {
		const result = service.complete(readParams(req.body))
		if (result.kind === 'redirect') {
			sendRedirect(res, result.location)
			return
		}
		if (result.kind === 'error_page') {
			sendHtml(res, 400, renderErrorPage(result.message))
			return
		}
		sendConsent(res, 401, result, wrongKeyMessage)
	}

	function handleToken (req: Request, res: Response): void {
		const result = service.exchange(readParams(req.body))
		res.set({
			'Cache-Control': 'no-store',
			Pragma: 'no-cache',
		})
		if (!result.ok) {
			sendOAuthError(
				res,
				result.status,
				result.error,
				result.description,
			)
			return
		}
		res.status(200).json(result.body)
	}

	function handleBodyError (
		err: unknown,
		_req: Request,
		res: Response,
		next: NextFunction,
	): void {
		if (!isClientError(err) || res.headersSent) {
			next(err)
			return
		}
		sendOAuthError(
			res,
			400,
			'invalid_request',
			'The request body could not be read',
		)
	}

	router.get(
		[
			'/.well-known/oauth-protected-resource',
			`/.well-known/oauth-protected-resource${MCP_PATH}`,
		],
		sendResourceMetadata,
	)
	router.get(
		'/.well-known/oauth-authorization-server',
		sendServerMetadata,
	)
	router.post('/oauth/register', json, handleRegister)
	router.get('/oauth/authorize', handleAuthorizeGet)
	router.post(
		'/oauth/authorize',
		failedAttempts,
		form,
		handleAuthorizePost,
	)
	router.post('/oauth/token', form, handleToken)
	router.use(handleBodyError)
	return router
}
