# tests/e2e/helpers/

Shared Playwright E2E helpers and their own E2E regression specs.

## Files

- **heartbeat.ts** — `assertHeartbeat` and `pollHeartbeat` helpers for polling a progress locator and asserting monotonic, distinct advancement.
- **heartbeat.spec.ts** — E2E regression tests for the heartbeat helper: throttled sync advancement, stalled sync detection, and non-monotonic rejection.
