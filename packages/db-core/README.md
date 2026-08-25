# `@lucasschirm/sal-db-core`

Runtime-independent SQLite capability contracts and SQL primitives for the
Session Analyzer analytics platform.

## Purpose

`db-core` is **SQLite-specific but runtime-agnostic**. It defines the canonical
contracts that concrete SQLite adapters must implement (`SqliteExecutor`,
`SqliteTransaction`, `AdapterBackend`) and the SQL-capability invariants the
higher-level packages rely on.

This package contains only:

- TypeScript types and interfaces.
- Readonly SQL-primitive constants (e.g. required PRAGMAs, supported SQL
  features).
- Small, pure helper functions that operate on the contracts.

It does **not** contain a runtime SQLite implementation and does not import any
runtime-specific modules.

## Runtime-independence invariant

No `db-core` source file may import or reference:

- `@sqlite.org/sqlite-wasm`
- `node:` built-in modules
- `opfs`, `DOM`, `worker`, `lit`, `fetch`

The package has `"lib": ["ES2021"]` and `"types": []` so that the build cannot
accidentally depend on DOM, Web Worker, or Node global types. The forbidden-import
test in `tests/forbidden-imports.test.ts` guards this invariant.

## Dependency matrix

```text
transformer -> claude parser (Claude plugin only)
db          -> transformer + db-core + narrow sync-core manifest contracts
site runtime -> db + db-core adapter contracts + sync/source adapters
site pages  -> AnalyticsDataSource DTO/client contracts only
```

`db-core` is at the bottom of the persistence dependency graph:

- `db-core` is **imported by** `db` and by concrete runtime adapters (WASM,
  future Node, etc.).
- `db-core` **imports nothing** from `transformer`, `db`, `site`, or any parser.
- No parser, transformer, or `db` package may be imported by `db-core`.

This direction is enforced by the package structure and by the forbidden-import
test.

## Schema structure

The analytics schema (`sal-analytics`) is normalized around identity, evidence,
precomputed analytics, and provenance. DDL and stores are organized into domain
modules that each own their table creation, indexes, foreign keys, and a
migrations fragment:

| Module | Tables | Responsibility |
|--------|--------|----------------|
| `schema.ts` | `schema_metadata`, `schema_migrations`, `analysis_releases`, `transformation_generations`, `ingestion_issues` | Schema identity, migration bookkeeping, analysis releases, generation control, ingestion issues |
| `identity.ts` | `tenants`, `portfolios`, `ingestion_sources`, `environments`, `projects`, `source_projects`, `project_mappings`, `repositories`, `workspaces` | Tenant/source/environment/portfolio/project identity hierarchy |
| `manifest.ts` | `source_manifests`, `manifest_coverage`, `manifest_artifacts`, `artifact_blobs`, `artifact_references`, `source_locations`, `retention_policies`, `source_tombstones` | Manifest and artifact retention |
| `component-ecosystem.ts` | `component_identities`, `component_aliases`, `component_versions`, `component_relationships`, `component_installations`, `configuration_snapshots`, `snapshot_completeness`, `snapshot_components`, `component_lifecycle_events`, `component_availability_events`, `component_context_events`, `session_component_exposures` | Global component ecosystem |
| `session-evidence.ts` | `sessions`, `session_relations`, `turns`, `messages`, `model_requests`, `model_usage`, `model_capabilities`, `pricing_versions`, `invocations`, `payloads`, `invocation_payloads`, `permission_events`, `mode_events`, `hook_executions`, `normalized_events`, `tasks`, `task_events`, `validations`, `file_operations`, `command_executions`, `component_evidence_links` | Session evidence spine |
| `metrics.ts` | `metric_definitions`, `transformer_metric_capabilities`, `metric_values`, `metric_distributions`, `metric_provenance`, `statistical_policies`, `attribution_policies`, `native_metric_values`, `heuristic_metric_values` | Metric registry and values |

All tables use `STRICT` typing. Every replaceable evidence, summary,
provenance, contribution, chart, lifecycle, and cohort row carries
`generation_id` or an owning generation-scoped foreign key. Candidate and
current rows use composite uniqueness so they can coexist during atomic
replacement. `sessions.current_generation_id` is the single visibility authority.

## Migration system

Migrations are forward-only, append-only, and checksummed. Each migration is
a `Migration` record with `id`, `name`, `sql`, and an FNV-1a 64-bit `checksum`.

`MigrationRunner` (`src/migrations.ts`):

1. Initializes `schema_metadata` and `schema_migrations` control tables.
2. Runs pending migrations in order, each in its own transaction.
3. Verifies already-applied migrations against stored checksums — a mismatch
   or missing migration throws and leaves the database at the last successful
   migration.
