import { loadEnv } from './config/env.js'
import { createGamesService } from './domain/games-service.js'
import { createParlayService } from './domain/parlay-service.js'
import { createPortfolioService } from './domain/portfolio-service.js'
import { createApp } from './http/app.js'
import { createCachedKalshiClient } from './kalshi/cached-client.js'
import { KalshiHttpError } from './kalshi/errors.js'
import { createKalshiClient } from './kalshi/kalshi-client.js'
import {
	createKalshiSigner,
	maskKeyId,
} from './kalshi/kalshi-signer.js'
import { TtlCache } from './kalshi/ttl-cache.js'

const SHUTDOWN_TIMEOUT_MS = 10_000

/** Startup line saying whether Kalshi requests are signed. */
function authStatusLine (keyId: string | undefined): string {
	if (keyId === undefined) {
		return 'kalshi auth: disabled (public data only)'
	}
	return `kalshi auth: enabled (key ${maskKeyId(keyId)})`
}

function describeError (err: unknown): string {
	if (err instanceof KalshiHttpError) {
		return `${err.name} status=${err.status} path=${err.path}`
	}
	if (err instanceof Error) {
		return `${err.name}: ${err.message}\n${err.stack ?? ''}`
	}
	return String(err)
}

/**
 * Start the HTTP server and close it on SIGTERM or SIGINT.
 * Parlay quotes use the uncached client so they stay fresh.
 * With Kalshi credentials the raw client signs every request,
 * and the portfolio service reads through it, never the cache.
 */
function main (): void {
	const env = loadEnv()
	const cache = new TtlCache(env.cacheMaxEntries)
	const signer = env.kalshiAuth === null
		? undefined
		: createKalshiSigner(env.kalshiAuth)
	const raw = createKalshiClient({
		baseUrl: env.kalshiBaseUrl,
		timeoutMs: env.kalshiTimeoutMs,
		deadlineMs: env.kalshiDeadlineMs,
		...(signer === undefined ? {} : { signer }),
	})
	const kalshi = createCachedKalshiClient(raw, cache, env)
	const games = createGamesService(kalshi)
	const parlay = createParlayService(raw)
	const app = createApp(env, {
		kalshi,
		games,
		parlay,
		...(signer === undefined
			? {}
			: { portfolio: createPortfolioService(raw) }),
	})
	console.log(authStatusLine(env.kalshiAuth?.keyId))
	const server = app.listen(env.port, '0.0.0.0', function () {
		console.log(`listening on 0.0.0.0:${env.port}`)
	})
	let isShuttingDown = false

	function shutdown (signal: string): void {
		if (isShuttingDown) {
			return
		}
		isShuttingDown = true
		console.log(`received ${signal}, closing server`)
		setTimeout(function () {
			console.error('shutdown timed out, forcing exit')
			process.exit(1)
		}, SHUTDOWN_TIMEOUT_MS).unref()
		server.close(function () {
			process.exit(0)
		})
	}

	server.on('error', function (err) {
		console.error(`server error: ${describeError(err)}`)
		process.exit(1)
	})
	process.on('unhandledRejection', function (reason) {
		console.error(
			`unhandledRejection: ${describeError(reason)}`,
		)
	})
	process.on('uncaughtException', function (err) {
		console.error(`uncaughtException: ${describeError(err)}`)
		process.exit(1)
	})
	process.on('SIGTERM', function () {
		shutdown('SIGTERM')
	})
	process.on('SIGINT', function () {
		shutdown('SIGINT')
	})
}

main()
