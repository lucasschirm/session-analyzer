---
name: add-pipeline-e2e-test
description: Use when adding an analytics pipeline integration test that spans parse → transform → ingest → rollup → analytics query across packages (sync, sync-core, parsers, transformer, db-core, db). Covers the pipeline test location, in-memory SQLite executor choice, fixture-driven packages, failure-injection harness usage, and staleness/generation-token assertions.
---

# Add Pipeline E2E Test

## Overview

Pipeline tests exercise the seam between packages (not browser UI): native
artifact → parser → transformer → `db` ingestion with atomic generation →
rollup contribution → `AnalyticsDataSource` DTO. They catch breaks that
isolated unit tests cannot: transformer/ingestion schema drift,
commit/partial-write boundaries, and stale rollups served silently.

**Core invariants:**

- One happy-path end: `packages/db/tests/unit/ingestion-to-portfolio.test.ts`
  already proves value; extend it, don't fork it, unless the new test
  requires failure injection.
- Failure assertions must check a *signal*, not absence of data:
  e.g. `IngestionIssue` entries, generation/freshness tokens, explicit
  `unavailable` capabilities.
- Re-ingestion is never additive duplication.
- Missing values are missing, never zero (rule `missing-is-never-zero`).
- Tests must be deterministic: no wall-clock windows, no real network.

## Plan references

- §4.3 Silent-failure map (pipeline)
- §6 Tier B catalog (PIPE-### entries)
- §7.5 Pipeline failure-injection harness

## Package paths

| Concern | Path |
|---|---|
| Pipeline specs | `packages/db/tests/pipeline/*.test.ts` (new) |
| Existing full-path spec | `packages/db/tests/unit/ingestion-to-portfolio.test.ts` |
| Failure-injection harness | `packages/db/tests/pipeline/harness.ts` (to create) |
| Fixtures (Claude) | `packages/parsers/claude-session-parser/tests/fixtures/` |
| Ingestion entry | `packages/db/src/ingestion.ts` |
| Rollup reconciliation | `packages/db/src/rollup-reconciliation.ts` |
| Analytics DTO façade | `packages/db/src/analytics.ts` |
| Transformer registry | `packages/transformer/src/` plugins |

## Procedure

### Step 1 — Register the test in the catalog

Assign the next PIPE ID in §6 Tier B of
`docs/superpowers/plans/2026-08-27-e2e-coverage-enhancement.md`. Name
tests with the ID prefix (`PIPE-004: commit failure boundary...`).

### Step 2 — Pick the pipeline slice

Decide the span:

- **db-only span (fastest, most common):** parse→transform→ingest→query
  using parser fixtures (`sal-claude-session-parser/tests/fixtures`).
- **plugin-span (for PIPE-009):** build the plugin bundle
  (`@lucasschirm/claude-session-sync`) artifact first, then run parser +
  transformer + db. Use only when the hypotheses spans the plugin's
  artifact mapping, not just the parser.

### Step 3 — Choose the executor

Follow `packages/db/tests/unit/ingestion-to-portfolio.test.ts` for the
SQLite executor setup (in-memory driver already exercised in unit tests).
Do not resurrect WASM OPFS or real filesystem handles in pipeline tests.

### Step 4 — Happy-path first, then injected failures

Write the passing pipeline run, then layer failure:

- Use `packages/db/tests/pipeline/harness.ts` (create if missing) to wrap
  stores/executors and throw at a named stage
  (`stage: 'validate' | 'commit' | 'rollup' | 'query'`).
- Assert the explicit signal: `IngestionReceipt({status:'failed'})` or
  `IngestionIssue` entries; never just empty DTOs.
- For staleness (PIPE-002): write, mark stale intentionally, and assert
  the DTO exposes a version/generation marker the UI can compare.

### Step 5 — Missing-never-zero with explicit assertions

For PIPE-008: ingest a session missing a metric signal, assert the DTO
carries explicit missingness (e.g. `eligibleN`, `unknownCount`,
`missingDataBehavior: 'unknown'`), and aggregates are not zero-filled.

### Step 6 — Idempotency / duplication guards

For PIPE-006/007: ingest, re-ingest same session, assert contribution
uniqueness, generation supersedes, no additive duplication, and version
markers consistent.

### Step 7 — Register and run

```bash
pnpm --filter @lucasschirm/sal-db test -- tests/pipeline/<name>.test.ts
pnpm --filter @lucasschirm/sal-db verify
```

Vitest nodes only; never Playwright for Tier B. Browser UX lives in Tier A.

## Completion checklist

- [ ] PIPE ID registered with L/U/D scores in the plan.
- [ ] Spec under `packages/db/tests/pipeline/` (unless extending
      `ingestion-to-portfolio.test.ts` deliberately).
- [ ] Failure assertions check explicit signals, not absence.
- [ ] Missing-never-zero explicitly asserted for metric-bearing tests.
- [ ] Idempotency verified for re-ingest cases.
- [ ] Generation/staleness tokens asserted where freshness is in scope.
- [ ] Harness stage injection used (no ad-hoc throw).
- [ ] Deterministic fixtures; no network or wall-clock reliance.
- [ ] `pnpm --filter @lucasschirm/sal-db verify` green.
- [ ] Mutation sanity (kill the guard, see it red) documented for critical
      staleness/duplication guards.
