import type { ClaudeCodeEntry } from '../../types/session.js';
import type { RuleRecord } from '../../types/timeline.js';
import type { TimelineDeriveOptions } from './context.js';

// TODO(T5): implement — see spec §2/Rules
export function deriveRuleTimeline(entries: ClaudeCodeEntry[], options?: TimelineDeriveOptions): RuleRecord[] {
  void entries;
  void options;
  return [];
}
