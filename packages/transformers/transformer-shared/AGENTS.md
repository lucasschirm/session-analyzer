# packages/transformers/transformer-shared/

Harness-agnostic session transformer contract layer, registry, and
conformance suite for the Session Analyzer analytics platform.

Package name: `@lucasschirm/sal-transformer-shared`

This package is the contract layer split out of the original
`packages/transformer` (see `docs/architecture/adr/0001-package-boundaries.md`
amendment). It has no harness parser dependency and no knowledge of any
specific harness plugin — `packages/transformers/claude-transformer/` and a
future `packages/transformers/devin-transformer/` (DS-F7 / #149) both depend
on this package, never the other way around.

## Source layout

```
src/
├── index.ts                   # Public barrel export
├── bundle.ts                  # ArtifactBundle, UnknownArtifactBundle, Artifact, ArtifactScope/Status types
├── classification.ts          # ArtifactClassificationResult, ArtifactKind, ClassifiedArtifact, ClassifierConfidence
├── component.ts                # ComponentIdentity, ComponentKind, ComponentSummary, ConfigurationSnapshot, ComponentCompleteness
├── context.ts                 # TransformContext
├── comparability.ts           # Comparability group derivation from metric definition properties
├── evidence.ts                # NormalizedEvidenceRecord and evidence link types
├── invariants.ts              # 10 canonical invariants (CANONICAL_INVARIANTS, listCanonicalInvariants)
├── issue.ts                   # Issue, DetectionIssue, issue severity types
├── metric.ts                  # ScalarMetricValue, Distribution, MetricCapability, MetricUnavailableReason, MetricDefinition
├── provenance.ts              # Provenance and provenance link types
├── session.ts                 # SessionSummary and session-level transform output types
├── registry.ts                # TransformerRegistry — plugin registration and resolution
├── conformance/                # Public subpath export: @lucasschirm/sal-transformer-shared/conformance
│   ├── index.ts                # Barrel re-exporting suite.ts and fixtures/index.ts
│   ├── suite.ts                # runTransformerConformanceSuite — 10 canonical invariants
│   └── fixtures/
│       └── index.ts            # Generic ConformanceFixture/TransformerFixtures contract types
└── plugin/
    ├── index.ts                # Plugin barrel export
    └── contract.ts             # SessionTransformer<TBundle>, DetectionResult, TransformResult
```

## Test layout

```
tests/
├── forbidden-imports.test.ts       # Asserts no db-core/db/site/SQLite imports in src/
└── unit/
    ├── AGENTS.md                   # See unit/AGENTS.md
    ├── base-contract-conformance.test.ts  # Conformance suite against a base-contract-only fixture transformer (DS-B1 / #139 regression)
    ├── comparability.test.ts       # Comparability group semantics
    ├── contract.test.ts            # Transformer contract and registry integration
    ├── invariants.test.ts          # Canonical invariant definitions
    └── registry.test.ts            # Registry and detection heuristics
```

Claude Code-specific tests (`claude-code*.test.ts`, `conformance.test.ts`,
Claude conformance fixtures/data) live in
`packages/transformers/claude-transformer/tests/`, not here.

## Key invariants

- **Pure and deterministic**: same bundle + versions → same output. No SQLite,
  no remote storage, no project history queries, no lifecycle event emission.
- **No harness-specific code**: this package has no dependency on any harness
  parser and defines no harness-specific transformer plugin.
- **Manifest harness takes precedence** over schema detection in every plugin
  built on `SessionTransformer<TBundle>`. Ambiguous detection is a structured
  error, never first-match.
- **10 canonical invariants** enforced by the conformance suite, exported as
  the public subpath `@lucasschirm/sal-transformer-shared/conformance` so any
  transformer plugin package (in-tree or future) can consume it without a
  `tests/`-relative reach-through into a sibling package.
- **Deterministic IDs** from stable source identity, not call order or
  wall-clock time.
- **Cross-harness comparability**: metrics keyed by `comparability_group_id`;
  mixed groups never aggregate.

## Key relationships

- No dependencies on any harness parser or transformer plugin package.
- Imported by every transformer plugin package (`claude-transformer` today,
  `devin-transformer` per DS-F7 / #149) for contract types and the
  conformance suite.
- Imported by `packages/transformers/registry` (composition root) for
  `TransformerRegistry`.
- Imported by `packages/db` for transformer selection and write-batch
  validation (contract types only — the registry is injected by the caller).
- Does not import `db-core`, `db`, `site`, or any SQLite/runtime module.
