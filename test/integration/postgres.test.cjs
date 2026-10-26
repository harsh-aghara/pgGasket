'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { wrapPool } = require('../../dist/cjs/index.js');

const connectionString = process.env.DATABASE_URL;

let pg;
try {
	pg = require('pg');
} catch {
	// pg not installed
}

test(
	'real PostgreSQL leak warning and pool.query exclusion',
	{
		skip:
			(!connectionString || !pg) &&
			'set DATABASE_URL and install pg to run integration tests'
	},
	async () => {
		const { Pool } = pg;
		const messages = [];
		const prior = console.warn;
		console.warn = (message) => messages.push(message);
		const raw = new Pool({ connectionString });
		const pool = wrapPool(raw, { threshold: 20 });
		try {
			const client = await pool.connect();
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(
				messages.filter((message) => /possible connection leak/.test(message))
					.length,
				1
			);
			client.release();
			messages.length = 0;
			await pool.query('select pg_sleep(0.05)');
			assert.equal(messages.length, 0);
		} finally {
			console.warn = prior;
			await raw.end();
		}
	}
);
