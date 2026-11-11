/**
 * A non-success Kalshi HTTP response, or a body that was not JSON.
 */
export class KalshiHttpError extends Error {
	readonly status: number
	readonly path: string
	readonly bodySnippet: string

	/**
	 * @param status HTTP status, or the status of a body that
	 * failed to parse.
	 * @param path Request path relative to the API base URL.
	 * @param bodySnippet Short response text.
	 */
	constructor (
		status: number,
		path: string,
		bodySnippet: string,
	) {
		super(
			`Kalshi HTTP ${status} for ${path}: ${bodySnippet}`,
		)
		this.name = 'KalshiHttpError'
		this.status = status
		this.path = path
		this.bodySnippet = bodySnippet
	}
}

/**
 * HTTP 429 from Kalshi.
 * Raised when the client stops retrying a rate limit.
 */
export class KalshiRateLimitError extends KalshiHttpError {
	/**
	 * @param path Request path relative to the API base URL.
	 * @param bodySnippet Short response text.
	 */
	constructor (path: string, bodySnippet: string) {
		super(429, path, bodySnippet)
		this.name = 'KalshiRateLimitError'
	}
}

/**
 * A Kalshi request that hit the per-attempt timeout on every
 * try. The status is 504 and the body snippet is fixed.
 */
export class KalshiTimeoutError extends KalshiHttpError {
	/**
	 * @param path Request path relative to the API base URL.
	 */
	constructor (path: string) {
		super(504, path, 'request timed out')
		this.name = 'KalshiTimeoutError'
	}
}

/**
 * A Kalshi request that failed before any HTTP response, such
 * as a refused or reset connection. The status is 0 and the
 * body snippet is fixed, so the cause is never exposed. The
 * system error code (for example `ECONNREFUSED`) is kept on a
 * non-enumerable `code` property for logs only.
 */
export class KalshiNetworkError extends KalshiHttpError {
	/** System error code, or `undefined` when none was found. */
	declare readonly code: string | undefined

	/**
	 * @param path Request path relative to the API base URL.
	 * @param code System error code from the failed fetch.
	 */
	constructor (path: string, code?: string) {
		super(0, path, 'network error')
		this.name = 'KalshiNetworkError'
		Object.defineProperty(this, 'code', {
			value: code,
			enumerable: false,
		})
	}
}

const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,40}$/

/**
 * Read a system error code such as `ECONNREFUSED` from a
 * failed fetch. Undici nests it under `cause`.
 */
export function networkErrorCode (err: unknown): string | undefined {
	let current: unknown = err
	for (let depth = 0; depth < 3; depth += 1) {
		if (typeof current !== 'object' || current === null) {
			return undefined
		}
		const code = (current as { code?: unknown }).code
		if (typeof code === 'string' && ERROR_CODE.test(code)) {
			return code
		}
		current = (current as { cause?: unknown }).cause
	}
	return undefined
}

/**
 * Kalshi answered 401 or 403 to a signed request: the key id,
 * the private key, or the clock is wrong. The body snippet is
 * fixed so the response text never reaches logs or clients.
 */
export class KalshiAuthError extends KalshiHttpError {
	/**
	 * @param status 401 or 403.
	 * @param path Request path relative to the API base URL.
	 */
	constructor (status: number, path: string) {
		super(status, path, 'authentication failed')
		this.name = 'KalshiAuthError'
	}
}

/**
 * A portfolio method was called on a client that has no
 * signer, so there are no Kalshi credentials to sign with.
 */
export class KalshiAuthNotConfiguredError extends Error {
	constructor () {
		super('Kalshi credentials are not configured')
		this.name = 'KalshiAuthNotConfiguredError'
	}
}
