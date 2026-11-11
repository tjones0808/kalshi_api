import {
	constants,
	sign as cryptoSign,
	type KeyObject,
} from 'node:crypto'

const KEY_ID_PREFIX_LENGTH = 4
const MASK_ALL_MAX_LENGTH = 8

/** Inputs for {@link createKalshiSigner}. */
export interface KalshiSignerOptions {
	/** Kalshi API key id (sent as `KALSHI-ACCESS-KEY`). */
	keyId: string
	/** Parsed RSA or Ed25519 private key. */
	privateKey: KeyObject
}

/** The three headers Kalshi requires on an authed request. */
export interface KalshiAuthHeaders {
	'KALSHI-ACCESS-KEY': string
	'KALSHI-ACCESS-TIMESTAMP': string
	'KALSHI-ACCESS-SIGNATURE': string
}

/**
 * Signs one request. `pathname` is the full URL pathname,
 * `/trade-api/v2` prefix included. Anything from `?` on is
 * ignored. Every call reads the clock, so a retry that calls
 * again gets a fresh timestamp.
 */
export type KalshiSigner = (
	method: string,
	pathname: string,
) => KalshiAuthHeaders

/**
 * Key id made safe to log: `****` when it is 8 characters or
 * fewer, otherwise its first four characters and an ellipsis.
 */
export function maskKeyId (keyId: string): string {
	if (keyId.length <= MASK_ALL_MAX_LENGTH) {
		return '****'
	}
	return `${keyId.slice(0, KEY_ID_PREFIX_LENGTH)}…`
}

/**
 * Build a request signer for Kalshi's key auth.
 *
 * The signed text is `timestampMs + METHOD + pathname`.
 * RSA keys sign it with RSA-PSS, SHA-256, MGF1-SHA256 and a
 * salt as long as the digest; Ed25519 keys sign it directly.
 * The signature is base64.
 *
 * @throws When the key is neither RSA nor Ed25519.
 */
export function createKalshiSigner (
	options: KalshiSignerOptions,
): KalshiSigner {
	const { keyId, privateKey } = options
	const keyType = privateKey.asymmetricKeyType
	if (keyType !== 'rsa' && keyType !== 'ed25519') {
		throw new Error('Unsupported private key type')
	}

	function signText (text: string): Buffer {
		const message = Buffer.from(text, 'utf8')
		if (keyType === 'ed25519') {
			return cryptoSign(null, message, privateKey)
		}
		return cryptoSign('sha256', message, {
			key: privateKey,
			padding: constants.RSA_PKCS1_PSS_PADDING,
			saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
		})
	}

	return function sign (
		method: string,
		pathname: string,
	): KalshiAuthHeaders {
		const timestamp = String(Date.now())
		const path = pathname.split(/[?#]/, 1)[0] ?? ''
		const text = `${timestamp}${method.toUpperCase()}${path}`
		return {
			'KALSHI-ACCESS-KEY': keyId,
			'KALSHI-ACCESS-TIMESTAMP': timestamp,
			'KALSHI-ACCESS-SIGNATURE':
				signText(text).toString('base64'),
		}
	}
}
