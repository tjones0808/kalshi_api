import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TtlCache } from './ttl-cache.js'

describe('TtlCache', function () {
	beforeEach(function () {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
	})

	afterEach(function () {
		vi.useRealTimers()
	})

	it('returns a value until the ttl elapses', function () {
		const cache = new TtlCache()
		cache.set('price', '0.42', 1_000)
		expect(cache.get('price')).toBe('0.42')
		vi.advanceTimersByTime(999)
		expect(cache.get('price')).toBe('0.42')
		vi.advanceTimersByTime(1)
		expect(cache.get('price')).toBeUndefined()
	})

	it('keeps the latest value for a key', function () {
		const cache = new TtlCache()
		cache.set('k', 'a', 1_000)
		cache.set('k', 'b', 1_000)
		expect(cache.get('k')).toBe('b')
	})

	it('caches a successful wrap and not a failed one', async function () {
		const cache = new TtlCache()
		let calls = 0

		async function load (): Promise<string> {
			calls += 1
			if (calls < 3) {
				throw new Error('nope')
			}
			return 'ok'
		}

		await expect(
			cache.wrap('k', 5_000, load),
		).rejects.toThrow('nope')
		await expect(
			cache.wrap('k', 5_000, load),
		).rejects.toThrow('nope')
		await expect(
			cache.wrap('k', 5_000, load),
		).resolves.toBe('ok')
		await expect(
			cache.wrap('k', 5_000, load),
		).resolves.toBe('ok')
		expect(calls).toBe(3)
		expect(cache.get('k')).toBe('ok')
	})

	it('skips reads and writes when ttl is not positive', async function () {
		const cache = new TtlCache()
		cache.set('k', 'stale', 5_000)
		let calls = 0

		async function load (): Promise<string> {
			calls += 1
			return 'fresh'
		}

		await expect(cache.wrap('k', 0, load)).resolves.toBe('fresh')
		expect(calls).toBe(1)
		expect(cache.get('k')).toBe('stale')

		cache.set('zero', 1, 0)
		cache.set('neg', 3, -5)
		expect(cache.get('zero')).toBeUndefined()
		expect(cache.get('neg')).toBeUndefined()
	})

	it('evicts the oldest entry when full', function () {
		const cache = new TtlCache(2)
		cache.set('a', 1, 10_000)
		cache.set('b', 2, 10_000)
		cache.set('c', 3, 10_000)
		expect(cache.get('a')).toBeUndefined()
		expect(cache.get('b')).toBe(2)
		expect(cache.get('c')).toBe(3)
	})

	it('drops expired entries before evicting live ones', function () {
		const cache = new TtlCache(2)
		cache.set('old', 1, 1_000)
		cache.set('live', 2, 10_000)
		vi.advanceTimersByTime(1_000)
		cache.set('new', 3, 10_000)
		expect(cache.get('live')).toBe(2)
		expect(cache.get('new')).toBe(3)
	})

	it('moves a rewritten key to the newest slot', function () {
		const cache = new TtlCache(2)
		cache.set('a', 1, 10_000)
		cache.set('b', 2, 10_000)
		cache.set('a', 3, 10_000)
		cache.set('c', 4, 10_000)
		expect(cache.get('b')).toBeUndefined()
		expect(cache.get('a')).toBe(3)
		expect(cache.get('c')).toBe(4)
	})

	it('does not evict when rewriting a key at capacity', function () {
		const cache = new TtlCache(2)
		cache.set('a', 1, 10_000)
		cache.set('b', 2, 10_000)
		cache.set('b', 3, 10_000)
		expect(cache.get('a')).toBe(1)
		expect(cache.get('b')).toBe(3)
	})

	it('rejects an invalid maxEntries', function () {
		expect(function () {
			return new TtlCache(0)
		}).toThrow('maxEntries')
	})

	it('shares one in-flight load per key', async function () {
		const cache = new TtlCache()
		let calls = 0
		let release: (value: string) => void = function () {}
		const gate = new Promise<string>(function (resolve) {
			release = resolve
		})

		function load (): Promise<string> {
			calls += 1
			return gate
		}

		const first = cache.wrap('k', 5_000, load)
		const second = cache.wrap('k', 5_000, load)
		release('ok')
		await expect(first).resolves.toBe('ok')
		await expect(second).resolves.toBe('ok')
		expect(calls).toBe(1)
	})

	it('shares a failed in-flight load and retries after', async function () {
		const cache = new TtlCache()
		let calls = 0

		async function load (): Promise<string> {
			calls += 1
			if (calls === 1) {
				throw new Error('boom')
			}
			return 'ok'
		}

		const first = cache.wrap('k', 5_000, load)
		const second = cache.wrap('k', 5_000, load)
		await expect(first).rejects.toThrow('boom')
		await expect(second).rejects.toThrow('boom')
		await expect(cache.wrap('k', 5_000, load)).resolves.toBe('ok')
		expect(calls).toBe(2)
	})
})
