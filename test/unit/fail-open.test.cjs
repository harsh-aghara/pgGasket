'use strict';

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const { wrapPool } = require('../../dist/cjs/index.js');

const originalWarn = console.warn;
afterEach(() => {
	console.warn = originalWarn;
});

test('passes a synchronous connect error through by identity', () => {
	const expected = new Error('connect failed');
	const pool = {
		connect() {
			throw expected;
		}
	};
	assert.throws(
		() => wrapPool(pool).connect(),
		(actual) => actual === expected
	);
});

test('passes a rejected connect error through by identity', async () => {
	const expected = new Error('connect failed');
	const pool = {
		connect() {
			return Promise.reject(expected);
		}
	};
	await assert.rejects(
		wrapPool(pool).connect(),
		(actual) => actual === expected
	);
});

test('returns a frozen client without making a timer when release cannot be hooked', async () => {
	const client = Object.freeze({ release() {} });
	const messages = [];
	console.warn = (message) => messages.push(message);
	const pool = {
		totalCount: 0,
		idleCount: 0,
		waitingCount: 0,
		connect() {
			return Promise.resolve(client);
		}
	};
	assert.equal(await wrapPool(pool, { threshold: 1 }).connect(), client);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(
		messages.filter((message) => /possible connection leak/.test(message))
			.length,
		0
	);
	assert.ok(
		messages.some((message) => /checkout instrumentation/.test(message))
	);
});

test('a throwing console never changes a client release result', async () => {
	console.warn = () => {
		throw new Error('closed output');
	};
	let released = false;
	const client = {
		release() {
			released = true;
			return 123;
		}
	};
	const pool = {
		connect() {
			return Promise.resolve(client);
		}
	};
	const wrapped = wrapPool(pool, { threshold: 1 });
	const checkedOut = await wrapped.connect();
	assert.equal(checkedOut.release(), 123);
	assert.equal(released, true);
});
