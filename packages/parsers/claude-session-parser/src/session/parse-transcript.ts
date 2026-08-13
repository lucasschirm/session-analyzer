import type { ParseOptions } from '../types/common.js';
import type { ClaudeCodeSession } from '../types/session.js';

// TODO(T2): implement — see spec §1 + §4 (parseSessionTranscript)
export function parseSessionTranscript(content: string, options?: ParseOptions): ClaudeCodeSession {
  void content;
  void options;
  return {
    cliVersions: [],
    isSidechain: false,
    entries: [],
    aggregateUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      models: {},
    },
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
    parseErrors: [],
    unknownTypes: {},
  };
}
