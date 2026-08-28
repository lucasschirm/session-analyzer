---
name: add-e2e-test
description: Use when adding or updating a browser-level end-to-end test (Playwright) for the session-analyzer dashboard. Covers catalog placement, seeded preference existing helpers, hash-route navigation, fixture uploads, mock S3 CAS flows, chart-geometry and empty-vs-error assertions, progress heartbeats, and export verification.
---

# Add Browser E2E Test

## Overview

Browser E2E tests live under `packages/site/tests/e2e/` and run with
Playwright against Chromium. They guard the user experience end to end:
upload → parse → dashboard → drill-down → transcript → export, and
connect → CAS sync → dashboard refresh, plus failure affordances.

**Core invariants:**

- A data component failure must never assert an "empty" affordance; tests
  distinguish error from empty.
- Progress UIs must assert advancement, not mere visibility, when the test
  targets stall regressions.
- Selectors are centralized in helpers (`.project-card`,
  `input[type="file"]`, dialog roles), never duplicated inline.
- Every test cites its catalog ID from
  `docs/superpowers/plans/2026-08-27-e2e-coverage-enhancement.md` (e.g. UX-003).
- Tests do not re-cover what unit tests already guarantee (parsers, metric
  math, router params).

## Plan references

- §4.1 Existing E2E coverage
- §6 Tier A catalog (UX-### entries)
- §7 Infrastructure prerequisites (helpers 1–3, 4)
- §10 Maintenance model

## Package paths

| Concern | Path |
|---|---|
| Spec location | `packages/site/tests/e2e/*.spec.ts` |
| Session/upload fixtures | `packages/site/tests/e2e/fixtures/` |
| Sync fixtures (`FixtureBucket`, manifests) | `packages/site/tests/e2e/sync-fixtures.ts` |
| Shared helpers (chart geometry, heartbeat, export) | `packages/site/tests/e2e/helpers/` |
| Playwright config | `packages/site/playwright.config.ts` |
| Hash router | `packages/site/src/router.ts` |

## Procedure

### Step 1 — Register the test in the catalog

Open `docs/superpowers/plans/2026-08-27-e2e-coverage-enhancement.md` and
assign the next UX ID in §6 Tier A. Score L/U/D uniformly (no pain-point
boosting). Link the ID in the test name, e.g.
`test('UX-003: portfolio refreshes live after second upload', ...)`.

### Step 2 — Reuse existing helpers before adding new logic

`app.spec.ts` already provides these patterns (copy, don't reinvent):

- `createProject(page, name, description)` — modal-driven project creation.
- `openProject(page, name)` — navigate via card click.
- `uploadFile(page, fixtureName)` — `input[type=file].setInputFiles`.

For CAS/sync flows, follow `sync.spec.ts` patterns: `openConnectModal`,
`fillConnectionForm`, `FixtureBucket` builders from `sync-fixtures.ts`.
Mock transport is intercepted with `page.route` there — do not hit real S3.

### Step 3 — Navigate hash routes

The router is hash-wrapped (`#/projects/:id/behavior`);
`page.goto('/')` then UI interaction is preferred. Direct hash navigation
is acceptable when testing deep-link survival:
`page.goto('/#/projects/<id>/behavior')`.

### Step 4 — Choose the assertion class

1. **Happy-path state assertions** — metric card text, project name,
   session row. Keep these coarse.
2. **Empty-vs-error pair** — for any data component touched, assert both
   forced-empty and forced-failure render distinct affordances. Use the
   shared helper once `packages/site/tests/e2e/helpers/` exists.
3. **Chart geometry** — `expectRenderedGeometry(locator)` pierces shadow
   DOM and checks rendered chart children rather than legend text only.
4. **Heartbeat** — `assertHeartbeat(locator)` polls a progress element and
   asserts at least two distinct values in a bounded window (for stall
   regressions only).
5. **Export content** — `verifyExportIncludes(download, 'sessions')`
   validates export bytes through the Node-capable WASM SQLite driver.

### Step 5 — Wire fixture uploads

Place new session fixtures in `packages/site/tests/e2e/fixtures/`. Small,
deterministic, and one format per file. Reuse existing fixtures when
possible (e.g. `claude-session.jsonl`). Never import from
`packages/parsers/...tests/fixtures` directly at the browser layer —
duplicate deliberately to keep browser specs self-contained.

### Step 6 — Mock S3 for sync flows

Use `FixtureBucket` from `sync-fixtures.ts`, via `page.route` interception
of `${S3_ENDPOINT}` URLs. Never depend on network or a real bucket.
Surface error responses (e.g. 500) by having the mock route fulfill with
error statuses.

### Step 7 — Failure affordances where applicable

If a feature has a user-visible failure path (upload reject, sync error,
query failure), add an assertion for the exact affordance (banner, toast
in `toast-container`, or dialog). A missing affordance is a product bug —
surface it, don't mask it.

### Step 8 — Run

```bash
pnpm --filter site test:e2e            # full suite
cd packages/site && pnpm exec playwright test tests/e2e/<name>.spec.ts
cd packages/site && pnpm exec playwright test -g "UX-003"
```

On CI (`ubuntu-latest`, workers=1, retries=2), do not rely on timing;
assert on states, not sleeps.

### Step 9 — Mutation sanity check (for critical assertions)

Where feasible, verify the test would catch the regression: temporarily
break the guarded code path (e.g. stub `onFileDownloaded`), confirm the
test fails, then restore. Report the check in the PR description.

## Completion checklist

- [ ] Catalog ID registered in the plan with L/U/D scores.
- [ ] Spec placed in `packages/site/tests/e2e/`; helper reuse maximized.
- [ ] Empty-vs-error assertion applied where data components are used.
- [ ] Chart geometry asserted via helper when charts are visible.
- [ ] Heartbeat assertion included for stall-related regressions.
- [ ] Export verifier used for export flows.
- [ ] Fixtures are deterministic and small.
- [ ] Mock S3 only; no real network.
- [ ] Failure affordance asserted when the feature has one.
- [ ] `pnpm --filter site test:e2e` green locally and in CI.
- [ ] Mutation sanity check performed for critical guards (documented in PR).
