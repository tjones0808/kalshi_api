import type { NextFunction, Request, Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
	KalshiHttpError,
	KalshiNetworkError,
	KalshiRateLimitError,
	KalshiTimeoutError,
	networkErrorCode,
} from '../kalshi/errors.js'
import {
	errorHandler,
	notFoundHandler,
} from './error-handler.js'

interface Sent {
	statusCode: number
	body: unknown
	jsonCalls: number
}

function fakeRes (headersSent = false) {
	const sent: Sent = {
		statusCode: 0,
		body: undefined,
		jsonCalls: 0,
	}
	const res = {
		headersSent,
		status (code: number) {
			sent.statusCode = code
			return this
		},
		json (body: unknown) {
			sent.body = body
			sent.jsonCalls += 1
			return this
		},
	}
	return {
		res: res as unknown as Response,
		sent,
	}
}

function silenceError () {
	return vi.spyOn(console, 'error').mockImplementation(
		function () {},
	)
}

describe('error handler', function () {
	afterEach(function () {
		vi.restoreAllMocks()
	})

	it('hides unknown error details', function () {
		const spy = silenceError()
		const err = new Error('postgres://secret-db')
		const { res, sent } = fakeRes()
		const next = vi.fn()
		errorHandler(
			err,
			{} as Request,
			res,
			next as NextFunction,
		)
		expect(sent.statusCode).toBe(500)
		expect(sent.body).toEqual({
			error: 'internal_error',
			message: 'Internal server error',
		})
		expect(JSON.stringify(sent.body)).not.toContain(
			'secret-db',
		)
		expect(spy).toHaveBeenCalledWith(
			'Error: postgres://secret-db',
			err.stack,
		)
		expect(next).not.toHaveBeenCalled()
	})

	it('logs Kalshi errors as status and path only', function () {
		const spy = silenceError()
		const err = new KalshiHttpError(
			500,
			'/markets',
			'body-secret',
		)
		const { res } = fakeRes()
		errorHandler(
			err,
			{ headers: { authorization: 'Bearer top-secret' } } as
				unknown as Request,
			res,
			vi.fn() as NextFunction,
		)
		expect(spy).toHaveBeenCalledTimes(1)
		expect(spy).toHaveBeenCalledWith(
			'kalshi error status=500 path=/markets',
		)
		const logged = JSON.stringify(spy.mock.calls)
		expect(logged).not.toContain('body-secret')
		expect(logged).not.toContain('top-secret')
	})

	it('maps a Kalshi timeout to 504', function () {
		silenceError()
		const err = new KalshiTimeoutError('/markets')
		const { res, sent } = fakeRes()
		errorHandler(
			err,
			{} as Request,
			res,
			vi.fn() as NextFunction,
		)
		expect(sent.statusCode).toBe(504)
		expect(sent.body).toEqual({
			error: 'upstream_timeout',
			message: 'Upstream request timed out',
		})
	})

	it('logs only the system code of a network error', function () {
		const spy = silenceError()
		const cause = Object.assign(new Error('connect 10.0.0.1:443'), {
			code: 'ECONNREFUSED',
		})
		const err = new KalshiNetworkError(
			'/markets',
			networkErrorCode(new TypeError('fetch failed', { cause })),
		)
		errorHandler(
			err,
			{} as Request,
			fakeRes().res,
			vi.fn() as NextFunction,
		)
		expect(spy).toHaveBeenCalledWith(
			'kalshi error status=0 path=/markets code=ECONNREFUSED',
		)
		expect(JSON.stringify(spy.mock.calls)).not.toContain('10.0.0.1')
		expect(JSON.stringify(err)).not.toContain('ECONNREFUSED')
	})

	it('maps a Kalshi network failure to 502', function () {
		silenceError()
		const err = new KalshiNetworkError('/markets')
		const { res, sent } = fakeRes()
		errorHandler(
			err,
			{} as Request,
			res,
			vi.fn() as NextFunction,
		)
		expect(sent.statusCode).toBe(502)
		expect(sent.body).toEqual({
			error: 'upstream_error',
			message: 'Upstream request failed',
		})
	})

	it('keeps the message of custom Zod refinements', function () {
		silenceError()
		const schema = z.object({ a: z.number() }).superRefine(
			function (_value, ctx) {
				ctx.addIssue({
					code: 'custom',
					message: 'a is not allowed',
				})
			},
		)
		const result = schema.safeParse({ a: 1 })
		const { res, sent } = fakeRes()
		errorHandler(
			result.error,
			{} as Request,
			res,
			vi.fn() as NextFunction,
		)
		expect(sent.statusCode).toBe(400)
		expect(sent.body).toEqual({
			error: 'bad_request',
			message: 'a is not allowed',
		})
	})

	it(
		'maps ZodError to 400 without the input',
		function () {
			silenceError()
			let caught: unknown
			try {
				z.number().parse('super-secret-input')
			} catch (err) {
				caught = err
			}
			const { res, sent } = fakeRes()
			errorHandler(
				caught,
				{} as Request,
				res,
				vi.fn() as NextFunction,
			)
			expect(sent.statusCode).toBe(400)
			expect(sent.body).toEqual({
				error: 'bad_request',
				message: 'Invalid request',
			})
			expect(JSON.stringify(sent.body)).not.toContain(
				'super-secret-input',
			)
		},
	)

	it('uses statusCode on client errors', function () {
		silenceError()
		const err = new Error('Cursor is invalid')
		Object.assign(err, {
			statusCode: 400,
			error: 'bad_request',
		})
		const { res, sent } = fakeRes()
		errorHandler(
			err,
			{} as Request,
			res,
			vi.fn() as NextFunction,
		)
		expect(sent.body).toEqual({
			error: 'bad_request',
			message: 'Cursor is invalid',
		})
	})

	it(
		'hides messages on 5xx statusCode errors',
		function () {
			silenceError()
			const err = new Error('disk path secret')
			Object.assign(err, { statusCode: 503 })
			const { res, sent } = fakeRes()
			errorHandler(
				err,
				{} as Request,
				res,
				vi.fn() as NextFunction,
			)
			expect(sent.statusCode).toBe(503)
			expect(sent.body).toEqual({
				error: 'internal_error',
				message: 'Internal server error',
			})
			expect(JSON.stringify(sent.body)).not.toContain(
				'secret',
			)
		},
	)

	it('delegates when headers are sent', function () {
		silenceError()
		const err = new Error('late')
		const { res, sent } = fakeRes(true)
		const next = vi.fn()
		errorHandler(
			err,
			{} as Request,
			res,
			next as NextFunction,
		)
		expect(next).toHaveBeenCalledWith(err)
		expect(sent.jsonCalls).toBe(0)
	})

	it('returns json 404', function () {
		const { res, sent } = fakeRes()
		notFoundHandler({} as Request, res)
		expect(sent.statusCode).toBe(404)
		expect(sent.body).toEqual({
			error: 'not_found',
			message: 'Not found',
		})
	})

	it(
		'maps Kalshi rate limits to 502',
		function () {
			silenceError()
			const err = new KalshiRateLimitError(
				'/events',
				'retry-secret',
			)
			const { res, sent } = fakeRes()
			errorHandler(
				err,
				{} as Request,
				res,
				vi.fn() as NextFunction,
			)
			expect(sent.statusCode).toBe(502)
			expect(sent.body).toEqual({
				error: 'upstream_rate_limited',
				message: 'Kalshi rate limited the request',
			})
			expect(JSON.stringify(sent.body)).not.toContain(
				'retry-secret',
			)
		},
	)

	it('maps Kalshi 404 using status', function () {
		silenceError()
		const err = new KalshiHttpError(
			404,
			'/markets/NOPE',
			'hidden-body',
		)
		const { res, sent } = fakeRes()
		errorHandler(
			err,
			{} as Request,
			res,
			vi.fn() as NextFunction,
		)
		expect(sent.statusCode).toBe(404)
		expect(sent.body).toEqual({
			error: 'not_found',
			message: 'Not found',
		})
		expect(JSON.stringify(sent.body)).not.toContain(
			'hidden-body',
		)
	})

	it('maps Kalshi 400 without the body', function () {
		silenceError()
		const err = new KalshiHttpError(
			400,
			'/markets',
			'bad-cursor-secret',
		)
		const { res, sent } = fakeRes()
		errorHandler(
			err,
			{} as Request,
			res,
			vi.fn() as NextFunction,
		)
		expect(sent.statusCode).toBe(400)
		expect(sent.body).toEqual({
			error: 'bad_request',
			message: 'Invalid request',
		})
		expect(JSON.stringify(sent.body)).not.toContain(
			'bad-cursor-secret',
		)
	})

	it('maps other Kalshi HTTP errors to 502', function () {
		silenceError()
		const err = new KalshiHttpError(
			500,
			'/markets',
			'disk-secret',
		)
		const { res, sent } = fakeRes()
		errorHandler(
			err,
			{} as Request,
			res,
			vi.fn() as NextFunction,
		)
		expect(sent.statusCode).toBe(502)
		expect(sent.body).toEqual({
			error: 'upstream_error',
			message: 'Upstream request failed',
		})
		expect(JSON.stringify(sent.body)).not.toContain(
			'disk-secret',
		)
	})

	it('maps invalid dates to 400', function () {
		silenceError()
		const err = new Error('date must be YYYY-MM-DD')
		const { res, sent } = fakeRes()
		errorHandler(
			err,
			{} as Request,
			res,
			vi.fn() as NextFunction,
		)
		expect(sent.statusCode).toBe(400)
		expect(sent.body).toEqual({
			error: 'bad_request',
			message: 'date must be YYYY-MM-DD',
		})
	})

	it('maps unknown leagues to 400', function () {
		silenceError()
		const err = new Error('Unknown league series "KXOOPS"')
		const { res, sent } = fakeRes()
		errorHandler(
			err,
			{} as Request,
			res,
			vi.fn() as NextFunction,
		)
		expect(sent.statusCode).toBe(400)
		expect(sent.body).toEqual({
			error: 'bad_request',
			message: 'Unknown league series "KXOOPS"',
		})
	})

	it(
		'maps a milestone with no game to 404',
		function () {
			silenceError()
			const err = new Error(
				'Milestone abc has no game event',
			)
			const { res, sent } = fakeRes()
			errorHandler(
				err,
				{} as Request,
				res,
				vi.fn() as NextFunction,
			)
			expect(sent.statusCode).toBe(404)
			expect(sent.body).toEqual({
				error: 'not_found',
				message: 'Milestone abc has no game event',
			})
		},
	)
})
