import { describe, expect, it } from 'vitest'
import { createExpiringSet } from './expiring-set.js'

describe('createExpiringSet', function () {
	it('reserves an id once', function () {
		const set = createExpiringSet(10, () => 0)
		expect(set.reserve('a', 100)).toBe(true)
		expect(set.reserve('a', 100)).toBe(false)
		expect(set.has('a')).toBe(true)
		expect(set.has('b')).toBe(false)
	})

	it('forgets an id at its deadline', function () {
		let now = 0
		const set = createExpiringSet(10, function () {
			return now
		})
		set.reserve('a', 5)
		now = 4_999
		expect(set.has('a')).toBe(true)
		now = 5_000
		expect(set.has('a')).toBe(false)
		expect(set.reserve('a', 50)).toBe(true)
	})

	it('scans out expired entries before dropping live ones', function () {
		let now = 0
		const set = createExpiringSet(3, function () {
			return now
		})
		set.reserve('old1', 1)
		set.reserve('live', 1000)
		set.reserve('old2', 2)
		now = 10_000
		set.reserve('new', 2000)
		expect(set.has('live')).toBe(true)
		expect(set.has('new')).toBe(true)
		expect(set.reserve('live', 1000)).toBe(false)
	})

	it('drops the oldest live entry when full', function () {
		const set = createExpiringSet(2, () => 0)
		set.reserve('a', 1000)
		set.reserve('b', 1000)
		set.reserve('c', 1000)
		expect(set.has('a')).toBe(false)
		expect(set.has('b')).toBe(true)
		expect(set.has('c')).toBe(true)
	})
})
