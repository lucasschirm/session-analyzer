# Schema Architecture

ER diagrams, table dictionary, indexes, retention, migrations, and query
patterns for the Session Analyzer analytics database.

## Overview

The analytics schema (`sal-analytics`) is a normalized SQLite schema owned by
`@lucasschirm/sal-db-core`. It is organized around four concerns: identity,
evidence, precomputed analytics, and provenance. All tables use `STRICT` typing.
Every replaceable row carries `generation_id` for atomic replacement visibility.

## ER diagram (text-based)

```text
┌─────────────────────────────────────────────────────────────────────┐
│                        Schema & Generation Control                   │
│                                                                      │
│  schema_metadata ──< schema_migrations                               │
│  analysis_releases ──< transformation_generations ──< ingestion_issues│
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                              Identity                                 │
│                                                                       │
│  tenants ──< portfolios ──< ingestion_sources ──< environments       │
│                                    │                                  │
│                                    ├──< projects ──< source_projects  │
│                                    │      │                           │
│                                    │      ├──< project_mappings       │
│                                    │      ├──< repositories           │
│                                    │      └──< workspaces             │
│                                    │                                  │
│                                    └── (scoped by environment +       │
│                                         source + portfolio)           │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    Manifests & Artifact Retention                     │
│                                                                       │
│  source_manifests ──< manifest_coverage                               │
│                  ──< manifest_artifacts ──> artifact_blobs            │
│                                  │            │                       │
│                                  │            └──< artifact_references│
│                                  │                                    │
│                                  └──< source_locations                 │
│                                                                       │
│  retention_policies          source_tombstones                        │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    Global Component Ecosystem                         │
│                                                                       │
│  component_identities ──< component_versions                          │
│         │                ──< component_aliases                        │
│         │                ──< component_relationships                  │
│         │                ──< component_installations                  │
│         │                                                              │
│         └──< configuration_snapshots ──< snapshot_completeness        │
│                                    ──< snapshot_components             │
│                                                                       │
│  component_lifecycle_events   component_availability_events           │
│  component_context_events     session_component_exposures             │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                       Session Evidence Spine                          │
│                                                                       │
│  sessions ──< session_relations                                       │
│          ──< turns ──< messages                                       │
│          ──< model_requests ──< model_usage                           │
│          ──< invocations ──< invocation_payloads ──> payloads         │
│          ──< permission_events                                        │
│          ──< mode_events                                              │
│          ──< hook_executions                                          │
│          ──< tasks ──< task_events                                    │
│          ──< validations                                              │
│          ──< file_operations                                          │
│          ──< command_executions                                       │
│          ──< normalized_events                                        │
│          ──< component_evidence_links                                 │
│                                                                       │
│  model_capabilities     pricing_versions                              │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│              Metric Registry, Values & Precomputed Analytics           │
│                                                                       │
│  metric_definitions ──< metric_values                                 │
│                    ──< metric_distributions                           │
│                    ──< metric_provenance                              │
│                    ──< transformer_metric_capabilities                │
│                                                                       │
│  statistical_policies   attribution_policies                          │
│  native_metric_values   heuristic_metric_values                       │
│                                                                       │
│  session_summaries     session_component_stats    session_chart_series│
│                                                                       │
│  rollup_contributions                                                 │
│    ├──< project_daily_rollups      ├──< portfolio_daily_rollups       │
│    ├──< project_dimension_rollups  ├──< portfolio_dimension_rollups   │
│    ├──< project_distributions      ├──< portfolio_distributions       │
│    └──< component_rollups                                             │
│                                                                       │
│  comparison_cohorts ──< comparison_cohort_members                     │
│  insight_evidence                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Table dictionary

### Schema & generation control

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `schema_metadata` | Schema identity and current migration | `schema_name` (PK), `schema_version` |
| `schema_migrations` | Append-only migration history and checksum | `id` (PK), `name`, `sql`, `checksum`, `applied_at` |
| `analysis_releases` | Compatible ontology/metric/policy versions | `id` (PK), `ontology_version`, `metric_registry_version`, `is_default` |
| `transformation_generations` | Parser/transformer/ontology/metric versions, status, supersession | `id` (PK), `session_id` (FK), `analysis_release_id` (FK), `status` |
| `ingestion_issues` | Fatal/recoverable issue codes and affected entities | `id` (PK), `generation_id` (FK), `severity`, `code` |

### Identity

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `tenants` | Trusted authorization boundary | `id` (PK) |
| `portfolios` | Analytical collection inside a tenant | `id` (PK), `tenant_id` (FK) |
| `ingestion_sources` | Immutable source namespace and type | `id` (PK), `portfolio_id` (FK) |
| `environments` | User/device/harness configuration root | `id` (PK), `ingestion_source_id` (FK) |
| `projects` | Canonical project identity and metadata | `id` (PK) |
| `source_projects` | Source-native project ID mapped to canonical | `id` (PK), `ingestion_source_id` (FK), `project_id` (FK) |
| `project_mappings` | Create/merge/split/reassignment audit | `id` (PK), `project_id` (FK) |
| `repositories` | Optional repository identity and safe VCS metadata | `id` (PK) |
| `workspaces` | Project workspace identity and scope chain | `id` (PK), `project_id` (FK) |

### Manifests & artifact retention

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `source_manifests` | Validated session/inventory manifest, finality, sequence | `id` (PK), `environment_id` (FK) |
| `manifest_coverage` | Expected inventory, per-category completeness, temporal role | `id` (PK), `manifest_id` (FK) |
| `manifest_artifacts` | Source-native project/session, scope/path/hash/status | `id` (PK), `manifest_id` (FK) |
| `artifact_blobs` | Content-addressed local bytes, media type, retention class | `sha256` (PK) |
| `artifact_references` | Manifest/manual source, observing session, blob relationship | `id` (PK), `blob_sha256` (FK) |
| `source_locations` | Reacquisition metadata without credentials | `id` (PK) |
| `retention_policies` | Portfolio default, environment policy, project overrides | `id` (PK) |
| `source_tombstones` | Authoritative source deletions | `id` (PK) |

### Global component ecosystem

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `component_identities` | Portfolio-scoped canonical component kind and safe identity | `id` (PK), `kind`, `portfolio_id` (FK) |
| `component_aliases` | Native/cross-harness equivalence with source and confidence | `id` (PK), `component_id` (FK) |
| `component_versions` | Immutable content/configuration/schema hashes and metadata | `id` (PK), `component_id` (FK) |
| `component_relationships` | MCP-to-Tool, plugin-to-contribution, parent/child, alias, causation | `id` (PK) |
| `component_installations` | Global/project/workspace/plugin scope and effective intervals | `id` (PK), `component_id` (FK) |
| `configuration_snapshots` | Observing session, ordering, scope chain, capture time | `id` (PK), `session_id` (FK) |
| `snapshot_completeness` | Status per component type | `id` (PK), `snapshot_id` (FK) |
| `snapshot_components` | Component version and source scope observed in a snapshot | `id` (PK), `snapshot_id` (FK) |
| `component_lifecycle_events` | Baseline/added/updated/removed with before/after versions | `id` (PK) |
| `component_availability_events` | Offered, deferred, enabled, disabled, connected, disconnected, unavailable | `id` (PK) |
| `component_context_events` | Listed, loaded, injected, reinjected, replaced, compacted, removed | `id` (PK) |
| `session_component_exposures` | Unavailable/not-applicable/available-not-loaded/loaded/unknown intervals | `id` (PK), `session_id` (FK) |

### Session evidence spine

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `sessions` | Root and child logical sessions, harness, timing, finality, current generation, outcome | `id` (PK), `project_id` (FK), `current_generation_id` (FK) |
| `session_relations` | Parent/root relation, spawn invocation, depth, inclusion semantics | `id` (PK), `session_id` (FK) |
| `turns` | Human/assistant logical turns and ordering | `id` (PK), `session_id` (FK) |
| `messages` | Role/type, source identity, parent relationship, timestamp | `id` (PK), `turn_id` (FK) |
| `model_requests` | Request order, model/provider, context volume, timestamps | `id` (PK), `session_id` (FK) |
| `model_usage` | Observed token classes, cost, pricing version | `id` (PK), `request_id` (FK) |
| `model_capabilities` | Versioned model context limits and provider metadata | `id` (PK) |
| `pricing_versions` | Provider/model/currency/effective-date token prices | `id` (PK) |
| `invocations` | Tool/Skill/Agent kind, component version, start/result IDs, status, latency | `id` (PK), `session_id` (FK) |
| `payloads` | Typed input/result/injection payload sizes, exact/estimated tokens | `id` (PK) |
| `invocation_payloads` | Invocation-to-input/result/context correlation, non-additive attribution | `id` (PK), `invocation_id` (FK) |
| `permission_events` | Prompt, approval/denial/cancellation, mode, wait interval | `id` (PK), `session_id` (FK) |
| `mode_events` | Permission/session mode transitions and effective intervals | `id` (PK), `session_id` (FK) |
| `hook_executions` | Hook/plugin identity, status, duration, context-bearing result | `id` (PK), `session_id` (FK) |
| `normalized_events` | Versioned typed-event union for low-volume native evidence | `id` (PK), `session_id` (FK) |
| `tasks` / `task_events` | Observed task identity/status history | `id` (PK), `session_id` (FK) |
| `validations` | Validation type, command/result, timestamps, edit-cycle relationship | `id` (PK), `session_id` (FK) |
| `file_operations` | Read/write/edit/create/delete/rename/revert with safe normalized path | `id` (PK), `session_id` (FK) |
| `command_executions` | Command category, exit/signal/status, timing | `id` (PK), `session_id` (FK) |
| `component_evidence_links` | Component-to-turn/message/invocation/payload/task/validation/file/command | `id` (PK) |

### Metric registry & values

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `metric_definitions` | Immutable versioned meaning, dimension schema, compatibility group | `id` (PK), `metric_id`, `version` |
| `transformer_metric_capabilities` | Support and reason by transformer/harness/version | `id` (PK) |
| `metric_values` | Typed values, grain entity, dimensions key, class, confidence, root scope | `id` (PK), `generation_id` (FK) |
| `metric_distributions` | Eligible N, known n, unknown count, percentiles, dispersion | `id` (PK) |
| `metric_provenance` | Source artifact/event/field and estimation/allocation method | `id` (PK) |
| `statistical_policies` | Observation unit, eligibility, weighting, percentile algorithm, censoring | `id` (PK) |
| `attribution_policies` | Phase 3 window boundaries, overlap handling, allocation, confidence | `id` (PK) |
| `native_metric_values` | Namespaced values not yet canonicalized | `id` (PK) |
| `heuristic_metric_values` | Separately versioned future semantic results | `id` (PK) |

### Precomputed summaries & rollups

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `session_summaries` | Root-only and inclusive headline metrics, capability coverage, outcome | `session_id` (PK), `generation_id` (FK) |
| `session_component_stats` | Component availability, context, invocation, payload, status, outcome facts | `id` (PK), `session_id` (FK) |
| `session_chart_series` | Bounded precomputed turn/time series and annotations | `id` (PK), `session_id` (FK) |
| `rollup_contributions` | One session's additive contribution to each project/portfolio bucket | `id` (PK), `generation_id` (FK) |
| `project_daily_rollups` / `portfolio_daily_rollups` | Additive time series | `id` (PK) |
| `project_dimension_rollups` / `portfolio_dimension_rollups` | Bounded model, harness, mode, task, component, confidence dimensions | `id` (PK) |
| `project_distributions` / `portfolio_distributions` | Write-time materialized distributions | `id` (PK) |
| `component_rollups` | Portfolio/project/component/version utilization, overhead, reliability | `id` (PK) |
| `comparison_cohorts` / `comparison_cohort_members` | Reproducible before/after or matched groups | `id` (PK) |
| `insight_evidence` | Deterministic insight recipe, wording inputs, evidence IDs, confidence | `id` (PK) |

## Indexes

Indexes are defined alongside table DDL in each domain module. Key index
patterns:

- **Generation-scoped visibility**: composite indexes on `(generation_id,
  business_key)` for every replaceable table.
- **Session evidence**: indexes on `session_id` for all evidence tables;
  `parent_uuid` for message tree traversal; `(session_id, turn_order)` for
  turn-ordered queries.
- **Session outcome**: `sessions(outcome)` and
  `sessions(project_id, finality, outcome)` back the `session:outcome`
  metric's per-project rollup query (`SessionOutcomeStore.rollupByProject`);
  `outcome` is nullable-with-meaning (`NULL` = unreadable tail / not
  classifiable, distinct from a real classified value).
- **Rollup lookups**: indexes on `(project_id, bucket_date)` for daily rollups;
  `(comparability_group_id, analysis_release_id)` for dimension rollups.
- **Metric values**: indexes on `(metric_definition_id, generation_id,
  dimensions_key)` for filtered metric queries.
- **Component ecosystem**: indexes on `(component_id, installation_scope)` and
  `(session_id, exposure_state)` for exposure queries.
- **Manifest artifacts**: indexes on `(manifest_id, scope, relative_path)` and
  `(sha256)` for deduplication.

CI gates verify that required dashboard queries use expected indexes
(`EXPLAIN QUERY PLAN` assertions on benchmark fixtures).

## Retention

Retention is policy-driven and typed:

| Category | Default retention | Notes |
|----------|-------------------|-------|
| Transcript and Sub Agent source blobs | User-controlled | Deleting source blobs does not delete normalized evidence |
| Configuration artifacts (Rule/Skill/Agent/MCP/Tool/settings) | Retained locally when safely capturable | Required for version diffing; cannot be silently removed while referenced by lifecycle comparison |
| Normalized evidence | Permanent (within analysis release) | Not deleted when source blobs are purged |
| Aggregates/rollups | Permanent (within analysis release) | Rebuilt from contributions during reprocessing |
| Secrets/credentials | Never stored | Redacted before persistence; sensitive changes use local keyed digests |

Each generation reports `local`, `remote_reacquirable`, or `unavailable`
reprocessing status. Deletion is explicit and typed: local blob purge,
authoritative source tombstone, session deletion, project deletion, and privacy
erasure have separate commands and restore behavior.

## Migrations

Migrations are forward-only, append-only, and checksummed (FNV-1a 64-bit).
`MigrationRunner` runs each migration in its own transaction; any failure rolls
back and leaves the database at the last successful migration. CI gates verify:

- Migration history is append-only and checksummed.
- Fresh schema equals sequentially upgraded schema
  (`tests/unit/schema-parity.test.ts`).

See `packages/db-core/src/migrations.ts` and the `add-db-migration` skill
(`.agents/skills/add-db-migration/`) for migration authoring guidance.

## Query patterns

### Session open (bounded)

Opening a session performs only:

- `session_summaries` lookup by `session_id` + current `generation_id`.
- `session_chart_series` bounded series by `session_id` + `generation_id`.
- Paginated evidence queries (turns, messages, invocations) with cursor
  pagination against the generation token.

No transcript scan, no tree reconstruction over all messages, no percentile
calculation, no metric derivation, no configuration diff, no project-wide
aggregation.

### Project/portfolio dashboards

Project and portfolio pages use precomputed rollups and bounded indexed series:

- `project_daily_rollups` / `portfolio_daily_rollups` for time series.
- `project_dimension_rollups` / `portfolio_dimension_rollups` for filtered
  dimensions.
- `project_distributions` / `portfolio_distributions` for histograms.
- Simple display arithmetic and joins to current baseline summaries are allowed;
  metric formulas and distribution scans are not.

### Evidence drill-down

Paginated evidence retrieval uses cursor pagination snapshot-consistent against
the generation token. Evidence links (`component_evidence_links`) connect
component versions to specific turns, messages, invocations, payloads, tasks,
validations, file operations, and commands.

## References

- Plan: `docs/superpowers/plans/2026-08-24-analytics-data-platform-design.md` §8 (Logical data model), §10 (Ingestion, replacement, and reprocessing), §11.5 (Read-performance rule)
- ADR-0002: Typed facts and rollups
- ADR-0005: Source retention
- ADR-0007: Fresh database rollout
- Implementation: `packages/db-core/src/schema.ts`, `packages/db-core/src/identity.ts`, `packages/db-core/src/manifest.ts`, `packages/db-core/src/component-ecosystem.ts`, `packages/db-core/src/session-evidence.ts`, `packages/db-core/src/metrics.ts`
