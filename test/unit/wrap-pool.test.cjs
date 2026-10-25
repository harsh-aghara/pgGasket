'use strict';

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const { wrapPool } = require('../../dist/cjs/index.js');
const { MockPool } = require('../fixtures/mock-pool.cjs');

const originalWarn = console.warn;
let warnings;

afterEach(() => {
	console.warn = originalWarn;
});

function captureWarnings() {
	warnings = [];
	console.warn = (message) => warnings.push(message);
}

test('preserves pool and client behavior while tracking consumer connect', async () => {
	captureWarnings();
	const raw = new MockPool();
	const pool = wrapPool(raw, { threshold: 25 });
	assert.equal(pool instanceof MockPool, true);
	assert.equal(pool.connect, pool.connect);
	assert.equal(
		pool.on('x', () => {}),
		pool
	);
	const client = await pool.connect();
	assert.equal(client, raw.client);
	client.release();
	await new Promise((resolve) => setTimeout(resolve, 35));
	assert.deepEqual(warnings, []);
});

test('warns once with a consumer stack and writes a late-release note', async () => {
	captureWarnings();
	const pool = wrapPool(new MockPool(), { threshold: 5 });
	const client = await pool.connect();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /^pg-gasket: possible connection leak/m);
	assert.match(warnings[0], /wrap-pool\.test\.cjs/);
	assert.doesNotMatch(warnings[0], /gasketConnect/);
	client.release();
	assert.equal(warnings.length, 2);
	assert.match(warnings[1], /released after/);
});

test('does not track pool.query internal checkouts', async () => {
	captureWarnings();
	const raw = new MockPool();
	const pool = wrapPool(raw, { threshold: 5 });
	await pool.query('select 1');
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(raw.connectCalls, 1);
	assert.deepEqual(warnings, []);
});

test('supports callback connect and replaces done with the hooked release', () => {
	captureWarnings();
	const raw = new MockPool();
	const pool = wrapPool(raw, { threshold: 25 });
	pool.connect((error, client, done) => {
		assert.equal(error, undefined);
		assert.equal(done, client.release);
		done(true);
	});
	assert.equal(raw.removed, 1);
});

test('passes pg-pool double release errors through unchanged', async () => {
	captureWarnings();
	const pool = wrapPool(new MockPool(), { threshold: 25 });
	const client = await pool.connect();
	client.release();
	assert.throws(() => client.release(), /Release called on client/);
	assert.deepEqual(warnings, []);
});

test('unsampled warnings omit stacks and invalid options fail open', async () => {
	captureWarnings();
	const pool = wrapPool(new MockPool(), {
		threshold: 5,
		sampleRate: 0,
		typo: true
	});
	const client = await pool.connect();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.match(warnings.at(-1), /stack: unavailable/);
	assert.ok(warnings.some((line) => /unknown option/.test(line)));
	client.release();
});

test('pool.end cancels active checkout timers and suppresses leak warnings', async () => {
	captureWarnings();
	const raw = new MockPool();
	const pool = wrapPool(raw, { threshold: 10 });
	assert.equal(pool.end, pool.end);
	const client = await pool.connect();
	await pool.end();
	assert.equal(raw.ended, true);
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.deepEqual(warnings, []);
	client.release();
	assert.deepEqual(warnings, []);
});

test('warns when re-wrapping an already wrapped pool with new options', () => {
	captureWarnings();
	const raw = new MockPool();
	const wrapped1 = wrapPool(raw, { threshold: 50 });
	assert.deepEqual(warnings, []);

	const wrapped2 = wrapPool(wrapped1, { threshold: 100 });
	assert.equal(wrapped2, wrapped1);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /pool is already wrapped; options were ignored/);

	const wrapped3 = wrapPool(raw, { threshold: 100 });
	assert.equal(wrapped3, wrapped1);
	assert.equal(warnings.length, 2);
	assert.match(warnings[1], /pool is already wrapped; options were ignored/);

	const wrapped4 = wrapPool(wrapped1);
	const wrapped5 = wrapPool(raw);
	assert.equal(wrapped4, wrapped1);
	assert.equal(wrapped5, wrapped1);
	assert.equal(warnings.length, 2);
});

test('routes warnings to a custom function logger', async () => {
	captureWarnings();
	const customLogs = [];
	const pool = wrapPool(new MockPool(), {
		threshold: 5,
		logger: (msg) => customLogs.push(msg)
	});
	const client = await pool.connect();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(warnings.length, 0);
	assert.equal(customLogs.length, 1);
	assert.match(customLogs[0], /possible connection leak/);
	client.release();
	assert.equal(customLogs.length, 2);
	assert.match(customLogs[1], /released after/);
});

test('routes warnings to a custom object logger with a warn method', async () => {
	captureWarnings();
	const objectLogs = [];
	const customLogger = {
		warn: (msg) => objectLogs.push(msg)
	};
	const pool = wrapPool(new MockPool(), {
		threshold: 5,
		logger: customLogger
	});
	const client = await pool.connect();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(warnings.length, 0);
	assert.equal(objectLogs.length, 1);
	assert.match(objectLogs[0], /possible connection leak/);
	client.release();
});

test('suppresses text warnings when logger is set to false', async () => {
	captureWarnings();
	const pool = wrapPool(new MockPool(), {
		threshold: 5,
		logger: false
	});
	const client = await pool.connect();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(warnings.length, 0);
	client.release();
	assert.equal(warnings.length, 0);
});

test('invokes onLeak callback with structured leak details', async () => {
	captureWarnings();
	const leaks = [];
	const pool = wrapPool(new MockPool(), {
		threshold: 5,
		logger: false,
		onLeak: (info) => leaks.push(info)
	});
	const client = await pool.connect();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(warnings.length, 0);
	assert.equal(leaks.length, 1);
	assert.equal(typeof leaks[0].id, 'number');
	assert.ok(leaks[0].held >= 4);
	assert.equal(leaks[0].threshold, 5);
	assert.equal(typeof leaks[0].stack, 'string');
	assert.deepEqual(leaks[0].pool, { total: 1, idle: 0, waiting: 0 });
	client.release();
});

test('catches throwing onLeak and logger without breaking client release', async () => {
	captureWarnings();
	const pool = wrapPool(new MockPool(), {
		threshold: 5,
		logger: {
			warn() {
				throw new Error('logger broke');
			}
		},
		onLeak() {
			throw new Error('onLeak broke');
		}
	});
	const client = await pool.connect();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.doesNotThrow(() => client.release());
});
