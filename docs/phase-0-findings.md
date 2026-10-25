# Phase 0 findings

The Node 22 probe records an `Error` header followed by indented `at` frames; at limit zero it records only the header. This validates structural frame filtering and the `stack unavailable` fallback. Run `npm run spike:stack` on Node 18, 20, 24, and 26 before release and retain those outputs in the release record. The probe is kept as an executable check because stack formatting is V8-version-specific.

The implementation follows the confirmed pg-pool interaction from the plan: consumer `connect()` is intercepted; `pool.query()` runs with the raw pool as `this`, so its internal checkout is never tracked. The release wrapper is installed before its timer starts and delegates the original release untouched.

`scripts/spikes/pg-pool.cjs` is the dependency-presence probe. It intentionally reports a clear failure until the optional `pg` peer is installed; it does not add `pg` as a runtime dependency.
