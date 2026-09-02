# Harnesses Architecture

Native-to-canonical mappings, transformer plugin contract, and known
limitations for each supported harness integration.

## Overview

Each harness integration has two separate layers:

```text
native artifacts -> harness parser -> typed native model
                  -> harness transformer -> canonical write batch
```

The parser produces a typed native model from raw artifacts. The transformer
normalizes that model into canonical evidence, metrics, and configuration
snapshots. Parsers and transformers are separate packages so that a parser can
be reused without pulling in the transformation framework, and so that
transformer plugins remain pure and deterministic.

## Transformer plugin contract

A transformer plugin implements `SessionTransformer<TBundle>` (see
`packages/transformers/transformer-shared/src/plugin/contract.ts`):

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

- **`detect`** — Schema-based detection. Returns `matched`, `unmatched`, or
  `ambiguous`. Used for manual imports or validation; manifest harness identity
  takes precedence.
- **`classifyArtifacts`** — Maps harness-specific paths and content to canonical
  artifact kinds.
- **`getCapabilities`** — Declares metric support (`available`, `partial`,
  `unavailable`, `incompatible`) for this bundle.
- **`transform`** — Produces normalized evidence, summaries, metric values,
  distributions, configuration snapshot, capabilities, provenance, and issues.

All generated identifiers must be deterministic from stable source identity.

## Registry

`TransformerRegistry` (`packages/transformers/transformer-shared/src/registry.ts`) manages plugins.
The default registry composing every transformer plugin package lives in
`packages/transformers/registry/src/default-registry.ts`
(`@lucasschirm/sal-transformer-registry`):

- `register(plugin)` — Registers by ID and harness names.
- `resolve(harness)` — Manifest-declared harness resolution.
- `resolveByDetection(bundle)` — Schema-based resolution for manual imports.
  Ambiguous detection returns all candidates; the caller must resolve.

## Claude Code

**Plugin**: `ClaudeCodeTransformer` (`packages/transformers/claude-transformer/src/plugin/claude-code.ts`)
**Parser**: `@lucasschirm/sal-claude-session-parser`
**Harness ID**: `claude_code`

### Artifact classification

Classification uses normalized full paths and structured content:

| Scope/path | Classification |
|------------|---------------|
| `.claude/skills/<name>/SKILL.md` and related files | Skill definition/resource |
| `.claude/agents/*.md` | Agent definition |
| `.claude/rules/**` | Rule |
| `CLAUDE.md`, global Claude instruction files | Rule/memory |
| `.mcp.json` | MCP configuration (zero or more servers) |
| `.claude/settings.json` | Settings and contributed plugin/hook configuration |
| `.claude/settings.local.json` | Project-local settings |
| global `.claude.json` | Global settings/MCP configuration |
| manifest main transcript path | Root transcript |
| `subagents/*.jsonl` | Sub Agent transcript |
| `subagents/*.meta.json` | Sub Agent metadata |
| unmatched supported-scope path | Unclassified with reason |

A structured artifact can yield multiple component definitions. Each extracted
component retains a source pointer (JSON Pointer or text range).

### Metric capabilities

| Metric family | Capability | Notes |
|---------------|------------|-------|
| Token usage (input/output/cache) | Available | Exact provider-observed values from `message_start`/usage events |
| Cost | Available | Computed from pricing versions and observed token classes |
| Tool/Skill/Agent invocations | Available | From `tool_use`/`tool_result` blocks; Skill and Agent excluded from generic tool pool |
| Sub Agent metrics | Partial | Requires Sub Agent transcript; launch evidence retained when transcript is missing |
| File operations | Available | From tool parameters (Read/Write/Edit/Create/Delete/Rename) |
| Command executions | Available | From Bash tool invocations |
| Context/compaction | Available | From cache_creation/cache_read events and compact_boundary markers |
| Validation | Available | From todo_write and task validation events |
| Configuration lifecycle | Partial | Requires manifest v3 for finality and tombstones; older manifests produce partial snapshots |

### Known limitations

- **Manifest v2 completeness**: The current manifest v2 does not prove an
  exhaustive configuration snapshot and therefore cannot prove removal. A
  manifest v3 revision is a prerequisite for lifecycle-removal and
  offered-versus-unused metrics.
- **Sub Agent transcript link**: There is no exact `tool_use` ↔ Sub Agent
  transcript link in the native data. Sub Agent placement is chronological
  best-effort.
- **Estimated token counts**: A tokenizer can make captured-text token counts
  exact under a named tokenizer/method, but this does not turn them into
  provider-observed request usage.
- **Global configuration scope**: A global artifact can be observed by sessions
  in many projects. One global update creates one environment lifecycle event
  and project/session exposure intervals; it is not duplicated per project.

## Devin CLI

**Plugin**: `DevinTransformer` (`packages/transformers/devin-transformer/src/devin-transformer.ts`)
**Parser**: `@lucasschirm/sal-devin-session-parser`
**Harness ID**: `devin`

### Artifact classification

Classification uses the bundle's path conventions and, where available,
schema-validated content:

| Scope/path | Classification |
|------------|---------------|
| `transcript.jsonl` | Session transcript |
| `native/atif-transcript.json` | Native ATIF transcript (role: `native`) |
| `native/models.json` | Settings/runtime, role: `models` |
| `native/schema-descriptor.json` | Settings/runtime, role: `schema` |
| `native/models-list.raw.json` | Settings/runtime, role: `models-raw` |
| `plans/plan-<id>.md` | Session transcript, role: `plan` |
| `.devin/config.json`, `config.json` | Settings (workspace/global) |

### Metrics

Phase 1 emits the following comparability groups: token counts (prompt,
completion, cached, total), step and turn counts, tool/skill/agent
invocations, wall-clock duration, and total cost. Token counts are exact
when `ATIF-v1.7` `final_metrics` or `response_dimensions` are present; skill
and agent counts and session cost require follow-on parser work.

## Future harnesses

The transformer plugin contract and conformance suite are designed for
extensibility. Adding a new harness requires:

1. A harness-specific parser package (pure, dependency-free).
2. A transformer plugin implementing `SessionTransformer<TBundle>`.
3. Artifact classification rules for the harness's path conventions.
4. Capability declarations for supported/partial/unavailable metrics.
5. Golden fixtures and conformance suite passage.
6. Registry registration.

See the `add-harness-integration` skill (`.agents/skills/add-harness-integration/`)
for scaffolding, detection, classification, capability mapping, fixtures,
registration, and conformance guidance.

## Conformance suite

Every transformer plugin must pass the shared conformance suite, published as
the public subpath `@lucasschirm/sal-transformer-shared/conformance`
(`packages/transformers/transformer-shared/src/conformance/suite.ts`),
proving the 10 canonical invariants:

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

## References

- Plan: `docs/superpowers/plans/2026-08-24-analytics-data-platform-design.md` §6 (Transformer plugin and comparability contract), §7 (Manifest-driven artifacts)
- ADR-0003: Component identity
- ADR-0004: Manifest authority
- ADR-0006: Metric versioning
- Implementation: `packages/transformers/claude-transformer/src/plugin/`, `packages/transformers/devin-transformer/src/`, `packages/transformers/transformer-shared/src/registry.ts`, `packages/transformers/transformer-shared/src/classification.ts`
