# pg-gasket

`wrapPool(pool)` warns when an application-owned `pool.connect()` checkout is held too long.

```js
const { Pool } = require('pg');
const { wrapPool } = require('pg-gasket');

const pool = wrapPool(new Pool(), { threshold: 5_000, sampleRate: 1 });
const client = await pool.connect();
// client.release()
```

`threshold` is measured in milliseconds and defaults to `5000`. `sampleRate` controls stack capture from `0` to `1`; unsampled warnings still report duration and pool counts, but omit the stack.

`logger` accepts a custom logger function `(msg) => void`, a logger object with a `.warn(msg)` method (e.g. Pino, Winston), or `false` to suppress text warnings. Defaults to `console.warn`.

`onLeak` receives structured leak details `{ id, held, threshold, stack, pool: { total, idle, waiting } }`, suitable for structured loggers and APM/metrics systems (e.g. OpenTelemetry, Datadog).

The wrapper keeps the client object identity and hooks its per-checkout `release` function. It never closes or evicts a client. A repeated release preserves pg-pool's own error. `pool.query()` is intentionally untracked because pg-pool uses `connect()` internally for that convenience method; a slow query would otherwise be reported as a leak.

Warnings use one `console.warn` call. The first line, `pg-gasket: possible connection leak`, is stable. Stack frames are supplied verbatim by Node and can contain absolute source paths. Use `node --enable-source-maps` when that is appropriate for your application.

## Development checks

```sh
npm install
npm test
npm run test:stress
docker compose up -d
DATABASE_URL=postgres://postgres:postgres@localhost:5433/pg_gasket npm run test:integration
npm run test:package
```

The integration suite skips when `DATABASE_URL` is absent. `npm run spike:stack` records the local V8 stack shape; `npm run spike:pool` requires the optional `pg` peer.
