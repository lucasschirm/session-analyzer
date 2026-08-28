# `@lucasschirm/sal-db`

Application-facing analytics ingestion, aggregation, lifecycle, reprocessing,
and analytics data-source facade for the Session Analyzer platform.

## Purpose

`db` joins transformers to `db-core`. It owns ingestion orchestration, atomic
generation replacement, rollup reconciliation, configuration lifecycle, the
stable `AnalyticsDataSource` read interface, and browser/server-neutral DTOs.
It depends on `db-core` and `transformer`; manifest inputs use `sync-core`
contract types through a narrow adapter.

The package does not depend on Lit, WASM, OPFS, Web Workers, or HTTP. Artifact
acquisition is caller/runtime-owned: `db` receives injected `ArtifactResolver`,
`ContentHasher`, and optional `ArtifactBlobStore` ports, or a fully materialized
verified bundle. Persisted source references never contain credentials.

## Dependency matrix

```text
transformer -> claude parser (Claude plugin only)
db          -> transformer + db-core + narrow sync-core manifest contracts
site runtime -> db + db-core adapter contracts + sync/source adapters
site pages  -> AnalyticsDataSource DTO/client contracts only
```

`db` imports `db-core`, `transformer`, and `sync-core` manifest contract types
only. It does not import the site, any SQLite runtime, or any parser. This is
enforced by `tests/forbidden-imports.test.ts`.

## Ingestion facade

`src/ingestion.ts` defines the `IngestionOrchestrator` interface and supporting
contracts:

- **`ingestManifest(bundle)`** — Accepts an already-resolved, integrity-verified
  manifest bundle plus source/environment identity. Selects a transformer from
  the manifest harness, classifies artifacts, normalizes evidence, derives
  metrics, validates capabilities/provenance/anti-double-counting, compares
  configuration snapshots, and persists a replacement generation atomically.
  Returns an `IngestionReceipt` with generation ID, status, and issue IDs.
- **`ingestManual(bundle)`** — Ingests a manually supplied artifact bundle.
  Manual sessions do not fabricate configuration completeness or lifecycle
  events; supplied artifacts may be classified but omitted artifacts remain
  unknown.

Transformation occurs outside the write transaction. The complete batch is
validated before persistence. `AtomicGenerationCommit` describes the candidate
replacement: generation ID, previous generation ID, candidate records, affected
project IDs, and analysis release ID.

`src/manifest.ts` defines `VerifiedManifestBundle` and `ManualIngestionBundle`
input types. `ManifestInput` is a re-export of `SyncManifest` from `sync-core`.

## Ports

`src/ports.ts` defines runtime-injected ports:

- **`ArtifactResolver`** — Resolves an `ArtifactReference` to verified content.
  Implementations are runtime-owned (site uses a sync cache adapter; future
  servers use their own storage adapter).
- **`ContentHasher`** — Content-addressable hashing to verify artifact integrity
  before transformation.
- **`ArtifactBlobStore`** — Optional local blob store for retained artifacts.
  Analytics never stores credentials with retained source references.
- **`SourceLocation`** — Credential-free reacquisition metadata. The opaque
  reacquisition key is provided by the caller runtime.

## AnalyticsDataSource interface

`src/analytics.ts` defines the stable `AnalyticsDataSource` read contract
grouped by view:

- **Portfolio** — overview, trends, component utilization, model/harness
  cohorts, project list.
- **Project Behavior** — summary, session trend series, configuration timeline,
  outliers, comparisons.
- **Session Evidence** — summary, context/timing series, root-child breakdown,
  component facts, validation, evidence pages.
- **Component Ecosystem** — summary, versions, scopes, utilization,
  distributions, projects/sessions, lifecycle comparisons.
- **Artifact Diff** — version metadata and safe unified/side-by-side diff.

All methods accept an `AnalyticsQuery` with optional analysis release,
generation token, comparability group, time range, filters, cursor, and limit.
Results are `CursorPage<T>` with generation and analysis-release tokens for
snapshot-consistent pagination. DTOs carry coverage, measurement class,
confidence, metric version, and evidence links.

## DTOs

`src/dto.ts` defines browser/server-neutral DTOs:

- **`AnalyticsToken`** — analysis release, generation, comparability group,
  eligible `N`, known `n`, unknown count, coverage, measurement class,
  confidence, metric version, evidence links.
- **`MetricValueDto`** — metric ID, value, unit, label, exact flag, plus token.
- **`EvidenceLink`** — evidence ID, entity type, entity ID, label.
- **Constants**: `ANALYTICS_DTO_VERSION`, `DEFAULT_ANALYTICS_LIMIT`.
- **Helpers**: `emptyEvidenceLinks`, `isValidComparabilityGroupId`,
  `makeMetricValueDto`.

UI components never import SQL types or calculate canonical metrics. They
consume only these DTOs and the data-source client contract.

## Public API

The package exports from `src/index.ts`:

- **Ingestion**: `IngestionOrchestrator`, `IngestionReceipt`, `IngestionIssue`,
  `IngestionContext`, `AtomicGenerationCommit`.
- **Manifest types**: `VerifiedManifestBundle`, `ManualIngestionBundle`,
  `ManifestInput`, `Artifact`.
- **Ports**: `ArtifactResolver`, `ContentHasher`, `ArtifactBlobStore`,
  `SourceLocation`, `ArtifactReference`, `ResolvedArtifact`.
- **Analytics**: `AnalyticsDataSource`, `AnalyticsQuery`, `Filter`,
  `TimeRange`, `CursorPage`, view-specific result interfaces.
- **DTOs**: `AnalyticsToken`, `MetricValueDto`, `EvidenceLink`, `Coverage`,
  `MeasurementClass`, `Confidence`, constants and helpers.
