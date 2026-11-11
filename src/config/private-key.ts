import { createPrivateKey, type KeyObject } from 'node:crypto'

const PEM_MARKER = '-----BEGIN'
const BASE64_BODY = /^[A-Za-z0-9+/=_-]+$/

/**
 * Turn an env value into PEM text.
 * Accepts a raw multiline PEM, a PEM whose newlines are the
 * two characters `\n`, or base64 of a PEM (any value without
 * a `-----BEGIN` marker).
 */
export function normalizePem (value: string): string | undefined {
	const trimmed = value.trim()
	if (trimmed.includes(PEM_MARKER)) {
		return trimmed
			.replace(/\\r/g, '')
			.replace(/\\n/g, '\n')
	}
	const compact = trimmed.replace(/\s+/g, '')
	if (!BASE64_BODY.test(compact)) {
		return undefined
	}
	const decoded = Buffer.from(compact, 'base64').toString('utf8')
	return decoded.includes(PEM_MARKER) ? decoded : undefined
}

/**
 * Parse an RSA or Ed25519 private key from env text.
 *
 * Error messages name `label` and the problem only. They never
 * include the key text or the parser's own message.
 *
 * @param value PEM, `\n`-escaped PEM, or base64 PEM.
 * @param label Env variable name used in error messages.
 */
export function parsePrivateKey (
	value: string,
	label: string,
): KeyObject {
	const invalid = `${label} is not a valid private key. Use a `
		+ 'PEM, a PEM with \\n escapes, or a base64-encoded PEM '
		+ '(RSA or Ed25519, no passphrase).'
	const pem = normalizePem(value)
	if (pem === undefined) {
		throw new Error(invalid)
	}
	let key: KeyObject
	try {
		key = createPrivateKey(pem)
	} catch {
		throw new Error(invalid)
	}
	const keyType = key.asymmetricKeyType
	if (keyType !== 'rsa' && keyType !== 'ed25519') {
		throw new Error(
			`${label} must be an RSA or Ed25519 private key.`,
		)
	}
	return key
}
