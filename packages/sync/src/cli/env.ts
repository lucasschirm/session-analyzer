import * as fsp from 'node:fs/promises';
import os from 'node:os';
import process from 'node:process';

import type { CliHarnessAdapter } from './harness-adapter.js';

const EMPTY_BLOCKLIST: ReadonlySet<string> = new Set();

async function readConfigEnv(configPath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await fsp.readFile(configPath, 'utf8');
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
    // Missing or unreadable config file — caller falls through to the next source.
    return undefined;
  }
}

function fillMissing(
  merged: Record<string, string | undefined>,
  configEnv: Record<string, unknown> | undefined,
  blocklist: ReadonlySet<string>,
): void {
  if (!configEnv) return;
  for (const [key, value] of Object.entries(configEnv)) {
    if (typeof value !== 'string') continue;
    if (blocklist.has(key)) continue;
    if (merged[key] === undefined || merged[key] === '') {
      merged[key] = value;
    }
  }
}

/**
 * Harness-parameterized environment resolver behind every
 * `claude-session-sync`/`devin-session-sync` CLI command and hook.
 *
 * Precedence ladder (highest -> lowest):
 *
 * ```
 *   process.env                              (real environment variables — always win)
 *   <adapter's local config path>    "env"   (project-local, expected gitignored, no blocklist)
 *   <adapter's project config path>  "env"   (project-wide, may be committed, blocklist applies)
 *   <adapter's user-global config path> "env" (user-global, may be committed, blocklist applies)
 * ```
 *
 * A variable set in a higher-precedence source is never overwritten by a
 * lower one. Non-overlapping keys accumulate across all sources. Only the
 * `env` key of each config file is read; non-string values are silently
 * skipped; missing or malformed files are silently ignored — the run
 * proceeds with whatever sources are available.
 *
 * This is the generalized form of `claude-session-sync`'s original
 * `resolveCliEnv`. Its security blocklist was introduced after a security
 * review (commit `9d71ce6`) and was once accidentally dropped during a
 * refactor (commit `461cc73`) before a merge re-introduced it — see
 * `packages/plugins/claude-session-sync/src/cli/AGENTS.md` for the full
 * history this guards against. Each plugin's own `src/cli/env.ts` is a thin
 * wrapper around this function, bound to that plugin's `CliHarnessAdapter`,
 * so it can keep exposing the exact `resolveCliEnv(cwd?, processEnv?,
 * blocklist?)` signature its own tests assert on.
 *
 * @param adapter - the calling harness's `CliHarnessAdapter`
 * @param cwd - the project working directory (defaults to `process.cwd()`)
 * @param processEnv - the raw process environment (defaults to `process.env`)
 * @param blocklist - env var names never honored from a committed config
 *   file; defaults to `adapter.profile.securityBlocklist`. Parameterized so
 *   a caller can supply a different list without a hardcoded array in this
 *   module (DS-F1 #156 precedent).
 * @returns the merged environment record
 */
export async function resolveCliEnv(
  adapter: CliHarnessAdapter,
  cwd: string = process.cwd(),
  processEnv: Record<string, string | undefined> = process.env,
  blocklist: readonly string[] = adapter.profile.securityBlocklist,
): Promise<Record<string, string | undefined>> {
  const paths = adapter.resolveConfigPaths(cwd, os.homedir());
  const merged: Record<string, string | undefined> = {};
  const committedBlocklist = new Set(blocklist);

  // Layer 1: local config override (highest among files, no blocklist — gitignored).
  const localEnv = await readConfigEnv(paths.local);
  fillMissing(merged, localEnv, EMPTY_BLOCKLIST);

  // Layer 2: project config (may be committed — blocklist applies).
  const projectEnv = await readConfigEnv(paths.project);
  fillMissing(merged, projectEnv, committedBlocklist);

  // Layer 3: user-global config (may be committed — blocklist applies).
  const userEnv = await readConfigEnv(paths.userGlobal);
  fillMissing(merged, userEnv, committedBlocklist);

  // Layer 4: process.env — always wins, but only for keys that are actually
  // set (undefined values don't override config files).
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  return merged;
}
