import type { ClaudeScope } from '../types/common.js';
import type {
  AgentDefinition,
  ClaudeConfigSnapshot,
  ClaudeCodeSettings,
  McpConfig,
  PluginMarketplace,
  RuleDefinition,
  SkillDefinition,
} from '../types/config.js';

// TODO(T9): implement — see spec §3 (ClaudeConfigSnapshot) + §4 (buildConfigSnapshot)
export function buildConfigSnapshot(
  parsed: Array<AgentDefinition | SkillDefinition | RuleDefinition | McpConfig | ClaudeCodeSettings | PluginMarketplace>,
  scope?: ClaudeScope,
): ClaudeConfigSnapshot {
  void parsed;
  void scope;
  return {
    inventories: [],
    effectiveSettings: {
      kind: 'settings',
      scope: scope ?? 'unknown',
      raw: {},
      parseErrors: [],
    },
    agentsByName: {},
    skillsByName: {},
    mcpServersByName: {},
  };
}
