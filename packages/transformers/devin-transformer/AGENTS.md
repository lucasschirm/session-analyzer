# packages/transformers/devin-transformer/

Devin CLI session transformer plugin for the Session Analyzer analytics
platform: artifact classification, canonical subagent decomposition, evidence
normalization, and metric derivation for Devin sessions.

Package name: `@lucasschirm/sal-devin-transformer`

This package implements `SessionTransformer<TBundle>` from
`@lucasschirm/sal-transformer-shared` and depends on
`@lucasschirm/sal-devin-session-parser` for native parsing. It transforms
Devin CLI artifacts (`transcript.jsonl`, `native/models.json`,
`native/schema-descriptor.json`, `native/atif-transcript.json`, and config files)
into normalized evidence records and metrics.

## Source layout

```
src/
├── index.ts                 # Public barrel export
├── devin-transformer.ts     # DevinTransformer — detection, classification, transform orchestration
├── session-spine.ts         # Spine, turn, message evidence records, and deterministic id derivation
├── subagent-spine.ts        # Decomposition of subagent branches into canonical child sessions
├── subagent-evidence.ts     # Legacy/fallback subagent turn and detached conversation evidence
├── tool-invocations.ts      # Tool, skill, and agent invocation evidence records
├── token-usage.ts           # Token usage and model_usage evidence records
├── session-components.ts    # Session component derivation (cogs, tools, agents, invoked components)
├── component-evidence-links.ts # Attributes invocations back to the components they used
├── message-classification.ts   # Per-message Tool / Skill / Agent domain classification
├── config-components.ts     # File-backed skill, agent, rule components
├── compaction.ts            # Compaction evidence records
├── effort.ts                # Reasoning effort extraction and normalization
├── capabilities.ts          # Metric capability declarations
├── classification.ts        # Devin artifact classifier and completeness
├── conformance-profile.ts   # Conformance profile configuration for shared suite
├── parse-bundle.ts          # Bundle parsing, transcript ordering, and line deduplication
└── metrics/                 # Metric definitions, comparability, and derivation
```

## Test layout

```
tests/
├── forbidden-imports.test.ts # Asserts no db-core/db/site/SQLite imports in src/
├── conformance/              # Shared conformance suite runners and golden fixtures
└── unit/                     # Unit tests for spine, tools, tokens, components, metrics
```

## Key invariants

- **Pure and deterministic**: same bundle + versions → same output. No SQLite,
  no remote storage, no project history queries, no lifecycle event emission.
- **Canonical Subsession Decomposition**: Subagents executed via `run_subagent`
  are decomposed into canonical child sessions (`sessions`, `session_summaries`,
  `session_relations`) with their own lifecycle, messages, and tool invocations.
- **Metric Disjointness**: Root-only metrics (`root_only`) measure strictly root-agent
  activity (excluding child tool calls and subagent tokens). Child sessions
  measure strictly their own activity. Inclusive metrics (`inclusive`) sum across
  the session tree.
- **Tool Invocations from Subagent Message Nodes**: In Devin, subagents execute tools
  recorded in `chat_message.tool_calls` (OpenAI format) with results in `role: "tool"`
  messages. These are extracted as canonical `invocation` and `payload` records scoped
  to the child session id.
- **Session failure isolation**: A transformation error in one session must produce
  structured issues and never impede or crash transformation of other sessions.
- **Usage is always attributable**: every root-session `invocation` emits a
  `component_evidence_link` to a component that exists in `componentSummaries`,
  and every invoked tool/skill/agent gets a component identity of its own.
  Declared availability is never a prerequisite for something that ran —
  otherwise `session_component_stats` stays empty and the Available / Used /
  Unused views report every component as unused (`component-evidence-links.ts`,
  `extractInvokedComponents` in `session-components.ts`).

## Key relationships

- Depends on `@lucasschirm/sal-transformer-shared` for the `SessionTransformer`
  contract, all normalized types, and the conformance suite.
- Depends on `@lucasschirm/sal-devin-session-parser` for native parsing.
- Registered into `TransformerRegistry` by `packages/transformers/registry`.
- Does not import `db-core`, `db`, `site`, or any SQLite/runtime module.
