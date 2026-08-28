# e2e/

Playwright end-to-end tests and fixtures for the site package.

## Files

- **app.spec.ts** — Core user journey covering project CRUD, manual import, session evidence, persistence, export, and routing.
- **chart-content.spec.ts** — Smoke tests for the chart-content geometry and empty/error affordance helpers.
- **sessions-filter.spec.ts** — Sessions scope filter interactions on the Portfolio and Project Behavior pages.
- **sync.spec.ts** — CAS sync pipeline, offline handling, retry, passkey, and large transcript flows.
- **sync-fixtures.ts** — Mock S3 CAS payload and `FixtureBucket` builders for sync tests.
- **fixtures/** — Session transcript and sidecar fixtures used by manual import and sync specs.

## Subdirectories

- **helpers/** — Shared assertion helpers for E2E specs. See `helpers/AGENTS.md`.
