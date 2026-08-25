# ADR-0005: Deleting source blobs doesn't delete normalized evidence

**Status:** Accepted

**Date:** 2026-08-24

**Plan reference:** `docs/superpowers/plans/2026-08-24-analytics-data-platform-design.md` §4.3 (Fresh analytics database), §8.3 (Manifests and artifact retention), §10.4 (Reprocessing)

## Context

The platform stores both source artifacts (transcripts, configuration files,
Sub Agent transcripts) and normalized evidence (turns, messages, invocations,
metric values, rollups, lifecycle events). Source artifacts can be large and
may be deleted by the user to save space or for privacy reasons.

If deleting a source blob also deleted the normalized evidence derived from it,
the analytics database would lose all session metrics, rollups, cohorts, and
lifecycle events whenever a user purged source text. This would make the
analytics database fragile and dependent on source retention, defeating the
purpose of precomputed analytics.

However, some evidence (configuration artifact versions needed for historical
diffs) must be retained while referenced by lifecycle comparisons. The system
must distinguish between optional source blobs (transcripts) and required
configuration artifacts.

## Decision

Deleting optional source blobs (transcripts, Sub Agent transcripts) does not
delete normalized evidence. Each generation reports `local`,
`remote_reacquirable`, or `unavailable` reprocessing status:

- **`local`** — source blobs are retained locally and available for
  reprocessing.
- **`remote_reacquirable`** — source blobs were deleted but can be reacquired
  through safe source references.
- **`unavailable`** — source blobs were deleted and cannot be reacquired;
  existing metrics remain readable in their prior analysis release.

Configuration artifacts required for Rule/Skill/Agent/MCP/Tool/settings/plugin
version diffing are retained locally when safely capturable and cannot be
silently removed while referenced by a lifecycle comparison. If source text is
purged, the UI presents metadata-only evidence rather than reconstructing
content.

Deletion is explicit and typed with separate commands and restore behavior:

- **Local blob purge** — removes optional source bytes; normalized evidence
  remains.
- **Authoritative source tombstone** — triggers source deletion; distinct from
  absent list results.
- **Session deletion** — subtracts contributions, rebuilds distributions/
  cohorts/lifecycle from the earliest affected frontier, removes or tombstones
  evidence links.
- **Project deletion** — cascades scoped sessions/installations/references
  while preserving shared blobs only when another reference remains.
- **Privacy erasure** — removes all local analytical and retained-source data.

Analytical deletion subtracts contributions, rebuilds distributions/cohorts/
lifecycle from the earliest affected frontier, removes or tombstones evidence
links, and garbage-collects unreferenced blobs/identities according to policy.

## Consequences

**Positive:**

- Users can purge large source transcripts without losing analytics.
- The analytics database remains useful even when source blobs are unavailable.
- Reprocessing can use retained blobs or reacquire sources through safe
  references; if sources are unavailable, existing metrics remain readable.
- Configuration artifact retention ensures historical diffs remain available
  while referenced.

**Negative:**

- Storage for normalized evidence is permanent (within an analysis release)
  even after source deletion.
- The UI must explain why a newer analysis release has lower coverage when
  sources are unavailable for reprocessing.
- Configuration artifact retention requires explicit policy management to avoid
  unbounded growth.

**Neutral:**

- The `retention_policies` table manages portfolio default, environment policy,
  and project overrides for retention behavior.

## Alternatives

**Cascade deletion of evidence with source blobs.** Rejected because it would
destroy all analytics whenever a user purges source text, making the analytics
database fragile and defeating the purpose of precomputed analytics.

**Require permanent source retention.** Rejected because source transcripts
can be large and users need the ability to manage local storage. Forcing
permanent retention would make the platform impractical for long-term use.

**Reconstruct evidence from remaining sources on demand.** Rejected because
reprocessing requires source availability. If sources are unavailable, the
system cannot reconstruct evidence; it must preserve what was already computed.
