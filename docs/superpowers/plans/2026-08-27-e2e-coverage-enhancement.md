# E2E Coverage Enhancement Plan

Status: living document. Owner: `e2e-test-planner` (catalog), `e2e-test-maintainer`
(green/quarantine lifecycle). Created 2026-08-27; backfilled 2026-09-02 by
issue #160 after the file was found to be referenced by
`.agents/rules/e2e-coverage-required.md` and several skills/agents without
ever having been created.

## 1. Purpose & scope

This plan is the single source of truth for end-to-end coverage of the
session-analyzer dashboard: which user-facing risks are guarded by a
browser or pipeline test, how those tests are scored, and how coverage
gaps are closed. `.agents/rules/e2e-coverage-required.md` requires every
user-facing change to register a mapped entry in §6 before merge.

Out of scope: unit-level coverage (parsers, metric math, router params) —
those are guaranteed by package-level `verify` scripts, not this catalog.

## 2. Tiers & catalog ID format

| Tier | Prefix | Layer | Location |
|---|---|---|---|
| A — Browser UX | `UX-###` | Playwright, full browser | `packages/site/tests/e2e/*.spec.ts` |
| B — Analytics Pipeline | `PIPE-###` | Vitest, in-memory SQLite, no browser | `packages/db/tests/pipeline/*.test.ts` |
| C — Sync Lifecycle | `SYNC-###` | Vitest/Playwright, watcher/manifest/CAS seams | `packages/plugins/claude-session-sync/tests/e2e/`, `packages/plugins/devin-session-sync/tests/pipeline/`, `packages/sync/tests/e2e/`, `packages/site/tests/unit/` |

IDs are assigned sequentially within a tier and never reused, even if a
test is deleted (see §10). Cite the ID in the test name/`describe` block
(e.g. `test('UX-003: ...')`) so `grep` and CI output stay traceable to
this table.

## 3. Why L×U×D

A flat backlog invites recency bias — the last incident always feels most
urgent. Scoring risk uniformly (§5) before triage keeps prioritization
defensible and keeps `e2e-test-planner` from boosting a familiar pain
point over an equally severe unfamiliar one.

## 4. Existing coverage

### 4.1 Existing E2E coverage (Tier A, browser)

All 13 spec files currently under `packages/site/tests/e2e/*.spec.ts`,
backfilled into §6.1 by this plan:

| Spec file | Covers |
|---|---|
| `app.spec.ts` | Project CRUD, manual import, session evidence, OPFS persistence, export, routing, drag-drop (UX-012), unknown-harness rejection (UX-013), chart geometry (UX-001) |
| `chart-content.spec.ts` | Helper smoke tests for chart geometry (UX-001) and empty/error affordance (UX-002) helpers |
| `design-fixes.spec.ts` | Header nav active state (UX-017), left-nav Projects section (UX-018), sync-confirm modal (UX-019), data-sources URL hash (UX-020), pre-ready loading state (UX-021) |
| `opfs-fallback.spec.ts` | OPFS-unavailable in-memory storage warning (UX-014) |
| `passkey.spec.ts` | Locked-vault passkey prompt and "Forgot" vault deletion (UX-016) |
| `portfolio-refresh.spec.ts` | Live portfolio metric/chart refresh after a second upload (UX-003) |
| `sessions-filter.spec.ts` | Scope filter URL sync and reload persistence (UX-010) |
| `sync.spec.ts` | Full CAS sync journey, retry, cancel, offline, reload reconciliation, second-tab follower, plus catalog entries UX-004 (ingestion seam), UX-005 (heartbeat), UX-006 (export content), UX-008 (S3 5xx affordance) |
| `transcript-xss.spec.ts` | Transcript XSS sanitization (UX-011) |
| `ux-002-empty-error.spec.ts` | Empty vs. error state disambiguation (UX-002) |
| `ux-007-import-failure.spec.ts` | Manual import failure-class specificity (UX-007) |
| `ux-009-query-hang.spec.ts` | Bounded timeout on a blocked analytics query (UX-009) |
| `ux-015-delete-confirmation.spec.ts` | Delete-confirmation focus trap / keyboard contract (UX-015) |

