import type { ClaudeCodeEntry } from '../../types/session.js';
import type { CompactionRecord, HookEventRecord, PermissionModeChange, PrLinkRecord } from '../../types/timeline.js';
import type { TimelineDeriveOptions } from './context.js';

// TODO(T5): implement — see spec §2/Supporting records
export function deriveSupportingRecords(
  entries: ClaudeCodeEntry[],
  options?: TimelineDeriveOptions,
): {
  permissionModes: PermissionModeChange[];
  hooks: HookEventRecord[];
  compactions: CompactionRecord[];
  prLinks: PrLinkRecord[];
} {
  void entries;
  void options;
  return { permissionModes: [], hooks: [], compactions: [], prLinks: [] };
}
