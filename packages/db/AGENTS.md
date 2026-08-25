# packages/db/

Application-facing analytics ingestion, aggregation, lifecycle, reprocessing,
and analytics data-source facade for the Session Analyzer platform.

Package name: `@lucasschirm/sal-db`

## Source layout

```
src/
├── index.ts              # Public barrel export
├── analytics.ts          # AnalyticsDataSource interface, queries, filters, and view result types
├── analytics-portfolio.ts # Portfolio analytics view implementation
├── analytics-session.ts  # Session, component, search, artifact, and metadata view implementation
├── artifact-diff.ts      # Artifact diffing, canonicalization, and behavioral field extraction
├── component-lifecycle.ts # Component ecosystem ingestion and lifecycle event handling
├── configuration.ts      # Configuration snapshot capture and environment/project binding
├── distributions.ts      # Distribution materialization, cohorts, and deterministic insights
├── dto.ts                # AnalyticsToken, MetricValueDto, EvidenceLink, Coverage, and helpers
├── ingestion.ts          # IngestionOrchestrator, IngestionReceipt, IngestionContext, AtomicGenerationCommit
├── manifest.ts           # VerifiedManifestBundle, ManualIngestionBundle, ManifestInput re-export
├── manual-ingestion.ts   # Manual artifact ingestion and validation
├── metric-registry.ts    # Metric registry, comparability groups, and statistical/attribution policy helpers
├── ports.ts              # ArtifactResolver, ContentHasher, ArtifactBlobStore, SourceLocation, ResolvedArtifact
├── rebuild-frontiers.ts  # Rebuild frontier computation, cost estimation, and maintenance jobs
├── reprocessing.ts       # Reprocessing triggers, interruption recovery, and generation replacement
└── rollup-reconciliation.ts # Rollup recomputation and count reconciliation
```

## Test layout

```
tests/
├── forbidden-imports.test.ts          # Asserts no site/Lit/WASM/Worker/HTTP imports in src/
└── unit/
    ├── analytics-session.test.ts      # Session, component, search, artifact, and metadata view tests
    ├── component-lifecycle.test.ts    # Component lifecycle event and identity tests
    ├── configuration.test.ts          # Configuration snapshot and binding tests
    ├── contracts.test.ts              # Ingestion and analytics contract tests
    ├── distributions.test.ts          # Distribution, cohort, and insight tests
    ├── dto.test.ts                    # DTO construction and validation tests
    ├── ingestion.test.ts              # Ingestion orchestrator tests
    ├── manual-ingestion.test.ts       # Manual ingestion tests
    ├── rebuild-frontiers.test.ts      # Rebuild frontier tests
    ├── reprocessing.test.ts           # Reprocessing and replacement tests
    └── rollup-reconciliation.test.ts  # Rollup and reconciliation tests
```

## Key invariants

- **No runtime dependencies**: does not import Lit, WASM, OPFS, Web Workers, or
  HTTP. Artifact acquisition is caller/runtime-owned through injected ports.
- **Transformation outside write transaction**: the complete batch is validated
  before persistence; atomic generation replacement is the single visibility
  switch.
- **Credential-free**: persisted source references never contain credentials,
  secrets, or signed URLs.
- **DTO-only for UI**: UI components consume only DTOs and the data-source
  client contract — never SQL types or metric formulas.

## Key relationships

- Depends on `@lucasschirm/sal-db-core` (persistence contracts, stores,
  generation control) and `@lucasschirm/sal-transformer` (transformer registry,
  write-batch types).
- Depends on `@lucasschirm/sal-sync-core` for narrow manifest contract types
  (`SyncManifest`).
- Imported by `packages/site` runtime (WASM/OPFS adapter, artifact-resolver/
  blob-store adapters, worker transport) and by site pages (AnalyticsDataSource
  DTO/client contracts only).
- Does not import the site, any SQLite runtime, or any parser.
