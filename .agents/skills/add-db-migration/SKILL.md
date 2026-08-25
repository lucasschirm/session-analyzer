---
name: add-db-migration
description: Use when adding or modifying a database schema migration in the analytics platform. Covers forward migration, fresh-schema parity, store/index updates, query plan verification, rollup rebuild hooks, and upgrade fixtures.
---

# Add DB Migration

## Overview

This skill codifies the repeatable procedure for adding a forward-only schema
migration to `@lucasschirm/sal-db-core`. Migrations are append-only,
checksummed, and must produce a schema identical to the fresh schema. Every
schema change includes migration tests, fresh-schema parity tests, updated
stores/indexes, query-plan assertions, and rollup rebuild hooks where
applicable.

**Core invariants:**
- Migration history is append-only and checksummed.
- Fresh schema equals sequentially upgraded schema.
- SQL exists only in `db-core` migrations/stores.
- Schema migration failure never exposes a partially migrated database.
- Every schema change includes migration/fresh-schema/query-plan tests.

## Plan references

- §8 Logical data model (all subsections — schema tables)
- §4.2 SQLite executor adapters
- §4.3 Fresh analytics database and split storage topology
- §10.3 Atomic generation replacement (generation-scoped schema)
- §10.4 Reprocessing (rebuild frontiers)
- §15.1 db-core acceptance criteria
- §16.3 Rules — SQL exists only in db-core; schema changes include
  migration/fresh-schema/query-plan tests
- §16.5 CI maintenance gates — migration history is append-only and
  checksummed; fresh schema equals sequentially upgraded schema

## Package paths

| Concern | Path |
|---|---|
| Schema definition | `packages/db-core/src/schema.ts` |
| Migration runner | `packages/db-core/src/migrations.ts` |
| Generation control | `packages/db-core/src/generations.ts` |
| Identity stores | `packages/db-core/src/identity.ts` |
| Manifest stores | `packages/db-core/src/manifest.ts` |
| Session evidence stores | `packages/db-core/src/session-evidence.ts` |
| Metric stores | `packages/db-core/src/metrics.ts` |
| Component ecosystem stores | `packages/db-core/src/component-ecosystem.ts` |
| SQLite contract | `packages/db-core/src/contract.ts` |
| Conformance tests | `packages/db-core/tests/` |
| Schema docs | `docs/architecture/schema/` |

## Procedure

### Step 1 — Identify the schema change

Determine which logical table(s) from §8 are affected:

| Section | Tables |
|---|---|
| §8.1 | `schema_metadata`, `schema_migrations`, `analysis_releases`, `transformation_generations`, `ingestion_issues` |
| §8.2 | `tenants`, `portfolios`, `ingestion_sources`, `environments`, `projects`, `source_projects`, `project_mappings`, `repositories`, `workspaces` |
| §8.3 | `source_manifests`, `manifest_coverage`, `manifest_artifacts`, `artifact_blobs`, `artifact_references`, `source_locations`, `retention_policies`, `source_tombstones` |
| §8.4 | `component_identities`, `component_aliases`, `component_versions`, `component_relationships`, `component_installations`, `configuration_snapshots`, `snapshot_completeness`, `snapshot_components`, `component_lifecycle_events`, `component_availability_events`, `component_context_events`, `session_component_exposures` |
| §8.5 | `sessions`, `session_relations`, `turns`, `messages`, `model_requests`, `model_usage`, `model_capabilities`, `pricing_versions`, `invocations`, `payloads`, `invocation_payloads`, `permission_events`, `mode_events`, `hook_executions`, `normalized_events`, `tasks`, `task_events`, `validations`, `file_operations`, `command_executions`, `component_evidence_links` |
| §8.6 | `metric_definitions`, `transformer_metric_capabilities`, `metric_values`, `metric_distributions`, `metric_provenance`, `statistical_policies`, `attribution_policies`, `native_metric_values`, `heuristic_metric_values` |
| §8.7 | `session_summaries`, `session_component_stats`, `session_chart_series`, `rollup_contributions`, `project_daily_rollups`, `portfolio_daily_rollups`, `project_dimension_rollups`, `portfolio_dimension_rollups`, `project_distributions`, `portfolio_distributions`, `component_rollups`, `comparison_cohorts`, `comparison_cohort_members`, `insight_evidence` |

