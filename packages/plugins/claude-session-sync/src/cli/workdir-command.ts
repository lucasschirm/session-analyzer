import {
  runWorkdirCommand as sharedRunWorkdirCommand,
  type WorkdirCommandOptions,
} from '@lucasschirm/sal-sync';

import { ClaudeCliAdapter } from '../claude-cli-adapter.js';

export type { WorkdirCommandOptions, WorkdirConfig } from '@lucasschirm/sal-sync';
export {
  isGlobPattern,
  readWorkdirConfig,
  resolveWorkdirPath,
  workdirConfigPath,
  workdirMatches,
  writeWorkdirConfig,
} from '@lucasschirm/sal-sync';

/**
 * Manage working directories mapped to the current `SAL_PROJECT_ID`.
 *
 * Claude Code's hook-driven model doesn't keep a `sessions.db` of all
 * sessions, so `workdir list` shows only the configured patterns (no
 * "available from session store" section). `workdir add` requires an
 * explicit path argument — interactive selection is unavailable because
 * `ClaudeCliAdapter.listAvailableWorkdirs` is not defined.
 *
 * Thin wrapper around `@lucasschirm/sal-sync`'s harness-parameterized
 * `runWorkdirCommand(adapter, argv, options)`, bound to `ClaudeCliAdapter`.
 */
export async function runWorkdirCommand(
  argv: string[] = [],
  options: WorkdirCommandOptions = {},
): Promise<number> {
  return sharedRunWorkdirCommand(ClaudeCliAdapter, argv, options);
}
