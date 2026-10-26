# Contributing to pg-gasket

Thank you for your interest in contributing to **pg-gasket**! We welcome community contributions, bug reports, and improvements.

This guide outlines our development workflow, engineering invariants, and instructions for setting up the project locally.

---

## Code of Conduct

Please be respectful, constructive, and considerate in all interactions across issues, pull requests, and discussions.

---

## Getting Started

### Prerequisites

- **Node.js**: `18.0.0` or higher (Node 20 or 22 LTS recommended)
- **npm**: `9.0.0` or higher
- **Docker** (optional): For running integration tests against a live PostgreSQL instance

### Local Setup

1. Fork and clone the repository:

   ```sh
   git clone https://github.com/<your-username>/pg-gasket.git
   cd pg-gasket
   ```

2. Install dependencies:

   ```sh
   npm install
   ```

   _Note: This automatically sets up Husky git pre-commit hooks._

3. Build the project:
   ```sh
   npm run build
   ```

---

## Development Workflow

### Available Scripts

| Command                    | Description                                                                                                    |
| :------------------------- | :------------------------------------------------------------------------------------------------------------- |
| `npm run build`            | Compiles TypeScript into CommonJS (`dist/cjs`), ES Modules (`dist/esm`), and type declarations (`dist/types`). |
| `npm test`                 | Builds and runs the unit test suite (`test/unit/*.test.cjs`).                                                  |
| `npm run test:stress`      | Runs the 100,000 checkout/release lifecycle stress test with `--expose-gc`.                                    |
| `npm run test:integration` | Runs live PostgreSQL integration tests (requires `DATABASE_URL`).                                              |
| `npm run test:package`     | Packs a tarball and validates CJS, ESM, and TypeScript `NodeNext` imports in an isolated temp directory.       |
| `npm run test:all`         | Runs unit, integration, stress, and package smoke tests sequentially.                                          |
| `npm run lint`             | Runs ESLint and TypeScript compiler type-checking (`tsc -p tsconfig.json`).                                    |
| `npm run lint:fix`         | Runs ESLint and automatically fixes formatting/linting issues where possible.                                  |
| `npm run format`           | Formats all code, markdown, and config files with Prettier.                                                    |
| `npm run format:check`     | Checks formatting without modifying files.                                                                     |
| `npm run pack:check`       | Performs a dry run of package packing to inspect tarball contents.                                             |

---

## Running Integration Tests

Integration tests run against a real PostgreSQL database to verify interaction with `node-postgres`:

1. Start the PostgreSQL test container:

   ```sh
   docker compose up -d
   ```

2. Run the integration test suite:

   ```sh
   DATABASE_URL=postgres://postgres:postgres@localhost:5433/pg_gasket npm run test:integration
   ```

3. When finished, shut down the container:
   ```sh
   docker compose down
   ```

_(If `DATABASE_URL` is omitted, the integration test suite automatically skips cleanly.)_

---

## Core Engineering Invariants

When contributing code changes to `src/index.ts`, please preserve the following architectural contracts:

1. **Fail-Open Observability:**
   `pg-gasket` is strictly an observability layer. It must **never** crash, throw unhandled exceptions, or degrade database operations. All hooking and bookkeeping operations must be safely enclosed in defensive error boundaries.

2. **Zero Runtime Dependencies:**
   `pg-gasket` has no runtime dependencies. `pg` is an optional `peerDependency`. Do not introduce runtime npm packages into `dependencies`.

3. **Proxy Receiver Binding (`pool.query` Exclusion):**
   Internal calls from pool methods (such as `pool.query()`) must run with `this` bound to the raw underlying pool. This ensures that internal checkouts performed by `pg-pool` for query execution do not trigger false-positive leak warnings.

4. **Event Loop Cleanliness:**
   All checkout timers must invoke `unref()` so that active leak timers never block graceful Node.js shutdown or CLI command exits.

5. **Dual CJS & ESM Compatibility:**
   The package must maintain clean dual module support (CommonJS and ES Modules) with accurate TypeScript declarations.

---

## Submitting a Pull Request

1. **Create a topic branch:**

   ```sh
   git checkout -b feat/my-improvement
   ```

2. **Verify tests and code style:**
   Before pushing, ensure all checks pass:

   ```sh
   npm run lint
   npm run format:check
   npm test
   npm run test:stress
   ```

3. **Commit your changes:**
   Follow standard [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat:`, `fix:`, `docs:`, `test:`, `chore:`). Husky and `lint-staged` will automatically check formatting on staged files.

4. **Open a Pull Request:**
   Provide a clear summary of your changes, reference any relevant issues, and describe how the changes were verified.
