# ADR-0006: Metric meaning changes require versioning

**Status:** Accepted

**Date:** 2026-08-24

**Plan reference:** `docs/superpowers/plans/2026-08-24-analytics-data-platform-design.md` §9 (Metric definition and evolution), §6.2 (Cross-harness comparability)

## Context

The platform stores metric values across many sessions, projects, harnesses,
and transformer versions. Metrics evolve: formulas change, denominators are
refined, inclusion rules shift between root-only and inclusive, measurement
classes change from estimated to observed, and allocation methods are updated.

If a metric's meaning changed silently (same `metricId`, different formula),
historical values would be incorrectly combined with new values in rollups,
distributions, and cohorts. A dashboard showing "total tokens" would mix
old-definition and new-definition values, producing meaningless aggregates.

Cross-harness comparability depends on knowing exactly which properties of a
metric are compatible. Without versioning, the system cannot determine whether
a Claude Code token count and an Agentic Pi token count are safely combinable.

## Decision

Every metric definition is versioned. Changing any of the following properties
creates a **new definition version**:

- Formula or computation method
- Denominator
- Inclusion rule (root-only vs inclusive)
- Measurement class (`observed`, `derived`, `estimated`, `heuristic`)
- Allocation method
- Statistical policy
- Population or status rules

Historical values retain their original version. Label-only corrections may
update documentation without changing meaning, but registry checksums still
detect drift.

The registry derives a machine-readable `comparability_group_id` from
definition properties: metric ID and version, unit, currency/pricing version,
grain, dimensions, denominator, observation unit, population, session-finality
rules, measurement class, native mapping version, root-only/inclusive
semantics, status/threshold/censoring/missing-data rules, and
aggregation/statistical/attribution method.

Values, distributions, contributions, rollups, cohorts, and chart series are
keyed by `comparability_group_id` and **cannot aggregate mixed groups**.
Project/portfolio rollups are partitioned by `analysis_release_id` and
`comparability_group_id`, so sessions that cannot be reprocessed never silently
mix old and new metric meanings.

Capabilities are `available`, `partial`, `unavailable`, or `incompatible`.
Dashboards show eligible `N`, known `n`, unknown count, and coverage. Default
portfolio headlines stratify incompatible groups by harness/method instead of
combining them.

An exact provider token value is never silently combined with an estimated
text-token value. Native metrics may use a namespaced ID
(`native.claude_code.<metric>`) until a canonical definition and explicit
bridge mapping exist.

## Consequences

**Positive:**

- Historical values remain meaningful and comparable within their version.
- Rollups and distributions never silently mix incompatible metric meanings.
- Dashboards explicitly show coverage and stratify incompatible groups.
- Cross-harness comparison is safe: the system knows exactly when values can be
  combined.

**Negative:**

- Changing a metric's meaning requires a new version and reprocessing to
  populate values under the new definition.
- Sessions that cannot be reprocessed remain in their prior analysis release;
  the UI must explain why a newer release has lower coverage.
- The metric release matrix must be maintained to track every metric's
  evidence/class/policy gates.

**Neutral:**

- Registry checksums detect drift even for label-only corrections, ensuring
  documentation and code stay in sync.

## Alternatives

**Silent formula changes (same version).** Rejected because it would
incorrectly combine old and new values in aggregates, producing meaningless
dashboards and corrupting historical analysis.

**Separate metric IDs for each variant.** Rejected because it fragments the
metric namespace and makes it difficult to track the evolution of a single
conceptual metric. Versioning within a stable `metricId` preserves continuity
while distinguishing meanings.

**No cross-harness comparison.** Rejected because the platform's value
proposition includes portfolio-level analysis across harnesses. Explicit
comparability groups enable safe comparison when properties are compatible and
honest separation when they are not.

**Automatic reprocessing on definition change.** Rejected as the only option
because sources may be unavailable. The system must preserve existing metrics
in their prior analysis release and explain coverage gaps rather than
discarding them.
