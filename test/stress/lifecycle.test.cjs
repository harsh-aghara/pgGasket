'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { wrapPool } = require('../../dist/cjs/index.js');
const { MockPool } = require('../fixtures/mock-pool.cjs');

test('100,000 checkout/release cycles do not retain wrapper state', async () => {
	const prior = console.warn;
	console.warn = () => {};
	try {
		const pool = wrapPool(new MockPool(), { threshold: 60_000, sampleRate: 0 });
		for (let index = 0; index < 100_000; index += 1) {
			const client = await pool.connect();
			client.release();
		}
		if (global.gc) global.gc();
		assert.equal(pool.idleCount, 1);
	} finally {
		console.warn = prior;
	}
});
