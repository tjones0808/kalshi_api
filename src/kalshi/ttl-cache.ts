interface CacheEntry {
	value: unknown
	expiresAt: number
}

const DEFAULT_MAX_ENTRIES = 5000

/**
 * In-memory cache that drops entries after a time to live.
 * A TTL of 0 or less does not store a value, and `wrap`
 * will not read one either.
 *
 * The store holds at most `maxEntries` values. When a new key
 * would overflow it, expired entries go first, then the
 * oldest-written entries.
 */
export class TtlCache {
	private readonly store = new Map<string, CacheEntry>()
	private readonly inFlight = new Map<string, Promise<unknown>>()
	private readonly maxEntries: number

	/**
	 * @param maxEntries Upper bound on stored entries. Defaults
	 * to 5000.
	 */
	constructor (maxEntries: number = DEFAULT_MAX_ENTRIES) {
		if (!Number.isInteger(maxEntries) || maxEntries < 1) {
			throw new Error('maxEntries must be a positive integer')
		}
		this.maxEntries = maxEntries
	}

	/**
	 * Return a cached value, or `undefined` when it is missing
	 * or expired.
	 */
	get<T> (key: string): T | undefined {
		const entry = this.lookup(key)
		if (!entry) {
			return undefined
		}
		return entry.value as T
	}

	/**
	 * Store `value` until `ttlMs` milliseconds have elapsed.
	 * Non-positive TTLs are ignored.
	 */
	set<T> (key: string, value: T, ttlMs: number): void {
		if (!(ttlMs > 0)) {
			return
		}
		// Delete first so a rewrite moves the key to the newest slot.
		this.store.delete(key)
		if (this.store.size >= this.maxEntries) {
			this.makeRoom()
		}
		this.store.set(key, {
			value,
			expiresAt: Date.now() + ttlMs,
		})
	}

	/**
	 * Return a cached value, or call `fn`, store the result, and
	 * return it. Failures are not cached. Concurrent calls for
	 * the same key share one `fn` call. A non-positive `ttlMs`
	 * always calls `fn` and does not store the result.
	 */
	async wrap<T> (
		key: string,
		ttlMs: number,
		fn: () => Promise<T>,
	): Promise<T> {
		if (!(ttlMs > 0)) {
			return fn()
		}
		const entry = this.lookup(key)
		if (entry) {
			return entry.value as T
		}
		const pending = this.inFlight.get(key)
		if (pending) {
			return pending as Promise<T>
		}
		const load = this.load(key, ttlMs, fn)
		this.inFlight.set(key, load)
		try {
			return await load
		} finally {
			this.inFlight.delete(key)
		}
	}

	private async load<T> (
		key: string,
		ttlMs: number,
		fn: () => Promise<T>,
	): Promise<T> {
		const value = await fn()
		this.set(key, value, ttlMs)
		return value
	}

	private makeRoom (): void {
		const now = Date.now()
		for (const [key, entry] of this.store) {
			if (now >= entry.expiresAt) {
				this.store.delete(key)
			}
		}
		while (this.store.size >= this.maxEntries) {
			const oldest = this.store.keys().next()
			if (oldest.done) {
				return
			}
			this.store.delete(oldest.value)
		}
	}

	private lookup (key: string): CacheEntry | undefined {
		const entry = this.store.get(key)
		if (!entry) {
			return undefined
		}
		if (Date.now() >= entry.expiresAt) {
			this.store.delete(key)
			return undefined
		}
		return entry
	}
}
