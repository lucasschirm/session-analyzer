import {
  type AbortLogResult,
  formatLogTimestamp,
  buildLogFileName as sharedBuildLogFileName,
  formatAbortMessage as sharedFormatAbortMessage,
  formatErrorLogContent as sharedFormatErrorLogContent,
  resolveLogFolder as sharedResolveLogFolder,
  writeErrorLog as sharedWriteErrorLog,
} from '@lucasschirm/sal-sync';

import { DevinCliAdapter } from '../devin-cli-adapter.js';

export type { AbortLogResult };
export { formatLogTimestamp };

/**
 * Environment variable used to override the folder where `devin-sync` writes
 * error log files when a command aborts with an unhandled exception. Mirrors
 * `claude-session-sync`'s `CLAUDE_SYNC_LOG_PATH_FOLDER`. When unset, logs are
 * written to the `logs/` subdirectory of the sync data dir (`SAL_DATA_DIR`,
 * defaulting to `~/.sal-sync`).
 */
export const LOG_FOLDER_ENV = DevinCliAdapter.logFolderEnvVar;

/**
 * Resolve the log folder for `devin-sync` error logs.
 *
 * Hoisted (#354) to `@lucasschirm/sal-sync`'s harness-parameterized logger —
 * this wrapper binds it to `DevinCliAdapter`.
 */
export function resolveLogFolder(env: Record<string, string | undefined>): string {
  return sharedResolveLogFolder(DevinCliAdapter, env);
}

/** Build the log filename for a given command and timestamp. */
export function buildLogFileName(command: string | undefined, timestamp: string): string {
  return sharedBuildLogFileName(DevinCliAdapter, command, timestamp);
}

/** Render the full text content of an error log file. */
export function formatErrorLogContent(err: unknown, command: string | undefined): string {
  return sharedFormatErrorLogContent(DevinCliAdapter, err, command);
}

/**
 * Write an error log file for an aborted `devin-sync` command. If writing
 * fails for any reason, `written` is `false` and the caller falls back to
 * printing the raw error message — never a silent success.
 */
export async function writeErrorLog(
  env: Record<string, string | undefined>,
  command: string | undefined,
  err: unknown,
): Promise<AbortLogResult> {
  return sharedWriteErrorLog(DevinCliAdapter, env, command, err);
}

/** Build the user-facing abort message printed to stderr when a command aborts. */
export function formatAbortMessage(err: unknown, result: AbortLogResult): string {
  return sharedFormatAbortMessage(DevinCliAdapter, err, result);
}
