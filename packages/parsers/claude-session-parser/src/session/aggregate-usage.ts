import type { ClaudeCodeEntry, ClaudeCodeSession } from '../types/session.js';

// TODO(T2): implement — see spec §1.1 (aggregateUsage, computed by summing
// message.usage across every assistant entry — never sum message.usage.iterations)
export function accumulateUsage(entries: ClaudeCodeEntry[]): ClaudeCodeSession['aggregateUsage'] {
  void entries;
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    models: {},
  };
}
