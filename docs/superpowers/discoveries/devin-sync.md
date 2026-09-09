# Discoveries — devin-sync fix train

Dated entries recording repeated failure patterns, reusable procedures, and
missing tooling found while working issues in the Devin/Claude sync fix
train. Format: Discovery / Proposed artifact / Location / Status.

---

## 2026-09-06 — `deriveClaudeCodeOptimizationMetrics` exceeds the function-length cap and keeps growing

**Discovery:** `packages/transformers/claude-transformer/src/plugin/claude-code-optimization-metrics.ts`'s
`deriveClaudeCodeMetrics`-adjacent function `deriveClaudeCodeOptimizationMetrics`
was already several hundred lines long (deriving 15+ metric families:
context, cache, compaction, payload, latency, parallelism, validation,
edit-cycle) before issue #377's fix touched it, in violation of
`workspace-rules.md`'s 20-line-target/30-line-hardcap. #377's fix added a
~140-line block (the context/cache derivation) inline to this same function
rather than extracting it, growing the violation further — flagged in
`pr-review` on PR #380 (https://github.com/lucasschirm/session-analyzer/pull/380#discussion_r3942450615)
but deferred rather than fixed under that PR's time pressure, since a
partial extraction (just the new block) would address the letter of the
rule without the substance (the function as a whole), and a full refactor
of the pre-existing sibling blocks risked regressing already-verified-correct
logic right before merge.

**Proposed artifact:** A dedicated task/issue to extract each metric family
in `deriveClaudeCodeOptimizationMetrics` (and its sibling
`deriveClaudeCodeMetrics` in `claude-code-metrics.ts`, likely the same
shape of problem) into its own named function — e.g.
`deriveContextAndCacheMetrics(sorted, censored, rootArtifactId, definitions,
pushMetric)`, `deriveCompactionMetrics(...)`, `derivePayloadMetrics(...)`,
etc. — with the parent function reduced to orchestration (call each,
collect). Needs full regression coverage re-run (not just spot checks)
since it touches the biggest, most metric-dense file in the transformer.

**Location:** `packages/transformers/claude-transformer/src/plugin/claude-code-optimization-metrics.ts`,
`packages/transformers/claude-transformer/src/plugin/claude-code-metrics.ts`.

**Status:** Open — not yet filed as a tracked issue.

---

## 2026-09-06 — `aggregate-usage.ts`'s `accumulateUsage` still zero-fills missing token fields, on code confirmed dead downstream today

**Discovery:** While fixing issue #377 (Claude parser coercing missing/malformed
per-record token fields to `0` instead of `null`), a second, narrower
instance of the same anti-pattern was found and *not* fixed:
`packages/parsers/claude-session-parser/src/session/aggregate-usage.ts`'s
`accumulateUsage` still calls `numOr0` on `usage.input_tokens` /
`output_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens`
when building `ClaudeCodeSession['aggregateUsage']` — even though the
parser now propagates these same fields as `number | null` on the source
`AssistantEntry`. This is a legitimate use of `numOr0` in the narrow sense
that `missing-is-never-zero.md` explicitly permits ("a missing value does
not contribute to a sum"), since `aggregateUsage`'s numeric fields are a
running SUM with no per-record exactness concept — but `aggregateUsage`
itself carries no exactness/completeness flag at all, unlike `model_usage`'s
`tokenValuesExact`, so a caller reading `aggregateUsage.inputTokens` today
has no way to know whether every contributing entry was actually counted.

Traced every consumer (repo-wide grep, confirmed in the #377 `pr-review` on
PR #380 — https://github.com/lucasschirm/session-analyzer/pull/380#discussion_r3942450664):
only `claude-code-metrics.ts`'s `hasUnrecognizedModelCost` reads
`aggregateUsage.models`, and only via `Object.keys(...)` (model name
strings) — the numeric totals (top-level and per-model) are computed but
never read by anything today. Same dormant-code category as `db-core`'s
`ModelRequestStore`/`ModelUsageStore` (deferred to issue #183): a real rule
tension, but not an active bug, since nothing currently trusts the number.

**Proposed artifact:** A follow-up issue to decide, then implement, one of:
(a) give `ClaudeCodeSession['aggregateUsage']` its own exactness signal
(mirroring `tokenValuesExact`) alongside keeping `numOr0`'s sum semantics,
or (b) make `aggregateUsage`'s fields `number | null`-aware end to end if a
future consumer needs the missing-vs-zero distinction at the session-total
grain, not just the per-record grain `model_usage` already covers. Do not
fix by reflex — confirm at issue-open time whether a real consumer has
since appeared (check `hasUnrecognizedModelCost` and any new caller of
`session.aggregateUsage` first).

**Location:** `packages/parsers/claude-session-parser/src/session/aggregate-usage.ts`.

**Status:** Open — not yet filed as a tracked issue. Currently dead
downstream; re-check consumers before prioritizing.
