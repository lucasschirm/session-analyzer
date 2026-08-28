---
name: reprocess-analytics
description: Use when reprocessing analytics data — replacing generations, reconciling rollups, recovering from interruptions, or reporting reprocessing outcomes. Covers source checks, replacement generations, reconciliation, interruption recovery, and reporting for the analytics data platform.
---

# Reprocess Analytics

## Overview

This skill codifies the repeatable procedure for reprocessing analytics data.
Reprocessing replaces a transformation generation atomically, rebuilds
affected rollups/distributions/cohorts/insights from an explicit frontier,
and handles source availability, interruption recovery, and reporting. The
architecture deliberately moves cost from reads to ingestion; reprocessing
cost is observable and retryable.

**Core invariants:**
- Transformation occurs outside the write transaction.
- The complete batch is validated before persistence.
- Readers see the previous complete generation until commit. Rollback leaves
  it unchanged.
- Deleting retained transcripts never deletes normalized facts.
- If sources are unavailable, existing metrics remain readable in their prior
  analysis release.
- Portfolio/project aggregates select one compatible release or show separate
  strata; they never silently mix versions.
- Interrupted transaction: rollback all evidence, contributions, cohorts, and
  current-generation changes.

## Plan references

- §10 Ingestion, replacement, and reprocessing (§10.1 synced flow, §10.3
  atomic generation replacement, §10.4 reprocessing)
- §8.1 Schema, analysis releases, and generation control
- §8.7 Precomputed summaries and rollups (rebuild frontiers)
- §13 Failure and edge-case behavior
- §15.3 db acceptance criteria (idempotent replacement, source retention,
  fatal failure preserving prior generation)
- §15.5 Performance acceptance criteria (atomic replacement under injected
  failures)
- §17 Consequences (replacing, deleting, reordering, reclassifying, or moving
  a session triggers rebuilds from an explicit frontier)

## Package paths

| Concern | Path |
|---|---|
| Ingestion orchestration | `packages/db/src/ingestion.ts` |
| Reprocessing workflows | `packages/db/src/ingestion.ts` |
| Generation control | `packages/db-core/src/generations.ts` |
| Manifest stores | `packages/db-core/src/manifest.ts` |
| Artifact retention | `packages/db-core/src/manifest.ts` |
| Rollup contributions | `packages/db-core/src/schema.ts` (stores) |
| Analytics data source | `packages/db/src/analytics.ts` |
| Ports (artifact resolver, blob store) | `packages/db/src/ports.ts` |
| db tests | `packages/db/tests/` |
| db-core tests | `packages/db-core/tests/` |

## Procedure

### Step 1 — Identify the reprocessing trigger

Determine what triggered the reprocessing:

| Trigger | Source | Frontier start |
|---|---|---|
| New analysis release (metric/ontology version change) | User selects new release | All sessions in scope |
| Late-arriving session | Sync delivers a session with earlier occurrence time | Earliest affected snapshot in `(environment, project, workspace, harness, scope-chain)` |
| Timestamp correction | Native event provides corrected time | Earliest affected snapshot |
| Reclassification | Artifact classifier version change | Earliest affected snapshot |
| Deletion | Authoritative source tombstone or session/project deletion | Earliest affected snapshot |
| Project move/reassignment | Project mapping change | All sessions in affected project |
| Transformer version change | New transformer plugin version | All sessions using that harness |
| Schema/migration change | New migration affecting rollups | All sessions (or per migration scope) |

### Step 2 — Check source availability

For each session to reprocess, check whether retained blobs or reacquirable
sources are available. Every generation records artifact hashes and all
parser/transformer/ontology/metric/schema/statistical/rollup versions.

```ts
// packages/db/src/ingestion.ts
interface ReprocessingSourceCheck {
  sessionId: string;
  generationId: string;
  status: 'local' | 'remote_reacquirable' | 'unavailable';
  artifactHashes: readonly string[];
  transformerVersion: string;
  ontologyVersion: string;
  metricDefinitionVersion: string;
  statisticalPolicyVersion: string;
  rollupPolicyVersion: string;
}
```

**Decision rules:**
- `local` → retained blobs are available; reprocess directly.
- `remote_reacquirable` → reacquire through safe source references (no
  credentials in analytics tables).
- `unavailable` → existing metrics remain readable in their prior analysis
  release. The UI explains why a newer release has lower coverage. Do not
  delete or zero out prior values.

**Command to check source availability:**

```bash
# In a test or maintenance script:
cd packages/db && pnpm vitest run -- -t "reprocess.*source.*check"
```

### Step 3 — Select the analysis release

Determine which analysis release to reprocess into. Portfolio/project
aggregates select one compatible release or show separate strata; they never
silently mix versions.

