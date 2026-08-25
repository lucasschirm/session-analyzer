# Analytics Data Platform Design

**Date:** 2026-08-24
**Status:** Design approved; written specification awaiting user review
**Scope:** `packages/db-core`, `packages/transformer`, `packages/db`, `packages/site`, analytics schema, dashboard experience, and repository maintenance guidance

## 1. Problem

The current site owns too many stages of the data lifecycle:

```text
sync saves artifacts
  -> site loads files
  -> parser translates native formats
  -> site transforms parser output
  -> site writes SQLite
  -> site scans detailed session rows to calculate dashboard values
```

This creates four related problems:

1. Parsing, transformation, persistence, and presentation contracts are coupled to the browser application.
2. Session and project metrics depend on repeated read-time aggregation of detailed rows. The larger metric ontology in `docs/superpowers/SESSION_METRICS.md` makes that approach unviable.
3. There is no portfolio-level model for Rules, Skills, Agents, MCP servers, Tools, settings, or plugins shared across projects and harnesses.
4. Adding a parser, transformer, metric, schema change, or analytics view has no stable extension workflow or agentic-development guidance.

The platform needs reusable packages that can run with browser SQLite today and a server or another SQLite runtime later. Opening a session must not scan its transcript or derive metrics. Project and portfolio dashboards must use precomputed facts and bounded indexed series.

## 2. Goals

- Create `@lucasschirm/sal-db-core`, an isomorphic SQLite persistence layer containing schema creation, migrations, stores, transactions, indexes, and query implementations.
- Create `@lucasschirm/sal-transformer`, a pure pluggable transformation framework with a Claude Code implementation first.
- Create `@lucasschirm/sal-db`, an application-facing ingestion, aggregation, lifecycle, reprocessing, and analytics data-source facade joining transformers to `db-core`.
- Make SQLite runtime-specific behavior injectable so browser WASM/OPFS, Node SQLite, and future server processes share schema and stores.
- Normalize evidence at useful grains while precomputing session facts, distributions, project rollups, portfolio rollups, cohorts, and chart series.
- Model a portfolio-wide component ecosystem above projects while retaining evidence down to project, session, Sub Agent, turn, message, invocation, payload, and outcome.
- Use session manifests as the authority for synced artifact ownership, paths, hashes, scopes, and observing sessions.
- Support complete, partial, and unavailable evidence without converting missing values to zero.
- Deliver the Phase 1 through Phase 3 metrics in `SESSION_METRICS.md`; keep Phase 4 semantic analysis separate and optional.
- Migrate the site to a stable `AnalyticsDataSource` contract and deliver Portfolio, Project Behavior, Session Evidence, Component Ecosystem, and artifact-version diff views.
- Establish repeatable skills, agents, rules, conformance suites, and architecture documentation for long-term maintenance.

## 3. Non-goals

- Supporting non-Claude harness transformers in the initial implementation. Their extension contract and conformance suite are required, but Claude Code is the first plugin.
- Implementing Phase 4 semantic or causal analysis as part of the initial release.
- Pretending unlike or unavailable native signals are directly comparable.
- Providing a storage-neutral ORM abstraction. The shared core is intentionally SQLite-focused.
- Backfilling the new analytics schema from the current browser database.
- Making causal claims from before/after component cohorts.
- Storing credentials, secrets, sensitive URL parameters, or private setting values as analytics dimensions or artifact text.

## 4. Architectural decisions

### 4.1 Typed evidence and incremental rollups

The platform stores normalized typed evidence, precomputed session summaries, and incrementally maintained project/portfolio analytics. It does not use a generic EAV ledger as the only fact store and does not persist UI-shaped dashboard JSON as the canonical model.

Typed evidence preserves relationships, constraints, provenance, and efficient indexes. A versioned metric registry handles scalar extensibility. Summary and rollup tables make reads bounded without discarding drill-down evidence.

### 4.2 SQLite executor adapters

`db-core` is SQLite-specific but runtime-independent. It receives an executor/transaction adapter and never imports `@sqlite.org/sqlite-wasm`, OPFS, DOM, Web Worker, Node filesystem, or a server framework.

The first adapter uses SQLite WASM in the site's database worker. A future Node adapter and server process implement the same contract. SQL dialect portability beyond SQLite is not a goal.

### 4.3 Fresh analytics database and split storage topology

The new analytics schema opens under a new database filename and schema identity. Existing analytical rows are not backfilled or interpreted as new metrics. Users re-sync or re-import sessions. This avoids invented provenance and false zeros.

The current site database also owns connection metadata, encrypted credentials, passkey state, and sync state. Those records cannot disappear when analytics resets. Before the analytics cutover, the implementation must split storage ownership:

- a **site control database** retains connection metadata, encrypted credentials, passkey/vault state, source checkpoints, and UI preferences under the existing runtime security boundary;
- the **analytics database** is owned through `db-core` and contains projects, source mappings, artifacts, normalized evidence, metrics, and rollups;
- the site coordinates the two through explicit IDs and ports, never a cross-database transaction;
- source discovery/checkpoint progress commits in the control database only after analytics ingestion returns an idempotent committed-generation receipt;
- the old database remains read-only/exportable during a bounded rollback window, using a separate worker/connection so its OPFS lock cannot be confused with the new database;
- activation is one-way for the new analytics database, but the UI can roll back to the old read-only application mode until the legacy-removal milestone.

The rollout must disclose the reset, source-retention implications, and re-sync/re-import path before activation. A later analytical importer can be designed independently but is not part of this effort.

### 4.4 Phase 1 through Phase 3 scope

The release covers exact core metrics, deterministic optimization metrics, and improved attribution from Sections 14.1 through 14.3 of `SESSION_METRICS.md`. Semantic correction, routing quality, task inference, and causal estimates remain a separately versioned analysis layer.

### 4.5 Portfolio is the top analytical scope

Components are portfolio-level identities first. Projects and sessions reference scoped installations and versions; they do not own duplicate component identities. Portfolio analysis can therefore answer how a component is configured, offered, injected, invoked, and associated with outcomes across every project and supported harness.

A portfolio is not the same as a machine/user harness environment or a future authenticated tenant. The hierarchy is:

```text
tenant / local portfolio
  -> ingestion source
    -> user or harness environment
      -> canonical project
        -> repository/workspace
          -> session
```

