---
globs: "packages/site/**,packages/db/**,packages/transformers/**,packages/sync/**,packages/parsers/**,packages/plugins/**"
---

# E2E Coverage Required

**When to use this rule:**

- When adding or modifying any user-facing surface: pages/routes,
  components rendering data, upload flows, sync flows, ingestion
  behavior, or export.

**Invariants (non-negotiable):**

- Every user-facing change ships with a mapped end-to-end or
  pipeline-integration test, registered in the catalog at
  `docs/superpowers/plans/2026-08-27-e2e-coverage-enhancement.md` (§6).
- PRs touching user-facing surfaces cite the catalog IDs (UX/PIPE/SYNC)
  they implement or invoke; absence of a mapping is a blocker.
- Helper-driven assertions (chart geometry, heartbeat, export content,
  empty-vs-error) are used where applicable; inline ad-hoc selectors are
  not acceptable.
- New product surfaces enter the catalog with L/U/D scores before merge.
- Breaking an existing E2E mapping is not resolved by deleting the test;
  classification follows the `triage-e2e-failure` skill.
