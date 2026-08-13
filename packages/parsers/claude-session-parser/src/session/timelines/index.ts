/**
 * `deriveTimelines` dispatch — calls all six derive functions and
 * assembles the `DerivedTimelines` result. NOBODY else edits this file:
 * T3/T4/T5 each replace their own derive function's stub body, and this
 * wiring stays correct without any further changes.
 */

import type { ClaudeCodeEntry } from '../../types/session.js';
import type {
  AgentAvailabilityRecord,
  CompactionRecord,
  HookEventRecord,
  McpServerRecord,
  PermissionModeChange,
  PrLinkRecord,
  RuleRecord,
  SkillAvailabilityRecord,
  SubagentLaunchRecord,
  ToolAvailabilityRecord,
} from '../../types/timeline.js';
import type { TimelineDeriveOptions } from './context.js';
import { deriveToolTimeline } from './tools.js';
import { deriveMcpTimeline } from './mcp.js';
import { deriveSkillTimeline } from './skills.js';
import { deriveAgentTimeline } from './agents.js';
import { deriveRuleTimeline } from './rules.js';
import { deriveSupportingRecords } from './supporting.js';

export type { TimelineDeriveOptions } from './context.js';

export interface DerivedTimelines {
  tools: ToolAvailabilityRecord[];
  skills: SkillAvailabilityRecord[];
  agents: AgentAvailabilityRecord[];
  rules: RuleRecord[];
  mcpServers: McpServerRecord[];
  permissionModes: PermissionModeChange[];
  hooks: HookEventRecord[];
  compactions: CompactionRecord[];
  prLinks: PrLinkRecord[];
  subagentLaunches: SubagentLaunchRecord[];
}

export function deriveTimelines(entries: ClaudeCodeEntry[], options?: TimelineDeriveOptions): DerivedTimelines {
  const tools = deriveToolTimeline(entries, options);
  const mcpServers = deriveMcpTimeline(entries, options);
  const skills = deriveSkillTimeline(entries, options);
  const { agents, subagentLaunches } = deriveAgentTimeline(entries, options);
  const rules = deriveRuleTimeline(entries, options);
  const { permissionModes, hooks, compactions, prLinks } = deriveSupportingRecords(entries, options);

  return {
    tools,
    skills,
    agents,
    rules,
    mcpServers,
    permissionModes,
    hooks,
    compactions,
    prLinks,
    subagentLaunches,
  };
}

export function emptyTimelines(): DerivedTimelines {
  return {
    tools: [],
    skills: [],
    agents: [],
    rules: [],
    mcpServers: [],
    permissionModes: [],
    hooks: [],
    compactions: [],
    prLinks: [],
    subagentLaunches: [],
  };
}
