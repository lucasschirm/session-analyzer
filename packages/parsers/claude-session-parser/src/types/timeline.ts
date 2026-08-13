/**
 * Timeline record types — spec §2. These track, as first-class data, what
 * tools/skills/agents/rules/MCP servers were available over the course of a
 * session, as a timeline rather than a snapshot.
 *
 * See spec: docs/superpowers/specs/2026-08-12-claude-session-parser-design.md
 */

import type { AvailabilityEvent } from './common.js';
import type { AgentDefinition, McpServerConfig } from './config.js';
import type { CompactMetadata } from './session.js';

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export type ToolAvailabilityAction = 'deferred' | 'undeferred' | 'removed' | 'readded' | 'invoked';

export interface ToolAvailabilityRecord {
  tool: string;
  /** Parsed from `deferred_tools_delta.addedLines` when that line carries a
   *  description beyond the bare name (rare but real). */
  description?: string;
  availability: AvailabilityEvent<ToolAvailabilityAction>[];
  /** Invoked but never appears in any deferred_tools_delta — was in the
   *  always-loaded base toolset. Computed per-session. */
  alwaysAvailable: boolean;
  /** Parsed from `mcp__<server>__<tool>`. */
  mcpServer?: string;
  mcpToolName?: string;
  invocationCount: number;
  firstInvokedAtMs?: number;
  lastInvokedAtMs?: number;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export type SkillAvailabilityAction = 'listed' | 'delisted' | 'discovered' | 'invoked' | 'expanded';

export interface SkillAvailabilityRecord {
  /** "superpowers:systematic-debugging" */
  name: string;
  pluginPrefix?: string;
  bareName: string;
  description?: string;
  availability: AvailabilityEvent<SkillAvailabilityAction>[];
  sourceDir?: string;
  displayPath?: string;
  /** "plugin:superpowers:systematic-debugging" */
  qualifiedPath?: string;
  /** Full SKILL.md body, when actually expanded. */
  injectedContent?: string;
  invocationCount: number;
  invocations: Array<{ entryUuid: string; toolUseId: string; args?: string; timestampMs: number; launched: boolean }>;
  /** Assistant entries with matching attributionSkill. */
  attributedTurnCount: number;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export type AgentAvailabilityAction = 'listed' | 'delisted' | 'mentioned' | 'invoked';

export interface AgentAvailabilityRecord {
  agentType: string;
  pluginPrefix?: string;
  availability: AvailabilityEvent<AgentAvailabilityAction>[];
  /** Parsed from agent_listing_delta.addedLines. */
  listingDescription?: string;
  /** "All tools" | "Bash, Read, WebFetch, WebSearch" | "*" */
  listingTools?: string;
  /** Filled in only if a matching definition file was also parsed. */
  definition?: AgentDefinition;
  invocations: SubagentLaunchRecord[];
  /** From assistant.attributionAgent on sidechain entries. */
  attributedTurnCount: number;
}

export interface SubagentLaunchRecord {
  toolUseId: string;
  entryUuid: string;
  resultEntryUuid?: string;
  /** tool_use.input.subagent_type */
  agentType: string;
  description?: string;
  prompt?: string;
  /** toolUseResult.resolvedModel */
  model?: string;
  /** toolUseResult.agentId — exact key for subagents/agent-<id>.jsonl */
  agentId?: string;
  isAsync?: boolean;
  runInBackground?: boolean;
  timestampMs: number;
  /** From toolUseResult.totalTokens — a real per-subagent aggregate Claude
   *  Code itself computes (confirmed, e.g. 77668), distinct from and not to
   *  be confused with the session-root `aggregateUsage` this package
   *  computes independently. */
  totalTokens?: number;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export type RuleScope = 'Project' | 'User' | 'Local' | 'Managed' | 'Unknown';
export type RuleAvailabilityAction = 'available' | 'injected' | 'referenced';
/** Resolved decision: tri-state, not boolean — config-derived rules
 *  (`origin: 'config_inventory'`) get `'unknown'`, never `'available'`
 *  implying "not injected", because a transcript alone can never confirm
 *  whether root-scope CLAUDE.md/AGENTS.md content (assembled into the
 *  system prompt, which Claude Code never writes to the JSONL) was in
 *  context. */
export type RuleInjectionStatus = 'injected' | 'available' | 'unknown';

export interface RuleRecord {
  path: string;
  displayPath?: string;
  title?: string;
  scope: RuleScope;
  injectionStatus: RuleInjectionStatus;
  availability: AvailabilityEvent<RuleAvailabilityAction>[];
  /** Set only when injectionStatus === 'injected'. */
  injectedContent?: string;
  rawContent?: string;
  frontmatter?: RuleFrontmatter;
  globs?: string[];
  contentDiffersFromDisk?: boolean;
  origin: 'nested_memory' | 'compact_file_reference' | 'config_inventory';
}

export interface RuleFrontmatter {
  description?: string;
  /** Normalized from either `globs:` or `paths:`, bare/quoted/comma/list forms. */
  globs?: string[];
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

export type McpAvailabilityAction =
  | 'instructions_added'
  | 'instructions_removed'
  | 'tools_offered'
  | 'tools_removed'
  | 'pending'
  | 'needs_auth'
  | 'invoked';

export interface McpServerRecord {
  /** "pep:mcp" — as Claude Code reports it. */
  server: string;
  /** "pep_mcp" — `:` → `_`, `-` preserved. */
  toolNamespace?: string;
  availability: AvailabilityEvent<McpAvailabilityAction>[];
  instructions?: string;
  offeredTools: string[];
  invokedTools: Array<{ tool: string; count: number }>;
  pending: boolean;
  needsAuth: boolean;
  /** Filled in only if a matching .mcp.json entry was also parsed. */
  config?: McpServerConfig;
}

// ---------------------------------------------------------------------------
// Supporting records
// ---------------------------------------------------------------------------

export interface PermissionModeChange {
  mode: string;
  lineNumber: number;
  timestampMs?: number;
}

export interface HookEventRecord {
  hookName: string;
  hookEvent: string;
  command?: string;
  outcome: 'success' | 'non_blocking_error' | 'system_message' | 'additional_context';
  exitCode?: number;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  injectedContext?: string[];
  entryUuid: string;
  timestampMs: number;
}

export interface CompactionRecord {
  entryUuid: string;
  timestampMs: number;
  metadata: CompactMetadata;
}

export interface PrLinkRecord {
  prNumber: number;
  prUrl: string;
  prRepository: string;
  timestampMs: number;
}
