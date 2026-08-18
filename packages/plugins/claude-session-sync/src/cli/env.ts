import * as fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Resolve the effective environment for the CLI.
 *
 * Process environment variables take precedence. For any SAL_* variable that
 * is not already set, the CLI looks for `${cwd}/.claude/settings.local.json`
 * and reads its `env` key, merging in the missing values.
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

  const settingsPath = path.join(cwd, '.claude', 'settings.local.json');
  let settingsEnv: Record<string, unknown> | undefined;

  try {
    const raw = await fsp.readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const env = (parsed as Record<string, unknown>).env;
      if (env && typeof env === 'object' && !Array.isArray(env)) {
        settingsEnv = env as Record<string, unknown>;
      }
    }
  } catch {
    // Missing or unreadable settings file — fall through to process env only.
  }

  if (settingsEnv) {
    for (const [key, value] of Object.entries(settingsEnv)) {
      if (typeof value !== 'string') continue;
      if (merged[key] === undefined || merged[key] === '') {
        merged[key] = value;
      }
    }
  }

  return merged;
}
