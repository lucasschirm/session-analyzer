import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Precedence ladder for Claude Code environment resolution (highest → lowest):
 *
 * ```
 *   process.env (ENV)
 *   .claude/settings.local.json   (project-local, gitignored)
 *   .claude/settings.json          (project, committed)
 *   ~/.claude/settings.json         (user-global)
 * ```
 *
 * A variable set in a higher-precedence source is never overwritten by a
 * lower-precedence one. This matches Claude Code's own resolution order and
 * the spread semantics `{ ...user, ...project, ...local, ...ENV }`.
 *
 * Only the `env` key of each settings file is read. Non-string values are
 * silently skipped (Claude Code itself ignores them). Missing or malformed
 * files are silently ignored — the run proceeds with whatever sources are
 * available.
 */
const SETTINGS_FILES = [
  // Lowest precedence first — each layer overwrites keys from the previous.
  // The user-scope path ignores `cwd` (it's always ~/.claude/settings.json),
  // but the parameter is kept for signature uniformity with the other entries.
  { scope: 'user', getPath: (_cwd: string) => path.join(os.homedir(), '.claude', 'settings.json') },
  { scope: 'project', getPath: (cwd: string) => path.join(cwd, '.claude', 'settings.json') },
  { scope: 'local', getPath: (cwd: string) => path.join(cwd, '.claude', 'settings.local.json') },
] as const;

/**
 * Read the `env` record from a single Claude Code settings file.
 * Returns `undefined` if the file is missing, unreadable, malformed, or
 * has no `env` key (or its `env` is not a plain object of strings).
 */
async function readSettingsEnv(filePath: string): Promise<Record<string, string> | undefined> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  const env = (parsed as Record<string, unknown>).env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return undefined;

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value === 'string') result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Resolve the effective environment for the Claude session-sync plugin.
 *
 * Merges `~/.claude/settings.json`, `${cwd}/.claude/settings.json`, and
 * `${cwd}/.claude/settings.local.json` (in that order), then overlays
 * `processEnv` on top so that real environment variables always win.
 *
 * This is the single shared function used by every entry point in the plugin
 * — the `claude-sync` CLI commands (sync, list, download, remove) and the
 * Claude Code hooks (session-start, session-end, hook, transcript-watcher).
 *
 * @param cwd - the project working directory (defaults to `process.cwd()`)
 * @param processEnv - the raw process environment (defaults to `process.env`)
 * @returns the merged environment record
 */
export async function resolveCliEnv(
  cwd: string = process.cwd(),
  processEnv: Record<string, string | undefined> = process.env,
): Promise<Record<string, string | undefined>> {
  const merged: Record<string, string | undefined> = {};

  // Layer 1–3: settings files, lowest precedence first.
  // Each layer overrides keys from the previous (higher precedence wins).
  for (const { getPath } of SETTINGS_FILES) {
    const env = await readSettingsEnv(getPath(cwd));
    if (env) {
      for (const [key, value] of Object.entries(env)) {
        merged[key] = value;
      }
    }
  }

  // Layer 4: process.env — always wins, but only for keys that are actually
  // set (undefined values don't override settings files).
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  return merged;
}
