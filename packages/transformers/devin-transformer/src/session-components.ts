import type { DevinCog, DevinToolCallLine } from '@lucasschirm/sal-devin-session-parser';
import { parseDevinCogsJson } from '@lucasschirm/sal-devin-session-parser';
import type { ComponentIdentity, ComponentSummary } from '@lucasschirm/sal-transformer-shared';
import { stableId } from './session-spine.js';
import {
  type DevinInvocationKind,
  DISPATCHER_TOOL_NAMES,
  invocationKindAndName,
} from './tool-invocations.js';

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

/**
 * Domain-dispatching tool names excluded from the generic `tool` component
 * pool per `.agents/rules/analytics-domain-distinctions.md`: `skill` and
 * `run_subagent` invocations are `skill`/`agent` domain records, never
 * generic tools — matching `invocationKindAndName` in tool-invocations.ts.
 */
const NON_GENERIC_TOOL_NAMES: ReadonlySet<string> = new Set(DISPATCHER_TOOL_NAMES);

/** True when the ATIF tool_definitions list contains at least one generic
 *  tool name (i.e. something beyond the skill/run_subagent dispatchers). */
export function hasModelSentToolDefinitions(toolDefinitions: readonly string[]): boolean {
  return toolDefinitions.some((n) => n.length > 0 && !NON_GENERIC_TOOL_NAMES.has(n));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Exported (not just used locally) so `config-components.ts`'s file-backed
 * component extraction (#342) reuses this exact identity shape instead of
 * duplicating it — same `displayName: nativeId` convention for both
 * cog-derived and file-derived components.
 */
export function componentIdentity(
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

/**
 * The one place a Devin component's canonical id formula is written down.
 * `agent` components are keyed on `profile` (their native name) and `tool`/
 * `skill` components on `name`, so a declared component (cogs allowlist,
 * ATIF `tool_definitions`, `run_subagent` profile) and the invocation that
 * exercises it always resolve to the SAME identity — which is what lets
 * `component-evidence-links.ts` attribute usage back to availability.
 */
export function devinComponentId(
  sourceId: string,
  kind: DevinInvocationKind,
  name: string,
): string {
  return kind === 'agent'
    ? stableId('agent', { source: sourceId, profile: name })
    : stableId(kind, { source: sourceId, name });
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
    const componentId = devinComponentId(sourceId, 'skill', name);
    return {
      componentId,
      kind: 'skill',
      identity: componentIdentity(componentId, name),
      sourceArtifactIds: [rootArtifactId],
      // cogs_json is a session line — declared availability for this
      // session, not a durable environment declaration.
      sessionScoped: true,
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
    const componentId = devinComponentId(sourceId, 'tool', name);
    return {
      componentId,
      kind: 'tool',
      identity: componentIdentity(componentId, name, 'mcp'),
      sourceArtifactIds: [rootArtifactId],
      // The cogs allowlist is a session line — declared availability for this
      // session, not a durable environment declaration.
      sessionScoped: true,
    };
  });
}

/**
 * One `kind: 'tool'` component per distinct name in the ATIF transcript's
 * `agent.tool_definitions` — the authoritative list of tool schemas actually
 * sent to the model. Domain dispatchers (`skill`, `run_subagent`) are
 * excluded; MCP wrapper names keep `provider: 'mcp'`.
 */
export function extractToolDefinitionComponents(
  sourceId: string,
  toolDefinitions: readonly string[],
  rootArtifactId: string,
): ComponentSummary[] {
  const names = new Set(toolDefinitions);
  return [...names]
    .filter((name) => name.length > 0 && !NON_GENERIC_TOOL_NAMES.has(name))
    .map((name) => {
      const componentId = devinComponentId(sourceId, 'tool', name);
      return {
        componentId,
        kind: 'tool' as const,
        identity: componentIdentity(
          componentId,
          name,
          MCP_WRAPPER_TOOL_NAMES.has(name) ? 'mcp' : undefined,
        ),
        sourceArtifactIds: [rootArtifactId],
        // agent.tool_definitions is this session's model-sent tool list —
        // a runtime observation, not an environment-level declaration.
        sessionScoped: true,
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
    const componentId = devinComponentId(sourceId, 'agent', profile);
    return {
      componentId,
      kind: 'agent',
      identity: componentIdentity(componentId, profile),
      sourceArtifactIds: [rootArtifactId],
      // tool_call_state is session runtime data — a per-session
      // observation, not a durable environment declaration.
      sessionScoped: true,
    };
  });
}

/**
 * One component per distinct `(kind, name)` actually exercised by a
 * `tool_call_state` record. Declared availability (`cogs_json` allowlist,
 * ATIF `tool_definitions`) is only ever a subset of what a session really
 * ran: the cogs rule promoted to `tool` components is deliberately limited to
 * the 4 MCP wrapper names (DS-F11 (#288) §4 noise avoidance), so a session
 * that spent its time in `exec`/`read`/`edit` had those tools invoked and
 * metric-counted but present in no component identity at all — the Session
 * Component Availability & Invocations panel could then never show them as
 * used. A tool that ran was by definition available, so every invoked
 * skill/agent/tool gets an identity, deduped against the declared ones (same
 * `devinComponentId` formula, so an invoked MCP wrapper collapses into the
 * declared record rather than duplicating it).
 */
export function extractInvokedComponents(
  sourceId: string,
  toolCalls: readonly DevinToolCallLine[],
  rootArtifactId: string,
): ComponentSummary[] {
  const byId = new Map<string, ComponentSummary>();
  for (const call of toolCalls) {
    if (!call.call) continue;
    const { kind, name } = invocationKindAndName(call.call, call.update);
    if (!name) continue;
    const componentId = devinComponentId(sourceId, kind, name);
    if (byId.has(componentId)) continue;
    byId.set(componentId, {
      componentId,
      kind,
      identity: componentIdentity(
        componentId,
        name,
        kind === 'tool' && MCP_WRAPPER_TOOL_NAMES.has(name) ? 'mcp' : undefined,
      ),
      sourceArtifactIds: [rootArtifactId],
      // Invocation evidence is runtime data for this session, never a durable
      // environment declaration.
      sessionScoped: true,
    });
  }
  return [...byId.values()];
}

/**
 * Derives all `cogs_json`/`tool_call_state`-sourced components for one
 * session. `sourceId` is the harness-scoped ingestion source id (never the
 * session id) — see the module doc comment above for why component
 * identity must be keyed on it instead.
 *
 * Declared and invoked sets are unioned and deduped by `componentId`, so a
 * component offered *and* used appears exactly once (and utilization can
 * report it as both available and used instead of picking one of the two).
 */
export function deriveDevinSessionComponents(
  sourceId: string,
  cogsJson: string | null | undefined,
  toolCalls: readonly DevinToolCallLine[],
  rootArtifactId: string,
  toolDefinitions: readonly string[] = [],
): ComponentSummary[] {
  const { cogs } = parseDevinCogsJson(cogsJson ?? null);
  // Prefer the model-sent tool schema list (ATIF agent.tool_definitions).
  // When ATIF carries no tool_definitions — JSONL-only sessions, or older
  // ATIF that predates the field — fall back to the declared cogs allowlist
  // so tool availability isn't lost entirely. Invoked tools are added on top
  // of either branch (see `extractInvokedComponents`).
  const declaredComponents =
    toolDefinitions.length > 0
      ? extractToolDefinitionComponents(sourceId, toolDefinitions, rootArtifactId)
      : extractMcpToolComponents(sourceId, cogs, rootArtifactId);
  const components = [
    ...extractSkillComponents(sourceId, cogs, rootArtifactId),
    ...declaredComponents,
    ...extractAgentComponents(sourceId, toolCalls, rootArtifactId),
    ...extractInvokedComponents(sourceId, toolCalls, rootArtifactId),
  ];
  const seen = new Set<string>();
  return components.filter((component) => {
    if (seen.has(component.componentId)) return false;
    seen.add(component.componentId);
    return true;
  });
}
