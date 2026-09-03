import process from 'node:process';

import { getDataDir } from '@lucasschirm/sal-sync';
import { validateCliConfig } from './cli/config.js';
import { resolveCliEnv } from './cli/env.js';
import { parseDevinHookInput, readStdin, toHarnessSession } from './devin.js';
import { DevinHarnessProfile } from './devin-profile.js';
import { type RunDevinHookSyncOptions, runDevinHookSync } from './hook-common.js';
import { isMainModule } from './is-main-module.js';
import { captureDevinModels } from './models/capture.js';

export type RunSessionStartOptions = Partial<
  Omit<RunDevinHookSyncOptions, 'sessionId' | 'cwd' | 'trigger'>
> & { cwd?: string };

/**
 * `SessionStart` hook entry point. **Verified not to fire for Devin Cloud
 * sessions** (Part A3) — only local CLI sessions trigger this. Unlike
 * `claude-session-sync`'s `session-start.ts`, this does not spawn a
 * per-session watcher process: the mandatory mitigation for Cloud sessions
 * is the standalone `watcher.ts` daemon (`bin/watcher`), which polls
 * `sessions.db` globally rather than being spawned per session.
 */
export async function runSessionStart(
  raw: unknown,
  options: RunSessionStartOptions = {},
): Promise<number> {
  const parsed = parseDevinHookInput(raw);
  if (!parsed.ok) {
    return 0;
  }

  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? (await resolveCliEnv(cwd));
  const session = toHarnessSession(parsed.input, cwd);
  session.startedAt = session.startedAt ?? new Date().toISOString();

  const validation = validateCliConfig(env, cwd);
  if (validation.ok) {
    const dataDir = getDataDir(env);
    const profile = options.harnessProfile ?? DevinHarnessProfile;
    const models = await captureDevinModels({ dataDir, devinCliVersion: profile.harnessVersion });
    if (models.error) {
      (options.stderr ?? process.stderr).write(
        `devin-session-sync session-start: models capture warning: ${models.error}\n`,
      );
    }
  }

  await runDevinHookSync('session-start', {
    ...options,
    env,
    sessionId: session.sessionId,
    cwd: session.cwd,
    trigger: 'session-start',
  });
  return 0;
}

async function main(): Promise<number> {
  try {
    const raw = await readStdin();
    return await runSessionStart(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`devin-session-sync session-start error: ${message}\n`);
    return 0;
  }
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(0),
  );
}