An **environment** identifies the source namespace, user/device profile, harness home/configuration root, and integration installation. Global configuration is global to an environment, not automatically to every user in a future tenant. Component identities may be portfolio-canonical, while installations, global snapshots, lifecycle events, and exposure remain environment-scoped. One global update creates one environment lifecycle event and project/session exposure intervals; it is not duplicated as an independent change per project.

### 4.6 Manifests are artifact authority, not automatic completeness proof

For synced sessions, `SyncManifest` supplies source-native project/session identity, harness, artifact scope, relative path, hash, size, and status. Classification derives from manifest context and harness-specific path rules. CAS object placement is a transport concern resolved through `sync-core`; it is not semantic ownership.

The current manifest v2 does **not** prove an exhaustive configuration snapshot and therefore cannot prove removal. A new manifest revision is a prerequisite for lifecycle-removal and offered-versus-unused metrics. It must add source/environment namespace, finality, deterministic sequence and capture times, workspace/repository/scope-chain identity, collector and sanitization-policy versions, expected category coverage, per-category discovery completeness, artifact role/media/encoding, collection outcome/reason, and authoritative tombstones when supported. Older manifests remain authoritative for the artifacts they list but produce partial configuration snapshots.

The manifest is authoritative for ownership, source identity, hash, status, and collector coverage. The versioned harness artifact classifier is authoritative for semantic kind. Neither may infer absent configuration from an incomplete inventory.

### 4.7 Manual imports do not fabricate configuration

A transcript-only or partial manual upload stores only supplied evidence. It does not create a synthetic complete manifest, infer absent components, establish offered-component denominators, or emit lifecycle removals. Explicitly supplied artifacts may be classified, but the snapshot remains partial.

## 5. Package boundaries

### 5.1 `@lucasschirm/sal-db-core`

`packages/db-core` owns:

- canonical persisted entity and query types;
- schema versioning and forward migrations;
- table creation, constraints, indexes, and foreign keys;
- SQLite executor and transaction contracts;
- typed stores/repositories and parameterized SQL;
- generation visibility and transactional replacement primitives;
- rollup contribution, aggregate, distribution, cohort, and chart-series stores;
- query APIs used by the higher-level `db` facade;
- adapter conformance tests shared by WASM and future Node adapters.

It depends on no parser or transformer. It exposes persistence contracts rather than site page models.

### 5.2 `@lucasschirm/sal-transformer`

`packages/transformer` owns:

- the harness transformer plugin interface and registry;
- artifact bundle, capability, provenance, issue, and normalized-write-batch contracts;
- canonical normalization helpers and metric computation primitives;
- harness-specific artifact classifiers;
- the Claude Code parser-output transformer;
- Phase 1–3 deterministic metric derivation;
- plugin and metric conformance suites;
- golden normalized-output fixtures.

It is pure and deterministic. It does not open SQLite, query project history, access remote storage, or emit project lifecycle events. Its first harness plugin depends on `@lucasschirm/sal-claude-session-parser`.

### 5.3 `@lucasschirm/sal-db`

`packages/db` owns:

- ingestion orchestration from already resolved, integrity-verified manifest/manual bundles;
- transformer selection and write-batch validation;
- atomic replacement generations;
- project-aware configuration snapshot comparison;
- component lifecycle events and before/after cohorts;
- incremental session contribution application and affected-bucket rebuilds;
- source-retention and reprocessing workflows;
- insight-ready read models and the stable `AnalyticsDataSource` interface;
- browser/server-neutral DTOs for dashboards, tables, filters, and evidence pagination.

The package depends on `db-core` and `transformer`. Manifest inputs use `sync-core` contract types through a narrow adapter package/export; `db` does not own storage-provider behavior. It does not depend on Lit, WASM, OPFS, Web Workers, or HTTP.

Artifact acquisition is caller/runtime-owned. `db` receives injected `ArtifactResolver`, `ContentHasher`, and optional retained `ArtifactBlobStore` ports, or a fully materialized verified bundle. Browser implementations use the existing sync worker/cache; future servers use their storage adapters. Persisted source references never contain credentials.

### 5.4 Runtime adapters and consumers

The site owns a small WASM/OPFS adapter, artifact-resolver/blob-store adapters, and worker transport. A future server owns equivalent Node adapters and may expose `AnalyticsDataSource` over HTTP. Lit pages depend only on the site-facing data-source client and DTOs.

The import-level dependency matrix is enforced:

```text
transformer -> claude parser (Claude plugin only)
db -> transformer + db-core + narrow sync-core manifest contracts
site runtime -> db + db-core adapter contracts + sync/source adapters
site pages -> AnalyticsDataSource DTO/client contracts only
```

No parser imports a transformer; no `db-core` module imports `db` or a transformer; no package imports the site.

## 6. Transformer plugin and comparability contract

### 6.1 Plugin contract

A harness integration has separate native parsing and canonical transformation layers:

```text
native artifacts -> harness parser -> typed native model
                  -> harness transformer -> canonical write batch
```

A transformer plugin provides:

```ts
interface SessionTransformer<TBundle> {
  readonly id: string;
  readonly harnesses: readonly string[];
  readonly transformerVersion: string;
  readonly ontologyVersion: string;

  detect(bundle: UnknownArtifactBundle): DetectionResult;
  classifyArtifacts(bundle: TBundle): ArtifactClassificationResult;
  getCapabilities(bundle?: TBundle): MetricCapability[];
  transform(bundle: TBundle, context: TransformContext): TransformResult;
}
```

Manifest harness identity takes precedence. Schema detection is used for manual imports or validation. Ambiguous detection is a structured error, never first-match behavior.

`TransformResult` includes:

- normalized evidence records;
- typed session and component summaries;
- scalar metric values and distributions;
- a configuration snapshot with per-component-type completeness;
- metric capabilities and unavailable reasons;
- artifact, source-event, and source-field provenance;
- parser, transformer, ontology, metric-definition, and estimation-method versions;
- recoverable warnings and fatal errors.

All generated identifiers must be deterministic from stable source identity, not call order or wall-clock time.

### 6.2 Cross-harness comparability

A canonical metric can be combined across transformers only when these properties are compatible:

- metric ID and definition version;
- unit, currency/pricing version, grain, and dimensions;
- denominator, observation unit, population, and session-finality rules;
- measurement class and native mapping version;
- root-only/inclusive semantics;
- status, threshold, censoring, and missing-data rules;
- aggregation, statistical, and attribution/allocation method.

