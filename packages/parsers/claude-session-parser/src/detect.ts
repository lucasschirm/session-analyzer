export type ClaudeCodeArtifactKind =
  | 'session-transcript'
  | 'subagent-transcript'
  | 'subagent-meta'
  | 'settings'
  | 'mcp-config'
  | 'agent-definition'
  | 'skill-definition'
  | 'rule-definition'
  | 'plugin-marketplace'
  | 'unknown';

// TODO(T8): implement — see spec §4/Detection
export function detectClaudeCode(content: string): boolean {
  void content;
  return false;
}

// TODO(T8): implement — see spec §4/Detection
export function detectClaudeCodeArtifact(input: { content: string; fileName?: string; relativePath?: string }): ClaudeCodeArtifactKind {
  void input;
  return 'unknown';
}