`packages/site/tests/e2e/helpers/heartbeat.spec.ts` is infrastructure —
a regression spec for the `assertHeartbeat` helper itself (§7.3), not a
numbered catalog entry.

### 4.2 Silent-failure map (browser)

Known ways a browser regression can hide behind an apparently-passing
test, guarded by the tests in §6.1:

- Empty chart rendered instead of an error banner (UX-001/UX-002).
- Generic "Import failed" masking a specific failure class (UX-007/UX-013).
- Progress bar visible but not advancing — a silent stall (UX-005).
- Sync completing in the control DB without reaching analytics ingestion
  (UX-004).
- Unsanitized transcript content executing as markup (UX-011).

### 4.3 Silent-failure map (pipeline)

- Rollup served from a stale generation without a freshness signal
  (PIPE-002).
- A metric dimension the transformer doesn't recognize silently dropped
  instead of surfaced (PIPE-003).
- A commit that fails partway leaves a partial write visible to queries
  (PIPE-004).
- A missing signal aggregated as a measured zero (PIPE-008, rule
  `missing-is-never-zero`).
- Re-sync or reprocessing produces duplicate or non-superseded
  contributions (PIPE-006, PIPE-007).

## 5. Scoring model

Applied uniformly by `e2e-test-planner` — no boosting for recent or
familiar pain points:

- **L (Likelihood, 1–5):** 5 = shipped broken repeatedly / has a known
  regression incident; 1 = theoretical.
- **U (UX impact, 1–5):** 5 = wrong or absent data with no user-visible
  signal; 1 = cosmetic.
- **D (Detectability, 1–5):** 5 = no other test layer (unit, type check,
  lint) would catch it.
- **Score = L × U × D.** Priority: **P0 ≥ 60**, **P1 30–59**, **P2 < 30**.

