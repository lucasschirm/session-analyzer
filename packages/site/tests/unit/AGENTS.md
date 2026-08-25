# tests/unit/

Vitest unit tests for the site package. Covers database/executor adapters, UI components, pages, workers, parsers, sync, and utilities.

## Files

- **app-root.test.ts** — Smoke tests for the root application shell.
- **components.test.ts** — Shared component behavior and rendering tests.
- **connect-modal.test.ts** — S3 connection modal interaction tests.
- **credential-crypto.test.ts** — Passkey/vault encryption helpers.
- **database-split.test.ts** — Database split/migration logic.
- **database-sync.test.ts** — Sync-related database operations.
- **database.test.ts** — Core DatabaseManager CRUD and migration tests.
- **db-client.test.ts** — Main-thread <-> worker database client tests.
- **file-processing-bridge.test.ts** — Subagent file merging and dispatch tests.
- **format.test.ts** — Compact number and token formatting helpers.
- **legacy-database.test.ts** — Backwards-compatible read-only database opening.
- **lib/claude-to-dashboard.test.ts** — ClaudeCodeSession to DashboardSession transformation tests.
- **markdown.test.ts** — `marked` + DOMPurify rendering helpers.
- **pages.test.ts** — Route-level page components.
- **parser-client.test.ts** — Worker parser client.
- **parser.test.ts** — Session file detection and parsing.
- **passkey-modal.test.ts** — Passkey create/unlock modal.
- **router.test.ts** — Hash router navigation.
- **s3-errors.test.ts** — S3 error formatting and hints.
- **session-parser.worker.test.ts** — Web Worker session parser.
- **session-sync.worker.test.ts** — Web Worker sync engine.
- **session-transcript.test.ts** — Transcript page rendering.
- **setup.ts** — Shared test setup.
- **subagents.test.ts** — Subagent classification and merging.
- **sync-manager.test.ts** — Sync run orchestration.
- **sync-protocol.test.ts** — Sync worker message protocol.
- **sync-ui.test.ts** — Sync progress/status UI components.
- **toast-container.test.ts** — Toast notification stack.
- **wasm-adapter.conformance.test.ts** — db-core conformance suite execution against `WasmSqliteExecutor`.