```ts
// packages/db/src/ingestion.ts
interface AnalysisReleaseSelection {
  analysisReleaseId: string;
  ontologyVersion: string;
  metricRegistryVersion: string;
  statisticalPolicyVersion: string;
  rollupPolicyVersion: string;
  comparabilityGroupIds: readonly string[];
}
```

If reprocessing into a new release, sessions that cannot be reprocessed
remain in their prior release. The UI shows separate strata or lower coverage,
never blended definition versions.

### Step 4 — Transform outside the write transaction

Run the transformer on each verified bundle outside the write transaction.
The complete batch is validated before persistence.

```ts
// packages/db/src/ingestion.ts
async function reprocessSession(params: ReprocessParams): Promise<void> {
  // 1. Resolve artifacts and verify hashes.
  const bundle = await artifactResolver.resolve(params.sessionId, params.generationId);
  // Hash mismatch → integrity failure, not retryable as a transform error.
  // Preserve previous generation and identify the artifact needing repair.

  // 2. Select transformer from manifest harness.
  const transformer = registry.select(bundle.harness);

  // 3. Transform outside the write transaction.
  const result = transformer.transform(bundle, context);

  // 4. Validate capabilities, provenance, and anti-double-counting.
  validateTransformResult(result);

  // 5. Compare eligible configuration snapshots (if applicable).
  // 6. Proceed to atomic replacement (Step 5).
}
```

### Step 5 — Perform atomic generation replacement

In one transaction, `db`:

1. inserts generation-scoped candidate records that can coexist with current
   rows;
2. computes the affected project/workspace rebuild frontier;
3. subtracts or invalidates previous-generation contributions;
4. rebuilds lifecycle boundaries, exposures, cohort memberships, and insights
   from the frontier;
5. applies root-only and inclusive contributions through their separate
   namespaces;
6. rebuilds affected distributions and chart buckets under the selected
   analysis release;
7. updates `sessions.current_generation_id` as the single visibility switch
   and marks the old generation superseded.

```ts
// packages/db/src/ingestion.ts
await executor.transaction(async (tx) => {
  // 1. Insert candidate records (generation-scoped, can coexist).
  await stores.insertCandidateEvidence(tx, result, newGenerationId);

  // 2. Compute affected rebuild frontier.
  const frontier = computeRebuildFrontier(sessionId, affectedScope);

  // 3. Subtract previous-generation contributions.
  await stores.subtractContributions(tx, oldGenerationId, frontier);

  // 4. Rebuild lifecycle, exposures, cohorts, insights from frontier.
  await stores.rebuildLifecycle(tx, frontier);
  await stores.rebuildExposures(tx, frontier);
  await stores.rebuildCohorts(tx, frontier);
  await stores.rebuildInsights(tx, frontier);

  // 5. Apply new root-only and inclusive contributions (separate namespaces).
  await stores.applyContributions(tx, result, newGenerationId, 'root_only');
  await stores.applyContributions(tx, result, newGenerationId, 'inclusive');

  // 6. Rebuild affected distributions and chart buckets.
  await stores.rebuildDistributions(tx, frontier, analysisReleaseId);
  await stores.rebuildChartBuckets(tx, frontier, analysisReleaseId);

  // 7. Switch visibility.
  await stores.updateCurrentGeneration(tx, sessionId, newGenerationId);
  await stores.markSuperseded(tx, oldGenerationId);
});
```

Readers see the previous complete generation until commit. Rollback leaves
it unchanged. Idempotency keys prevent duplicated manifests, sessions, and
source events from inflating metrics.

### Step 6 — Reconcile rollups

Verify that project/portfolio rollups exactly reconcile with current session
contributions:

```ts
// packages/db/tests/reprocessing-reconciliation.test.ts
describe('reprocessing reconciliation', () => {
  it('project rollup equals sum of current session contributions after reprocessing', async () => {
    // 1. Ingest sessions.
    // 2. Reprocess one session with changed data.
    // 3. Assert project rollup = sum of current contributions.
    // 4. Assert old contributions were subtracted.
    // 5. Assert new contributions were added.
  });

  it('inclusive portfolio total does not double-count child sessions', async () => {
    // Reprocess a root session with children.
    // Assert inclusive total = root + children, children not separately added.
  });

  it('distributions are rebuilt for affected buckets only', async () => {
    // Reprocess a session in one time bucket.
    // Assert only that bucket's distribution changed, others unchanged.
  });
});
```

**Command:**

```bash
cd packages/db && pnpm vitest run -- -t "reprocess.*reconcil"
cd packages/db-core && pnpm vitest run -- -t "rollup.*reconcil"
```

### Step 7 — Handle interruption recovery

If the transaction is interrupted, rollback all evidence, contributions,
cohorts, and current-generation changes. The previous complete generation
remains visible.

**Interruption recovery procedure:**