4. Never exposes a partially migrated database.

The `MIGRATIONS` constant aggregates fragments from every domain module. CI
gates verify that fresh schema equals sequentially upgraded schema
(`tests/unit/schema-parity.test.ts`).

## Stores

Each domain module exposes typed store functions that operate on a
`SqliteExecutor` or `SqliteTransaction` (`Queryable`). Stores use parameterized
SQL exclusively — no value is ever interpolated into a query string. Stores
cover:

- **Identity stores** — portfolio/project/environment/repository/workspace CRUD,
  project mapping audit, deterministic ID generation.
- **Manifest stores** — manifest/coverage/artifact persistence, blob retention,
  source locations, tombstones, retention policies.
- **Component ecosystem stores** — component identity/version/installation CRUD,
  configuration snapshots, lifecycle/availability/context events, session
  exposures.
- **Session evidence stores** — sessions, turns, messages, model
  requests/usage, invocations, payloads, permissions, modes, hooks, tasks,
  validations, file operations, commands, normalized events, evidence links.
- **Metrics stores** — metric definitions, capabilities, values, distributions,
  provenance, statistical/attribution policies, native and heuristic values.
- **Rollup stores** — session summaries, component stats, chart series, rollup
  contributions, project/portfolio daily and dimension rollups, distributions,
  component rollups, comparison cohorts, insight evidence.

Deterministic IDs use a pure-JS FNV-1a 64-bit hash (`deterministicId`) so that
replayed ingestion produces identical keys without depending on a runtime
crypto implementation.

## Generation control

`src/generations.ts` implements atomic generation replacement:

- Generations start in `pending` status and become visible only after an
  explicit commit switches `sessions.current_generation_id`.
- Status transitions: `pending` → `committed` | `failed` | `superseded`.
- Candidate generation-scoped rows coexist with current rows via composite
  uniqueness constraints.
- `beginGeneration`, `commitGeneration`, and `failGeneration` primitives are
  transactional — rollback leaves the previous generation unchanged.
- Each generation records parser, transformer, ontology, metric, schema,
  statistical, and rollup versions, plus source availability
  (`local`, `remote_reacquirable`, `unavailable`).

Only rows reachable from committed current generations and the selected
compatible analysis release are visible to ordinary readers.

## Forbidden-import guard

`tests/forbidden-imports.test.ts` asserts that no `db-core` source file imports:

- `@sqlite.org/sqlite-wasm`
- `node:` built-in modules
- `opfs`, `DOM`, `worker`, `lit`, `fetch`

The `tsconfig.json` sets `"lib": ["ES2021"]` and `"types": []` so the build
cannot accidentally depend on DOM, Web Worker, or Node global types. This guard
ensures the package remains isomorphic and runtime-agnostic.

## Adapter conformance

`tests/conformance/suite.ts` exports `runAdapterConformanceSuite`, a
runtime-agnostic test helper that asserts any `SqliteExecutor` satisfies the
db-core contract: transaction semantics, savepoints, integer/`bigint` fidelity,
BLOB binding, prepared statements, result shapes, required PRAGMAs,
cancellation, busy/lock behavior, durability reporting, and supported SQL
features. The WASM adapter in `packages/site` runs this suite; a future Node
adapter will run the same suite.

## Public API

The package exports the following from `src/index.ts`:

- **Contract types**: `SqliteValue`, `SqliteRow`, `SqliteExecResult`,
  `SqliteStatement`, `SqliteTransaction`, `SqliteExecutor`, `AdapterBackend`,
  `AdapterCapabilities`, `SqliteSqlCapabilities`, `SqliteCancellationToken`,
  `SqliteExecutionOptions`.
- **Constants**: `ANALYTICS_SCHEMA_NAME`, `REQUIRED_PRAGMAS`,
  `SUPPORTED_SQL_FEATURES`, `MIGRATIONS`.
- **Pure helpers**: `isBackendPersistent`, `isSupportedSqlFeature`,
  `getRequiredPragma`, `deterministicId` and domain-specific deterministic ID
  functions.
- **Migration runner**: `MigrationRunner`, `Migration`, `MigrationRecord`.
- **Generation control**: `beginGeneration`, `commitGeneration`,
  `failGeneration`, `GenerationStatus`, `SourceAvailability`.
- **Stores**: typed store functions for identity, manifest, component ecosystem,
  session evidence, metrics, and rollups.

The first concrete adapter is implemented elsewhere (WASM/OPFS in the `site`
package, planned Node adapter in a future package).
