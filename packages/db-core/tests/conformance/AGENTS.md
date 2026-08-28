# conformance/

Shared adapter conformance suite. Runtime-agnostic test helper that asserts any `SqliteExecutor` satisfies the db-core contract.

## Files

- **suite.ts** — `runAdapterConformanceSuite` and `ConformanceSuiteOptions`; exercises transactions, savepoints, integers/BLOBs, prepared statements, PRAGMAs, cancellation, busy/lock, durability, and SQL feature support using the db-core schema and migrations.
