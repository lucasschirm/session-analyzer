import * as fsp from 'node:fs/promises';
import path from 'node:path';

import { getDataDir } from '@lucasschirm/sal-sync';

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
export const LOG_FOLDER_ENV = 'CLAUDE_SYNC_LOG_PATH_FOLDER';

export interface AbortLogResult {
  /** Absolute path of the log file that was (attempted to be) written. */
  logPath: string;
  /** Whether the log file was successfully written to disk. */
  written: boolean;
}

/**
 * Resolve the log folder for `claude-sync` error logs.
 *
 * Honors `CLAUDE_SYNC_LOG_PATH_FOLDER` from the supplied env when set and
 * non-empty (it replaces the entire folder); otherwise defaults to the `logs/`
 * subdirectory of the sync data dir resolved by the shared `getDataDir` helper
 * from `@lucasschirm/sal-sync` (which honors `SAL_DATA_DIR`, defaulting to
 * `~/.sal-sync/logs`). Relative paths are resolved against the current working
 * directory.
 */
export function resolveLogFolder(env: Record<string, string | undefined>): string {
  const configured = env[LOG_FOLDER_ENV];
  if (configured && configured.trim() !== '') {
    return path.resolve(configured);
  }
  return path.join(getDataDir(env), 'logs');
}

/**
 * Format a timestamp suitable for use in a log filename
 * (`YYYYMMDD-HHMMSS`, UTC, filesystem-safe).
 */
export function formatLogTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/**
 * Build the log filename for a given command and timestamp.
 *
 * Produces `${command}-log-${timestamp}.log` (e.g. `download-log-20260901-180712.log`).
 * Unknown/missing commands fall back to `claude-sync-log-${timestamp}.log`.
 */
export function buildLogFileName(command: string | undefined, timestamp: string): string {
  const safeCommand = command && command.trim() !== '' ? command : 'claude-sync';
  return `${safeCommand}-log-${timestamp}.log`;
}

function formatCause(cause: unknown, depth = 0): string {
  const indent = '  '.repeat(depth);
  if (cause instanceof Error) {
    const parts = [`${indent}${cause.name}: ${cause.message}`];
    if (cause.stack) parts.push(`${indent}${cause.stack}`);
    if ((cause as Error & { cause?: unknown }).cause && depth < 5) {
      parts.push(
        `${indent}Cause: ${formatCause((cause as Error & { cause?: unknown }).cause, depth + 1)}`,
      );
    }
    return parts.join('\n');
  }
  return `${indent}${String(cause)}`;
}

/**
 * Render the full text content of an error log file, including the error
 * name, message, stack trace, and any chained `cause` values.
 */
export function formatErrorLogContent(err: unknown, command: string | undefined): string {
  const commandLabel = command && command.trim() !== '' ? command : 'claude-sync';
  const timestamp = new Date().toISOString();
  const header = `claude-sync ${commandLabel} — error log\nTimestamp: ${timestamp}\n\n`;

  if (err instanceof Error) {
    const parts = [`Error: ${err.name}: ${err.message}`];
    if (err.stack) {
      parts.push(err.stack);
    } else {
      parts.push('(no stack trace available)');
    }
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause !== undefined) {
      parts.push(`\nCause:\n${formatCause(cause)}`);
    }
    return `${header}${parts.join('\n')}\n`;
  }

  return `${header}Error: ${String(err)}\n`;
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
  const folder = resolveLogFolder(env);
  const timestamp = formatLogTimestamp();
  const logPath = path.join(folder, buildLogFileName(command, timestamp));
  const content = formatErrorLogContent(err, command);
  try {
    await fsp.mkdir(folder, { recursive: true });
    await fsp.writeFile(logPath, content, 'utf8');
    return { logPath, written: true };
  } catch {
    return { logPath, written: false };
  }
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
  if (result.written) {
    return `claude-sync: aborted. Check log in ${result.logPath}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `claude-sync: aborted: ${message} (failed to write log at ${result.logPath})`;
}
