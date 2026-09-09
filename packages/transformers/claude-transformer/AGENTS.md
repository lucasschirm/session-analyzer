# packages/transformers/claude-transformer/

Claude Code session transformer plugin for the Session Analyzer analytics
platform: artifact classification, evidence normalization, and metric
derivation for Claude Code sessions.

Package name: `@lucasschirm/sal-claude-transformer`

This package was split out of the original `packages/transformer` (see
`docs/architecture/adr/0001-package-boundaries.md` amendment). It implements
`SessionTransformer<TBundle>` from `@lucasschirm/sal-transformer-shared` and
depends on `@lucasschirm/sal-claude-session-parser` for native parsing. The
`claude-code-*.ts` cluster moved here as one atomic unit — it is internally
cross-referential and must not be split across packages.

## Source layout

```
src/
├── index.ts                              # Public barrel export
└── plugin/
    ├── index.ts                          # Plugin barrel export
    ├── claude-code.ts                    # ClaudeCodeTransformer — detection, classification, transform orchestration
    ├── claude-code-usage.ts              # Token usage, model requests, invocations, payloads, permissions, modes, hooks
    ├── claude-code-metrics.ts            # Phase 1 metric derivation, anti-double-counting, unavailable reasons
    ├── claude-code-optimization-metrics.ts  # Optimization metric derivation
    ├── claude-code-attribution-metrics.ts   # Attribution metric derivation and allocation methods
    ├── claude-code-tasks.ts              # Tasks, validations, file operations, commands, normalized events
    └── metric-labels.ts                  # Metric ID -> label lookup, built from an injected set of MetricDefinitions
```

`MetricDefinition` itself is not defined here — it was promoted to
`@lucasschirm/sal-transformer-shared` (`src/metric.ts`) so it is available to
every transformer plugin package. `claude-code-metrics.ts` re-exports it for
this package's own internal imports.

## Test layout

```
tests/
├── forbidden-imports.test.ts       # Asserts no db-core/db/site/SQLite imports in src/
├── conformance/
│   └── fixtures/
│       ├── AGENTS.md               # See fixtures/AGENTS.md
│       ├── index.ts                # Claude-specific golden fixtures, built on transformer-shared's generic fixture contract
│       └── data/replayed.jsonl     # Synthetic replayed transcript for dedup tests
└── unit/
    ├── AGENTS.md                   # See unit/AGENTS.md
    ├── claude-code.test.ts         # ClaudeCodeTransformer integration tests
    ├── claude-code-metrics.test.ts # Metric derivation and anti-double-counting
    ├── claude-code-optimization-metrics.test.ts
    ├── claude-code-attribution-metrics.test.ts
    ├── claude-code-tasks.test.ts   # Task-derived evidence records
    ├── claude-code-usage.test.ts   # Model usage, invocations, payloads, permissions, hooks
    └── conformance.test.ts         # Runs the shared conformance suite (transformer-shared's /conformance subpath) against ClaudeCodeTransformer
```

## Key invariants

- **Pure and deterministic**: same bundle + versions → same output. No SQLite,
  no remote storage, no project history queries, no lifecycle event emission.
- **Manifest harness takes precedence** over schema detection. Ambiguous
  detection is a structured error, never first-match.
- **Passes the shared conformance suite** (`@lucasschirm/sal-transformer-shared/conformance`)
  against its golden fixtures — required before this plugin can be registered
  or loaded by `packages/db` ingestion (`.agents/rules/harness-plugins-conformance.md`).
- **Deterministic IDs** from stable source identity, not call order or
  wall-clock time.

## Key relationships

- Depends on `@lucasschirm/sal-transformer-shared` for the `SessionTransformer`
  contract, all normalized types, and the conformance suite.
- Depends on `@lucasschirm/sal-claude-session-parser` for native parsing.
- Registered into a `TransformerRegistry` by
  `packages/transformers/registry` (`@lucasschirm/sal-transformer-registry`),
  not by this package itself — this package exports the plugin, it does not
  compose a registry.
- Does not import `db-core`, `db`, `site`, or any SQLite/runtime module.
