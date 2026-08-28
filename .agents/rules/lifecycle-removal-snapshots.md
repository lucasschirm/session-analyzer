---
globs: "packages/db/**"
---

# Lifecycle Removals Require Comparable Complete Snapshots

**When to use this rule:**

- When implementing component lifecycle events, artifact removal, deletion, reclassification, or before/after cohort rebuilds in `packages/db`.

**Invariants (non-negotiable):**

- A lifecycle removal (deletion, reclassification, or replacement of a component/session/artifact) is only valid when comparable complete snapshots exist for both the before and after states.
- Partial or one-sided snapshots must not be used to derive lifecycle deltas or cohort comparisons.
- Removal processing must record the frontier, the complete before snapshot, the complete after snapshot, and the rebuild scope before activating results.
- Cohorts compared across a lifecycle event must be reconstructed from the same evidence grain; never compare a complete snapshot to an incomplete one.
- If a comparable complete after snapshot is unavailable, the removal is held at the frontier until it is — do not emit derived lifecycle metrics from incomplete state.
