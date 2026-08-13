import type { ClaudeCodeEntry } from '../../types/session.js';
import type { ToolAvailabilityRecord } from '../../types/timeline.js';
import type { TimelineDeriveOptions } from './context.js';

// TODO(T3): implement — see spec §2/Tools
export function deriveToolTimeline(entries: ClaudeCodeEntry[], options?: TimelineDeriveOptions): ToolAvailabilityRecord[] {
  void entries;
  void options;
  return [];
}
