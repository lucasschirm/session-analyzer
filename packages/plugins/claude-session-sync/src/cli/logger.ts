import {
  type AbortLogResult,
  formatLogTimestamp,
  buildLogFileName as sharedBuildLogFileName,
  formatAbortMessage as sharedFormatAbortMessage,
  formatErrorLogContent as sharedFormatErrorLogContent,
  resolveLogFolder as sharedResolveLogFolder,
  writeErrorLog as sharedWriteErrorLog,
} from '@lucasschirm/sal-sync';

import { ClaudeCliAdapter } from '../claude-cli-adapter.js';

export type { AbortLogResult };
export { formatLogTimestamp };

/**
 * Environment variable used to override the folder where `claude-sync` writes
 * error log files when a command aborts with an unhandled exception. When set,
 * it replaces the entire log folder (not just the data dir). When unset, logs
 * are written to the `logs/` subdirectory of the sync data dir
 * (`SAL_DATA_DIR`, defaulting to `~/.sal-sync`) — the same `logs/` folder the
 * sync engine's `StateStore.ensureDirectories()` creates and that telemetry
 * writes its `telemetry.jsonl` to.
 *
 * This variable is read from `process.env` (or the merged env passed to the
 * abort handler) — it is not a sensitive credential, so it does not need the
 * security blocklist applied to `SAL_STORAGE_*` keys.
 */
export const LOG_FOLDER_ENV = ClaudeCliAdapter.logFolderEnvVar;

/**
 * Resolve the log folder for `claude-sync` error logs.
 *
 * Honors `CLAUDE_SYNC_LOG_PATH_FOLDER` from the supplied env when set and
 * non-empty (it replaces the entire folder); otherwise defaults to the `logs/`
 * subdirectory of the sync data dir resolved by the shared `getDataDir` helper
 * from `@lucasschirm/sal-sync` (which honors `SAL_DATA_DIR`, defaulting to
 * `~/.sal-sync/logs`). Relative paths are resolved against the current working
 * directory.
 *
 * Hoisted (#354) to `@lucasschirm/sal-sync`'s harness-parameterized logger —
 * this wrapper binds it to `ClaudeCliAdapter`.
 */
export function resolveLogFolder(env: Record<string, string | undefined>): string {
  return sharedResolveLogFolder(ClaudeCliAdapter, env);
}

/**
 * Build the log filename for a given command and timestamp.
 *
 * Produces `${command}-log-${timestamp}.log` (e.g. `download-log-20260901-180712.log`).
 * Unknown/missing commands fall back to `claude-sync-log-${timestamp}.log`.
 */
export function buildLogFileName(command: string | undefined, timestamp: string): string {
  return sharedBuildLogFileName(ClaudeCliAdapter, command, timestamp);
}

/**
 * Render the full text content of an error log file, including the error
 * name, message, stack trace, and any chained `cause` values.
 */
export function formatErrorLogContent(err: unknown, command: string | undefined): string {
  return sharedFormatErrorLogContent(ClaudeCliAdapter, err, command);
}

/**
 * Write an error log file for an aborted `claude-sync` command.
 *
 * The file is written to {@link resolveLogFolder} with a name built by
 * {@link buildLogFileName}. The folder is created (recursively) if missing.
 * If writing fails for any reason, `written` is `false` and `logPath` still
 * reflects the intended path — the caller can fall back to printing the raw
 * error message instead of the "check log" pointer.
 */
export async function writeErrorLog(
  env: Record<string, string | undefined>,
  command: string | undefined,
  err: unknown,
): Promise<AbortLogResult> {
  return sharedWriteErrorLog(ClaudeCliAdapter, env, command, err);
}

/**
 * Build the user-facing abort message printed to stderr when a command aborts
 * with an unhandled exception.
 *
 * When the log file was written successfully:
 *   `claude-sync: aborted. Check log in <logPath>`
 *
 * When the log file could not be written, the original error message is
 * surfaced so the user is never left with no diagnostic at all:
 *   `claude-sync: aborted: <message> (failed to write log at <logPath>)`
 */
export function formatAbortMessage(err: unknown, result: AbortLogResult): string {
  return sharedFormatAbortMessage(ClaudeCliAdapter, err, result);
}
