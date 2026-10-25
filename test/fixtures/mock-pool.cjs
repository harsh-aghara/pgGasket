'use strict';

const { EventEmitter } = require('node:events');

class MockClient extends EventEmitter {
	constructor() {
		super();
		this.released = true;
		this.release = undefined;
	}

	checkout(pool) {
		this.released = false;
		this.release = (error) => {
			if (this.released)
				throw new Error(
					'Release called on client which has already been released to the pool.'
				);
			this.released = true;
			if (error) pool.removed += 1;
			else pool.idleCount += 1;
		};
		return this;
	}

	async query() {
		return { rows: [] };
	}
}

class MockPool extends EventEmitter {
	constructor() {
		super();
		this.totalCount = 1;
		this.idleCount = 1;
		this.waitingCount = 0;
		this.removed = 0;
		this.client = new MockClient();
		this.connectCalls = 0;
		this.ended = false;
	}

	connect(callback) {
		this.connectCalls += 1;
		const client = this.client.checkout(this);
		this.idleCount = 0;
		if (typeof callback === 'function')
			return callback(undefined, client, client.release);
		return Promise.resolve(client);
	}

	async query() {
		const client = await this.connect();
		try {
			return await client.query();
		} finally {
			client.release();
		}
	}

	async end() {
		this.ended = true;
	}
}

module.exports = { MockClient, MockPool };
