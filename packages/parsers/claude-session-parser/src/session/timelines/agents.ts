import type { ClaudeCodeEntry } from '../../types/session.js';
import type { AgentAvailabilityRecord, SubagentLaunchRecord } from '../../types/timeline.js';
import type { TimelineDeriveOptions } from './context.js';

// TODO(T4): implement — see spec §2/Agents
export function deriveAgentTimeline(
  entries: ClaudeCodeEntry[],
  options?: TimelineDeriveOptions,
): { agents: AgentAvailabilityRecord[]; subagentLaunches: SubagentLaunchRecord[] } {
  void entries;
  void options;
  return { agents: [], subagentLaunches: [] };
}
