# `@lucasschirm/sal-transformer`

Pure, deterministic session transformation plugin framework and metric contracts
for the Session Analyzer analytics platform.

## Purpose

`transformer` is the canonical normalization layer between harness-specific
parsers and the analytics database. It receives typed native parser output,
classifies artifacts, normalizes evidence, derives Phase 1–3 metrics, and
produces a canonical write batch — all without opening SQLite, querying project
history, accessing remote storage, or emitting project lifecycle events.

The package is **pure and deterministic**: the same bundle and versions always
produce the same output. All generated identifiers are deterministic from stable
source identity, not call order or wall-clock time.

## Dependency matrix

```text
transformer -> claude parser (Claude plugin only)
db          -> transformer + db-core + narrow sync-core manifest contracts
site runtime -> db + db-core adapter contracts + sync/source adapters
site pages  -> AnalyticsDataSource DTO/client contracts only
```

`transformer` imports only its harness parser dependency
(`@lucasschirm/sal-claude-session-parser` for the Claude Code plugin). It does
not import `db-core`, `db`, `site`, or any SQLite/runtime module. This is
enforced by `tests/forbidden-imports.test.ts`.

## Plugin contract

A harness integration has separate native parsing and canonical transformation
layers:

```text
native artifacts -> harness parser -> typed native model
                  -> harness transformer -> canonical write batch
```

A transformer plugin implements `SessionTransformer<TBundle>`
(`src/plugin/contract.ts`):

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

- **`detect`** — Schema-based detection for manual imports or validation.
  Returns `matched`, `unmatched`, or `ambiguous`. Ambiguous detection is a
  structured error, never first-match behavior.
- **`classifyArtifacts`** — Maps harness-specific artifacts to canonical kinds
  (Skill, Agent, Rule, MCP, Settings, transcript, Sub Agent, etc.) using
  manifest context and path rules.
- **`getCapabilities`** — Declares which metrics are `available`, `partial`,
  `unavailable`, or `incompatible` for this bundle.
- **`transform`** — Produces a `TransformResult` containing normalized evidence,
  session/component summaries, scalar metric values, distributions, a
  configuration snapshot with per-component-type completeness, capabilities,
  provenance, and recoverable/fatal issues.

Manifest harness identity takes precedence over schema detection. All generated
identifiers must be deterministic from stable source identity.

## Registry

`TransformerRegistry` (`src/registry.ts`) manages plugin registration and
resolution:

- **`register(plugin)`** — Registers a plugin by ID and harness names. Throws
  on duplicate plugin ID or harness.
- **`resolve(harness)`** — Returns the transformer for a manifest-declared
  harness. Throws if none is registered.
- **`resolveByDetection(bundle)`** — Schema-based resolution for manual imports.
  Returns `matched`, `unmatched`, or `ambiguous` with candidate list.
- **`ids()` / `harnesses()`** — Enumerate registered plugins and harnesses.

`src/default-registry.ts` provides a default registry pre-populated with the
Claude Code transformer.

## Claude Code transformer

`src/plugin/claude-code.ts` implements `SessionTransformer<ArtifactBundle>` for
Claude Code sessions. It depends on `@lucasschirm/sal-claude-session-parser`
for native parsing and is split into focused modules:

| Module | Responsibility |
|--------|----------------|
| `claude-code.ts` | Main transformer: detection, classification, transform orchestration |
| `claude-code-usage.ts` | Token usage, model requests, invocations, payloads, permissions, modes, hooks |
| `claude-code-metrics.ts` | Phase 1 metric derivation, anti-double-counting, unavailable reasons |
| `claude-code-tasks.ts` | Tasks, validations, file operations, commands, normalized events |

Classification uses normalized full paths and structured content per the plan's
artifact classification table (`.claude/skills/<name>/SKILL.md` → Skill,
`.claude/agents/*.md` → Agent, `.claude/rules/**` → Rule, `.mcp.json` → MCP
configuration, etc.). A structured artifact can yield multiple component
definitions, each with a source pointer.

## Conformance suite

`tests/conformance/suite.ts` exports `runTransformerConformanceSuite`, which
verifies that any `SessionTransformer` obeys the 10 canonical invariants defined
in `src/invariants.ts`:

1. Tool, Skill, Agent, and Sub Agent remain distinct.
2. Unknown is not zero.
3. Exact and estimated values remain separable.
4. Root-only and inclusive values cannot double-count descendants.
5. Starts and results correlate by source ID.
6. Replayed source events deduplicate deterministically.
7. Partial snapshots do not imply removals.
8. Unavailable metrics include a reason.
9. Output is deterministic for the same bundle and versions.
10. Every aggregate retains evidence/provenance links.

Golden fixtures live in `tests/conformance/fixtures/` and include root sessions,
Sub Agent sessions, malformed/partial/redacted/compacted artifacts, and a
synthetic replayed transcript (`fixtures/data/replayed.jsonl`) that exercises
deterministic deduplication.

## Cross-harness comparability

`src/comparability.ts` derives a machine-readable `comparability_group_id` from
metric definition properties: metric ID and definition version, unit, currency/
pricing version, grain, dimensions, denominator, observation unit, population,
session-finality rules, measurement class, native mapping version, root-only/
inclusive semantics, status/threshold/censoring/missing-data rules, and
aggregation/statistical/attribution method. Values, distributions, contributions,
rollups, cohorts, and chart series are keyed by comparability group and cannot
aggregate mixed groups. An exact provider token value is never silently combined
with an estimated text-token value.

## Public API

The package exports from `src/index.ts`:

- **Plugin contract**: `SessionTransformer`, `DetectionResult`,
  `TransformResult`, `TransformContext`.
- **Registry**: `TransformerRegistry`, `RegistryResolution`.
- **Bundle types**: `ArtifactBundle`, `UnknownArtifactBundle`, `Artifact`,
  `ArtifactScope`, `ArtifactStatus`.
- **Classification**: `ArtifactClassificationResult`, `ArtifactKind`,
  `ClassifiedArtifact`, `ClassifierConfidence`.
- **Evidence**: `NormalizedEvidenceRecord`, evidence link types.
- **Metrics**: `ScalarMetricValue`, `Distribution`, `MetricCapability`,
  `MetricUnavailableReason`.
- **Components**: `ComponentIdentity`, `ComponentKind`, `ComponentSummary`,
  `ConfigurationSnapshot`, `ComponentCompleteness`.
- **Comparability**: comparability group derivation functions.
- **Invariants**: `CANONICAL_INVARIANTS`, `CanonicalInvariant`,
  `listCanonicalInvariants`.
- **Provenance**: `Provenance` and provenance link types.
- **Issues**: `Issue`, `DetectionIssue`.
- **Claude Code plugin**: `ClaudeCodeTransformer`.
- **Default registry**: pre-populated `TransformerRegistry` instance.
