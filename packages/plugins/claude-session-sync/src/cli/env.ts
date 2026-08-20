import * as fsp from 'node:fs/promises';
import path from 'node:path';

const SETTINGS_FILENAMES = ['settings.local.json', 'settings.json'];

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
): void {
  if (!settingsEnv) return;
  for (const [key, value] of Object.entries(settingsEnv)) {
    if (typeof value !== 'string') continue;
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
    fillMissing(merged, settingsEnv);
  }

  return merged;
}
