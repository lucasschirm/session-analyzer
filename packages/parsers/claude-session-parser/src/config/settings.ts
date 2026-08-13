import type { ClaudeScope } from '../types/common.js';
import type { ClaudeCodeSettings } from '../types/config.js';

// TODO(T6): implement — see spec §3 (ClaudeCodeSettings) + §4 (parseSettings)
export function parseSettings(content: string, scope: ClaudeScope, sourcePath?: string): ClaudeCodeSettings {
  void content;
  return {
    kind: 'settings',
    scope,
    sourcePath,
    raw: {},
    parseErrors: [],
  };
}