### Step 2 — Write the forward migration

Migrations are forward-only and append-only. Add a new migration file with an
incrementing version number.

**Migration file template
(`packages/db-core/src/migrations/v<NNN>_<description>.ts`):**

```ts
import type { SqliteExecutor } from '../contract';

export const migration_v<NNN> = {
  version: <NNN>,
  description: '<one-line description>',
  checksum: '<sha256 of the SQL body, computed at build time>',

  async up(executor: SqliteExecutor): Promise<void> {
    // Forward-only DDL. Use parameterized queries for any DML.
    // NEVER include destructive DROP TABLE unless the table is truly
    // obsolete and no data needs to be preserved.
    await executor.exec(`
      ALTER TABLE <table> ADD COLUMN <column> <type> <constraints>;
      -- or CREATE TABLE, CREATE INDEX, etc.
    `);

    // If data migration is needed:
    await executor.exec(`
      UPDATE <table> SET <column> = <value> WHERE <condition>;
    `);
  },
};
```

**Register the migration in the migration runner:**

```ts
// packages/db-core/src/migrations.ts
import { migration_v<NNN> } from './migrations/v<NNN>_<description>';

const MIGRATIONS = [
  // ...existing migrations...
  migration_v<NNN>,
];

// The runner applies migrations in version order, records checksums in
// schema_migrations, and rolls back on failure.
```

### Step 3 — Update the fresh schema

The fresh schema must produce the same result as sequentially applying all
migrations. Update the fresh schema definition:

```ts
// packages/db-core/src/schema.ts
export function createFreshSchema(executor: SqliteExecutor): Promise<void> {
  // Add or modify the CREATE TABLE / CREATE INDEX statements to match
  // the end state of all migrations including v<NNN>.
}
```

**Command to verify fresh-schema parity:**

```bash
cd packages/db-core && pnpm vitest run -- -t "fresh.*schema.*parity"
```

This test creates a fresh schema and a sequentially-upgraded schema, then
compares their `sqlite_master` output. They must be identical.

### Step 4 — Update stores and repositories

Update the typed store(s) that interact with the changed table(s):

```ts
// packages/db-core/src/<domain>.ts
export class <Table>Store {
  // Update insert/update/select queries to include new columns.
  // All SQL must be parameterized.

  async insert(executor: SqliteExecutor, row: <Table>Row): Promise<void> {
    await executor.run(
      `INSERT INTO <table> (<columns>) VALUES (${placeholders})`,
      ...values,
    );
  }

  async selectByX(executor: SqliteExecutor, x: string): Promise<<Table>Row | undefined> {
    return executor.get(`SELECT <columns> FROM <table> WHERE x = ?`, x);
  }
}
```

**Command to test store round trips:**

```bash
cd packages/db-core && pnpm vitest run -- -t "<table>.*store"
```

### Step 5 — Add or update indexes

Add indexes for any new query patterns. Document each index in
`docs/architecture/schema/`.

```ts
// In the migration and in the fresh schema:
await executor.exec(`
  CREATE INDEX IF NOT EXISTS idx_<table>_<column>
    ON <table>(<column>, <existing_indexed_column>);
`);
```

**Index decision rules:**
- Add an index for every frequently-filtered or joined column.
- Composite indexes should follow the query's column order.
- Verify the index is used by the query planner (Step 6).

### Step 6 — Verify query plans

Add query-plan assertions on benchmark fixtures to ensure indexes are used
and no full-table scans occur on large tables.

```ts
// packages/db-core/tests/<table>-query-plans.test.ts
describe('<table> query plans', () => {
  it('selectByX uses idx_<table>_<column>', async () => {
    const executor = await createBenchmarkFixture();
    const plan = await executor.all(`EXPLAIN QUERY PLAN SELECT ... WHERE x = ?`, 'value');
    expect(plan.some(step => step.detail.includes('idx_<table>_<column>'))).toBe(true);
    expect(plan.some(step => step.detail.includes('SCAN'))).toBe(false);
  });
});
```

**Command:**

```bash
cd packages/db-core && pnpm vitest run -- -t "query.*plan"
```

