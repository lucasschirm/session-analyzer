# E2E coverage catalog & enhancement plan

Status: **PR-A (bootstrap) landed.** This is the catalog referenced by
`.agents/rules/e2e-coverage-required.md` — every PR touching a user-facing
surface (pages/routes, data-rendering components, upload/sync/export flows,
ingestion behavior) must cite the catalog ID(s) it implements or invokes.
Absence of a mapping is a merge blocker.

Owning issue: #173 ("E2E coverage catalog, tests & rollout"), the final
sub-issue of the Direction A analytics redesign (parent #163). Issue #173
ships as two PRs at opposite ends of the sequence:

- **PR-A (this document's origin)** — bootstraps the catalog and the shared
  helper scaffolding (`packages/site/tests/e2e/helpers/`) that every other
  redesign PR depends on to cite real IDs. Lands first, before sub-issue 1.
- **PR-B** — the completeness gate. Lands last, after every other sub-issue.
  Audits that every cited ID across the feature resolves to a real, passing
  test, and adds only cross-cutting coverage (the full upload → drill-down →
  export journey test, filter-param remap verification).

## 1. Scope

This plan covers three test tiers:

| Prefix | Tier | Location | Runner |
|---|---|---|---|
| `UX-###` | Browser UX (Playwright, Chromium) | `packages/site/tests/e2e/*.spec.ts` | `pnpm --filter site test:e2e` |
| `PIPE-###` | Analytics pipeline integration (parse → transform → ingest → rollup → query, in-process) | `packages/db/tests/pipeline/*.test.ts` | `pnpm --filter db test` |
| `SYNC-###` | Sync/harness-plugin lifecycle (watcher, retry, manifest failure) | `packages/sync/tests/e2e/*.test.ts`, `packages/plugins/*/tests/e2e/*.test.ts` | `pnpm --filter sync test`, plugin `pnpm verify` |

## 2. Rules this catalog enforces

See `.agents/rules/e2e-coverage-required.md` for the full invariant list.
In short:

- Every user-facing change ships with a mapped E2E/pipeline-integration
  test registered here.
- PRs cite the catalog IDs they implement or invoke; a missing mapping
  blocks merge.
- Helper-driven assertions are used where applicable — no inline ad-hoc
  selectors duplicating what `helpers/` already provides.
- New surfaces enter the catalog with L/U/D scores before merge.
- A broken existing mapping is triaged (`triage-e2e-failure` skill), never
  silently deleted.

## 3. ID allocation

- IDs are **never renumbered**. Once assigned, an ID is permanent even if
  the test it names is later restructured (the row's "owning test file"
  column is updated instead).
- New entries always allocate the **next unused number in their prefix**.
- At the time PR-A landed, the existing `UX-###` range in
  `packages/site/tests/e2e/` was **UX-001 through UX-021** (§6.1 retroactively
  seeds all of them — see §9 "Deviation from issue text" for the discrepancy
  with the issue's stated UX-001–UX-016 range). New redesign work allocates
  **UX-022 and up**.
- `PIPE-###` and `SYNC-###` already have existing tests in the codebase
  (`PIPE-001`–`PIPE-012` under `packages/db/tests/pipeline/`, `SYNC-001`–
  `SYNC-005` under `packages/sync/tests/e2e/` and
  `packages/plugins/*/tests/e2e/`) that predate this catalog. PR-A's
  retroactive-seeding scope (issue #173 scope item 1) covers `UX-###` only —
  see §9 for the recommended fast-follow to seed the `PIPE-###`/`SYNC-###`
  rows before PR-B's completeness audit. New pipeline/sync work still
  allocates the next unused number in its prefix (`PIPE-013`, `SYNC-006`, …).

## 4. Existing E2E coverage (§4.1)

`packages/site/tests/e2e/` (see its `AGENTS.md` for the full file map):

- `app.spec.ts` — core project CRUD, manual import, session evidence,
  persistence, export, routing, drag-drop, chart geometry.
- `chart-content.spec.ts` — smoke tests for the `helpers/chart-content.ts`
  geometry and empty/error affordance helpers themselves.
- `design-fixes.spec.ts` — header nav active state, left-nav Projects
  section, sync-confirm modal, data-sources edit URL, loading state.
- `opfs-fallback.spec.ts` — OPFS-unavailable fallback warning.
- `passkey.spec.ts` — passkey vault lifecycle (forgot/delete).
- `portfolio-refresh.spec.ts` — live portfolio refresh after a second
  upload without navigation.
- `sessions-filter.spec.ts` — sessions scope filter interactions and
  reload persistence.
- `sync.spec.ts` — CAS sync pipeline, offline handling, retry, passkey,
  large transcript flows, export-after-sync.
- `transcript-xss.spec.ts` — transcript sanitization.
- `ux-002-empty-error.spec.ts`, `ux-007-import-failure.spec.ts`,
  `ux-009-query-hang.spec.ts`, `ux-015-delete-confirmation.spec.ts` —
  dedicated single-surface specs, one per catalog ID.

## 5. Risk scoring model (L×U×D)

Applied uniformly — no boosting for known pain points (`e2e-test-planner`
agent owns re-scoring on a periodic pass):

- **L (Likelihood, 1–5):** 5 = shipped broken repeatedly; 1 = theoretical.
- **U (UX impact, 1–5):** 5 = wrong/absent data with no user signal;
  1 = cosmetic.
- **D (Detectability, 1–5):** 5 = no other test layer catches it.
- **Score = L × U × D.** P0 ≥ 60, P1 30–59, P2 < 30.

Every row in §6 carries this score. Scores below were assigned during
PR-A's retroactive seeding, applying the model uniformly to already-shipped,
already-green coverage (not re-litigating whether the surface should have
been tested — it already is).

## 6. Catalog

Status values: `GREEN` (implemented and passing), `PROPOSED` (planned, not
yet implemented — a merge blocker until it lands), `IMPLEMENTING`,
`FAILING-PRODUCT-BUG` (per `triage-e2e-failure`).

### 6.1 Tier A — Browser UX (`UX-###`)

| ID | Surface | Journey | Helper(s) | L | U | D | Score | Owning test file | Status |
|---|---|---|---|---|---|---|---|---|---|
| UX-001 | Portfolio/project analytics charts | Upload a fixture, open a chart, assert non-zero rendered SVG/canvas geometry (not just legend text) | `expectRenderedGeometry` (`chart-content.ts`) | 3 | 4 | 4 | 48 | `app.spec.ts` | GREEN |
| UX-002 | Project Behavior charts | Zero-row query vs. a forced worker query failure render structurally distinct empty/error affordances | `assertEmptyAffordance`, `assertErrorBoundary` (`chart-content.ts`) | 4 | 5 | 3 | 60 | `ux-002-empty-error.spec.ts` (helper smoke: `chart-content.spec.ts`) | GREEN |
| UX-003 | Portfolio metrics + chart | A second in-session upload refreshes portfolio metrics/geometry live, without navigation/reload | `getRenderedGeometry` (`chart-content.ts`); seeded via `seedSession`/`captureAnalyticsWorker` (`seeded-store.ts`) | 4 | 4 | 3 | 48 | `portfolio-refresh.spec.ts` | GREEN |
| UX-004 | CAS sync ingestion seam | Sync completion makes the synced session queryable in the dashboard without extra action | `FixtureBucket` (`sync-fixtures.ts`) | 3 | 5 | 3 | 45 | `sync.spec.ts` | GREEN |
| UX-005 | Sync progress bar | Progress advances (heartbeat) while a throttled file download is in flight, not just visible once | `assertHeartbeat`, `syncProgressFilesParser` (`heartbeat.ts`) | 3 | 4 | 4 | 48 | `sync.spec.ts` (helper regression: `helpers/heartbeat.spec.ts`) | GREEN |
| UX-006 | Export flow | Export after sync includes the synced session rows, not just a valid empty database | `verifyExportContents` (`export-verify.ts`) | 3 | 5 | 3 | 45 | `sync.spec.ts` | GREEN |
| UX-007 | Manual import failure states | A corrupt/unsupported fixture surfaces a specific failure class (Unsupported / Unavailable / Integrity Error), never a generic "Import failed" | `expectManualImportState`, `queryManualImportState` (`manual-import-state.ts`) | 3 | 4 | 4 | 48 | `ux-007-import-failure.spec.ts` | GREEN |
| UX-008 | Sync error affordance | A mocked S3 5xx mid-sync surfaces a distinct, terminal error affordance (not a silent stall) | `FixtureBucket` (`sync-fixtures.ts`) | 3 | 5 | 4 | 60 | `sync.spec.ts` | GREEN |
| UX-009 | Project Behavior Overview | A blocked/hung analytics query reaches a bounded client-side timeout error affordance instead of an indefinite spinner | `installFailingWorker`, hanging worker script (`worker-failure.ts`) | 3 | 5 | 4 | 60 | `ux-009-query-hang.spec.ts` | GREEN |
| UX-010 | Portfolio + Project Behavior filter bar | Sessions-scope filter state, encoded in the URL hash, survives a page reload on both views | none (dedicated filter-control helpers local to the spec) | 3 | 3 | 3 | 27 | `sessions-filter.spec.ts` | GREEN |
| UX-011 | Session transcript rendering | Executable markup in a transcript is stripped while safe text remains visible; no `dialog` fires | none (Playwright `page.on('dialog')` guard local to the spec) | 2 | 5 | 3 | 30 | `transcript-xss.spec.ts` | GREEN |
| UX-012 | Manual import drag-drop | Three rapid, back-to-back drag-drop events each preserve their file in the upload list (no silent drop) | none | 2 | 3 | 3 | 18 | `app.spec.ts` | GREEN |
| UX-013 | Manual import harness detection | A file matching no supported harness schema surfaces "Unsupported", distinct from Integrity Error/Unavailable/generic failure | `expectManualImportState` conventions (asserted inline; see UX-007) | 3 | 3 | 3 | 27 | `app.spec.ts` | GREEN |
| UX-014 | Storage settings backend indicator | When OPFS is unavailable, the Storage settings page shows an "In-Memory" indicator instead of the OPFS persistent-storage badge | none | 2 | 3 | 4 | 24 | `opfs-fallback.spec.ts` | GREEN |
| UX-015 | Delete-confirmation dialog | The delete-project confirmation dialog traps focus, cancels on Escape, and returns focus to the trigger control | none | 2 | 3 | 3 | 18 | `ux-015-delete-confirmation.spec.ts` | GREEN |
| UX-016 | Passkey vault | "Forgot passkey" deletes the vault (and its saved connections) rather than leaving it in a stuck locked state | none | 2 | 4 | 3 | 24 | `passkey.spec.ts` | GREEN |
| UX-017 | Header navigation | The active nav link (Dashboard/Artifacts) tracks the current route across all its aliases (`/`, `/projects`, `/portfolio`, `/artifacts`, `/artifact-diff`) | none | 2 | 2 | 3 | 12 | `design-fixes.spec.ts` | GREEN |
| UX-018 | Left-nav Projects section | The Projects section is collapsed on the `/projects` list and auto-expands with per-project session-count stats on a specific project route | none | 2 | 2 | 3 | 12 | `design-fixes.spec.ts` | GREEN |
| UX-019 | Sync-confirm modal | Syncing a saved connection opens a confirm-sync modal; a locked vault prompts for the passkey first, then proceeds to sync | none | 3 | 4 | 3 | 36 | `design-fixes.spec.ts` | GREEN |
| UX-020 | Data-sources connection form | Opening the new-connection form (via click or direct route) updates the URL hash to `/settings/data-sources/new` | none | 2 | 2 | 2 | 8 | `design-fixes.spec.ts` | GREEN |
| UX-021 | App boot loading state | The loading state is visible before the app is ready and disappears once it is | none | 2 | 2 | 2 | 8 | `design-fixes.spec.ts` | GREEN |
| UX-022 | Self-hosted typography (redesign token/font foundation) | Space Grotesk's woff2 files load from the same origin (never `fonts.googleapis.com`/`fonts.gstatic.com`) and are usable via the Font Loading API, so the offline/GitHub-Pages build has no runtime Google Fonts dependency | none | 2 | 2 | 3 | 12 | `redesign-tokens.spec.ts` | GREEN |
| UX-023 | Chart layer error affordance retry control (issue #168) | `echarts-base`'s error-state panel (`.chart-affordance.state-error`) carries a "Retry" button; clicking it dispatches a bubbling/composed `chart-retry` `CustomEvent` a hosting page listens for to re-issue the failed query, proven end-to-end (real click → real event, not just markup presence) | `assertErrorBoundary` (`chart-content.ts`) | 3 | 4 | 3 | 36 | `ux-023-chart-retry.spec.ts` | GREEN |
| UX-024 | Heatmap missing-vs-zero cell distinction (issue #168) | A `heatmap`-type `analytics-chart` renders a missing native value (`ChartBucket.y === null`) as a dashed "—" cell with `data-missing="true"`, DOM-distinct from a measured `0` cell (`data-missing="false"`, text "0"); the ramp legend surfaces the series max | none (direct `[data-missing]` DOM assertion on the real `rd-heatmap-grid` shadow tree — no existing helper covers heatmap cell classification) | 3 | 5 | 4 | 60 | `ux-024-heatmap-missing.spec.ts` | GREEN |

New redesign entries allocate **UX-025** and up.

### 6.2 Tier B — Analytics pipeline integration (`PIPE-###`)

Existing coverage (`PIPE-001`–`PIPE-012`, `packages/db/tests/pipeline/`)
predates this catalog and is not retroactively seeded by PR-A — see §9.
New entries allocate **PIPE-013** and up.

| ID | Surface | Journey | Helper(s) | L | U | D | Score | Owning test file | Status |
|---|---|---|---|---|---|---|---|---|---|
| PIPE-013 | Session outcome signal (issue #178) | One fixture per registered harness plugin (claude-code, the only one registered — see the issue #178 signal audit comment) through parse → transform → ingest → `sessions.outcome` column → `SessionOutcomeStore.rollupByProject` / `getSessionOutcomeDistribution` rollup query, covering clean / interrupted-by-user / ended-on-error / unreadable-tail (missing) outcomes in one project | none (inline synthetic transcripts, following `pipe-012`'s pattern) | 3 | 4 | 4 | 48 | `pipe-013-session-outcome-rollup.test.ts` | GREEN |

### 6.3 Tier C — Sync/harness lifecycle (`SYNC-###`)

Existing coverage (`SYNC-001`–`SYNC-005`, `packages/sync/tests/e2e/` and
`packages/plugins/*/tests/e2e/`) predates this catalog and is not
retroactively seeded by PR-A — see §9. New entries allocate **SYNC-006**
and up.

| ID | Surface | Journey | Helper(s) | L | U | D | Score | Owning test file | Status |
|---|---|---|---|---|---|---|---|---|---|
| _(none added by PR-A)_ | | | | | | | | | |

## 7. Infrastructure prerequisites

Shared helpers in `packages/site/tests/e2e/helpers/` (see that directory's
`AGENTS.md` for the authoritative list). PR-A extends the pre-existing
helpers 1–3 and adds helper 4, all needed before sub-issues 4/7/8/9 land:

1. **`chart-content.ts`** — shadow-piercing chart geometry
   (`expectRenderedGeometry`, `getRenderedGeometry`) and empty/error
   affordance assertions. Pre-existing: `assertEmptyAffordance` /
   `assertErrorBoundary`, scoped to `analytics-chart`/`echarts-base`.
   **PR-A adds:** `assertComponentEmptyAffordance` /
   `assertComponentErrorAffordance` — the same empty-vs-error contract,
   generalized to any shadow-DOM data component (metric cards, tables,
   lists) that renders `.state-empty`/`.state-error` markers, not only
   charts.
2. **`export-verify.ts`** — opens a downloaded `.sqlite` export with the
   app's own WASM SQLite driver and returns row counts per table
   (`verifyExportContents`). Unchanged by PR-A; already generic across the
   control-database tables in `EXPORT_TABLES`.
3. **`heartbeat.ts`** — `assertHeartbeat`/`pollHeartbeat` poll a progress
   locator and assert monotonic, distinct advancement (stall detection).
   Unchanged by PR-A; already generic via the `ProgressParser` contract.
4. **`seeded-store.ts`** (new in PR-A) — seeded-store fixture loader.
   `captureAnalyticsWorker` captures the app's live analytics worker
   instance via an init script; `seedSession` ingests a fixture directly
   into it (the same detect + ingest worker messages the Manual Import UI
   sends), bypassing the file-picker UI. Extracted from the inline
   `ingestSessionFromPortfolio` helper in `portfolio-refresh.spec.ts` (UX-003),
   which now calls it.
5. **`worker-failure.ts`** (new in PR-A) — worker-failure injection.
   `installFailingWorker` patches `window.Worker` so a worker whose
   constructed script URL matches a given substring is swapped for a fake
   one before the app boots; `buildFailingQueryWorker` and
   `buildHangingQueryWorker` build the two common failure scripts (query
   rejection, query hang). Extracted from the inline fake-worker patterns in
   `ux-002-empty-error.spec.ts` (UX-002) and `ux-009-query-hang.spec.ts`
   (UX-009), both of which now call `installFailingWorker`. This is the
   seam `.agents/rules/sync-progress-observability.md` requires: worker
   error propagation must never be silently swallowed between the worker
   and the UI thread, and this helper is how tests prove a failure
   actually surfaces.

## 8. Test obligation (per-PR rule)

Every feature PR must land the tests for the catalog IDs it cites, in the
same PR. PR-B never back-fills a page PR's own surface coverage — it only
audits that every cited ID resolves to a real, passing test, and adds
cross-cutting coverage (full upload → drill-down → export journey,
filter-param remap verification).

## 9. Notes / deviations from issue text

- Issue #173 scope item 1 states the existing range is "currently
  UX-001–UX-016". At the time PR-A landed, `packages/site/tests/e2e/`
  actually contained **UX-001 through UX-021** — `design-fixes.spec.ts`
  (UX-017–UX-021) landed in a prior merge to `feature/analytics-redesign`
  after the issue body was written. All 21 existing IDs are seeded in §6.1;
  none are renumbered.
- `PIPE-###` (`PIPE-001`–`PIPE-012`) and `SYNC-###` (`SYNC-001`–`SYNC-005`)
  tests also already exist in the codebase but are outside PR-A's scoped
  retroactive-seeding (issue #173 scope item 1 names `UX-###` only).
  **Recommended fast-follow before PR-B's completeness audit:** seed §6.2
  and §6.3 with these existing rows, so the "every cited ID resolves to a
  real row" acceptance criterion holds for pipeline/sync PRs too, not only
  browser UX ones.

## 10. Maintenance model

- Breaking an existing catalog mapping is never resolved by deleting the
  test. Classify with the `triage-e2e-failure` skill (product bug / test
  bug / flake) and route the fix accordingly.
- The `e2e-test-planner` agent owns re-scoring (a periodic L/U/D pass) and
  catalog upkeep; the `e2e-test-implementer`-equivalent workflow (currently
  `add-e2e-test` / `add-pipeline-e2e-test` skills) owns turning a
  `PROPOSED` row into a `GREEN` one.
- New product surfaces enter the catalog with L/U/D scores **before**
  merge — an unscored or unmapped surface is a merge blocker per
  `.agents/rules/e2e-coverage-required.md`.