The registry derives a machine-readable `comparability_group_id` from these properties. Values, distributions, contributions, rollups, cohorts, and chart series are keyed by that group and cannot aggregate mixed groups. Capabilities are `available`, `partial`, `unavailable`, or `incompatible`. Dashboards show eligible `N`, known `n`, unknown count, and coverage. Default portfolio headlines stratify incompatible groups by harness/method instead of combining them. Component aliases do not imply metric comparability.

An exact provider token value is never silently combined with an estimated text-token value. Native metrics may use a namespaced ID such as `native.claude_code.<metric>` until a canonical definition and explicit bridge mapping exist. Lifecycle diffing across a harness migration also requires a bridge mapping; otherwise the boundary is a discontinuity.

### 6.3 Canonical invariants

Every plugin must pass a conformance suite proving:

- Tool, Skill, Agent, and Sub Agent remain distinct;
- unknown is not zero;
- exact and estimated values remain separable;
- root-only and inclusive values cannot double-count descendants;
- starts and results correlate by source ID;
- replayed source events deduplicate deterministically;
- partial snapshots do not imply removals;
- unavailable metrics include a reason;
- output is deterministic for the same bundle and versions;
- every aggregate retains evidence/provenance links.

## 7. Manifest-driven artifacts

### 7.1 Descriptor and classification

For each synced artifact, ingestion creates a descriptor from the manifest:

```ts
interface ArtifactDescriptor {
  manifestProjectId: string;
  manifestSessionId: string;
  harness: string;
  harnessVersion: string;
  manifestSchemaVersion: number;
  scope: 'session' | 'workspace' | 'global' | 'runtime';
  relativePath: string;
  sha256: string;
  size: number;
  status: 'uploaded' | 'failed' | 'skipped' | 'pending';
}
```

Classification belongs to the manifest artifact reference, not the content blob. Identical bytes can be a Rule in one path and another artifact kind elsewhere.

The Claude classifier uses normalized full paths and structured content:

| Scope/path | Classification |
|---|---|
| `.claude/skills/<name>/SKILL.md` and related files | Skill definition/resource |
| `.claude/agents/*.md` | Agent definition |
| `.claude/rules/**` | Rule |
| `CLAUDE.md`, global Claude instruction files | Rule/memory |
| `.mcp.json` | MCP configuration containing zero or more servers |
| `.claude/settings.json` | Settings and contributed plugin/hook configuration |
| `.claude/settings.local.json` | Project-local settings |
| global `.claude.json` | Global settings/MCP configuration according to native schema |
| manifest main transcript path | Root transcript |
| `subagents/*.jsonl` | Sub Agent transcript |
| `subagents/*.meta.json` | Sub Agent metadata |
| unmatched supported-scope path | Unclassified with reason |

A structured artifact can yield multiple component definitions. Each extracted component retains a source pointer such as a safe JSON Pointer or text range.

### 7.2 Scope and identity

`scope` defines where an artifact was captured; a component installation records how it applied. A global artifact can be observed by sessions in many projects. A workspace artifact belongs to the manifest project/workspace exposure even when its CAS blob is globally deduplicated.

Component identity uses kind, owner/provider, integration/plugin, native ID when available, and canonical source identity. Display-name equality is insufficient. Cross-harness equivalence uses an explicit alias edge with source and confidence.

### 7.3 Completeness, time, ordering, and lifecycle

A manifest-backed capture can produce a configuration snapshot only to the extent declared by its collector coverage. Completeness is recorded independently for each component type. Failed, skipped-by-policy, pending, unsupported, unexpected, or unclassified expected artifacts make the affected category partial or unsupported.

Snapshots record occurrence/effective bounds, capture time, ingestion time, native/manifest sequence, and temporal role: `pre_session`, `runtime`, `post_session`, or `capture_only`. Only confirmed pre-session or runtime state contributes offered/exposure denominators for that session. Post-session evidence may establish first observation after a session but is never backdated to session start. Multiple runtime snapshots may create exposure intervals inside a session.

Canonical ordering is `(authoritative native sequence, source occurrence time, manifest sequence, stable source id)` using the strongest available prefix. Unknown order is explicit. `db` compares only ordered snapshots with compatible source, environment, project, workspace, repository, harness/scope chain, and complete component categories. The first complete state creates baseline additions. Later diffs create `added`, `updated`, and `removed` lifecycle events anchored at the first session observing the new state.

A late insert, timestamp correction, reclassification, deletion, or newly authoritative native/filesystem event starts a rebuild frontier at the earliest affected snapshot in that `(environment, project, workspace, harness, scope-chain)` and recomputes transitions, exposure intervals, cohorts, insights, and rollups until the next unchanged state. Superseded inferred events remain auditable but are not current. Skipped intermediate versions are labeled unobserved. Partial manual or manifest snapshots never prove removal, and an erased-session gap is a discontinuity unless independent evidence proves continuity.

## 8. Logical data model

The schema is normalized around identity, evidence, precomputed analytics, and provenance. Names below are logical table names; the implementation plan may split migrations without changing their ownership.

### 8.1 Schema, analysis releases, and generation control

- `schema_metadata` — schema identity and current migration.
- `schema_migrations` — append-only migration history and checksum.
- `analysis_releases` — compatible ontology, metric registry, statistical policy, rollup policy, and mapping versions.
- `transformation_generations` — parser/transformer/ontology/metric versions, analysis release, status, timestamps, source availability, and supersession relation.
- `ingestion_issues` — fatal/recoverable issue code, affected artifact/entity, and safe details.

Every replaceable evidence, summary, provenance, contribution, chart, lifecycle, and cohort row carries `generation_id` or an owning generation-scoped foreign key. Candidate and current rows use composite uniqueness so they can coexist. `sessions.current_generation_id` is the single visibility authority; generation status is workflow state, not a second current marker. Project/portfolio rollups are partitioned by `analysis_release_id` and `comparability_group_id`, so sessions that cannot be reprocessed never silently mix old and new metric meanings.

Only rows reachable from committed current generations and the selected compatible analysis release are visible to ordinary readers.

### 8.2 Tenant, source, environment, portfolio, and project identity

