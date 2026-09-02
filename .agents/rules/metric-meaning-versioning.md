---
globs: "packages/db-core/**,packages/db/**,packages/transformers/**"
---

# Metric Meaning Changes Require Versioning

**When to use this rule:**

- When defining or modifying a metric in the metric registry, a transformer's metric derivation, or a db rollup/statistical policy.

**Invariants (non-negotiable):**

- Any change that alters what a metric means (formula, population, denominator, comparability group, missingness handling, attribution policy) must increment the metric's version in the registry.
- Metric IDs are stable; versions are monotonic. A versioned metric is a distinct comparability entity from its prior version.
- Rollups, distributions, cohorts, and dashboard series must record the metric version they were computed under; mixed versions are never aggregated together.
- Analysis releases gate which metric versions are active and prevent mixing meanings within a release.
- A meaning change shipped without a version bump is a defect and must be reverted or re-versioned before activation.
