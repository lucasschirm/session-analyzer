import type { ClaudeCodeEntry } from '../../types/session.js';
import type { McpServerRecord } from '../../types/timeline.js';
import type { TimelineDeriveOptions } from './context.js';

// TODO(T3): implement — see spec §2/MCP
export function deriveMcpTimeline(entries: ClaudeCodeEntry[], options?: TimelineDeriveOptions): McpServerRecord[] {
  void entries;
  void options;
  return [];
}
