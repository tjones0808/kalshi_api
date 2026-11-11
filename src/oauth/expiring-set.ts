/** A bounded set of ids that each stop counting at a deadline. */
export interface ExpiringSet {
	/**
	 * Add `id` unless it is already present and unexpired.
	 * Returns `false` for a duplicate. The check and the add
	 * happen in one synchronous step, so of two callers with
	 * the same id exactly one gets `true`.
	 */
	reserve: (id: string, expiresAtSeconds: number) => boolean
	/** Whether `id` is present and unexpired. */
	has: (id: string) => boolean
}

/**
 * Create an in-memory `ExpiringSet`. At `maxEntries` it first
 * scans out every expired entry, and only if that frees no
 * room does it drop the oldest. `now` returns epoch
 * milliseconds. The set lives in one process: a restart
 * forgets it, and replicas do not share it.
 */
export function createExpiringSet (
	maxEntries: number,
	now: () => number = Date.now,
): ExpiringSet {
	const entries = new Map<string, number>()

	function nowSeconds (): number {
		return Math.floor(now() / 1000)
	}

	function makeRoom (): void {
		const current = nowSeconds()
		for (const [id, expiresAt] of entries) {
			if (expiresAt <= current) {
				entries.delete(id)
			}
		}
		while (entries.size >= maxEntries) {
			const oldest = entries.keys().next().value
			if (oldest === undefined) {
				return
			}
			entries.delete(oldest)
		}
	}

	return {
		reserve (id, expiresAtSeconds) {
			const existing = entries.get(id)
			if (existing !== undefined && existing > nowSeconds()) {
				return false
			}
			entries.delete(id)
			if (entries.size >= maxEntries) {
				makeRoom()
			}
			entries.set(id, expiresAtSeconds)
			return true
		},
		has (id) {
			const expiresAt = entries.get(id)
			return expiresAt !== undefined && expiresAt > nowSeconds()
		},
	}
}
