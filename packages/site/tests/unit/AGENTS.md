# tests/unit/

Vitest unit tests for the site package. Covers database/executor adapters, UI components, pages, workers, sync, and utilities.

## Files

- **analytics-client.test.ts** — Analytics worker client query/ingestion flow.
- **app-root.test.ts** — Smoke tests for the root application shell.
- **artifact-diff-view.test.ts** — Artifact Diff route rendering and data-source integration.
- **component-ecosystem-view.test.ts** — Component Ecosystem route rendering and data-source integration.
- **connect-modal.test.ts** — S3 connection modal interaction tests.
- **credential-crypto.test.ts** — Passkey/vault encryption helpers.
- **format.test.ts** — Compact number and token formatting helpers.
- **helpers/** — Unit tests for shared E2E helpers. See `helpers/AGENTS.md`.
- **manual-import.test.ts** — Manual import flow and analytics ingestion.
- **markdown.test.ts** — `marked` + DOMPurify rendering helpers.
- **passkey-modal.test.ts** — Passkey create/unlock modal.
- **portfolio-view.test.ts** — Portfolio route rendering, filters, hash routing, and data-source integration.
- **project-behavior-view.test.ts** — Project Behavior route rendering, filters, hash routing, data-source integration, charts, cohorts, outliers, and accessibility.
- **router.test.ts** — Hash router navigation.
- **s3-errors.test.ts** — S3 error formatting and hints.
- **session-evidence-view.test.ts** — Session Evidence route rendering and data-source integration.
- **session-sync.worker.test.ts** — Web Worker sync engine.
- **setup.ts** — Shared test setup.
- **sync-protocol.test.ts** — Sync worker message protocol.
- **toast-container.test.ts** — Toast notification stack.
- **wasm-adapter.conformance.test.ts** — db-core conformance suite execution against `WasmSqliteExecutor`.
