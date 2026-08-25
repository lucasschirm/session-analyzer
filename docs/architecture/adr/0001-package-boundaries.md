# ADR-0001: Package boundaries — db-core, transformer, db as separate packages

**Status:** Accepted

**Date:** 2026-08-24

**Plan reference:** `docs/superpowers/plans/2026-08-24-analytics-data-platform-design.md` §5 (Package boundaries)

## Context

The current site owns too many stages of the data lifecycle: sync saves
artifacts, the site loads files, the site parses native formats, the site
transforms parser output, the site writes SQLite, and the site scans detailed
session rows to calculate dashboard values. This couples parsing,
transformation, persistence, and presentation contracts to the browser
application.

The larger metric ontology in `SESSION_METRICS.md` makes read-time aggregation
of detailed rows unviable. There is no portfolio-level model for components
shared across projects and harnesses. Adding a parser, transformer, metric,
schema change, or analytics view has no stable extension workflow.

The platform needs reusable packages that can run with browser SQLite today and
a server or another SQLite runtime later. The dependency direction must be
enforced so that runtime-specific code cannot leak into shared contracts.

## Decision

Split the analytics platform into three separate packages with enforced
dependency direction:

- **`@lucasschirm/sal-db-core`** (`packages/db-core`) — SQLite-specific but
  runtime-agnostic persistence contracts, schema, migrations, stores,
  generation control, and rollup primitives. Imports nothing from transformer,
  db, site, or any parser. No runtime SQLite implementation.
- **`@lucasschirm/sal-transformer`** (`packages/transformer`) — Pure, deterministic
  transformation plugin framework, metric contracts, and the Claude Code
  transformer. Imports only its harness parser dependency. No SQLite, no remote
  storage, no project history.
- **`@lucasschirm/sal-db`** (`packages/db`) — Application-facing ingestion
  facade, atomic generation replacement, rollup reconciliation, and the stable
  `AnalyticsDataSource` read interface. Depends on db-core and transformer;
  manifest inputs use sync-core contract types. No Lit, WASM, OPFS, Workers, or
  HTTP.

The import-level dependency matrix is:

```text
transformer -> claude parser (Claude plugin only)
db -> transformer + db-core + narrow sync-core manifest contracts
site runtime -> db + db-core adapter contracts + sync/source adapters
site pages -> AnalyticsDataSource DTO/client contracts only
```

No parser imports a transformer; no db-core module imports db or a transformer;
no package imports the site. This is enforced by forbidden-import tests in each
package and by CI dependency-direction gates.

## Consequences

**Positive:**

- Runtime-specific code (WASM/OPFS, Node, future server) is isolated in
  adapters; shared contracts remain isomorphic.
- Transformer plugins are pure and deterministic, enabling conformance suites
  and golden fixtures independent of SQLite.
- The site can migrate to `AnalyticsDataSource` DTOs without importing SQL
  types or calculating metrics.
- Future harness plugins can be added without touching persistence or UI code.
- A future server process can reuse db-core, transformer, and db with different
  adapters.

**Negative:**

- Three packages require separate build/test/lint configurations and
  coordination overhead.
- The narrow sync-core manifest contract surface must be maintained as an
  explicit adapter boundary.
- Artifact acquisition is caller-owned, requiring runtime adapter
  implementations in each consumer.

**Neutral:**

- SQL dialect portability beyond SQLite is explicitly not a goal; db-core is
  SQLite-focused by design.

## Alternatives

**Single monolithic package.** Rejected because it cannot enforce dependency
direction — runtime-specific imports would leak into shared contracts, and the
browser application would remain coupled to all lifecycle stages.

**Two packages (shared core + site).** Rejected because transformation and
persistence have different dependency profiles: transformation is pure and
depends only on parsers, while persistence is SQLite-specific. Merging them
would force transformer plugins to transitively depend on SQLite contracts.

**ORM or storage-neutral abstraction.** Rejected because the shared core is
intentionally SQLite-focused. A generic ORM would add complexity without
benefit since SQLite is the only target runtime, and it would obscure
SQLite-specific optimizations (STRICT tables, PRAGMAs, generated columns).
