---
globs: "packages/db/**,packages/site/src/**"
---

# Aggregates Expose Sample Size and Evidence

**When to use this rule:**

- When implementing or consuming rollups, distributions, insights, cohort summaries, or any aggregate query in `packages/db` or rendering aggregates in `packages/site`.

**Invariants (non-negotiable):**

- Every aggregate value must be accompanied by its sample size (count of underlying observations) and a reference to its evidence grain.
- An aggregate without sample size is invalid and must not be emitted by db queries or rendered by the site.
- The `AnalyticsDataSource` contract must return sample size alongside every aggregate field; components must display it (e.g. "n=42") or treat the value as unrenderable.
- Missing observations are reported in the sample-size breakdown, not silently folded into the count.
- No aggregate may be presented as a standalone number divorced from the evidence that produced it.
