import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * `.claude/settings.json` and `~/.claude/settings.json` are typically
 * committed to git, unlike `settings.local.json`. Credentials and the
 * storage endpoint must never be sourced from a file anyone with
 * commit/PR access can edit — a malicious `SAL_STORAGE_ENDPOINT` there
 * could silently redirect session uploads (and the requester's real
 * credentials) to an attacker-controlled server. These keys are only
 * ever honored from `process.env` or `settings.local.json`.
 */
const SHARED_SETTINGS_BLOCKLIST = new Set([
  'SAL_STORAGE_ENDPOINT',
  'SAL_STORAGE_ACCESS_KEY_ID',
  'SAL_STORAGE_SECRET_ACCESS_KEY',
]);
const EMPTY_BLOCKLIST: ReadonlySet<string> = new Set();

async function readSettingsEnv(settingsPath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await fsp.readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const env = (parsed as Record<string, unknown>).env;
    if (!env || typeof env !== 'object' || Array.isArray(env)) {
      return undefined;
    }
    return env as Record<string, unknown>;
  } catch {
    // Missing or unreadable settings file — caller falls through to the next source.
    return undefined;
  }
}

function fillMissing(
  merged: Record<string, string | undefined>,
  settingsEnv: Record<string, unknown> | undefined,
  blocklist: ReadonlySet<string>,
): void {
  if (!settingsEnv) return;
  for (const [key, value] of Object.entries(settingsEnv)) {
    if (typeof value !== 'string') continue;
    if (blocklist.has(key)) continue;
    if (merged[key] === undefined || merged[key] === '') {
      merged[key] = value;
    }
  }
}

/**
 * Precedence ladder for Claude Code environment resolution (highest → lowest):
 *
 * ```
 *   process.env (ENV)
 *   .claude/settings.local.json   (project-local, gitignored)
 *   .claude/settings.json          (project, committed)
 *   ~/.claude/settings.json         (user-global, committed)
 * ```
 *
 * Process environment variables take precedence. For any variable still
 * missing, the CLI looks for `${cwd}/.claude/settings.local.json` and merges
 * in its `env` key; any variable still missing after that is filled in from
 * `${cwd}/.claude/settings.json` (project-wide settings shared by the team),
 * and finally from `~/.claude/settings.json` (user-global settings).
 *
 * Credentials and the storage endpoint are never read from either committed
 * settings file (`settings.json` or `~/.claude/settings.json`), since those
 * files are typically committed to git — see {@link SHARED_SETTINGS_BLOCKLIST}.
 * Only `settings.local.json` (gitignored) and `process.env` may supply them.
 *
 * Only the `env` key of each settings file is read. Non-string values are
 * silently skipped (Claude Code itself ignores them). Missing or malformed
 * files are silently ignored — the run proceeds with whatever sources are
 * available.
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

  // Layer 1: settings.local.json (highest among files, no blocklist — gitignored).
  const localEnv = await readSettingsEnv(path.join(cwd, '.claude', 'settings.local.json'));
  fillMissing(merged, localEnv, EMPTY_BLOCKLIST);

  // Layer 2: .claude/settings.json (committed — blocklist applies).
  const projectEnv = await readSettingsEnv(path.join(cwd, '.claude', 'settings.json'));
  fillMissing(merged, projectEnv, SHARED_SETTINGS_BLOCKLIST);

  // Layer 3: ~/.claude/settings.json (committed — blocklist applies).
  const userEnv = await readSettingsEnv(path.join(os.homedir(), '.claude', 'settings.json'));
  fillMissing(merged, userEnv, SHARED_SETTINGS_BLOCKLIST);

  // Layer 4: process.env — always wins, but only for keys that are actually
  // set (undefined values don't override settings files).
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  return merged;
}
