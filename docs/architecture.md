# Architecture & Design Internals

`pg-gasket` provides lightweight, fail-open connection leak warnings for applications using `node-postgres` (`pg`). This document details the architectural decisions, runtime invariants, and design tradeoffs underlying the library.

---

## 1. High-Level Design

Connection leaks in relational databases typically occur when an application checks out a client from a connection pool via `pool.connect()` but fails to call `client.release()` (for instance, due to an unhandled exception or missing `finally` block). Over time, the pool exhausts its available connections and incoming queries hang indefinitely.

`pg-gasket` wraps an existing `pg.Pool` instance using a JavaScript `Proxy`. It intercepts connection checkouts, schedules an unreferenced timeout for each checkout, and emits a warning with the origin stack trace if the connection is not returned to the pool within the configured threshold.

```
+-------------------------------------------------------------+
|                          Consumer                           |
+-------------------------------------------------------------+
         |                                           ^
         | pool.connect()                            | client
         v                                           |
+-------------------------------------------------------------+
|                     pg-gasket Proxy                         |
|  - Samples checkout stack via Error.captureStackTrace        |
|  - Starts unref'd timer (default 5000ms)                    |
|  - Hooks client.release()                                   |
+-------------------------------------------------------------+
         |                                           ^
         | rawPool.connect()                         | rawClient
         v                                           |
+-------------------------------------------------------------+
|                      node-postgres                          |
+-------------------------------------------------------------+
```

---

## 2. Proxy Receiver Semantics (`pool.query` Exclusion)

One of the most critical engineering decisions in `pg-gasket` is distinguishing between explicit, application-owned checkouts (`pool.connect()`) and internal, library-owned checkouts (`pool.query()`).

In `pg-pool`, the convenience method `pool.query(text, values)` internally calls `this.connect()` to acquire a connection, executes the query, and releases the connection in a `finally` block. If `pg-gasket` tracked `this.connect()` during a slow analytical query (e.g., lasting 10 seconds with a 5-second threshold), it would trigger a false-positive leak warning.

To prevent this, the proxy intercepts pool method invocations and explicitly binds `this` to the raw, underlying pool:

```ts
const result = Reflect.apply(
	current,
	this === proxy || this == null ? target : this,
	args
);
return result === target ? proxy : result;
```

Because `this` inside `pool.query` points to `target` (the raw pool) rather than `proxy`, its internal call to `this.connect()` hits `rawPool.connect` directly, bypassing the gasket wrapper entirely. Only calls made directly on the proxy (`proxy.connect()`) are instrumented.

---

## 3. Connection Instrumentation & Release Hooking

When a client is checked out, `pg-gasket` hooks its `release` function:

1. **Identity Preservation:** The wrapper returns the exact `Client` instance provided by `pg`. No surrogate objects or client proxies are created.
2. **Hooking `client.release`:** The client's own `release` property is wrapped with a function that:
   - Clears the pending leak timer and removes the entry from the registry.
   - If the connection already triggered a leak warning, emits a late-release notification (`checkout X released after Yms`).
   - Forwards all arguments directly to the original release method via `Reflect.apply`.
3. **Double-Release Passthrough:** If an application calls `client.release()` multiple times, `pg-gasket` safely passes the second call through to `pg-pool`, preserving `pg-pool`'s native error (`Release called on client which has already been released to the pool`).
4. **Callback Support:** For legacy callback patterns (`pool.connect((err, client, done) => ...)`), `done` is replaced with the hooked release function so that calling `done()` or `client.release()` triggers the same cleanup logic.

---

## 4. Stack Trace Capture & V8 Optimization

Stack traces are invaluable for diagnosing leak origins, but formatting stack frames is computationally expensive. `pg-gasket` optimizes stack capture using V8 engine capabilities:

1. **Boundary Clipping:** Checkout stacks are captured using `Error.captureStackTrace(holder, connect)`. Passing the `connect` wrapper as the constructor boundary ensures that internal `pg-gasket` frames are omitted. The top stack frame points directly to the application code where `pool.connect()` was called.
2. **Lazy Evaluation:** V8 does not format the stack trace string at the time `Error.captureStackTrace` is called; it creates a lazy getter. `pg-gasket` only reads `holder.stack` inside the `warn()` callback when a leak actually occurs. Normal, healthy checkouts that release before the threshold incur **zero string formatting overhead**.
3. **Sampling:** For high-throughput applications, `sampleRate` (between `0` and `1`) allows fractional stack capture, preserving duration and pool metrics while minimizing memory usage.

---

## 5. Fail-Open Safety Invariants

`pg-gasket` is strictly an observability tool and adheres to a strict fail-open contract: **instrumentation must never crash or interrupt application database traffic.**

- **Defensive Error Handling:** Every phase of instrumentation (proxy traps, stack capture, timer creation, release hooking, warning output) is wrapped in `try/catch` boundaries.
- **Diagnostic Logging:** Internal operational errors are caught and logged once via `runtimeDiagnostic()` using a deduplicated `Set` to prevent log floods.
- **Throwing Logger Protection:** If a consumer-supplied `logger` or `onLeak` callback throws, the error is caught, and the underlying database operation (`connect` or `release`) completes normally.
- **Frozen Object Handling:** If a client or pool has non-writable properties, `pg-gasket` logs a configuration diagnostic and returns the raw client without creating a timer.

---

## 6. Resource Bounds & Event Loop Hygiene

To prevent memory leaks or process stalls in long-running services:

- **Unreferenced Timers:** Every checkout timer calls `timer.unref()`. This ensures that active leak timers never prevent Node.js from exiting cleanly during shutdown or CLI execution.
- **Bounded Registry:** Active checkout entries are tracked in a `Map<number, Entry>` capped at `MAX_ENTRIES = 1,000` per pool. If an application leaks thousands of connections, tracking halts and emits a single diagnostic rather than consuming unbounded memory.
- **Explicit Cleanup:** Calling `pool.end()` immediately cancels all pending checkout timers and clears the internal registry.

---

## 7. Testing Architecture

The codebase maintains comprehensive test suites covering all operational layers:

- **Unit Suite (`test/unit/`):** Tests proxy behavior, callback vs promise resolution, option normalization, custom logger routing, structured `onLeak` payloads, double-release handling, and fail-open guarantees using an event-driven `MockPool` fixture.
- **Stress Suite (`test/stress/`):** Validates 100,000 rapid checkout/release iterations under `--expose-gc` to verify that wrapper state is discarded cleanly.
- **Integration Suite (`test/integration/`):** Runs against a live PostgreSQL 16 instance (managed via `compose.yaml`) to verify real-world interaction with `node-postgres`.
- **Packaging Smoke Test (`test/package/`):** Bundles the package tarball and tests both CommonJS `require()`, ES Module `import`, and TypeScript `NodeNext` strict type resolution in an isolated temporary project.