```bash
# 1. Detect interrupted reprocessing (generation status = 'candidate' but
#    not committed, or transaction left open).
# 2. The database transaction rollback is automatic for the connection that
#    failed. For resumable maintenance jobs, check generation status:
cd packages/db && pnpm vitest run -- -t "interrupt.*recovery"

# 3. Clean up orphaned candidate rows from interrupted transactions:
#    These have generation status 'candidate' with no current visibility
#    switch. They can coexist safely and are garbage-collected.
# 4. Resume reprocessing from the frontier — idempotency keys prevent
#    duplication.
```

**Failure edge cases (§13):**
- Corrupt/hash-mismatched artifact: reject the candidate generation and
  preserve the previous one.
- Source blob deletion during reprocessing: fail before replacement and
  preserve the current generation.
- Interrupted transaction: rollback all evidence, contributions, cohorts, and
  current-generation changes.
- Stale rollup version: prevent inconsistent generation reads and rebuild from
  current contribution rows.
- OPFS lock/unsupported runtime: retain explicit fallback behavior; the
  adapter reports backend and durability.

### Step 8 — Handle deletion and privacy erasure

Deletion is explicit and typed with separate commands and restore behavior:

| Deletion type | Behavior |
|---|---|
| Local blob purge | Deletes retained bytes; normalized evidence remains |
| Authoritative source tombstone | Triggers source deletion; subtracts contributions, rebuilds from earliest affected frontier |
| Session deletion | Subtracts contributions, rebuilds distributions/cohorts/lifecycle, removes/tombstones evidence links, garbage-collects unreferenced blobs |
| Project deletion | Cascades scoped sessions/installations/references; preserves shared blob only when another reference remains |
| Privacy erasure | Typed erasure with separate restore behavior |

A deleted intermediate snapshot creates a discontinuity; the engine does not
infer a transition across the gap without independent continuity evidence.

### Step 9 — Report reprocessing outcomes

Generate a reprocessing report documenting:

```ts
interface ReprocessingReport {
  trigger: string;
  analysisReleaseId: string;
  sessionsProcessed: number;
  sessionsSkipped: number;
  sessionsUnavailable: number;
  frontierStart: string; // earliest affected snapshot
  frontierEnd: string;
  contributionsSubtracted: number;
  contributionsApplied: number;
  distributionsRebuilt: number;
  cohortsRebuilt: number;
  insightsRebuilt: number;
  rollupsReconciled: boolean;
  failures: readonly ReprocessingFailure[];
  duration: number;
}

interface ReprocessingFailure {
  sessionId: string;
  failureType: 'hash_mismatch' | 'source_unavailable' | 'transform_error' | 'integrity_error';
  message: string;
  preservedGenerationId: string; // prior generation preserved
}
```

**Report command (maintenance script):**

```bash
# Run reprocessing and output a report
cd packages/db && pnpm vitest run -- -t "reprocess.*report"
```

The UI explains reprocessing outcomes:
- which sessions were reprocessed vs. skipped vs. unavailable;
- why a newer release has lower coverage (if applicable);
- separate compatible strata or lower coverage, never blended versions.

### Step 10 — Verify performance budgets

Reprocessing cost is observable and retryable. Benchmark budgets determine
whether a frontier is processed inline or through a resumable maintenance job
before activation.

```bash
cd packages/db && pnpm vitest run -- -t "reprocess.*performance"
```

Acceptance criteria (§15.5):
- exact reconciliation of current session contributions to project/portfolio
  additive totals;
- write-time distribution/cohort rebuilds for affected buckets only;
- atomic replacement under injected failures.

## Completion checklist

- [ ] Reprocessing trigger identified and frontier start determined.
- [ ] Source availability checked for each session (local, remote_reacquirable,
      unavailable).
- [ ] Analysis release selected; incompatible sessions remain in prior release.
- [ ] Transformation performed outside the write transaction.
- [ ] Complete batch validated before persistence.
- [ ] Atomic generation replacement performed in one transaction (7 steps).
- [ ] Root-only and inclusive contributions applied through separate namespaces.
- [ ] Affected distributions and chart buckets rebuilt under selected release.
- [ ] Rollup reconciliation verified (project/portfolio = sum of current
      contributions).
- [ ] Anti-double-counting verified (inclusive total does not double-count
      children).
- [ ] Interruption recovery tested (rollback preserves previous generation).
- [ ] Deletion/privacy erasure handled with typed commands (if applicable).
- [ ] Reprocessing report generated with outcomes and failures.
- [ ] Performance budgets verified (affected buckets only, atomic replacement
      under injected failures).
- [ ] `pnpm --filter @lucasschirm/sal-db verify` passes.
- [ ] `pnpm --filter @lucasschirm/sal-db-core verify` passes.
