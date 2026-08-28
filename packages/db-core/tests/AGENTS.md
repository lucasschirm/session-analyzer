# tests/

Test suites for the db-core package.

## Directories

- **conformance/** — Shared adapter conformance suite. See `conformance/AGENTS.md`.
- **helpers/** — Test helpers including a reference WASM executor adapter.
- **unit/** — Unit tests for schema, migrations, generations, identity, and the capability contract.

## Files

- **forbidden-imports.test.ts** — Asserts that db-core source does not import DOM, Worker, OPFS, `node:`, or `@sqlite.org/sqlite-wasm` modules.
