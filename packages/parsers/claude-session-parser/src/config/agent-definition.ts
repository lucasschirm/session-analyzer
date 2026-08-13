import type { ClaudeScope } from '../types/common.js';
import type { AgentDefinition } from '../types/config.js';

// TODO(T7): implement — see spec §3 (AgentDefinition) + §4 (parseAgentDefinition)
export function parseAgentDefinition(content: string, sourcePath?: string, scope?: ClaudeScope): AgentDefinition {
  void content;
  return {
    kind: 'agent-definition',
    sourcePath,
    scope: scope ?? 'unknown',
    name: '',
    frontmatter: {},
    body: '',
    parseErrors: [],
  };
}