### Step 7 — Add rollup rebuild hooks (if applicable)

If the migration affects rollup, distribution, cohort, or contribution
tables, add or update the rebuild frontier logic:

```ts
// packages/db/src/ingestion.ts or packages/db-core/src/generations.ts
// If the schema change affects how contributions are stored or aggregated:
// 1. Update the contribution apply/subtract logic.
// 2. Update the rebuild frontier computation.
// 3. Ensure late-arrival/deletion/reclassification frontiers still work.
// 4. Ensure distributions are rebuilt for affected buckets only.
```

**Command to test rollup rebuild:**

```bash
cd packages/db && pnpm vitest run -- -t "rebuild.*frontier"
cd packages/db-core && pnpm vitest run -- -t "rollup.*rebuild"
```

### Step 8 — Add upgrade fixtures

Create sequential upgrade fixtures that verify migration from each prior
version to the new version:

```ts
// packages/db-core/tests/migration-v<NNN>.test.ts
describe('migration v<NNN>', () => {
  it('upgrades from v<NNN-1> to v<NNN> correctly', async () => {
    const executor = await createExecutorWithSchema('v<NNN-1>');
    await migration_v<NNN>.up(executor);
    // Assert new columns exist, data is migrated, constraints hold.
    const columns = await executor.all(`PRAGMA table_info(<table>)`);
    expect(columns.find(c => c.name === '<new_column>')).toBeDefined();
  });

  it('fresh schema equals upgraded schema', async () => {
    const fresh = await createFreshSchema();
    const upgraded = await createUpgradedSchema('v<NNN>');
    const freshMaster = await fresh.all(`SELECT * FROM sqlite_master ORDER BY name`);
    const upgradedMaster = await upgraded.all(`SELECT * FROM sqlite_master ORDER BY name`);
    expect(upgradedMaster).toEqual(freshMaster);
  });

  it('rolls back on failure without partial migration', async () => {
    // Inject a failure mid-migration and assert schema_migrations does not
    // record v<NNN> and the database is unchanged.
  });

  it('checksum matches', async () => {
    const computed = await computeChecksum(migration_v<NNN>);
    expect(computed).toBe(migration_v<NNN>.checksum);
  });
});
```

**Command:**

```bash
cd packages/db-core && pnpm vitest run -- -t "migration.*v<NNN>"
```

### Step 9 — Update schema documentation

Update `docs/architecture/schema/` with:
- ER diagram changes;
- table dictionary entries for new columns/tables;
- index documentation;
- retention implications;
- migration notes.

### Step 10 — Run the full conformance suite

```bash
cd packages/db-core && pnpm verify
```

This runs:
- fresh schema, sequential upgrade fixtures, migration checksums, and failure
  rollback;
- foreign keys, constraints, cascade behavior, and all indexes;
- repository round trips and parameterized-query coverage;
- adapter conformance for transaction semantics and value binding;
- generation visibility and atomic replacement primitives;
- generation-scoped coexistence and one authoritative visibility switch;
- separate root-only/inclusive contribution add/subtract and rollup
  reconciliation;
- late-arrival/deletion/project-move rebuild frontiers;
- affected-distribution rebuilds and versioned cohort persistence;
- query-plan assertions on benchmark fixtures.

## Completion checklist

- [ ] Migration file created with version, description, and checksum.
- [ ] Migration registered in the migration runner.
- [ ] Fresh schema updated to match the end state of all migrations.
- [ ] Fresh-schema parity test passes.
- [ ] Stores updated with parameterized queries for new columns/tables.
- [ ] Store round-trip tests pass.
- [ ] Indexes added for new query patterns.
- [ ] Query-plan assertions pass (no full-table scans on large tables).
- [ ] Rollup rebuild hooks updated (if applicable).
- [ ] Rollup rebuild tests pass (if applicable).
- [ ] Upgrade fixtures created (upgrade from prior version, fresh=upgraded,
      rollback on failure, checksum match).
- [ ] Schema documentation updated in `docs/architecture/schema/`.
- [ ] `pnpm --filter @lucasschirm/sal-db-core verify` passes.
- [ ] CI maintenance gate: migration history is append-only and checksummed.
- [ ] CI maintenance gate: fresh schema equals sequentially upgraded schema.
