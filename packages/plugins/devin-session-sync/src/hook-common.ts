import process from 'node:process';
import {
  buildStorageAdapter,
  getDataDir,
  type HarnessProfile,
  type StorageAdapter,
  type SyncTrigger,
} from '@lucasschirm/sal-sync';

import { validateCliConfig } from './cli/config.js';
import { resolveCliEnv } from './cli/env.js';
import { DevinHarnessProfile } from './devin-profile.js';
import { readDevinSnapshot } from './devin-snapshot.js';
import {
  type DevinSessionSyncOutcome,
  type DevinSyncProgressEvent,
  runDevinSessionSync,
} from './session-sync.js';

export interface RunDevinHookSyncOptions {
  sessionId: string;
  cwd: string;
  trigger: SyncTrigger;
  env?: Record<string, string | undefined>;
  storageAdapter?: StorageAdapter;
  harnessProfile?: HarnessProfile;
  stderr?: NodeJS.WritableStream;
  /** Overrides `sessions.db`'s resolved path; primarily for tests. */
  sessionsDbPath?: string;
  homeDir?: string;
}

export type RunDevinHookSyncResult =
  | { ok: true; outcome: DevinSessionSyncOutcome }
  | { ok: false; reason: string };

function writeHookProgress(
  stderr: NodeJS.WritableStream,
  label: string,
  event: DevinSyncProgressEvent,
): void {
  stderr.write(`devin-session-sync ${label}: ${event.timestamp} ${event.message}\n`);
}

async function buildSyncDependencies(
  options: RunDevinHookSyncOptions,
  stderr: NodeJS.WritableStream,
) {
  const env = options.env ?? (await resolveCliEnv(options.cwd));
  const validation = validateCliConfig(env, options.cwd);
  if (!validation.ok || !validation.config) {
    stderr.write(`devin-session-sync: ${validation.errorMessage ?? 'configuration error'}\n`);
    return undefined;
  }
  return { env, config: validation.config };
}

/**
 * Shared hook-trigger sync path used by `session-start.ts`, `hook.ts`, and
 * `session-end.ts`. Hooks are best-effort and fail-open (Part A3): every
 * failure is reported on stderr (a user-visible channel, per
 * `.agents/rules/sync-progress-observability.md`), but the caller still
 * exits 0 so a sync failure never blocks the Devin session itself.
 */
export async function runDevinHookSync(
  label: string,
  options: RunDevinHookSyncOptions,
): Promise<RunDevinHookSyncResult> {
  const stderr = options.stderr ?? process.stderr;
  const deps = await buildSyncDependencies(options, stderr);
  if (!deps) return { ok: false, reason: 'config' };

  const { env, config } = deps;
  const profile = options.harnessProfile ?? DevinHarnessProfile;

  try {
    const snapshot = await readDevinSnapshot({
      env,
      cwd: options.cwd,
      devinCliVersion: profile.harnessVersion,
      sessionsDbPath: options.sessionsDbPath,
      home: options.homeDir,
    });
    const outcome = await runDevinSessionSync({
      tables: snapshot.tables,
      schemaDescriptor: snapshot.schemaDescriptor,
      sessionId: options.sessionId,
      cwd: options.cwd,
      config,
      dataDir: getDataDir(env),
      storageAdapter: options.storageAdapter ?? buildStorageAdapter(config),
      trigger: options.trigger,
      profile,
      env,
      homeDir: options.homeDir,
      onProgress: (event) => writeHookProgress(stderr, label, event),
    });
    return { ok: true, outcome };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`devin-session-sync ${label} error: ${message}\n`);
    return { ok: false, reason: message };
  }
}
