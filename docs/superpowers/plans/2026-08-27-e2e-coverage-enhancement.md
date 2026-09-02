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
- `design-fixes.spec.ts` — header nav active state, sync-confirm modal,
  data-sources edit URL, loading state. (Left-nav Projects section, UX-018,
  was removed per issue #165 — see §9.)
- `icon-rail.spec.ts` — icon rail navigation journey, active-route mapping
  including nested routes, keyboard accessibility, `aria-current`
  semantics, and interim domain-page reachability via `/artifacts`.
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
`FAILING-PRODUCT-BUG` (per `triage-e2e-failure`), `REMOVED` (the surface the
row covered was intentionally deleted per a documented product change — the
row and its ID stay, permanently, per §3's "never renumbered" rule; `REMOVED`
exists so a deliberate removal is never misread as an unbuilt `PROPOSED` row
or a silently-dropped mapping — see the Journey/Owning-test-file columns for
the disposition and pointer to any replacement coverage).

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
| UX-018 | Left-nav Projects section (REMOVED — issue #165) | `left-nav` and its expandable-Projects-children-with-stats behavior were deleted per issue #165's disposition table: `left-nav` is replaced by the `icon-rail` component (4 flat destinations, no expandable children); the per-project list moved to render on the `/projects` route body instead of a nav sub-tree. This is a deliberate, documented product change, not a dropped-coverage regression — see §9. | none | 2 | 2 | 3 | 12 | superseded — no longer applicable; the Projects rail item's active-route behavior (including nested `/projects/:slug` routes) is covered by UX-023 in `icon-rail.spec.ts` | REMOVED |
| UX-019 | Sync-confirm modal | Syncing a saved connection opens a confirm-sync modal; a locked vault prompts for the passkey first, then proceeds to sync | none | 3 | 4 | 3 | 36 | `design-fixes.spec.ts` | GREEN |
| UX-020 | Data-sources connection form | Opening the new-connection form (via click or direct route) updates the URL hash to `/settings/data-sources/new` | none | 2 | 2 | 2 | 8 | `design-fixes.spec.ts` | GREEN |
| UX-021 | App boot loading state | The loading state is visible before the app is ready and disappears once it is | none | 2 | 2 | 2 | 8 | `design-fixes.spec.ts` | GREEN |
| UX-022 | Self-hosted typography (redesign token/font foundation) | Space Grotesk's woff2 files load from the same origin (never `fonts.googleapis.com`/`fonts.gstatic.com`) and are usable via the Font Loading API, so the offline/GitHub-Pages build has no runtime Google Fonts dependency | none | 2 | 2 | 3 | 12 | `redesign-tokens.spec.ts` | GREEN |
| UX-023 | Icon rail (app shell) | From `/`, click each of the four rail items (Portfolio, Projects, Artifacts, Settings) in turn and assert the route/content changes each time; nested routes (a project's behavior page, `/settings/storage`) still highlight the right rail item; keyboard: Tab reaches every rail item in document order, Enter activates the focused item and navigates, and the focused item shows a visible focus outline | none (dedicated `icon-rail.spec.ts`) | 3 | 4 | 3 | 36 | `icon-rail.spec.ts` | GREEN |
| UX-024 | Icon rail active-state semantics | For each of the four rail destinations, the active item's link carries `aria-current="page"` and the other three carry no `aria-current` attribute at all (never `aria-current="false"`) | none | 2 | 3 | 3 | 18 | `icon-rail.spec.ts` | GREEN |
| UX-025 | Domain pages reachability via Artifacts | From `/`, click the Artifacts rail item, then click each of the four "Domain pages" links (Agents/Skills/Tools/MCP) added to the `/artifacts` view, and assert each lands on its respective `tbd-page` route — documents/tests the interim 2-click path (rail → Artifacts → domain) per issue #165's disposition table, until sub-issue 7 restores 1-click parity from `/` | none | 3 | 3 | 3 | 27 | `icon-rail.spec.ts` | GREEN |
| UX-026 | Chart layer error affordance retry control (issue #168) | `echarts-base`'s error-state panel (`.chart-affordance.state-error`) carries a "Retry" button; clicking it dispatches a bubbling/composed `chart-retry` `CustomEvent` a hosting page listens for to re-issue the failed query, proven end-to-end (real click → real event, not just markup presence) | `assertErrorBoundary` (`chart-content.ts`) | 3 | 4 | 3 | 36 | `ux-026-chart-retry.spec.ts` | GREEN |
| UX-027 | Heatmap missing-vs-zero cell distinction (issue #168) | A `heatmap`-type `analytics-chart` renders a missing native value (`ChartBucket.y === null`) as a dashed "—" cell with `data-missing="true"`, DOM-distinct from a measured `0` cell (`data-missing="false"`, text "0"); the ramp legend surfaces the series max | none (direct `[data-missing]` DOM assertion on the real `rd-heatmap-grid` shadow tree — no existing helper covers heatmap cell classification) | 3 | 5 | 4 | 60 | `ux-027-heatmap-missing.spec.ts` | GREEN |
| UX-028 | Global filter bar & time-range control (issue #167) | Selecting the 7d segment on the Portfolio view's `filter-bar` narrows the range past the seeded fixture's daily rollups: the "Session Metrics" trend chart transitions to a distinct empty affordance (not an error) and the URL hash gains explicit `timeStart`/`timeEnd` | `expectRenderedGeometry`, `expectEmptyAffordance` (new), `assertNoErrorBoundary` (`chart-content.ts`); `seedSession` (`seeded-store.ts`) | 3 | 4 | 3 | 36 | `filter-bar.spec.ts` | GREEN |
| UX-029 | Global filter bar & time-range control (issue #167) | Selecting a time-range preset (30d) and reloading the page preserves the `timeStart`/`timeEnd` URL params and the segmented control's `aria-selected` state; the trend chart re-renders with data | `expectRenderedGeometry` (`chart-content.ts`) | 3 | 3 | 3 | 27 | `filter-bar.spec.ts` | GREEN |
| UX-030 | Global filter bar & time-range control (issue #167) | Selecting 30d then 7d then pressing the browser Back button restores the 30d segment's `aria-selected` state and its rendered trend-chart geometry, not the intervening 7d empty state | `expectRenderedGeometry`, `expectEmptyAffordance` (new) (`chart-content.ts`) | 3 | 4 | 3 | 36 | `filter-bar.spec.ts` | GREEN |

| UX-031 | Project Behavior drill-down header (issue #171) | Navigating from the Portfolio project leaderboard to a project's drill-down page renders `<h1>` matching the clicked project's display name | none | 3 | 4 | 3 | 36 | `project-behavior.spec.ts` | GREEN |
| UX-032 | Project Behavior session-duration histogram (issue #171) | The histogram's rendered SVG bars, and its accessible table fallback, correspond to the `SessionDurationHistogram` DTO bins for the seeded session(s) — never a hardcoded bin table | none (direct SVG + `details.table-fallback` row assertions) | 3 | 4 | 4 | 48 | `project-behavior.spec.ts` | GREEN |
| UX-033 | Project Behavior session outcomes legend (issue #171) | The outcome legend rows' counts and percentages (plus the unreadable-tail footnote) sum to exactly the session total | none | 3 | 4 | 3 | 36 | `project-behavior.spec.ts` | GREEN |
| UX-034 | Project Behavior chart empty vs error (issue #171) | A genuine zero-row time window and a forced worker query failure render structurally distinct empty/error affordances on the Session duration histogram | `assertEmptyAffordance`, `assertErrorBoundary` (`chart-content.ts`) | 4 | 5 | 3 | 60 | `ux-002-empty-error.spec.ts` (repointed at the redesigned page's histogram chart by this PR) | GREEN |
| UX-035 | Project Behavior breadcrumb returnContext (issue #171) | The breadcrumb link carries the originating Portfolio filter state (`returnContext`) and clicking it restores that filtered Portfolio view | none | 2 | 3 | 3 | 18 | `project-behavior.spec.ts` | GREEN |

New redesign entries allocate **UX-036** and up next.

### 6.2 Tier B — Analytics pipeline integration (`PIPE-###`)

Existing coverage (`PIPE-001`–`PIPE-012`, `packages/db/tests/pipeline/`)
predates this catalog and is not retroactively seeded by PR-A — see §9.
New entries allocate **PIPE-015** and up.

| ID | Surface | Journey | Helper(s) | L | U | D | Score | Owning test file | Status |
|---|---|---|---|---|---|---|---|---|---|
| PIPE-013 | Session outcome signal (issue #178) | One fixture per registered harness plugin (claude-code, the only one registered — see the issue #178 signal audit comment) through parse → transform → ingest → `sessions.outcome` column → `SessionOutcomeStore.rollupByProject` / `getSessionOutcomeDistribution` rollup query, covering clean / interrupted-by-user / ended-on-error / unreadable-tail (missing) outcomes in one project | none (inline synthetic transcripts, following `pipe-012`'s pattern) | 3 | 4 | 4 | 48 | `pipe-013-session-outcome-rollup.test.ts` | GREEN |
| PIPE-014 | AnalyticsDataSource read-contract additions (issue #169, rounds 1-4): session events + dimension domains + portfolio KPI-band additions (token totals, cost coverage, clean-completion rate, sessions-by-model, model×harness matrix, invocations-by-domain) + Project Behavior stat strip/duration histogram/weekly tool error rate/top tools/model×harness cohorts + turn-timeline segments + project leaderboard | claude-code fixture through parse → transform → ingest → `MetadataView.getDimensionDomains` (real project/harness values from ingested `sessions`/`projects`), `SessionEvidenceView.getSessionEvents`/`getTurnTimeline`, `PortfolioView.getKpiBand`/`getSessionsByModel`/`getModelHarnessMatrix`/`getInvocationsByDomain`/`getProjectLeaderboard`, and `ProjectBehaviorView.getStatStrip`/`getDurationHistogram`/`getWeeklyToolErrorRate`/`getTopTools`/`getModelHarnessCohorts` (all document the known gap that ingestion does not yet populate `messages`/`turns`/`invocations`/`payloads`/`model_requests`/`model_usage`, so every DTO is correctly empty/null/unknown rather than fabricated — each store is separately unit-tested against those tables directly; `sessions.start_time`/`end_time` ARE populated by ingestion, so the duration stat/histogram/turn-timeline bounds and the leaderboard's session count/last-active assert a real measured value) | none (inline synthetic transcript, following `pipe-013`'s pattern) | 3 | 3 | 4 | 36 | `pipe-014-session-events-and-dimension-domains.test.ts` | GREEN |

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
- **UX-018 (left-nav Projects section) — REMOVED, issue #165.** The "App
  shell: icon rail + top bar" sub-issue deletes `left-nav.ts` (and its
  test) and replaces it with `icon-rail.ts`, a flat 4-item rail with no
  expandable children. The `left-nav`-specific behavior UX-018 covered —
  the Projects section collapsing on `/projects` and auto-expanding with
  per-project session-count stats on a specific project route — no longer
  exists anywhere in the app; the per-project list now renders on the
  `/projects` route body instead of a nav sub-tree. This is an explicit
  disposition in issue #165's table, not an accidental coverage drop. Per
  `.agents/rules/e2e-coverage-required.md` the row and its ID are kept
  (never renumbered/deleted); its status is set to `REMOVED` and its
  `design-fixes.spec.ts` test block was replaced with a short comment
  pointing back here. The Projects rail item's active-route mapping
  (including nested `/projects/:slug` routes) is now covered by the new
  UX-023 row (`icon-rail.spec.ts`).
- **UX-028/UX-029/UX-030 (issue #167) assert against the trend chart, not
  metric cards.** The issue's test plan says a range change should update
  "the existing trend chart + metric cards"; in the current (pre-sub-issue-7)
  `packages/db/src/analytics-portfolio.ts`, `getPortfolioOverview`'s headline
  metrics and `countSessionsInPortfolio`/`sumTotalTokensInPortfolio` do not
  consult `query.timeRange` at all — only `getPortfolioTrends`'s daily
  rollups are range-scoped (`isDailyRollupInQuery`). This is a pre-existing
  backend gap, not something issue #167 (a UI-mounting issue, dependent on
  #169's already-merged `AnalyticsDataSource` additions) touches or should
  fix — `packages/db` query changes are out of its scope, and the redesigned,
  genuinely range-scoped KPI band lands with the sub-issue-7 portfolio
  rebuild. The three new rows instead assert the trend chart's
  geometry/empty-affordance transition, the URL hash, and the segmented
  control's own `aria-selected` state, which are the parts of the acceptance
  criteria this PR's backend actually supports today.
- **`sessions-filter.spec.ts` (UX-010) needed no selector remap for issue
  #167.** `filter-bar.ts`'s shadow-DOM wrapper carries `class="filter-bar"`
  (the tag-name-matching wrapper class required by
  `.agents/rules/frontend-coding-style.md`), and the sessions-scope control
  is still rendered as a `<label>Sessions<select>…</select></label>` inside
  it — Playwright's CSS engine pierces open shadow roots, so the existing
  `.filter-bar label` / `select, input` selectors in `sessions-filter.spec.ts`
  resolve unchanged through the new nested `<filter-bar>` custom element.
- Added `expectEmptyAffordance` to `helpers/chart-content.ts` — a polling
  counterpart to the existing single-shot `assertEmptyAffordance`, needed
  because a filter change re-issues its query asynchronously and a
  single-shot check can race the still-in-flight previous render. Also fixed
  a latent `no-silent-empty-states` gap in `portfolio-view.ts`'s
  `panelStateFromResult`: it only recognized the cursor-page `items` shape as
  potentially empty, so `PortfolioTrendSeries` (which exposes `series`, not
  `items`) was never classified `'empty'` — a range with zero matching
  rollups silently rendered as `'ok'` with no data, rather than the
  distinct empty affordance. Covered by a new `portfolio-view.test.ts` case.

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
