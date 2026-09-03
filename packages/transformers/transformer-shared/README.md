# `@lucasschirm/sal-transformer-shared`

Harness-agnostic session transformer contract layer, registry, and
conformance suite for the Session Analyzer analytics platform.

## Purpose

`transformer-shared` defines the canonical contract between harness-specific
transformer plugins (`@lucasschirm/sal-claude-transformer`, and a future
`devin-transformer`, DS-F7 / #149) and the rest of the analytics platform. It
has no harness parser dependency and defines no harness-specific plugin — it
is the pure normalization framework the plugins implement, not a plugin
itself.

The package is **pure and deterministic**: the same bundle and versions always
produce the same output. All generated identifiers are deterministic from
stable source identity, not call order or wall-clock time.

## Dependency matrix

```text
transformer-shared -> (no harness parser dependency)
claude-transformer  -> transformer-shared + claude parser
transformer-registry -> transformer-shared + claude-transformer (+ future harness transformer packages)
db          -> transformer-shared (contract types only) + db-core + narrow sync-core manifest contracts
site runtime -> transformer-registry (composition) + db + db-core adapter contracts + sync/source adapters
site pages  -> AnalyticsDataSource DTO/client contracts only
```

`transformer-shared` imports nothing from `db-core`, `db`, `site`, or any
SQLite/runtime module, and no harness parser. This is enforced by
`tests/forbidden-imports.test.ts`.

## Plugin contract

A harness integration has separate native parsing and canonical
transformation layers:

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

This package does not compose a default registry — that composition root
(wiring `TransformerRegistry` together with every transformer plugin package)
lives in `packages/transformers/registry`
(`@lucasschirm/sal-transformer-registry`), which depends on this package plus
every transformer plugin. Keeping composition out of `transformer-shared`
avoids a dependency from the contract layer onto any specific plugin.

## Conformance suite

`src/conformance/suite.ts` exports `runTransformerConformanceSuite`, published
as the public subpath `@lucasschirm/sal-transformer-shared/conformance` so any
transformer plugin package can import it directly rather than reaching into
this package's `tests/` directory. It verifies that any `SessionTransformer`
obeys the 10 canonical invariants defined in `src/invariants.ts`:

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

The suite treats `ScalarMetricValue`'s extended fields (`provenance`,
`evidenceRecordIds`, `unavailableReason`) as optional, falling back to the
base contract (`provenanceArtifactId`, `TransformResult.unavailableReasons`)
so a spec-conformant plugin that does not extend `ScalarMetricValue` (as
Claude's `ClaudeMetricValue` does) still passes (DS-B1 / #139).

The generic fixture contract types (`ConformanceFixture<TBundle>`,
`TransformerFixtures<TBundle>`) live in `src/conformance/fixtures/index.ts`.
Golden fixture *data* (the actual fixture bundles and payloads) is
harness-specific and lives in each transformer plugin package's own
`tests/conformance/fixtures/` (e.g.
`packages/transformers/claude-transformer/tests/conformance/fixtures/`).

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
  `MetricUnavailableReason`, `MetricDefinition`.
- **Components**: `ComponentIdentity`, `ComponentKind`, `ComponentSummary`,
  `ConfigurationSnapshot`, `ComponentCompleteness`.
- **Comparability**: comparability group derivation functions.
- **Invariants**: `CANONICAL_INVARIANTS`, `CanonicalInvariant`,
  `listCanonicalInvariants`.
- **Provenance**: `Provenance` and provenance link types.
- **Issues**: `Issue`, `DetectionIssue`.

The subpath `@lucasschirm/sal-transformer-shared/conformance` additionally
exports `runTransformerConformanceSuite`, `ConformanceFixture`,
`TransformerFixtures`, `InvariantReport`, and `ConformanceRunResult`.
