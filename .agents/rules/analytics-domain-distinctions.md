---
globs: "packages/transformers/**,packages/db/**,packages/site/src/**,packages/plugins/**"
---

# Analytics Domain Distinctions (Tool / Skill / Agent / Sub Agent)

**When to use this rule:**

- When normalizing events, deriving metrics, building indicators, or rendering UI that references Tool, Skill, Agent, or Sub Agent concepts.

**Invariants (non-negotiable):**

- Tool, Skill, Agent, and Sub Agent are four distinct domains. They are never conflated in code, metrics, schema, or UI copy.
- A **Skill** describes how something works and how to execute a set of tasks (Claude Code tool name `Skill`).
- An **Agent** describes how to execute a specific task step by step (Claude Code tool name `Agent`).
- A **Tool** is a project tool whose availability can depend on session mode (e.g. planning mode forbids content-editing tools).
- A **Sub Agent** is a sub-session that executes its own tools, agents, and skills to complete a specific goal — distinct from the `Agent` indicator. Regardless of native harness layout (e.g. separate `subagents/agent-<id>.jsonl` files or single-store detached branches), every subagent must be normalized into a dedicated canonical child session.
- **Canonical Subsession Decomposition**: The transformer must decompose native subagent activity into an independent child `SessionSummary` and canonical `session` record linked to its parent/root via `session_relation` (`nativeInclusionSemantics: 'subagent'`). Subagent child sessions receive their own scoped `turn`, `message`, and tool `invocation` records (plus `model_usage` when reported per-subagent by the harness).
- **Metric Disjointness**: Subsession metrics must never be merged into the parent session's `root_only` metrics. Parent `root_only` metrics measure strictly root-agent activity; the child subsession measures its own activity. Descendant metrics aggregate only under rollups and `inclusive` scope metrics.
- Skill and Agent invocations are excluded from the generic "tool call" pool (`Tools Used` metric, `tools` indicator); they have their own dedicated metrics and pages.
- Native harness terms are mapped to these four domains via the transformer's capability mapping; never invent a fifth domain in site or db code.
