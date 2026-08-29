# tests/e2e/helpers/

Shared Playwright assertion helpers used across the E2E suite, and their own E2E regression specs.

## Files

- **chart-content.ts** — Shadow-piercing assertions for rendered chart geometry and empty-vs-error affordance disambiguation.
- **export-verify.ts** — Opens a downloaded `.sqlite` export with the app's own WASM driver and returns row counts per table; throws on corrupt/invalid files.
- **heartbeat.ts** — `assertHeartbeat` and `pollHeartbeat` helpers for polling a progress locator and asserting monotonic, distinct advancement.
- **heartbeat.spec.ts** — E2E regression tests for the heartbeat helper: throttled sync advancement, stalled sync detection, and non-monotonic rejection.
