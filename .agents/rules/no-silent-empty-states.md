---
globs: "packages/site/src/**,packages/site/tests/**"
---

# No Silent Empty States

**When to use this rule:**

- When implementing or changing a data-rendering component (charts,
  metric cards, tables, lists) or its E2E assertions.

**Invariants (non-negotiable):**

- A query failure and a zero-row result must render distinguishable
  affordances. Failure-as-"No data" is a defect, not a design choice.
- UI components on a failure surface an error affordance (error badge,
  banner, or toast), never identical to the legitimate empty state.
- E2E tests for any data component assert both the empty and the error
  affordances; one assertion alone is insufficient coverage.
- Worker error propagation must not be silently swallowed between the
  worker and the UI thread (e.g. `rejectAll` without a user signal).
- Treating absence-of-signal as zero conflicts with
  `missing-is-never-zero`; it also forbids collapses in UI affordances.
