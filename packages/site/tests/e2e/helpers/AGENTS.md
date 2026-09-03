# tests/e2e/helpers/

Shared Playwright assertion helpers used across the E2E suite, and their own E2E regression specs.

## Files

- **chart-content.ts** — Shadow-piercing assertions for rendered chart geometry and empty-vs-error affordance disambiguation.
- **export-verify.ts** — Opens a downloaded `.sqlite` export with the app's own WASM driver and returns row counts per table; throws on corrupt/invalid files.
- **heartbeat.ts** — `assertHeartbeat` and `pollHeartbeat` helpers for polling a progress locator and asserting monotonic, distinct advancement.
- **heartbeat.spec.ts** — E2E regression tests for the heartbeat helper: throttled sync advancement, stalled sync detection, and non-monotonic rejection.
- **manual-import-state.ts** — Shadow-piercing state assertions for `manual-import-state`: reads the semantic `phase`, badge class/text, and hint copy to distinguish Unsupported/Unavailable/Integrity Error affordances from each other and from the idle state.
- **seeded-store.ts** — Seeded-store fixture loader: `captureAnalyticsWorker` captures the app's live analytics worker instance, and `seedSession` ingests a fixture directly into it (detect + ingest worker messages), bypassing the Manual Import UI. Used to seed the store with fixture data across a test without a second `AnalyticsClient`/OPFS lock contention.
- **canned-session.ts** — Canned analytics worker for Session Evidence end-to-end tests. `buildCannedSessionWorker` returns a worker script that answers `session.*` and `search.getRootSessionTree` queries with realistic DTOs, and `installCannedSessionWorker` swaps the live analytics worker for it before the app boots. Used by `session-evidence.spec.ts` (UX-032/033/034/035) and `ux-046-full-journey.spec.ts`.
- **worker-failure.ts** — Worker-failure injection: `installFailingWorker` patches `window.Worker` to swap a matched worker (by script URL substring) for a fake one before the app boots. `buildFailingQueryWorker` and `buildHangingQueryWorker` build common failure scripts (query rejection, query hang) for testing error/timeout propagation per `.agents/rules/sync-progress-observability.md`.

`chart-content.ts` also exposes generic empty-vs-error affordance assertions (`assertComponentEmptyAffordance` / `assertComponentErrorAffordance`) for any shadow-DOM data component — not just `analytics-chart` — that renders `.state-empty`/`.state-error` markers, per `.agents/rules/no-silent-empty-states.md`.
