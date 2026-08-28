---
globs: "packages/transformer/**,packages/db/**,packages/site/src/**,packages/plugins/**"
---

# Analytics Domain Distinctions (Tool / Skill / Agent / Sub Agent)

**When to use this rule:**

- When normalizing events, deriving metrics, building indicators, or rendering UI that references Tool, Skill, Agent, or Sub Agent concepts.

**Invariants (non-negotiable):**

- Tool, Skill, Agent, and Sub Agent are four distinct domains. They are never conflated in code, metrics, schema, or UI copy.
- A **Skill** describes how something works and how to execute a set of tasks (Claude Code tool name `Skill`).
- An **Agent** describes how to execute a specific task step by step (Claude Code tool name `Agent`).
- A **Tool** is a project tool whose availability can depend on session mode (e.g. planning mode forbids content-editing tools).
- A **Sub Agent** is a sub-session transcript (`subagents/agent-<id>.jsonl`) with its own tools, agents, and skills — distinct from the `Agent` indicator.
- Skill and Agent invocations are excluded from the generic "tool call" pool (`Tools Used` metric, `tools` indicator); they have their own dedicated metrics and pages.
- Native harness terms are mapped to these four domains via the transformer's capability mapping; never invent a fifth domain in site or db code.
