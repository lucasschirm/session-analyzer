import type { DevinCog, DevinToolCallLine } from '@lucasschirm/sal-devin-session-parser';
import { parseDevinCogsJson } from '@lucasschirm/sal-devin-session-parser';
import type { ComponentIdentity, ComponentSummary } from '@lucasschirm/sal-transformer-shared';
import { stableId } from './session-spine.js';

/**
 * Derives `Skill`/`Tool`(MCP-wrapper-availability)/`Agent` `ComponentSummary`
 * records from `sessions.cogs_json` and `tool_call_state` (DS-F11 (#288)
 * research findings §1-4).
 *
 * These components have no backing file — unlike Claude's skills/agents,
 * which are keyed on harness+scope+path+content hash
 * (`.agents/rules/component-identity-not-display-name.md`). Absent a path
 * or hash, `componentId` is instead keyed on the harness-scoped ingestion
 * `sourceId` (never the session id) plus `kind` and the native
 * skill/tool/agent name — `stableId(kind, {source, name})`, mirroring how
 * `claude-transformer`'s `extractSkillComponent`/`extractAgentComponent`
 * key `componentId` on `source.ingestionSourceId` (not the session) so the
 * same skill/agent invoked across many sessions from the same source
 * resolves to one stable identity instead of a fresh one per session.
 * `sourceArtifactIds` still points at the whole-transcript `rootArtifactId`
 * — the only artifact that actually exists for these components.
 */

const MCP_WRAPPER_TOOL_NAMES: ReadonlySet<string> = new Set([
  'mcp_call_tool',
  'mcp_list_servers',
  'mcp_list_tools',
  'mcp_read_resource',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function componentIdentity(
  componentId: string,
  nativeId: string,
  provider?: string,
): ComponentIdentity {
  return {
    canonicalId: componentId,
    nativeId,
    displayName: nativeId,
    provider,
    integration: 'devin',
  };
}

function skillNames(cogs: readonly DevinCog[]): Set<string> {
  const names = new Set<string>();
  for (const cog of cogs) {
    if (cog.lifetime.namespace === 'skill' && cog.lifetime.name) names.add(cog.lifetime.name);
  }
  return names;
}

/** One `kind: 'skill'` component per distinct `skill/<name>` lifetime cog. */
export function extractSkillComponents(
  sourceId: string,
  cogs: readonly DevinCog[],
  rootArtifactId: string,
): ComponentSummary[] {
  return [...skillNames(cogs)].map((name) => {
    const componentId = stableId('skill', { source: sourceId, name });
    return {
      componentId,
      kind: 'skill',
      identity: componentIdentity(componentId, name),
      sourceArtifactIds: [rootArtifactId],
    };
  });
}

function mcpWrapperToolNames(cogs: readonly DevinCog[]): Set<string> {
  const names = new Set<string>();
  for (const cog of cogs) {
    if (cog.toolAvailability?.mode !== 'allow') continue;
    for (const name of cog.toolAvailability.names) {
      if (MCP_WRAPPER_TOOL_NAMES.has(name)) names.add(name);
    }
  }
  return names;
}

/**
 * One `kind: 'tool'` component per distinct MCP wrapper tool name found in
 * any cog's `toolAvailability.mode === 'allow'` list. Only the 4 MCP wrapper
 * names are promoted (DS-F11 (#288) research findings §4's noise-avoidance
 * decision) — the other ~23 always-identical built-in tool names in the
 * same AllowList are not promoted to components.
 */
export function extractMcpToolComponents(
  sourceId: string,
  cogs: readonly DevinCog[],
  rootArtifactId: string,
): ComponentSummary[] {
  return [...mcpWrapperToolNames(cogs)].map((name) => {
    const componentId = stableId('tool', { source: sourceId, name });
    return {
      componentId,
      kind: 'tool',
      identity: componentIdentity(componentId, name, 'mcp'),
      sourceArtifactIds: [rootArtifactId],
    };
  });
}

function subagentProfile(call: DevinToolCallLine): string | null {
  const rawInput = call.call?.rawInput;
  if (!isRecord(rawInput) || typeof rawInput.profile !== 'string') return null;
  return rawInput.profile;
}

function subagentProfiles(toolCalls: readonly DevinToolCallLine[]): Set<string> {
  const profiles = new Set<string>();
  for (const call of toolCalls) {
    if (call.update?.inferenceToolName !== 'run_subagent') continue;
    const profile = subagentProfile(call);
    if (profile) profiles.add(profile);
  }
  return profiles;
}

/**
 * One `kind: 'agent'` component per distinct `rawInput.profile` among
 * `run_subagent` tool calls — sourced from `tool_call_state`, not
 * `cogs_json` (no `agent/*` cog exists, DS-F11 (#288) research findings §3).
 */
export function extractAgentComponents(
  sourceId: string,
  toolCalls: readonly DevinToolCallLine[],
  rootArtifactId: string,
): ComponentSummary[] {
  return [...subagentProfiles(toolCalls)].map((profile) => {
    const componentId = stableId('agent', { source: sourceId, profile });
    return {
      componentId,
      kind: 'agent',
      identity: componentIdentity(componentId, profile),
      sourceArtifactIds: [rootArtifactId],
    };
  });
}

/**
 * Derives all `cogs_json`/`tool_call_state`-sourced components for one
 * session. `sourceId` is the harness-scoped ingestion source id (never the
 * session id) — see the module doc comment above for why component
 * identity must be keyed on it instead.
 */
export function deriveDevinSessionComponents(
  sourceId: string,
  cogsJson: string | null | undefined,
  toolCalls: readonly DevinToolCallLine[],
  rootArtifactId: string,
): ComponentSummary[] {
  const { cogs } = parseDevinCogsJson(cogsJson ?? null);
  return [
    ...extractSkillComponents(sourceId, cogs, rootArtifactId),
    ...extractMcpToolComponents(sourceId, cogs, rootArtifactId),
    ...extractAgentComponents(sourceId, toolCalls, rootArtifactId),
  ];
}