- `tenants` — trusted authorization boundary; the local application has one implicit tenant.
- `portfolios` — an analytical collection inside a tenant.
- `ingestion_sources` — immutable source namespace, type, authority, cursor/checkpoint capabilities, and credential-free identity.
- `environments` — user/device/harness configuration root inside an ingestion source.
- `projects` — canonical project identity and metadata.
- `source_projects` — source-native project ID mapped to a canonical project.
- `project_mappings` — explicit create/merge/split/reassignment audit records.
- `repositories` — optional repository identity and safe VCS metadata.
- `workspaces` — project workspace identity and scope chain.
- `project_sessions` is not required; `sessions.project_id` is the owning relation.

Source-native project/session IDs are unique only inside `ingestion_source_id`; deterministic IDs and idempotency constraints include that namespace. Project reassignment rebuilds affected contributions, lifecycle, exposure, and cohorts transactionally. Server tenant scope comes from trusted authorization context, never a caller-provided portfolio ID.

### 8.3 Manifests and artifact retention

- `source_manifests` — source/environment-scoped validated session or inventory manifest, finality, occurrence/capture/ingestion time, sequence, raw-safe metadata, hash, and schema/collector/policy versions.
- `manifest_coverage` — expected inventory, per-category completeness, temporal role, authority, and failure/exclusion reasons.
- `manifest_artifacts` — source-native project/session, scope/path/hash/size/status, role/media/encoding, and remote source reference.
- `artifact_blobs` — content-addressed local bytes or text, media type, retention class, encryption/redaction metadata, and size.
- `artifact_references` — manifest/manual source, observing session, component/version, source pointer, and blob relationship.
- `source_locations` — reacquisition metadata without credentials.
- `retention_policies` — portfolio default, environment policy, and project overrides.
- `source_tombstones` — authoritative source deletions distinct from absent list results.

Inventory manifests may exist without a session. They establish current environment installation state when authoritative, but never imply that a session was offered, loaded, or invoked a component.

Transcript and Sub Agent source retention is user-controlled. Configuration artifacts required for Rule/Skill/Agent/MCP/Tool/settings/plugin version diffing are retained locally when safely capturable. Secrets and credential-bearing fields are redacted before persistence; a local keyed digest or change marker detects sensitive-value changes without exposing values.

Deleting optional source blobs does not delete normalized evidence. Each generation reports `local`, `remote_reacquirable`, or `unavailable` reprocessing status.

Artifact/component canonicalization is versioned by harness and kind. It records separate raw-byte, normalized-content, and behavior-configuration hashes; line-ending, Unicode, JSON key-order, generated-field, comment, path-case, and redaction rules; classifier/canonicalizer version; and source filesystem case sensitivity. Multi-component files support artifact-level and component-level diffs. If source text is purged, the UI presents metadata-only evidence rather than reconstructing content.

Digest records include scheme and key-domain ID. They are never compared across unrelated or rotated key domains without an explicit rekey operation. Upstream capture must emit a privacy-safe sensitive-change digest/version before constant redaction when such change detection is required; analytics cannot recover it from already redacted bytes.

### 8.4 Global component ecosystem

- `component_identities` — portfolio-scoped canonical component kind and safe identity.
- `component_aliases` — native/cross-harness equivalence with source and confidence.
- `component_versions` — immutable content/configuration/schema hashes and safe metadata.
- `component_relationships` — MCP-to-Tool, plugin-to-contribution, parent/child, alias, and causation relationships.
- `component_installations` — global/project/workspace/plugin scope and effective intervals.
- `configuration_snapshots` — observing session, ordering, scope chain, capture time, and harness.
- `snapshot_completeness` — status per component type.
- `snapshot_components` — component version and source scope observed in a snapshot.
- `component_lifecycle_events` — baseline/added/updated/removed with before/after versions and concurrent-event grouping.
- `component_availability_events` — offered, deferred, enabled, disabled, connected, disconnected, or unavailable.
- `component_context_events` — listed, loaded, injected, reinjected, replaced, compacted, or removed.
- `session_component_exposures` — unavailable, not applicable, available-not-loaded, loaded, or unknown intervals.

Lifecycle, availability, context, and invocation records stay separate.

### 8.5 Session evidence spine

- `sessions` — root and child logical sessions with source/environment/project, harness, timing, finality/censoring, mode, task cohort, and current generation.
- `session_relations` — parent/root relation, spawn invocation, depth, and native inclusion semantics.
- `turns` — human/assistant logical turns and ordering.
- `messages` — role/type, source identity, parent relationship, timestamp, and optional retained/sanitized content reference.
- `model_requests` — request order, model/provider, context volume, timestamps, and correlation fields.
- `model_usage` — observed token classes, cost, pricing version, and request/session relation.
- `model_capabilities` — versioned model context limits and provider metadata.
- `pricing_versions` — provider/model/currency/effective-date token prices.
- `invocations` — Tool/Skill/Agent kind, component version, start/result IDs, status, latency, and root/child origin.
- `payloads` — typed input/result/injection payload sizes, exact or estimated tokens, truncation, and media/structure counts.
- `invocation_payloads` — invocation-to-input/result/context correlation and non-additive attribution metadata.
- `permission_events` — prompt, approval/denial/cancellation, mode, and wait interval.
- `mode_events` — permission/session mode transitions and effective intervals.
- `hook_executions` — hook/plugin identity, status, duration, and context-bearing result metadata.
- `normalized_events` — a versioned typed-event union for low-volume native evidence that does not warrant a dedicated table.
- `tasks` and `task_events` — observed task identity/status history.
- `validations` — validation type, command/result, timestamps, and edit-cycle relationship.
- `file_operations` — read/write/edit/create/delete/rename/revert with privacy-safe normalized path/category.
- `command_executions` — command category, exit/signal/status, and timing.
- `component_evidence_links` — component-to-turn/message/invocation/payload/task/validation/file/command evidence.

Rule/component exposure rows include applicability evidence, start/end sequence, availability completeness, injection completeness, and state. Frequently queried permission, mode, hook, pricing, and model-limit facts use dedicated tables rather than opaque metadata.

Raw parameters/results are retained only under configured privacy policy. Analytical dimensions use typed safe columns rather than unbounded JSON.

### 8.6 Metric registry and values

