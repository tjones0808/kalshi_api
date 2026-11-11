import { lookup as dnsLookup } from 'node:dns/promises'
import { request } from 'node:https'
import {
	BlockList,
	isIP,
	type LookupFunction,
} from 'node:net'

const fetchTimeoutMs = 5000
const fetchMaxBytes = 16 * 1024

/** One resolved address of a host. */
export interface ResolvedAddress {
	address: string
	family: number
}

/** Resolves a host to all of its addresses. */
export type Resolver = (
	host: string,
) => Promise<ResolvedAddress[]>

/** Fetches a URL and returns the body, or `undefined`. */
export type DocumentFetcher = (
	url: string,
) => Promise<string | undefined>

const blocked = new BlockList()

const blockedV4: Array<[string, number]> = [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.88.99.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4],
	['240.0.0.0', 4],
]

const blockedV6: Array<[string, number]> = [
	['::', 128],
	['::1', 128],
	['64:ff9b::', 96],
	['100::', 64],
	['2001::', 32],
	['2001:db8::', 32],
	['2002::', 16],
	['fc00::', 7],
	['fe80::', 10],
	['fec0::', 10],
	['ff00::', 8],
]

for (const [net, prefix] of blockedV4) {
	blocked.addSubnet(net, prefix, 'ipv4')
}
for (const [net, prefix] of blockedV6) {
	blocked.addSubnet(net, prefix, 'ipv6')
}

/**
 * `BlockList` matches an IPv4 address against IPv4-mapped IPv6
 * rules, so the mapped range is checked here instead, on the
 * normalized form.
 */
function isMappedV4 (address: string): boolean {
	try {
		return new URL(`http://[${address}]`).hostname
			.startsWith('[::ffff:')
	} catch {
		return true
	}
}

/**
 * Whether an address may not be fetched: loopback, private,
 * link-local (including the 169.254.169.254 metadata
 * address), carrier-grade NAT, multicast, reserved,
 * documentation, and IPv6 ranges that embed an IPv4 address
 * (mapped, NAT64, 6to4, Teredo). Anything that is not an IP
 * address is blocked.
 */
export function isBlockedAddress (address: string): boolean {
	const version = isIP(address)
	if (version === 0) {
		return true
	}
	if (version === 6 && isMappedV4(address)) {
		return true
	}
	return blocked.check(address, version === 4 ? 'ipv4' : 'ipv6')
}

async function resolveAll (
	host: string,
): Promise<ResolvedAddress[]> {
	return dnsLookup(host, { all: true, verbatim: true })
}

/**
 * A `lookup` for `https.request` that resolves every address
 * and refuses the connection when any of them is blocked.
 * The socket then connects to an address this function
 * returned, so a second DNS answer cannot redirect it.
 */
export function createPublicLookup (
	resolve: Resolver = resolveAll,
): LookupFunction {
	return function publicLookup (host, options, callback) {
		resolve(host).then(
			function (addresses) {
				const first = addresses[0]
				const isSafe = first !== undefined
					&& addresses.every(function (entry) {
						return !isBlockedAddress(entry.address)
					})
				if (first === undefined || !isSafe) {
					callback(
						new Error('Blocked address') as
							NodeJS.ErrnoException,
						'',
						0,
					)
					return
				}
				if (options.all === true) {
					callback(null, addresses)
					return
				}
				callback(null, first.address, first.family)
			},
			function (err: unknown) {
				callback(
					(err instanceof Error
						? err
						: new Error('Lookup failed')) as
						NodeJS.ErrnoException,
					'',
					0,
				)
			},
		)
	}
}

/**
 * GET an https URL and return the body as text. Any failure
 * resolves to `undefined`: a blocked or failed lookup, a
 * non-200 status (redirects are not followed), more than
 * 16 KiB, or more than 5 s in total.
 */
export function fetchPublicText (
	url: string,
	resolve?: Resolver,
): Promise<string | undefined> {
	return new Promise(function (done) {
		let target: URL
		try {
			target = new URL(url)
		} catch {
			done(undefined)
			return
		}
		if (target.protocol !== 'https:') {
			done(undefined)
			return
		}
		const req = request(target, {
			method: 'GET',
			headers: { accept: 'application/json' },
			lookup: createPublicLookup(resolve),
			agent: false,
			signal: AbortSignal.timeout(fetchTimeoutMs),
		}, function (res) {
			if (res.statusCode !== 200) {
				res.resume()
				done(undefined)
				return
			}
			const chunks: Buffer[] = []
			let total = 0
			res.on('data', function (chunk: Buffer) {
				total += chunk.length
				if (total > fetchMaxBytes) {
					req.destroy()
					done(undefined)
					return
				}
				chunks.push(chunk)
			})
			res.on('end', function () {
				done(Buffer.concat(chunks).toString('utf8'))
			})
			res.on('error', function () {
				done(undefined)
			})
		})
		req.on('error', function () {
			done(undefined)
		})
		req.end()
	})
}
