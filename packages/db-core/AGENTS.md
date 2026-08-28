# packages/db-core/

Runtime-independent SQLite persistence contracts, schema, migrations, stores,
and generation control for the Session Analyzer analytics platform.

Package name: `@lucasschirm/sal-db-core`

## Source layout

```
src/
├── index.ts                 # Public barrel export
├── contract.ts              # SqliteExecutor, SqliteTransaction, SqliteStatement, value/result types, PRAGMA/SQL-feature constants, adapter backend contract
├── schema.ts                # Schema control tables (schema_metadata, schema_migrations, analysis_releases, transformation_generations, ingestion_issues), MIGRATIONS aggregate, fresh-schema DDL
├── migrations.ts            # MigrationRunner — forward, checksummed, transactional migrations
├── generations.ts           # Generation control: begin/commit/fail primitives, generation-scoped table specs, status transitions
├── identity.ts              # Tenant/portfolio/source/environment/project/repository/workspace schema and stores, deterministic ID helpers
├── manifest.ts              # Source manifests, coverage, artifacts, blobs, references, source locations, retention policies, tombstones
├── component-ecosystem.ts   # Component identities, aliases, versions, relationships, installations, configuration snapshots, lifecycle/availability/context events, exposures
├── session-evidence.ts      # Sessions, turns, messages, model requests/usage, invocations, payloads, permissions, modes, hooks, tasks, validations, file ops, commands, evidence links
└── metrics.ts               # Metric definitions, capabilities, values, distributions, provenance, statistical/attribution policies, native/heuristic values
```

## Test layout

```
tests/
├── AGENTS.md                       # See tests/AGENTS.md
├── forbidden-imports.test.ts       # Asserts no runtime/DOM/Worker/Node imports in src/
├── conformance/
│   ├── AGENTS.md                   # See conformance/AGENTS.md
│   └── suite.ts                    # runAdapterConformanceSuite — shared adapter conformance
├── helpers/
│   ├── schema-snapshot.ts          # Schema snapshot comparison helper
│   └── sqlite-wasm-adapter.ts      # Reference WASM executor adapter for tests
└── unit/
    ├── contracts.test.ts           # Capability contract tests
    ├── schema-parity.test.ts       # Fresh schema == sequentially upgraded schema
    ├── migrations.test.ts          # Migration runner, checksums, rollback
    ├── generations.test.ts         # Generation begin/commit/fail, visibility
    ├── identity.test.ts            # Identity stores and deterministic IDs
    ├── manifest.test.ts            # Manifest and artifact stores
    ├── component-ecosystem.test.ts # Component ecosystem stores
    ├── session-evidence.test.ts    # Session evidence stores
    └── metrics.test.ts             # Metric registry and value stores
```

## Key invariants

- **Runtime-agnostic**: no imports of `@sqlite.org/sqlite-wasm`, `node:`, OPFS,
  DOM, Worker, Lit, or fetch. Enforced by `forbidden-imports.test.ts` and
  `tsconfig.json` (`"lib": ["ES2021"]`, `"types": []`).
- **Parameterized SQL only**: no value is ever interpolated into a query string.
- **Forward-only migrations**: checksummed, transactional, never partial.
- **Generation-scoped visibility**: `sessions.current_generation_id` is the
  single visibility switch; candidate and current rows coexist.
- **Deterministic IDs**: pure-JS FNV-1a 64-bit hash, no runtime crypto.

## Key relationships

- Imported by `packages/db` and by concrete runtime adapters
  (`packages/site/src/db/wasm-sqlite-executor.ts`).
- Imports nothing from `transformer`, `db`, `site`, or any parser.
- The conformance suite is shared with the site WASM adapter and future Node
  adapters.