- `metric_definitions` — immutable versioned meaning, dimension schema, population/status rules, compatibility group, statistical policy, and allocation method.
- `transformer_metric_capabilities` — support and reason by transformer/harness/version.
- `metric_values` — typed numeric/integer/text representation, grain entity, dimensions key, class, confidence, root scope, definition/comparability version, and explicit unavailable/not-applicable reason.
- `metric_distributions` — definition/comparability/statistical-policy key, eligible `N`, known `n`, unknown count, sum, min, max, mean, p50/p75/p90/p95, dispersion, and outlier rule.
- `metric_provenance` — source artifact/event/field and estimation/allocation method.
- `statistical_policies` — observation unit, eligibility, micro/macro weighting, percentile algorithm/minimums, ratio policy, censoring, outliers, uncertainty, timezone/day boundary, matching, coverage, and insight suppression.
- `attribution_policies` — Phase 3 window boundaries, overlap handling, allocation, confidence, and additive status.
- `native_metric_values` — namespaced values not yet canonicalized.
- `heuristic_metric_values` — separately versioned future semantic results and evidence.

Frequently filtered high-volume dimensions and the Session Evidence header use typed summary tables instead of pivoting the scalar metric table.

### 8.7 Precomputed summaries and rollups

- `session_summaries` — root-only and inclusive headline metrics, capability coverage, observed outcome state, and source completeness.
- `session_component_stats` — component availability, context, invocation, payload, status, and outcome facts for one session.
- `session_chart_series` — bounded precomputed turn/time series and annotations required by Session Evidence.
- `rollup_contributions` — one current session's additive contribution to each bounded project/portfolio bucket, explicitly namespaced as root-session root-only or root-session inclusive. Child sessions remain independently queryable but never contribute again to inclusive portfolio totals.
- `project_daily_rollups` and `portfolio_daily_rollups` — additive time series.
- `project_dimension_rollups` and `portfolio_dimension_rollups` — bounded model, harness, mode, task cohort, component, and confidence dimensions.
- `project_distributions` and `portfolio_distributions` — write-time materialized distributions.
- `component_rollups` — portfolio/project/component/version utilization, overhead, reliability, timing, and outcome distributions.
- `comparison_cohorts` and `comparison_cohort_members` — reproducible before/after or matched groups with concurrent-event metadata.
- `insight_evidence` — deterministic insight recipe, wording inputs, evidence IDs, and confidence.

The system does not precompute arbitrary dimension combinations. A versioned `rollup_policy` defines supported dimensions, cardinality caps, top-N/other behavior, unknown buckets, bucket timezone, and analysis release. Supported dashboard filters define bounded rollup keys. Unsupported ad hoc analysis can operate on normalized facts in a future analytical service without slowing default pages.

Exact percentile/distribution buckets are recomputed during ingestion for affected bounded cohorts from indexed current session contributions. This makes writes heavier but reads predictable and makes replacement subtraction correct. A future mergeable sketch may be introduced only as a separately versioned estimated aggregation method.

## 9. Metric definition and evolution

A metric definition records at least:

```ts
interface MetricDefinition {
  metricId: string;
  version: number;
  label: string;
  description: string;
  family: string;
  measurementClass: 'observed' | 'derived' | 'estimated' | 'heuristic';
  unit: string;
  valueType: 'integer' | 'real' | 'currency' | 'ratio' | 'text';
  grain: string;
  dimensions: readonly string[];
  denominator?: string;
  populationRule: string;
  statusRule: string;
  aggregation: string;
  allocationMethod?: string;
  statisticalPolicyId: string;
  comparabilityGroupInputs: readonly string[];
  missingDataBehavior: 'unknown' | 'not_applicable';
  rootInclusion: 'root_only' | 'inclusive' | 'both' | 'not_applicable';
  distributionPolicy?: string;
  provenanceRequirement: string;
}
```

Changing a formula, denominator, inclusion rule, measurement class, or allocation method creates a new definition version. Historical values retain their version. Label-only corrections may update documentation without changing meaning, but registry checksums still detect drift.

Adding a metric requires:

1. update `SESSION_METRICS.md` or a linked proposal;
2. define class, unit, grain, dimensions, denominator, provenance, availability, confidence, aggregation, and missing behavior;
3. verify whether current normalized evidence is sufficient;
4. add/version the registry entry;
5. update relevant transformer capabilities;
6. implement deterministic computation outside UI code;
7. add typed storage only when scalar/distribution storage is insufficient;
8. implement rollup contribution and replacement behavior;
9. add anti-double-counting and reconciliation tests;
10. expose a data-source DTO/series only for a real consumer;
11. add accessible presentation and evidence drill-down;
12. document reprocessing requirements and compatibility.

A generated metric release matrix maps every Phase 1–3 metric and insight recipe to required evidence, class, additive/non-additive behavior, capability gate, statistical/attribution policy, and release readiness. Broad phase labels do not override metric-level gates. Deterministic variants of insight recipes ship before heuristic variants. A tokenizer can make captured-text token counts exact under a named tokenizer/method; it does not turn them into provider-observed request usage.

The temporal context rules in `SESSION_METRICS.md` supersede the parser-wiring suggestion in `CONTEXT_COST.md`: parsers expose native timeline evidence; transformers compute initial and dynamic estimates. Later Skill expansion, Rule reinjection, or Tool availability changes are dynamic costs and are never subtracted from the first-request anchor.

## 10. Ingestion, replacement, and reprocessing

### 10.1 Synced manifest-backed flow

```text
runtime resolver obtains artifacts and verifies hashes
  -> db accepts a verified bundle plus source/environment identity
  -> select transformer from manifest harness
  -> classify artifacts from harness + scope + full relative path
  -> parse root and Sub Agent sources
  -> normalize evidence and derive Phase 1-3 metrics
  -> validate capabilities, provenance, and anti-double-counting
  -> compare eligible configuration snapshots
  -> persist a replacement generation atomically
  -> rebuild affected rollups, distributions, cohorts, and insights
```

A hash mismatch is an integrity failure and is not ordinarily retryable as a transform error. It preserves the previous generation and identifies the remote/source artifact needing repair.

### 10.2 Manual flow

A manual bundle preserves directory-relative paths when available and records source namespace, native session ID, selected canonical project/workspace, harness choice/detection evidence, hashes, import-batch ID, and supplied-file inventory. Transcript-only sessions can contribute transcript-supported token, time, invocation, context, validation, file, and command metrics.

