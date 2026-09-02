---
globs: "packages/transformers/**,packages/db/**,packages/site/**,packages/parsers/**,packages/plugins/**"
---

# SQL Exists Only in db-core Migrations/Stores

**When to use this rule:**

- When adding or editing code in any package other than `packages/db-core`.

**Invariants (non-negotiable):**

- SQL statements (raw SQL strings, query builders emitting SQL, DDL) may appear only inside `packages/db-core` migrations and stores.
- `packages/transformers` (e.g. `transformer-shared`, `claude-transformer`), `packages/db`, `packages/site`, `packages/parsers`, and `packages/plugins` must not contain SQL.
- `packages/db` consumes `db-core` stores via typed repository/query methods; it never writes SQL.
- `packages/site` consumes the `AnalyticsDataSource` read contract; it never touches SQL or the database runtime.
- If a new query is needed, add a store method in `db-core` and expose it through the appropriate facade — do not inline SQL elsewhere.

**Carve-out: read-only SQL against third-party harness application databases in `packages/plugins/`**

- `packages/plugins/` may contain SQL only to read a third-party harness's own
  application database (e.g. Devin CLI's `sessions.db`) inside a sync
  plugin's extractor module (e.g.
  `packages/plugins/devin-session-sync/src/extractor/`).
- This carve-out is read-only extraction only: the SQL issued must never
  write, migrate, or otherwise mutate the third-party database, and it must
  never target this product's own SQLite (`db-core`'s database) — that
  remains exclusively `db-core`'s responsibility.
- The rule's intent is unchanged: all *product* persistence SQL lives in
  `packages/db-core` migrations and stores. This carve-out covers extraction
  of external data sources only, so a sync plugin can read a harness's
  native session store without db-core standing in as a driver for a
  database it does not own.
- Everywhere else in `packages/plugins/` (hooks, CLI, manifest generation,
  and any code outside an extractor module reading a third-party harness
  database), SQL remains forbidden, same as `packages/transformers`,
  `packages/db`, `packages/site`, and `packages/parsers`.
