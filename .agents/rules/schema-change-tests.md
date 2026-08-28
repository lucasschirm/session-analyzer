---
globs: "packages/db-core/**"
---

# Schema Changes Include Migration / Fresh-Schema / Query-Plan Tests

**When to use this rule:**

- When adding or modifying any database schema: tables, columns, indexes, constraints, or migrations under `packages/db-core`.

**Invariants (non-negotiable):**

- Every schema change ships with three test classes:
  1. **Migration tests** — the migration transforms a prior schema version to the new one correctly and is append-only/checksummed.
  2. **Fresh-schema tests** — the fresh schema built from scratch equals the schema produced by sequentially applying all migrations.
  3. **Query-plan tests** — required dashboard queries use the expected indexes and do not degrade (no full scans on hot paths).
- A schema change missing any of these three test classes must not merge.
- Migration history is append-only; editing or reordering existing migrations is forbidden.
- Index additions/removals are schema changes and require the same three test classes.