Deterministic match rules use source namespace plus native session ID first, then exact source artifact identity. A later authoritative sync enriches/replaces a matching manual session generation rather than duplicating metrics. Conflicts require explicit user resolution. Browser inputs that lose relative paths cannot support path-based configuration classification.

Manual sessions do not contribute configuration exposure denominators or lifecycle events. Supplied configuration artifacts may create partial point evidence links but omitted artifacts remain unknown; a user assertion alone does not establish completeness or removal.

### 10.3 Atomic generation replacement

Transformation occurs outside the write transaction. The complete batch is validated before persistence. In one transaction, `db`:

1. inserts generation-scoped candidate records that can coexist with current rows;
2. computes the affected project/workspace rebuild frontier;
3. subtracts or invalidates previous-generation contributions;
4. rebuilds lifecycle boundaries, exposures, cohort memberships, and insights from the frontier;
5. applies root-only and inclusive contributions through their separate namespaces;
6. rebuilds affected distributions and chart buckets under the selected analysis release;
7. updates `sessions.current_generation_id` as the single visibility switch and marks the old generation superseded.

Readers see the previous complete generation until commit. Rollback leaves it unchanged. Idempotency keys prevent duplicated manifests, sessions, and source events from inflating metrics.

### 10.4 Reprocessing

Every generation records artifact hashes and all parser/transformer/ontology/metric/schema/statistical/rollup versions. Reprocessing may use retained blobs or reacquire sources through safe source references. If sources are unavailable, existing metrics remain readable in their prior analysis release and the UI explains why a newer release has lower coverage. Portfolio/project aggregates select one compatible release or show separate strata; they never silently mix versions.

Deleting retained transcripts never deletes normalized facts. Configuration artifact versions needed for historical diffs follow their explicit retention policy and cannot be silently removed while referenced by a lifecycle comparison.

Deletion is explicit and typed: local blob purge, authoritative source tombstone, session deletion, project deletion, and privacy erasure have separate commands and restore behavior. Analytical deletion subtracts contributions, rebuilds distributions/cohorts/lifecycle from the earliest affected frontier, removes or tombstones evidence links, and garbage-collects unreferenced blobs/identities according to policy. A deleted intermediate snapshot creates a discontinuity; the engine does not infer a transition across the gap without independent continuity evidence.

## 11. Read contract and dashboards

### 11.1 `AnalyticsDataSource`

The site consumes browser/server-neutral methods grouped by view:

- portfolio overview, trends, component utilization, model/harness cohorts, and project list;
- project behavior summary, session trend series, configuration timeline, outliers, and comparisons;
- session evidence summary, context/timing series, root-child breakdown, component facts, validation, and evidence pages;
- component ecosystem summary, versions, scopes, utilization, distributions, projects/sessions, and lifecycle comparisons;
- artifact version metadata and safe unified/side-by-side diff;
- paginated transcript/evidence retrieval;
- project session list/search/sort with source, harness, completeness, finality, reprocessing, and issue state;
- root/child session trees and generation-aware links;
- filter metadata and capability/coverage explanations.

DTOs carry analysis release and generation tokens, comparability group, eligible `N`, known `n`, unknown count, coverage, measurement class, confidence, metric version, and evidence links. Cursor pagination is snapshot-consistent against the generation token. Future remote clients negotiate protocol, metric/capability versions, retryable errors, and cursor semantics. UI components never import SQL types or calculate canonical metrics.

### 11.2 Navigation

```text
Portfolio (default route)
  -> Project Behavior
    -> Session Evidence

Portfolio / Project / Session
  -> Component Ecosystem
    -> exact project/session/turn/message/invocation evidence
    -> artifact version diff and before/after cohorts
```

Stable hash URLs preserve time range, project, harness, model, mode, task cohort, root/inclusive scope, confidence, selected component/version, analysis release, and return context. Component pages retain canonical identity while breadcrumbs preserve the originating portfolio/project/session filters. Deleted or superseded evidence resolves to an explanatory tombstone rather than an unrelated row.

“Late in a project” means late in the observed project session/time sequence unless an explicit completion signal exists.

### 11.3 Views

**Portfolio** shows cross-project cost, context, time, validation, model/harness cohorts, global configuration overhead, component utilization, and unused offered components.

**Project Behavior** shows session-to-session context growth, cost/time/outcome distributions, configuration timeline annotations, matched before/after cohorts, regressions, and outliers.

**Session Evidence** shows precomputed context/request timelines, composition, cache/compaction, root/Sub Agent contribution, latency/parallelism, Tool/Skill/Agent activity, validation, file/command activity, and supporting evidence.

**Component Ecosystem** works for Tool, MCP server, Skill, Agent, Rule, plugin, setting, model, and version. It shows installation scope, offered/loaded/invoked funnels, context overhead, payload distributions, reliability, project/harness cohorts, lifecycle timing, and evidence.

**Artifact Diff** shows safe unified and side-by-side text or structural diffs, changed scope/globs/permissions/model/schema metadata, sessions exposed to each version, concurrent changes, and observational cohort distributions.

### 11.4 Charts

Reusable Lit chart components use tree-shaken ECharts modules. The supported set includes time series, stacked bar/area, histograms, percentile bands, scatter, heatmap, box/distribution, funnels, and annotated timelines.

Every chart has keyboard interaction, a textual summary, a tabular fallback, color-independent status encoding, loading/empty/partial/error states, and evidence links. Chart components receive series DTOs and contain no SQL or metric formulas.

### 11.5 Read-performance rule

Opening a session performs summary, bounded chart-series, and paginated evidence queries only. It performs no transcript scan, tree reconstruction over all messages, percentile calculation, metric derivation, configuration diff, or project-wide aggregation.

Project and portfolio pages use rollups and bounded indexed series. Simple display arithmetic and joins to current baseline summaries are allowed; metric formulas and distribution scans are not.

## 12. Privacy, integrity, and retention

A field-level privacy taxonomy classifies source text, component content, names, paths, repository metadata, task labels, command/error details, source pointers, normalized facts, hashes/digests, and aggregates. Each class defines capture, redaction/generalization, local retention, export disclosure, erasure, and garbage-collection behavior. Safe path handling may hash or generalize segments; error text and structured source pointers use allowlists. “Normalized” never automatically means non-sensitive.

