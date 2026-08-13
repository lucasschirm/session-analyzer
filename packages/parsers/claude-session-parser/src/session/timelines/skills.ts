import type { ClaudeCodeEntry } from '../../types/session.js';
import type { SkillAvailabilityRecord } from '../../types/timeline.js';
import type { TimelineDeriveOptions } from './context.js';

// TODO(T4): implement — see spec §2/Skills
export function deriveSkillTimeline(entries: ClaudeCodeEntry[], options?: TimelineDeriveOptions): SkillAvailabilityRecord[] {
  void entries;
  void options;
  return [];
}
