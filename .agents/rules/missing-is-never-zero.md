---
globs: "packages/db-core/**,packages/db/**,packages/transformer/**,packages/site/src/**"
---

# Missing Is Never Zero

**When to use this rule:**

- When storing, aggregating, transforming, or displaying metric values, counts, durations, or any quantitative field sourced from native harness signals.

**Invariants (non-negotiable):**

- Missing, unavailable, or not-applicable values are never coerced to `0`, `null`-as-zero, or empty-string-as-zero.
- A missing signal is stored and propagated as missing (e.g. a dedicated missing sentinel or explicit optional type), distinct from a measured zero.
- Aggregations, sums, averages, and rollups must account for missingness separately from sample size; a missing value does not contribute to a sum and is not counted as a zero observation.
- UI must render missing values as "—" / "N/A" / "unavailable", never as `0`.
- Comparability groups and metric versions must prevent mixing missing-as-zero with measured-zero populations.