- All SQL is parameterized.
- Portfolio/tenant identity scopes every query.
- Credentials and secret values never enter analytics tables or artifact blobs.
- Paths are normalized/sanitized according to existing sync policies.
- Raw prompts, parameters, results, and transcript content obey user retention choices.
- Configuration artifacts are retained only after harness-specific redaction and safe classification.
- Sensitive changes use local keyed digests or boolean change markers, not constant redaction hashes.
- Artifact hashes are verified before transformation.
- Source text is not required for ordinary dashboard reads.
- Current sync transcripts are not guaranteed secret-free; the runtime applies the selected local retention/redaction policy before optional blob persistence, and the UI does not claim otherwise.
- Database export clearly identifies retained source/configuration content, normalized sensitive fields, digest portability/key domain, and warns the user.
- Deleting a project cascades scoped sessions/installations/references while preserving a shared blob only when another reference remains.
- Portfolio deletion removes all local analytical and retained-source data.

## 13. Failure and edge-case behavior

- Unsupported manifest schema: reject ingestion with a structured issue.
- Unsupported harness: preserve source metadata/retained artifacts when allowed and expose unsupported status.
- Ambiguous manual detection: require user choice; do not guess.
- Corrupt/hash-mismatched artifact: reject the candidate generation and preserve the previous one.
- Partial/truncated/redacted transcript: commit only when the plugin can declare partial capabilities safely.
- Missing Sub Agent transcript: keep launch evidence and mark child metrics unavailable; do not treat them as zero.
- Unknown parent inclusion semantics: do not produce an inclusive sum.
- Clock skew or absent timestamps: preserve source ordering and omit invented duration precision.
- Concurrent invocations: correlate by IDs; overlapping allocation remains non-additive unless partitioned.
- Duplicate sync replay: deterministic IDs and idempotency constraints prevent inflation.
- Out-of-order manifests: store occurrence/capture/ingestion times and ordering confidence, then run the defined rebuild frontier when canonical order becomes known.
- Concurrent configuration changes: group and display them; do not isolate causal credit.
- Component rename: remove/add unless native or VCS identity proves continuity.
- Same-name cross-harness components: separate identities unless an explicit alias exists.
- Component artifact with several definitions: one artifact version can source many component versions through source pointers.
- Source blob deletion during reprocessing: fail before replacement and preserve the current generation.
- Interrupted transaction: rollback all evidence, contributions, cohorts, and current-generation changes.
- Stale rollup version: prevent inconsistent generation reads and rebuild from current contribution rows.
- OPFS lock/unsupported runtime: retain explicit fallback behavior; the adapter reports backend and durability.
- Schema migration failure: never expose a partially migrated database.
- Relative-delta denominator zero: store/display absolute delta and undefined relative delta.
- Small cohort: enforce its versioned statistical policy; show eligible `N`, known `n`, unknown count, and coverage while suppressing only unsupported claims, not raw evidence.
- In-progress/truncated/right-censored session: exclude or include according to each metric's population/censoring policy; never treat a current partial duration or absent final outcome as final.
- Source/import disappearance: only an authoritative tombstone triggers source deletion; absence from a listing is unknown.
- Cross-environment global component: share canonical identity only; keep installation, lifecycle, and exposure environment-scoped.
- Analysis release coverage gap: show separate compatible strata or lower coverage; never blend definition versions.

## 14. Site migration strategy

Delivery uses gated vertical increments so foundational contracts are proven before the full metric/UI scope:

1. **Source and topology gate:** evolve manifest coverage/finality/source identity; define resolver/blob-store ports; split control/vault ownership from analytics; add rollback/export behavior.
2. **Persistence gate:** create package shells and dependency rules; implement the SQLite capability contract, migration runner, generation-scoped schema, fresh/upgrade parity, and WASM adapter conformance.
3. **Root-session vertical slice:** implement the Claude plugin for identity, turns, messages, requests, token classes, and a minimal Session Evidence summary; ingest one session atomically and read it through `AnalyticsDataSource`.
4. **Replacement and additive rollups:** prove idempotent enrichment/replacement, root/inclusive contribution namespaces, project/portfolio reconciliation, deletion, and late-arrival rebuild frontiers.
5. **Configuration ecosystem:** implement manifest classification, safe artifact retention/canonicalization, global environment-scoped component identity, snapshots, exposures, lifecycle, and artifact diffs.
6. **Statistics and Phase 2:** implement metric registry, statistical/rollup policies, affected distributions, deterministic insights, project behavior, and component utilization.
7. **Phase 3 attribution:** implement model/pricing registries, attribution policies, context retention, Sub Agent overlap/critical path, and all metric-level release-matrix items that pass evidence gates.
8. **Complete views and source workflows:** finish Portfolio, Project Behavior, Session Evidence, Component Ecosystem, Artifact Diff, manual import/enrichment, retention, reprocessing, and remote-ready data-source contracts.
9. **Cutover:** validate large fixtures and legacy feature parity, activate the fresh analytics database with explicit notice, and provide re-sync/re-import plus old read-only export/rollback window.
10. **Legacy removal:** remove old `site/src/db` analytics ownership, `SessionBuilder` transformation, read-time aggregation, and obsolete indicator implementations only after acceptance and rollback-window expiry.

Each gate has an executable acceptance suite and may ship behind a flag. Connection/vault cryptography remains site/runtime-specific; safe source/connection identity bridges into analytics through opaque IDs.

## 15. Testing and acceptance criteria

### 15.1 `db-core`

- a documented SQLite capability contract covering sync/async transaction callback constraints, savepoints, integer/`bigint` fidelity, BLOB binding/transfer, result shapes, required PRAGMAs, cancellation, busy/lock behavior, durability, and supported SQL features;
- fresh schema, sequential upgrade fixtures, migration checksums, and failure rollback;
- foreign keys, constraints, cascade behavior, and all indexes;
- repository round trips and parameterized-query coverage;
- adapter conformance for transaction semantics and value binding;
- generation visibility and atomic replacement primitives;
- generation-scoped coexistence and one authoritative visibility switch;
- separate root-only/inclusive contribution add/subtract and rollup reconciliation;
- late-arrival/deletion/project-move rebuild frontiers;
- affected-distribution rebuilds and versioned cohort persistence;
- query-plan assertions on benchmark fixtures.

### 15.2 `transformer`

