# ADR-0007: Fresh activation with rollback window

**Status:** Accepted

**Date:** 2026-08-24

**Plan reference:** `docs/superpowers/plans/2026-08-24-analytics-data-platform-design.md` §4.3 (Fresh analytics database and split storage topology), §14 (Site migration strategy, Gate 9)

## Context

The new analytics schema introduces a fundamentally different data model:
typed evidence, precomputed rollups, generation-scoped visibility, component
ecosystem, and metric versioning. The existing site database uses read-time
aggregation over detailed rows and has no concept of generations, rollups, or
component identity.

Backfilling the new analytics schema from the current browser database would
require inventing provenance for metrics that were computed differently,
mapping old detailed rows to new typed evidence without manifest context, and
fabricating configuration snapshots from artifacts that were never classified.
This would produce false zeros, invented provenance, and unreliable lifecycle
events.

The current site database also owns connection metadata, encrypted credentials,
passkey state, and sync state. Those records cannot disappear when analytics
resets.

## Decision

The new analytics schema opens under a new database filename and schema
identity (`sal-analytics`). Existing analytical rows are not backfilled or
interpreted as new metrics. Users re-sync or re-import sessions.

Before the analytics cutover, storage ownership is split:

- A **site control database** retains connection metadata, encrypted
  credentials, passkey/vault state, source checkpoints, and UI preferences
  under the existing runtime security boundary.
- The **analytics database** is owned through `db-core` and contains projects,
  source mappings, artifacts, normalized evidence, metrics, and rollups.
- The site coordinates the two through explicit IDs and ports, never a
  cross-database transaction.
- Source discovery/checkpoint progress commits in the control database only
  after analytics ingestion returns an idempotent committed-generation receipt.

The rollout uses a rollback window:

- The old database remains read-only/exportable during a bounded rollback
  window, using a separate worker/connection so its OPFS lock cannot be
  confused with the new database.
- Activation is one-way for the new analytics database, but the UI can roll
  back to the old read-only application mode until the legacy-removal milestone.
- The rollout discloses the reset, source-retention implications, and
  re-sync/re-import path before activation.

A later analytical importer can be designed independently but is not part of
this effort.

## Consequences

**Positive:**

- The new schema starts clean with correct provenance, no invented data, and no
  false zeros.
- Connection/vault state is preserved; users do not lose credentials or sync
  state.
- Users can roll back to the old application during the rollback window if the
  new analytics experience has issues.
- The split storage topology clarifies ownership: control vs. analytics.

**Negative:**

- Users must re-sync or re-import sessions; existing analytics are not
  migrated.
- The rollback window requires maintaining two database connections and two
  application modes simultaneously.
- The rollout must disclose the reset and re-sync requirement, which is a UX
  friction point.

**Neutral:**

- The old database remains read-only/exportable during the rollback window,
  giving users time to verify the new analytics before the legacy-removal
  milestone.

## Alternatives

**Backfill from the old database.** Rejected because it would require inventing
provenance for metrics computed under a different model, mapping detailed rows
to typed evidence without manifest context, and fabricating configuration
snapshots. This produces false zeros, invented provenance, and unreliable
lifecycle events.

**In-place schema migration.** Rejected because the data model is
fundamentally different — generation-scoped visibility, rollup contributions,
and component ecosystem tables have no analog in the old schema. An in-place
migration would require dropping and recreating most tables, effectively a
fresh database with added complexity.

**Dual-write during transition.** Rejected because it would require maintaining
both the old read-time aggregation and the new ingestion pipeline simultaneously,
doubling the work and risking inconsistency. The old and new models are too
different for meaningful dual-write.

**Immediate cutover without rollback.** Rejected because it provides no safety
net. If the new analytics experience has issues, users would have no way to
access their previous dashboard. The rollback window is a necessary safety
mechanism.
