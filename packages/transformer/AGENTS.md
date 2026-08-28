# packages/transformer/

Pure, deterministic session transformation plugin framework and metric contracts
for the Session Analyzer analytics platform.

Package name: `@lucasschirm/sal-transformer`

## Source layout

```
src/
├── index.ts                   # Public barrel export
├── bundle.ts                  # ArtifactBundle, UnknownArtifactBundle, Artifact, ArtifactScope/Status types
├── classification.ts          # ArtifactClassificationResult, ArtifactKind, ClassifiedArtifact, ClassifierConfidence
├── component.ts               # ComponentIdentity, ComponentKind, ComponentSummary, ConfigurationSnapshot, ComponentCompleteness
├── context.ts                 # TransformContext
├── comparability.ts           # Comparability group derivation from metric definition properties
├── evidence.ts                # NormalizedEvidenceRecord and evidence link types
├── invariants.ts              # 10 canonical invariants (CANONICAL_INVARIANTS, listCanonicalInvariants)
├── issue.ts                   # Issue, DetectionIssue, issue severity types
├── metric.ts                  # ScalarMetricValue, Distribution, MetricCapability, MetricUnavailableReason
├── provenance.ts              # Provenance and provenance link types
├── session.ts                 # SessionSummary and session-level transform output types
├── registry.ts                # TransformerRegistry — plugin registration and resolution
├── default-registry.ts        # Default registry pre-populated with ClaudeCodeTransformer
└── plugin/
    ├── index.ts               # Plugin barrel export
    ├── contract.ts            # SessionTransformer<TBundle>, DetectionResult, TransformResult
    ├── claude-code.ts         # ClaudeCodeTransformer — detection, classification, transform orchestration
    ├── claude-code-usage.ts   # Claude Code: token usage, model requests, invocations, payloads, permissions, modes, hooks
    ├── claude-code-metrics.ts # Claude Code: Phase 1 metric derivation, anti-double-counting, unavailable reasons
    └── claude-code-tasks.ts   # Claude Code: tasks, validations, file ops, commands, normalized events
```

## Test layout

```
tests/
├── forbidden-imports.test.ts       # Asserts no db-core/db/site/SQLite imports in src/
├── conformance/
│   ├── AGENTS.md                   # See conformance/AGENTS.md
│   ├── suite.ts                    # runTransformerConformanceSuite — 10 canonical invariants
│   └── fixtures/
│       ├── AGENTS.md               # See fixtures/AGENTS.md
│       ├── index.ts                # Golden fixtures and TransformerFixtures contract
│       └── data/replayed.jsonl     # Synthetic replayed transcript for dedup tests
└── unit/
    ├── AGENTS.md                   # See unit/AGENTS.md
    ├── claude-code.test.ts         # ClaudeCodeTransformer integration tests
    ├── claude-code-metrics.test.ts # Metric derivation and anti-double-counting
    ├── claude-code-tasks.test.ts   # Task-derived evidence records
    ├── claude-code-usage.test.ts   # Model usage, invocations, payloads, permissions, hooks
    ├── comparability.test.ts       # Comparability group semantics
    ├── conformance.test.ts         # Runs conformance suite against ClaudeCodeTransformer
    ├── contract.test.ts            # Transformer contract and registry integration
    ├── invariants.test.ts          # Canonical invariant definitions
    └── registry.test.ts            # Registry and detection heuristics
```

## Key invariants

- **Pure and deterministic**: same bundle + versions → same output. No SQLite,
  no remote storage, no project history queries, no lifecycle event emission.
- **Manifest harness takes precedence** over schema detection. Ambiguous
  detection is a structured error, never first-match.
- **10 canonical invariants** enforced by the conformance suite.
- **Deterministic IDs** from stable source identity, not call order or
  wall-clock time.
- **Cross-harness comparability**: metrics keyed by `comparability_group_id`;
  mixed groups never aggregate.

## Key relationships

- Depends on `@lucasschirm/sal-claude-session-parser` (Claude Code plugin only).
- Imported by `packages/db` for transformer selection and write-batch validation.
- Does not import `db-core`, `db`, `site`, or any SQLite/runtime module.
- The conformance suite is shared: any future harness plugin must pass it.
