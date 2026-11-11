import { createHash } from 'node:crypto'
import { isLoopbackHost } from './oauth-clients.js'

const styles = [
	'body{font-family:system-ui,sans-serif;max-width:28rem;',
	'margin:3rem auto;padding:0 1rem;line-height:1.5}',
	'label{display:block;margin:1rem 0 .25rem;font-weight:600}',
	'input[type=password]{width:100%;padding:.5rem;',
	'box-sizing:border-box}',
	'button{margin:1rem .5rem 0 0;padding:.5rem 1rem}',
	'.error{color:#b00020}',
	'code{word-break:break-all}',
].join('')

const styleHash = createHash('sha256')
	.update(styles, 'utf8')
	.digest('base64')

/** Values the consent page shows and carries forward. */
export interface ConsentView {
	clientName: string
	redirectUri: string
	/** Signed request blob, echoed back in a hidden field. */
	request: string
	/** Generic failure text, shown when the API key was wrong. */
	errorMessage?: string
}

/** Escape text for use in HTML content and attribute values. */
export function escapeHtml (value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll('\'', '&#39;')
}

/**
 * CSP for the consent page. No scripts run, styles are pinned
 * by hash, and framing is refused. `form-action` lists the
 * redirect origin as well as `'self'` because Chromium checks
 * the redirect after a form POST against it, and the POST
 * ends in a redirect to the client.
 */
export function consentCsp (redirectUri: string | undefined): string {
	const sources = ['\'self\'']
	if (redirectUri !== undefined) {
		sources.push(new URL(redirectUri).origin)
	}
	return [
		'default-src \'none\'',
		`style-src 'sha256-${styleHash}'`,
		`form-action ${sources.join(' ')}`,
		'frame-ancestors \'none\'',
		'base-uri \'none\'',
	].join('; ')
}

function page (title: string, body: string): string {
	return '<!doctype html>'
		+ '<html lang="en"><head><meta charset="utf-8">'
		+ '<meta name="viewport" '
		+ 'content="width=device-width,initial-scale=1">'
		+ `<title>${escapeHtml(title)}</title>`
		+ `<style>${styles}</style></head>`
		+ `<body>${body}</body></html>`
}

/**
 * The consent page: names the client and the host it will
 * return to, and asks for an API key. Every dynamic value is
 * escaped.
 */
export function renderConsentPage (view: ConsentView): string {
	const url = new URL(view.redirectUri)
	const warning = isLoopbackHost(url.hostname)
		? '<p class="error">This client runs on the same '
			+ 'computer as your browser.</p>'
		: ''
	const error = view.errorMessage === undefined
		? ''
		: `<p class="error" role="alert">${
			escapeHtml(view.errorMessage)
		}</p>`
	return page('Authorize access', [
		'<h1>Authorize access</h1>',
		`<p><strong>${escapeHtml(view.clientName)}</strong> `,
		'wants to read Kalshi data with your API key. After ',
		'you approve, your browser returns to ',
		`<code>${escapeHtml(url.host)}</code>.</p>`,
		warning,
		error,
		'<form method="post" action="/oauth/authorize">',
		'<input type="hidden" name="request" ',
		`value="${escapeHtml(view.request)}">`,
		'<label for="api_key">API key</label>',
		'<input id="api_key" name="api_key" type="password" ',
		'autocomplete="off" required>',
		'<button type="submit" name="decision" value="approve">',
		'Approve</button>',
		'<button type="submit" name="decision" value="deny" ',
		'formnovalidate>Deny</button>',
		'</form>',
	].join(''))
}

/** A plain page for requests that cannot safely redirect. */
export function renderErrorPage (message: string): string {
	return page('Authorization error', [
		'<h1>Authorization error</h1>',
		`<p class="error">${escapeHtml(message)}</p>`,
		'<p>Close this tab and start again from the app.</p>',
	].join(''))
}
