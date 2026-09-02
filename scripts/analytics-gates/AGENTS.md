# scripts/analytics-gates/

CI maintenance gate scripts for the analytics data platform. Each gate is a standalone Node module that exits non-zero with a clear message when the repository violates a documented invariant.

## Files

- `lib/runner.mjs` — Shared helpers for running pnpm commands, printing results, locating the repo root, and ensuring compiled `dist/` artifacts are present.
- `lib/packages.mjs` — Reads workspace `package.json` files and builds a dependency graph for cycle detection.
- `lib/sqlite.mjs` — Opens an in-memory SQLite database using `node:sqlite` and applies the fresh schema DDL from `packages/db-core/dist/schema.js` for query-plan gates.
- `check-verify-scripts.mjs` — Verifies every workspace package has a `verify` npm script.
- `gate-01-metric-registry-reference.mjs` — Confirms metric registry matches a generated reference.
- `gate-02-metadata-completeness.mjs` — Confirms metric release matrix and required metadata are complete.
- `gate-03-id-version-uniqueness.mjs` — Confirms metric IDs and versions are unique and versioned on meaning changes.
- `gate-04-manifest-contract-tests.mjs` — Confirms manifest stores and manual ingestion enforce coverage and finality contracts.
- `gate-05-migration-append-only-checksum.mjs` — Confirms migrations are checksummed, append-only, and transactional.
- `gate-06-fresh-upgraded-schema-parity.mjs` — Confirms a fresh schema equals a sequentially upgraded schema.
- `gate-07-acyclic-dependencies.mjs` — Confirms the pnpm workspace dependency graph is acyclic.
- `gate-08-transformer-conformance.mjs` — Confirms the shared transformer conformance suite passes.
- `gate-09-comparability-group-prevention.mjs` — Confirms mixed comparability groups are prevented.
- `gate-10-rollup-reconciliation.mjs` — Confirms rollup counts reconcile with contributions.
- `gate-11-policy-versioning.mjs` — Confirms statistical, attribution, and rollup policies are versioned and complete.
- `gate-12-index-usage.mjs` — Confirms required dashboard/evidence queries use expected indexes (`EXPLAIN QUERY PLAN`).
- `gate-13-dto-purity.mjs` — Confirms `packages/db/src/dto.ts` does not import runtime or SQLite types.
- `gate-14-documentation-index.mjs` — Confirms ADRs, packages, skills, rules, and the new scripts are referenced from index docs; also confirms `docs/superpowers/plans/2026-08-27-e2e-coverage-enhancement.md` (the E2E coverage catalog) exists, has a §6 section, references every `packages/site/tests/e2e/*.spec.ts` file, and has a catalog row for every UX-###/PIPE-###/SYNC-### ID cited in specs.
- `gate-15-schema-drift-guard.mjs` — Confirms an archived fixture ingests on the current schema and fails explicitly when a bumped migration renames a column the fixture still expects.
- `run-all-gates.mjs` — Runs all 15 gates (plus the verify-script preflight) and reports a combined result.

## Key relationships

- Gate scripts depend on the built `dist/` output of `packages/db-core`, `packages/db`, and `packages/transformer` (runner `ensureDist()` will build them if missing).
- The GitHub Actions workflow `.github/workflows/analytics-gates.yml` invokes `pnpm run analytics-gates`, which calls `run-all-gates.mjs`.
