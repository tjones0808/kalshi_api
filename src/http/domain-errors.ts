import type { ZodError } from 'zod'

const MILESTONE_PREFIX = 'Milestone '
const MILESTONE_SUFFIX = ' has no game event'

/**
 * Text that can be shown to a client.
 * Stacks and multiline dumps stay off the wire.
 */
export function isSafeClientText (message: string): boolean {
	if (message.length === 0) {
		return false
	}
	if (message.includes('\n')) {
		return false
	}
	if (message.includes('    at ')) {
		return false
	}
	return true
}

function isMissingGameEvent (message: string): boolean {
	if (!message.startsWith(MILESTONE_PREFIX)) {
		return false
	}
	if (!message.endsWith(MILESTONE_SUFFIX)) {
		return false
	}
	const idLength = message.length
		- MILESTONE_PREFIX.length
		- MILESTONE_SUFFIX.length
	return idLength > 0
}

/**
 * HTTP status for a calendar or league failure thrown by our
 * own code, or `undefined` for any other message. Only these
 * messages may be shown to a client.
 */
export function domainStatus (
	message: string,
): number | undefined {
	if (message === 'date must be YYYY-MM-DD') {
		return 400
	}
	if (message.startsWith('Unknown league')) {
		return 400
	}
	if (isMissingGameEvent(message)) {
		return 404
	}
	return undefined
}

/**
 * Our own `custom` refinements (such as the candle range
 * checks) carry fixed messages, so they are safe to show.
 * Any other Zod issue becomes `fallback`.
 */
export function zodClientMessage (
	err: ZodError,
	fallback: string,
): string {
	const isCustom = err.issues.length > 0
		&& err.issues.every(function (issue) {
			return issue.code === 'custom'
				&& isSafeClientText(issue.message)
		})
	if (!isCustom) {
		return fallback
	}
	return err.issues
		.map(function (issue) {
			return issue.message
		})
		.join('; ')
}
