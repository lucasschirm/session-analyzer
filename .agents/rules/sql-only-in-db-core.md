---
globs: "packages/transformer/**,packages/db/**,packages/site/**,packages/parsers/**,packages/plugins/**"
---

# SQL Exists Only in db-core Migrations/Stores

**When to use this rule:**

- When adding or editing code in any package other than `packages/db-core`.

**Invariants (non-negotiable):**

- SQL statements (raw SQL strings, query builders emitting SQL, DDL) may appear only inside `packages/db-core` migrations and stores.
- `packages/transformer`, `packages/db`, `packages/site`, `packages/parsers`, and `packages/plugins` must not contain SQL.
- `packages/db` consumes `db-core` stores via typed repository/query methods; it never writes SQL.
- `packages/site` consumes the `AnalyticsDataSource` read contract; it never touches SQL or the database runtime.
- If a new query is needed, add a store method in `db-core` and expose it through the appropriate facade — do not inline SQL elsewhere.
