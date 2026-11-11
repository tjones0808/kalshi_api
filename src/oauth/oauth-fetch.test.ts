import { describe, expect, it } from 'vitest'
import {
	createPublicLookup,
	fetchPublicText,
	isBlockedAddress,
	type Resolver,
} from './oauth-fetch.js'

function resolverFor (...addresses: string[]): Resolver {
	return async function () {
		return addresses.map(function (address) {
			return {
				address,
				family: address.includes(':') ? 6 : 4,
			}
		})
	}
}

function lookupOnce (
	resolve: Resolver,
	all = false,
): Promise<{ err: Error | null, address: unknown }> {
	return new Promise(function (done) {
		createPublicLookup(resolve)(
			'chatgpt.com',
			{ all },
			function (err, address) {
				done({ err, address })
			},
		)
	})
}

describe('isBlockedAddress', function () {
	it('blocks private, loopback, link-local, and reserved v4', function () {
		for (const address of [
			'0.0.0.0',
			'10.1.2.3',
			'100.64.0.1',
			'100.127.255.255',
			'127.0.0.1',
			'169.254.169.254',
			'172.16.0.1',
			'172.31.255.255',
			'192.168.1.1',
			'198.18.0.1',
			'224.0.0.1',
			'255.255.255.255',
		]) {
			expect(isBlockedAddress(address)).toBe(true)
		}
	})

	it('blocks private, loopback, and embedded v6', function () {
		for (const address of [
			'::',
			'::1',
			'fe80::1',
			'fc00::1',
			'fd12:3456::1',
			'ff02::1',
			'::ffff:127.0.0.1',
			'::ffff:10.0.0.1',
			'::ffff:8.8.8.8',
			'64:ff9b::a00:1',
			'2002:a00:1::1',
			'2001:db8::1',
		]) {
			expect(isBlockedAddress(address)).toBe(true)
		}
	})

	it('allows public addresses', function () {
		for (const address of [
			'8.8.8.8',
			'104.18.0.1',
			'172.32.0.1',
			'100.128.0.1',
			'2606:4700::1',
			'2a00:1450::1',
		]) {
			expect(isBlockedAddress(address)).toBe(false)
		}
	})

	it('blocks anything that is not an address', function () {
		for (const value of ['', 'localhost', 'chatgpt.com', '1.2.3']) {
			expect(isBlockedAddress(value)).toBe(true)
		}
	})
})

describe('createPublicLookup', function () {
	it('returns a public address', async function () {
		const one = await lookupOnce(resolverFor('104.18.0.1'))
		expect(one.err).toBeNull()
		expect(one.address).toBe('104.18.0.1')
		const all = await lookupOnce(
			resolverFor('104.18.0.1', '2606:4700::1'),
			true,
		)
		expect(all.err).toBeNull()
		expect(all.address).toHaveLength(2)
	})

	it('refuses when any answer is blocked', async function () {
		for (const addresses of [
			['10.0.0.1'],
			['104.18.0.1', '169.254.169.254'],
			['2606:4700::1', '::1'],
			[],
		]) {
			const res = await lookupOnce(resolverFor(...addresses))
			expect(res.err).not.toBeNull()
		}
	})

	it('passes a failed lookup on', async function () {
		const res = await lookupOnce(async function () {
			throw new Error('ENOTFOUND')
		})
		expect(res.err?.message).toBe('ENOTFOUND')
	})
})

describe('fetchPublicText', function () {
	it('gives up without connecting to a private address', async function () {
		const text = await fetchPublicText(
			'https://chatgpt.com/oauth/client.json',
			resolverFor('10.0.0.5'),
		)
		expect(text).toBeUndefined()
		const metadata = await fetchPublicText(
			'https://chatgpt.com/oauth/client.json',
			resolverFor('169.254.169.254'),
		)
		expect(metadata).toBeUndefined()
	})

	it('refuses non-https and invalid URLs', async function () {
		expect(await fetchPublicText('http://chatgpt.com/x'))
			.toBeUndefined()
		expect(await fetchPublicText('nope')).toBeUndefined()
	})
})