- Claude golden fixtures for root and Sub Agent sessions;
- complete, malformed, partial, redacted, compacted, and replayed artifacts;
- manifest path classification and structured multi-component artifacts;
- capability matrices and unavailable reasons;
- provenance to artifact/event/field;
- root/inclusive anti-double-counting;
- context, cache, compaction, payload, latency, validation, file, command, and attribution formulas;
- deterministic output and stable IDs;
- shared plugin conformance suite.

### 15.3 `db`

- synced and manual ingestion behavior;
- idempotent replacement generations;
- snapshot completeness and lifecycle boundary inference;
- baseline/add/update/remove events and concurrent changes;
- component global identity and alias behavior;
- source retention, deletion, reacquisition, and reprocessing;
- project/portfolio contribution reconciliation;
- versioned cohort recipes, fixed windows, eligibility/exclusion/matching rules, concurrent-change disclosure, refresh behavior, and zero-denominator behavior; simple observed before/after cohorts precede matched cohorts;
- source/manual enrichment identity and conflict handling;
- typed deletion/privacy-erasure behavior;
- fatal failure preserving prior generation.

### 15.4 Site and end-to-end

- data-source contract tests with local and mock remote implementations;
- Portfolio -> Project -> Session -> Component -> Evidence navigation;
- stable routes and filter continuity;
- artifact version diff and comparison cohorts;
- manual transcript-only limitations and labels;
- accessibility summaries/table fallbacks for every chart;
- fresh-database activation, export, reload, and source-retention controls;
- loading, empty, partial, unavailable, unsupported, integrity-error, and stale-rollup states.

### 15.5 Performance

CI benchmark fixtures represent multiple sources/environments, many projects, thousands of sessions, deep Sub Agent trees, large payloads, late arrivals/deletions, and long configuration histories. Environment-tolerant budgets cover ingestion memory, replacement/rebuild-frontier time, and p95 read latency.

Acceptance requires:

- no metric derivation or full transcript scan on session open;
- indexed/bounded dashboard queries;
- exact reconciliation of current session contributions to project/portfolio additive totals;
- write-time distribution/cohort rebuilds for affected buckets only;
- paginated detailed evidence;
- atomic replacement under injected failures.

## 16. Agentic development and maintenance

### 16.1 Skills

Create repository-local skills:

- `.agents/skills/add-harness-integration/SKILL.md` — parser/transformer scaffolding, detection, artifact classification, capability mapping, fixtures, registration, and conformance.
- `.agents/skills/add-session-metric/SKILL.md` — definition metadata, evidence sufficiency, storage/rollup decision tree, implementation, dashboard, versioning, and reprocessing.
- `.agents/skills/add-db-migration/SKILL.md` — forward migration, fresh-schema parity, stores, indexes, query plans, rollup rebuild, and upgrade fixtures.
- `.agents/skills/add-analytics-view/SKILL.md` — data-source DTOs, chart/table accessibility, filters, stable routes, evidence links, and performance.
- `.agents/skills/reprocess-analytics/SKILL.md` — source checks, replacement generations, reconciliation, interruption recovery, and reporting.

Each skill includes templates and commands, not only principles.

### 16.2 Specialized agents

Create or extend agents for:

- harness integration review;
- metric definition/schema/comparability review;
- analytics database migration/query/rollup review;
- analytics UI and chart accessibility/performance review.

The task orchestrator delegates relevant implementation tasks to these reviewers before completion. Review agents report violations with paths, metric IDs, migrations, or queries rather than generic advice.

### 16.3 Rules

Add path-scoped repository rules enforcing:

- domain distinctions among Tool, Skill, Agent, and Sub Agent;
- missing is never zero;
- canonical metrics are never calculated in Lit components;
- SQL exists only in `db-core` migrations/stores;
- transformers never write SQLite;
- lifecycle removals require comparable complete snapshots;
- component identity never relies on display name alone;
- metric meaning changes require versioning;
- aggregates expose sample size and evidence;
- schema changes include migration/fresh-schema/query-plan tests;
- harness plugins pass conformance;
- manifest-backed classification uses manifest harness, scope, path, and hash.

### 16.4 Documentation and decisions

Add and maintain:

- package READMEs and package-level `AGENTS.md` files;
- `docs/architecture/metrics/` for registry and extension guides;
- `docs/architecture/harnesses/` for native-to-canonical mappings and limitations;
- `docs/architecture/schema/` for ER diagrams, table dictionary, indexes, retention, migrations, and query patterns;
- `docs/architecture/adr/` with a template and decisions for package boundaries, typed facts/rollups, component identity, manifest authority, source retention, metric versioning, and fresh-database rollout.

Plans cite ADRs/specs; tasks cite plan sections; discoveries feed changes back into rules and skills.

### 16.5 CI maintenance gates

CI verifies:

- generated metric reference matches the registry;
- required metric metadata is complete and IDs/versions are unique;
- manifest contract tests prove coverage/finality semantics and old manifests remain partial;
- migration history is append-only and checksummed;
- fresh schema equals sequentially upgraded schema;
- package dependency direction remains acyclic;
- every transformer passes conformance;
- analysis releases and comparability groups prevent mixed metric meanings;
- root-only/inclusive rollups reconcile with current contributions;
- statistical/attribution/rollup policies are versioned and complete;
- required dashboard queries use expected indexes;
- DTO packages contain no runtime database implementation types;
- documentation, AGENTS, skill, rule, and ADR indexes reference new artifacts;
- every package provides the workspace-standard `verify` script.

## 17. Consequences

The architecture deliberately moves cost from reads to ingestion. Replacing, deleting, reordering, reclassifying, or moving a session can trigger rollup, distribution, lifecycle, exposure, insight, and cohort rebuilds from an explicit frontier. That cost is observable and retryable; benchmark budgets determine whether a frontier is processed inline or through a resumable maintenance job before activation. It remains preferable to repeated dashboard scans.

The normalized model and metric registry are larger than the current schema, but they preserve evidence and make cross-project and cross-harness analysis trustworthy. Plugin capabilities prevent false comparability. Portfolio component identity enables ecosystem analysis without erasing project scope or native semantics.

The site becomes one consumer rather than the owner of analytics behavior. Future local applications, CLIs, background processors, and servers can reuse transformation and SQLite stores or implement the same data-source read contract.
