# pg-gasket

<p align="left">
  <strong>Catch forgotten <code>client.release()</code> calls before your PostgreSQL pool runs out of breath.</strong>
</p>

<p align="left">
  <a href="https://github.com/harsh-aghara/pg-gasket/actions/workflows/ci.yml"><img src="https://github.com/harsh-aghara/pg-gasket/actions/workflows/ci.yml/badge.svg" alt="CI Status" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg" alt="Node >= 18" />
  <img src="https://img.shields.io/badge/TypeScript-Ready-blue.svg" alt="TypeScript Ready" />
  <img src="https://img.shields.io/badge/dependencies-0-success.svg" alt="Zero Dependencies" />
</p>

---

## The Problem

When using [`node-postgres`](https://github.com/brianc/node-postgres), acquiring a client from the connection pool requires returning it when done:

```js
const client = await pool.connect();
try {
	await client.query('SELECT 1');
} finally {
	client.release(); // Forgetting this line starves the pool!
}
```

A missing `finally` block or an early `return` can quietly keep a connection checked out indefinitely. Under load, connection pools exhaust their capacity, new queries hang forever, and debugging across hundreds of endpoints to find _which_ request leaked the client is notoriously painful.

## The Solution

`pg-gasket` wraps your existing `pg.Pool` with a lightweight, transparent `Proxy`. If an application-owned checkout is held longer than your configured threshold, `pg-gasket` logs a warning with the **exact origin stack trace** where `pool.connect()` was called.

---

## Features

- **Exact Origin Stack Traces:** Pinpoint the exact line of application code where the leaked checkout originated.
- **Zero Overhead on Normal Checkouts:** Uses V8 lazy stack capture (`Error.captureStackTrace`). Stack trace strings are only serialized if a leak actually occurs.
- **Fail-Open Safety:** Never evicts connections, closes sockets, or alters native `pg` behavior. If anything fails inside `pg-gasket`, your queries continue running uninterrupted.
- **Smart Query Exclusion:** `pool.query(...)` checkouts are intentionally untracked because `pg-pool` manages them internally. Slow queries never trigger false-positive leak warnings.
- **APM & Metrics Ready:** Structured `onLeak` callback allows seamless integration with OpenTelemetry, Prometheus, Datadog, or Pino/Winston.
- **Clean Event Loop:** Leak timers call `unref()`, ensuring background monitoring never delays graceful process shutdown.
- **Zero Dependencies:** Pure JavaScript/TypeScript using native Node.js and V8 primitives. Dual CJS/ESM support.

---

## Installation

```sh
# npm
npm install pg-gasket

# pnpm
pnpm add pg-gasket

# yarn
yarn add pg-gasket

# bun
bun add pg-gasket
```

_(Note: `pg` is an optional peer dependency; `pg-gasket` works with `pg` `^8.0.0`.)_

---

## Quick Start

### ES Modules / TypeScript

```ts
import { Pool } from 'pg';
import { wrapPool } from 'pg-gasket';

const pool = wrapPool(new Pool(), {
	threshold: 5000 // warn if a checkout is held > 5 seconds
});

// Use the pool exactly as you normally would:
const client = await pool.connect();

// If client.release() is not called within 5 seconds, pg-gasket warns you!
```

### CommonJS

```js
const { Pool } = require('pg');
const { wrapPool } = require('pg-gasket');

const pool = wrapPool(new Pool(), {
	threshold: 5000
});
```

---

## What a Warning Looks Like

When a connection checkout exceeds the configured threshold, `pg-gasket` outputs a structured warning:

```
pg-gasket: possible connection leak
checkout: 1
held: 5012ms
threshold: 5000ms
stack:
    at checkoutConnection (/app/services/billing.js:42:24)
    at processInvoice (/app/routes/invoices.js:18:9)
    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)
pool: total=10, idle=0, waiting=3
```

When the connection is finally returned to the pool, a resolution note is logged:

```
pg-gasket: checkout 1 released after 5230ms
```

---

## Configuration Options

Pass an options object as the second argument to `wrapPool(pool, options)`:

| Option       | Type                              | Default        | Description                                                                                                                                          |
| :----------- | :-------------------------------- | :------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------- |
| `threshold`  | `number`                          | `5000`         | Milliseconds a connection checkout may be held before triggering a warning.                                                                          |
| `sampleRate` | `number`                          | `1`            | Fraction of checkouts to capture stack traces for (`0` to `1`). Set to `0` to disable stack capture while still tracking durations and pool metrics. |
| `logger`     | `Function` \| `Object` \| `false` | `console.warn` | Custom logger function `(msg) => void`, logger object with a `.warn(msg)` method (e.g. Pino, Winston), or `false` to suppress text warnings.         |
| `onLeak`     | `(info: LeakInfo) => void`        | `undefined`    | Callback invoked with structured data when a connection leak is detected. Ideal for APM and metrics systems.                                         |

---

## Observability & APM Integration

Use the `onLeak` callback to forward structured leak events to your metrics or APM provider:

```ts
import { wrapPool, type LeakInfo } from 'pg-gasket';
import { Pool } from 'pg';

const pool = wrapPool(new Pool(), {
	threshold: 5000,
	logger: false, // disable console.warn if using structured logging
	onLeak(info: LeakInfo) {
		// Increment Prometheus / OpenTelemetry counter
		connectionLeakCounter.add(1, { pool_waiting: info.pool.waiting });

		// Send structured event to Datadog or Pino
		logger.warn(
			{
				event: 'database.connection_leak',
				checkoutId: info.id,
				heldDurationMs: info.held,
				thresholdMs: info.threshold,
				poolStats: info.pool,
				stack: info.stack
			},
			'PostgreSQL connection held beyond threshold'
		);
	}
});
```

---

## How It Works

1. **Proxy Interception:** `wrapPool` returns a Proxy wrapping your pool. Only `pool.connect()` is intercepted; all other pool methods and properties operate natively.
2. **`pool.query()` Exclusion:** Pool methods execute with `this` bound to the raw pool. When `pool.query()` calls `this.connect()` internally, it bypasses tracking, preventing long-running analytical queries from generating false leak warnings.
3. **Release Hooking:** When `pool.connect()` resolves, `client.release` is wrapped with a lightweight hook that cancels the checkout timer and records late release notes.
4. **Lazy V8 Stack Capture:** Stacks are registered via `Error.captureStackTrace` with the wrapper set as the boundary function, omitting internal library frames. V8 only formats the string if the timer fires.

For in-depth architectural details, see [docs/architecture.md](docs/architecture.md).

---

## Contributing

Contributions, bug reports, and suggestions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for local development setup and guidelines.

---

## License

[MIT](LICENSE) © 2026 harsh-aghara
