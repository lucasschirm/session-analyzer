import * as fsp from 'node:fs/promises';
import path from 'node:path';

import { getDataDir } from '@lucasschirm/sal-sync';

/**
 * Environment variable used to override the folder where `devin-sync` writes
 * error log files when a command aborts with an unhandled exception. Mirrors
 * `claude-session-sync`'s `CLAUDE_SYNC_LOG_PATH_FOLDER`. When unset, logs are
 * written to the `logs/` subdirectory of the sync data dir (`SAL_DATA_DIR`,
 * defaulting to `~/.sal-sync`).
 */
export const LOG_FOLDER_ENV = 'DEVIN_SYNC_LOG_PATH_FOLDER';

export interface AbortLogResult {
  logPath: string;
  written: boolean;
}

/** Resolve the log folder for `devin-sync` error logs. */
export function resolveLogFolder(env: Record<string, string | undefined>): string {
  const configured = env[LOG_FOLDER_ENV];
  if (configured && configured.trim() !== '') {
    return path.resolve(configured);
  }
  return path.join(getDataDir(env), 'logs');
}

/** Format a timestamp suitable for use in a log filename (`YYYYMMDD-HHMMSS`, UTC). */
export function formatLogTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/** Build the log filename for a given command and timestamp. */
export function buildLogFileName(command: string | undefined, timestamp: string): string {
  const safeCommand = command && command.trim() !== '' ? command : 'devin-sync';
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

/** Render the full text content of an error log file. */
export function formatErrorLogContent(err: unknown, command: string | undefined): string {
  const commandLabel = command && command.trim() !== '' ? command : 'devin-sync';
  const timestamp = new Date().toISOString();
  const header = `devin-sync ${commandLabel} — error log\nTimestamp: ${timestamp}\n\n`;

  if (err instanceof Error) {
    const parts = [`Error: ${err.name}: ${err.message}`];
    parts.push(err.stack ?? '(no stack trace available)');
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause !== undefined) {
      parts.push(`\nCause:\n${formatCause(cause)}`);
    }
    return `${header}${parts.join('\n')}\n`;
  }

  return `${header}Error: ${String(err)}\n`;
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

/** Build the user-facing abort message printed to stderr when a command aborts. */
export function formatAbortMessage(err: unknown, result: AbortLogResult): string {
  if (result.written) {
    return `devin-sync: aborted. Check log in ${result.logPath}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `devin-sync: aborted: ${message} (failed to write log at ${result.logPath})`;
}
