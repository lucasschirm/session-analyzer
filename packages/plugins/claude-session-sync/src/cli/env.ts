import * as fsp from 'node:fs/promises';
import path from 'node:path';

const SETTINGS_FILENAMES = ['settings.local.json', 'settings.json'];

/**
 * `.claude/settings.json` is typically committed to git, unlike
 * `settings.local.json`. Credentials and the storage endpoint must never be
 * sourced from a file anyone with commit/PR access can edit — a malicious
 * SAL_STORAGE_ENDPOINT there could silently redirect session uploads (and
 * the requester's real credentials) to an attacker-controlled server. These
 * keys are only ever honored from process.env or settings.local.json.
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
 * Resolve the effective environment for the CLI.
 *
 * Process environment variables take precedence. For any variable still
 * missing, the CLI looks for `${cwd}/.claude/settings.local.json` and merges
 * in its `env` key; any variable still missing after that is filled in from
 * `${cwd}/.claude/settings.json` (project-wide settings shared by the team).
 * Credentials and the storage endpoint are never read from settings.json,
 * since that file is typically committed to git — see
 * {@link SHARED_SETTINGS_BLOCKLIST}.
 *
 * @param cwd - the project working directory (defaults to `process.cwd()`)
 * @param processEnv - the raw process environment (defaults to `process.env`)
 * @returns the merged environment record
 */
export async function resolveCliEnv(
  cwd: string = process.cwd(),
  processEnv: Record<string, string | undefined> = process.env,
): Promise<Record<string, string | undefined>> {
  const merged: Record<string, string | undefined> = { ...processEnv };

  for (const filename of SETTINGS_FILENAMES) {
    const settingsEnv = await readSettingsEnv(path.join(cwd, '.claude', filename));
    const blocklist = filename === 'settings.json' ? SHARED_SETTINGS_BLOCKLIST : EMPTY_BLOCKLIST;
    fillMissing(merged, settingsEnv, blocklist);
  }

  return merged;
}
