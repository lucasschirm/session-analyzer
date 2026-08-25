# ADR-0002: Precomputed rollups over read-time aggregation

**Status:** Accepted

**Date:** 2026-08-24

**Plan reference:** `docs/superpowers/plans/2026-08-24-analytics-data-platform-design.md` §4.1 (Typed evidence and incremental rollups), §8.7 (Precomputed summaries and rollups), §11.5 (Read-performance rule)

## Context

The current site scans detailed session rows to calculate dashboard values at
read time. The larger metric ontology in `SESSION_METRICS.md` adds
distributions, cohorts, context growth, component utilization, lifecycle
comparisons, and attribution metrics. Read-time aggregation over detailed rows
becomes unviable as the number of sessions, projects, and metrics grows.

Opening a session must not scan its transcript or derive metrics. Project and
portfolio dashboards must use bounded indexed series. The read-performance rule
requires that session open performs only summary, bounded chart-series, and
paginated evidence queries — no transcript scan, no tree reconstruction, no
percentile calculation, no metric derivation, no configuration diff, no
project-wide aggregation.

## Decision

Store normalized typed evidence and precompute session summaries, project/
portfolio rollups, distributions, cohorts, and chart series at ingestion time.
Rollups are maintained incrementally through atomic generation replacement:

1. Each session's additive contribution to project/portfolio buckets is stored
   in `rollup_contributions`, explicitly namespaced as root-only or inclusive.
2. Project/portfolio daily and dimension rollups are additive time series
   materialized from contributions.
3. Distributions (percentiles, histograms) are recomputed during ingestion for
   affected bounded cohorts from indexed current session contributions.
4. Chart series are precomputed and bounded per session.
5. Cohorts and insight evidence are deterministically materialized.

A versioned `rollup_policy` defines supported dimensions, cardinality caps,
top-N/other behavior, unknown buckets, bucket timezone, and analysis release.
The system does not precompute arbitrary dimension combinations.

Exact percentile/distribution buckets are recomputed from indexed current
session contributions during ingestion. This makes writes heavier but reads
predictable and makes replacement subtraction correct.

## Consequences

**Positive:**

- Dashboard reads are bounded and indexed — no full scans, no metric
  derivation at read time.
- Opening a session is O(summary + bounded series + paginated evidence),
  independent of transcript size.
- Project and portfolio pages use precomputed rollups with predictable
  performance.
- Replacement is correct: subtracting old contributions and adding new ones
  produces exact rollups without re-scanning all sessions.
- Distributions and cohorts are reproducible from stored contribution rows.

**Negative:**

- Ingestion is heavier: replacing, deleting, reordering, reclassifying, or
  moving a session triggers rollup, distribution, lifecycle, exposure, insight,
  and cohort rebuilds from an explicit frontier.
- Write-time cost is observable and retryable; benchmark budgets determine
  whether a frontier is processed inline or through a resumable maintenance job.
- Storage is larger due to precomputed summary and rollup tables.

**Neutral:**

- A future mergeable sketch may be introduced only as a separately versioned
  estimated aggregation method; it does not replace exact precomputed
  distributions.

## Alternatives

**Read-time aggregation over detailed rows.** Rejected because the larger
metric ontology makes it unviable — p95 read latency would degrade as session
count grows, and opening a session would require full transcript scans.

**Generic EAV ledger as the only fact store.** Rejected because it discards
relationships, constraints, provenance, and efficient indexes. Typed evidence
preserves structure and enables efficient indexed queries.

**UI-shaped dashboard JSON as the canonical model.** Rejected because it
couples persistence to presentation, prevents drill-down to evidence, and makes
schema evolution brittle.

**Materialized views.** Rejected because SQLite materialized views are not
natively supported and manual refresh logic would duplicate the incremental
rebuild frontier machinery already needed for generation replacement.
