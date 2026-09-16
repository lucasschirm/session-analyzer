import type { ConformanceProfile } from '@lucasschirm/sal-transformer-shared/conformance';

/**
 * Devin's harness expectations for the shared conformance suite (#308).
 *
 * Divergences from the claude default, each grounded in the harness's real
 * model rather than convenience:
 * - Metric ids are `devin:`-prefixed.
 * - A complete fixture exhibits `skill`/`tool`/`agent` components (derived
 *   at transform time from `cogs_json` + `tool_call_state`, DS-F11 (#288)).
 * - `classifyArtifacts` ALSO emits `skill`/`agent`/`rule` components
 *   (classify-time, file-backed — `.devin/skills|agents|rules/**` and
 *   friends, #342); `mcp` extraction stays out of scope (#271 excludes MCP
 *   config from sync entirely) and `settings` components aren't extracted
 *   from config files today. `classificationComponentKinds` lists exactly
 *   the three classify-time kinds so `checkPartialSnapshotsDoNotImplyRemovals`
 *   asserts the enriched `partial-classification` fixture retains them
 *   alongside its unclassified artifact.
 * - Sub Agent evidence is inline (`subagent_turn`/`detached_conversation`
 *   normalized events, DS-B28 (#294)) — Devin sub-agents are not distinct
 *   sessions, so there are no `session_relation` records or child session
 *   ids by design.
 * - Invocation payloads carry `name` for both skills and agents.
 * - Token identity: `model_usage.inputTokens` is cache-EXCLUSIVE (the shared
 *   payload contract claude already uses), with the cached subset carried
 *   in `cacheReadTokens`. `devin:tokens:total` = prompt + completion where
 *   prompt = input + cached, so the per-record token identity is the same
 *   four-field sum claude uses
 *   (`inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens`).
 *   This replaced the earlier `inputTokens = prompt` (cache-inclusive)
 *   shape, which made the generic `context-timing` sum of input + cacheRead
 *   double-count the cache reads.
 * - Count families: only `turns:count` exists today (file operations,
 *   commands, and validations are tracked as #360).
 */
export const DEVIN_CONFORMANCE_PROFILE: ConformanceProfile = {
  metricPrefix: 'devin',
  completeComponentKinds: ['skill', 'tool', 'agent'],
  classificationComponentKinds: ['skill', 'agent', 'rule'],
  subagentEvidence: 'inline-events',
  inlineSubagentCategories: ['subagent_turn', 'detached_conversation'],
  skillNameField: 'name',
  agentNameField: 'name',
  totalTokenFields: ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens'],
  countMetricFamilies: [['turns:count', 'turn']],
};
