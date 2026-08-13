import type { ClaudeScope } from '../types/common.js';
import type { McpConfig } from '../types/config.js';

// TODO(T6): implement — see spec §3 (McpConfig/McpServerConfig) + §4 (parseMcp)
export function parseMcp(content: string, scope?: ClaudeScope, sourcePath?: string): McpConfig {
  void content;
  return {
    kind: 'mcp-config',
    sourcePath,
    scope: scope ?? 'unknown',
    servers: [],
    parseErrors: [],
  };
}
