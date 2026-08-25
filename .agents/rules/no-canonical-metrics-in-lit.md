---
globs: "packages/site/src/components/**,packages/site/src/pages/**"
---

# Canonical Metrics Are Never Calculated in Lit Components

**When to use this rule:**

- When creating or editing Lit web components or page-level components under `packages/site/src/`.

**Invariants (non-negotiable):**

- Lit components never compute canonical metrics. They only read precomputed facts, rollups, distributions, and series from the `AnalyticsDataSource` contract.
- No component may scan detailed session rows, sum tokens, derive rates, or recompute any metric defined in the metric registry.
- Display-side formatting (rounding, unit labels, sorting of already-computed values) is permitted; metric derivation is not.
- If a value is not exposed by `AnalyticsDataSource`, add it to the db query layer and metric registry — do not derive it in the component.
- Components must not import stores, run SQL, or reach into `db-core` internals.
