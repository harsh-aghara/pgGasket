'use strict';

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const { wrapPool } = require('../../dist/cjs/index.js');
const { MockPool } = require('../fixtures/mock-pool.cjs');

const originalWarn = console.warn;
afterEach(() => {
	console.warn = originalWarn;
});

test('normalizes invalid options without refusing to wrap the pool', () => {
	const messages = [];
	console.warn = (message) => messages.push(message);
	const raw = new MockPool();
	const wrapped = wrapPool(raw, {
		threshold: Infinity,
		sampleRate: NaN,
		unknown: 'x'
	});
	assert.notEqual(wrapped, raw);
	assert.equal(messages.length, 3);
	assert.ok(messages.every((message) => /configuration/.test(message)));
});

test('clamps timer overflow and sampling bounds', async () => {
	const messages = [];
	console.warn = (message) => messages.push(message);
	const pool = wrapPool(new MockPool(), { threshold: 9e12, sampleRate: -1 });
	const client = await pool.connect();
	client.release();
	assert.ok(messages.some((message) => /2147483647/.test(message)));
	assert.ok(
		messages.some((message) => /sampleRate was clamped to 0/.test(message))
	);
});

test('normalizes invalid logger and onLeak options with diagnostics', () => {
	const messages = [];
	console.warn = (message) => messages.push(message);
	const raw = new MockPool();
	wrapPool(raw, {
		logger: 123,
		onLeak: 'not-a-func'
	});
	assert.ok(
		messages.some((message) => /logger must be a function/.test(message))
	);
	assert.ok(
		messages.some((message) => /onLeak must be a function/.test(message))
	);
});
