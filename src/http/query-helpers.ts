import { z } from 'zod'

/** Treat an absent or blank query value as not given. */
export function emptyToUndefined (value: unknown): unknown {
	if (value === undefined || value === '') {
		return undefined
	}
	return value
}

/** Optional non-empty text query parameter. */
export function optionalText () {
	return z.preprocess(
		emptyToUndefined,
		z.string().min(1).optional(),
	)
}

/** Optional integer query parameter, `min` to `max` inclusive. */
export function optionalInt (min: number, max?: number) {
	const schema = z.coerce.number().int().min(min)
	const bounded = max === undefined
		? schema
		: schema.max(max)
	return z.preprocess(
		emptyToUndefined,
		bounded.optional(),
	)
}

/**
 * Copy `value` without its `undefined` properties, so parsed
 * zod output can be passed where `exactOptionalPropertyTypes`
 * forbids an explicit `undefined`.
 */
export function omitUndefined<T extends object> (
	value: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
	const result: Record<string, unknown> = {}
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) {
			result[key] = item
		}
	}
	return result as { [K in keyof T]?: Exclude<T[K], undefined> }
}