Status values used in §6: `PROPOSED`, `IMPLEMENTING`, `GREEN`,
`FAILING-PRODUCT-BUG`. Every entry below is `GREEN` — all are backed by
an existing, currently-passing test found at the time this catalog was
created (issue #160); none are proposed-but-unimplemented.

## 6. Catalog

### 6.1 Tier A — Browser UX (`UX-###`)

| ID | Surface | Mapped test file | Helper assertions | L | U | D | Score | Priority | Status |
|---|---|---|---|---|---|---|---|---|---|
| UX-001 | Analytics/portfolio chart renders non-zero geometry | `app.spec.ts`, `chart-content.spec.ts` | `expectRenderedGeometry` (chart-content.ts) | 4 | 5 | 5 | 100 | P0 | GREEN |
| UX-002 | Empty vs. error affordances are structurally distinct | `ux-002-empty-error.spec.ts`, `chart-content.spec.ts` | chart-content.ts empty/error helper | 4 | 5 | 4 | 80 | P0 | GREEN |
| UX-003 | Portfolio metrics/chart refresh live after a second upload | `portfolio-refresh.spec.ts` | `expectRenderedGeometry` | 3 | 4 | 4 | 48 | P1 | GREEN |
| UX-004 | Sync completion reaches analytics ingestion, not just the control DB | `sync.spec.ts` | `expectChartContains` | 5 | 5 | 5 | 125 | P0 | GREEN |
| UX-005 | Sync progress heartbeat advances during a throttled download | `sync.spec.ts` | `assertHeartbeat` (heartbeat.ts) | 4 | 4 | 5 | 80 | P0 | GREEN |
| UX-006 | Export after sync includes synced session rows | `sync.spec.ts` | `verifyExportContents` (export-verify.ts) | 3 | 3 | 4 | 36 | P1 | GREEN |
| UX-007 | Manual import failure surfaces a specific class, not a generic message | `ux-007-import-failure.spec.ts` | manual-import-state.ts phase/badge assertions | 4 | 4 | 4 | 64 | P0 | GREEN |
| UX-008 | Mocked S3 5xx mid-sync surfaces a distinct terminal error affordance | `sync.spec.ts` | progress bar + toast state assertions | 3 | 4 | 4 | 48 | P1 | GREEN |
| UX-009 | Blocked analytics query reaches a bounded timeout, not an infinite spinner | `ux-009-query-hang.spec.ts` | timeout/error affordance assertion | 3 | 5 | 5 | 75 | P0 | GREEN |
| UX-010 | Scope filter state persists across a page reload | `sessions-filter.spec.ts` | URL/hash state assertion | 3 | 3 | 3 | 27 | P2 | GREEN |
| UX-011 | Transcript content is sanitized against XSS | `transcript-xss.spec.ts` | DOM sanitization assertion | 3 | 5 | 5 | 75 | P0 | GREEN |
| UX-012 | Rapid repeated drag-drop preserves every dropped file | `app.spec.ts` | file count assertion | 2 | 3 | 4 | 24 | P2 | GREEN |
| UX-013 | Unrecognized file produces a distinct unsupported-harness message | `app.spec.ts` | manual-import-state.ts phase assertion | 3 | 3 | 3 | 27 | P2 | GREEN |
| UX-014 | OPFS-unavailable warns with an in-memory storage indicator | `opfs-fallback.spec.ts` | warning banner assertion | 2 | 3 | 4 | 24 | P2 | GREEN |
| UX-015 | Delete confirmation traps focus and restores it on cancel | `ux-015-delete-confirmation.spec.ts` | focus-trap/keyboard assertion | 3 | 3 | 4 | 36 | P1 | GREEN |
| UX-016 | Passkey "Forgot" deletes the vault; locked vault prompts before sync | `passkey.spec.ts` | vault/passkey dialog assertions | 3 | 4 | 4 | 48 | P1 | GREEN |
| UX-017 | Header nav shows the active-route state | `design-fixes.spec.ts` | active-class assertion | 2 | 2 | 3 | 12 | P2 | GREEN |
| UX-018 | Left-nav Projects section collapses/expands by route | `design-fixes.spec.ts` | section-state assertion | 2 | 2 | 3 | 12 | P2 | GREEN |
| UX-019 | Sync-confirm modal appears when syncing a saved connection | `design-fixes.spec.ts` | modal visibility assertion | 3 | 3 | 3 | 27 | P2 | GREEN |
| UX-020 | Data-sources edit updates the URL hash | `design-fixes.spec.ts` | URL/hash assertion | 2 | 2 | 3 | 12 | P2 | GREEN |
| UX-021 | Loading state is visible before the app is ready | `design-fixes.spec.ts` | loading-indicator assertion | 2 | 3 | 3 | 18 | P2 | GREEN |

### 6.2 Tier B — Analytics Pipeline (`PIPE-###`)

| ID | Surface | Mapped test file | Helper assertions | L | U | D | Score | Priority | Status |
|---|---|---|---|---|---|---|---|---|---|
| PIPE-001 | Full pipeline baseline with freshness token | `pipe-001-full-pipeline-baseline.test.ts` | freshness/generation token assertion | 3 | 4 | 4 | 48 | P1 | GREEN |
| PIPE-002 | Generation/freshness token detects stale rollups | `pipe-002-stale-rollup-freshness.test.ts` | staleness token assertion | 4 | 5 | 4 | 80 | P0 | GREEN |
| PIPE-003 | Unknown metric dimension is never silently skipped | `pipe-003-unknown-metric-dimension.test.ts` | `IngestionIssue` signal assertion | 3 | 5 | 4 | 60 | P0 | GREEN |
| PIPE-004 | Commit failure boundary leaves no partial write visible | `pipe-004-commit-failure.test.ts` | harness `pre-commit`/`mid-commit` injection | 3 | 5 | 5 | 75 | P0 | GREEN |
| PIPE-005 | Reprocess interruption recovery | `pipe-005-reprocess-interruption.test.ts` | harness `reprocess` stage injection | 3 | 4 | 4 | 48 | P1 | GREEN |
| PIPE-006 | Re-sync same session produces no duplicate contributions | `pipe-006-resync-no-duplicate.test.ts` | contribution-uniqueness assertion | 3 | 4 | 4 | 48 | P1 | GREEN |
| PIPE-007 | Generation supersede semantics | `pipe-007-generation-supersede.test.ts` | generation-version assertion | 3 | 4 | 4 | 48 | P1 | GREEN |
| PIPE-008 | Missing-vs-zero in aggregates | `pipe-008-missing-vs-zero.test.ts` | explicit missingness (`eligibleN`/`unknownCount`) assertion | 4 | 5 | 4 | 80 | P0 | GREEN |
| PIPE-009 | Cross-package pipeline (plugin bundle → parser → transformer → db) | `pipe-009-cross-package.test.ts` | full-span assertion | 3 | 4 | 3 | 36 | P1 | GREEN |
| PIPE-010 | Schema drift guard | `pipe-010-schema-drift-guard.test.ts` | archived-fixture ingest assertion | 3 | 4 | 4 | 48 | P1 | GREEN |
| PIPE-011 | Large-session boundedness | `pipe-011-large-session-bounded.test.ts` | resource-bound assertion | 2 | 3 | 4 | 24 | P2 | GREEN |
| PIPE-012 | `pricing_version` evidence record id is session-scoped | `pipe-012-pricing-version-collision.test.ts` | record-id collision assertion | 2 | 3 | 3 | 18 | P2 | GREEN |

### 6.3 Tier C — Sync Lifecycle (`SYNC-###`)

| ID | Surface | Mapped test file | Helper assertions | L | U | D | Score | Priority | Status |
|---|---|---|---|---|---|---|---|---|---|
| SYNC-001 | Watcher mid-session crash visibility | `packages/plugins/claude-session-sync/tests/e2e/watcher-crash.test.ts` | crash-visibility signal assertion | 3 | 4 | 4 | 48 | P1 | GREEN |
| SYNC-002 | Manifest upload failure mid-session | `packages/sync/tests/e2e/manifest-failure.test.ts` | failure-signal assertion | 3 | 4 | 4 | 48 | P1 | GREEN |
| SYNC-003 | Retry drives to a known terminal state | `packages/sync/tests/e2e/retry-terminal-state.test.ts` | terminal-state assertion | 3 | 4 | 4 | 48 | P1 | GREEN |
| SYNC-004 | Monotonic progress events for a multi-file session | `packages/site/tests/unit/session-sync.worker.test.ts` | monotonic progress-event assertion | 3 | 4 | 3 | 36 | P1 | GREEN |
| SYNC-005 | Browser CAS `FixtureBucket` ↔ plugin `StorageAdapter` mock parity | `packages/site/tests/unit/sync-cas-mock-parity.test.ts` | mock-transport parity assertion | 2 | 3 | 4 | 24 | P2 | GREEN |
| SYNC-006 | Devin hook-triggered sync (SessionStart→Stop→SessionEnd) produces a manifest with the full expected artifact set (transcript, workspace/global config, schema descriptor) | `packages/plugins/devin-session-sync/tests/pipeline/sync-to-manifest.test.ts` | manifest artifact-set / classification-key assertion | 4 | 5 | 4 | 80 | P0 | GREEN |
| SYNC-007 | Devin Cloud-session mitigation: sync completes via `Stop` alone + bulk `devin-sync sync`, with `SessionStart`/`SessionEnd` simulated as never firing (verified Part A3 caveat) | `packages/plugins/devin-session-sync/tests/pipeline/sync-to-manifest.test.ts` | manifest/transcript presence assertion without a SessionStart/SessionEnd call | 5 | 5 | 5 | 125 | P0 | GREEN |
| SYNC-008 | `devin-sync sync`/`list`/`download`/`remove`/`migrate` CLI verb smoke pipeline round-trips one session | `packages/plugins/devin-session-sync/tests/pipeline/sync-to-manifest.test.ts` | end-to-end CLI verb chain assertion | 3 | 4 | 3 | 36 | P1 | GREEN |

## 7. Infrastructure prerequisites

Shared helpers under `packages/site/tests/e2e/helpers/` (see that
directory's `AGENTS.md`):

### 7.1 Helper 1 — `chart-content.ts`

Shadow-piercing assertions for rendered chart geometry
(`expectRenderedGeometry`) and empty-vs-error affordance disambiguation.
Self-tested by `chart-content.spec.ts` (UX-001/UX-002 smoke).

### 7.2 Helper 2 — `export-verify.ts`

Opens a downloaded `.sqlite` export with the app's own WASM SQLite driver
and returns row counts per table (`verifyExportContents`); throws on
corrupt/invalid files.

### 7.3 Helper 3 — `heartbeat.ts`

`assertHeartbeat`/`pollHeartbeat` poll a progress locator and assert
monotonic, distinct advancement within a bounded window. Self-tested by
`helpers/heartbeat.spec.ts` (throttled advancement, stall detection,
non-monotonic rejection).

### 7.4 Helper 4 — `manual-import-state.ts`

Shadow-piercing state assertions for `manual-import-state`: reads the
semantic `phase`, badge class/text, and hint copy to distinguish
Unsupported/Unavailable/Integrity Error affordances from each other and
from the idle state.

### 7.5 Pipeline failure-injection harness

`packages/db/tests/pipeline/harness.ts` wraps the SQLite executor/stores
and throws at a named `InjectionStage`
(`pre-commit` | `mid-commit` | `mid-rollup` | `post-ingest` | `reprocess`
| `query`), used by PIPE-004/PIPE-005 to assert explicit failure signals
rather than silent partial state. Self-tested by
`packages/db/tests/pipeline/harness.test.ts`.

## 8. Rollout & task prep

New surfaces move `PROPOSED` → `IMPLEMENTING` → `GREEN` (or
`FAILING-PRODUCT-BUG` if the guard proves a real defect — see
`triage-e2e-failure`). `e2e-test-planner` registers the entry and hands
it to `e2e-test-implementer`. A PR touching a user-facing surface must
cite the catalog ID(s) it implements or invokes; a PR that introduces a
new surface without a corresponding `PROPOSED`/`IMPLEMENTING` row is
blocked by `.agents/rules/e2e-coverage-required.md`.

## 9. Open gaps / backlog

No entries are currently `PROPOSED`. As of this backfill (issue #160),
every ID in §6 corresponds to a pre-existing, currently-passing test;
none were newly written by this change. New candidate surfaces (e.g. from
the devin-sync feature, #138) register here first as `PROPOSED` with a
score, then move through §8.

SYNC-006/007/008 (DS-F3, issue #158) were registered and implemented in
the same PR — the Devin plugin's sync→manifest→artifact-set journey and
the Devin-Cloud `Stop`-hook-only mitigation are new user-observable
surfaces introduced by that PR, so `GREEN` reflects the pipeline test
landing alongside the feature rather than a backfill.

## 10. Maintenance model

- Failures are triaged with `triage-e2e-failure` before any fix
  (product bug / test bug / flake).
- Quarantines (`test.fixme()` / `describe.skip`) are time-boxed (30
  days), linked to a bug, and tracked in this table's Status column as
  `FAILING-PRODUCT-BUG` until resolved — never a silent skip.
- Breaking an existing mapping is never resolved by deleting the catalog
  row or the test; IDs are retired (marked, not reused) only if the
  guarded surface itself is removed from the product.
- Post-triage records are appended to
  `docs/superpowers/discoveries/2026-08-27-e2e-coverage-enhancement.md`.
- `e2e-test-planner` re-scores periodically; re-scoring must stay uniform
  across all entries (§5) — no boosting recent incidents.
