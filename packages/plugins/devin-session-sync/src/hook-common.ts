import process from 'node:process';
import {
  buildStorageAdapter,
  emitTelemetry,
  getDataDir,
  type HarnessProfile,
  type StorageAdapter,
  type SyncErrorCode,
  type SyncTelemetry,
  type SyncTrigger,
} from '@lucasschirm/sal-sync';

import { validateCliConfig } from './cli/config.js';
import { resolveCliEnv } from './cli/env.js';
import { DevinHarnessProfile } from './devin-profile.js';
import { readDevinSnapshot } from './devin-snapshot.js';
import type { CaptureDevinModelsOptions } from './models/capture.js';
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
  /** Optional overrides for the Devin models-list capture (e.g. test fixtures). */
  models?: Partial<CaptureDevinModelsOptions>;
}

export type RunDevinHookSyncResult =
  | { ok: true; outcome: DevinSessionSyncOutcome }
  | { ok: false; reason: string };

/**
 * Build a `SyncTelemetry` record from a Devin session sync outcome.
 *
 * The Devin sync pipeline (`runDevinSessionSync`) tracks uploaded/skipped/
 * failed counts and error/warning strings, but not byte counts or per-phase
 * durations (those live inside the shared sync engine's `SyncRun`). This
 * helper fills the missing `SyncRun` fields with zeros so the record is
 * structurally complete for the telemetry log — matching the pattern used
 * by `zeroRun()` in `packages/sync/src/cli/common.ts` for the Claude plugin's
 * capture path.
 *
 * Exported so the watcher and sync-command paths can emit the same record
 * shape without duplicating the mapping.
 */
export function buildDevinTelemetryRecord(
  outcome: DevinSessionSyncOutcome,
  trigger: SyncTrigger,
  command: string,
): SyncTelemetry {
  return {
    trigger,
    filesDiscovered: outcome.uploaded + outcome.skipped + outcome.failed,
    filesChanged: outcome.uploaded + outcome.failed,
    filesUploaded: outcome.uploaded,
    filesFailed: outcome.failed,
    filesSkipped: outcome.skipped,
    bytesDiscovered: 0,
    bytesChanged: 0,
    bytesUploaded: 0,
    errors: outcome.errors.length > 0 ? ['SYNC_INTERNAL_ERROR'] : [],
    errorDetails: outcome.errors.map((message) => ({
      code: 'SYNC_INTERNAL_ERROR' as SyncErrorCode,
      message,
    })),
    discoveryDurationMs: 0,
    sanitizationDurationMs: 0,
    hashDurationMs: 0,
    uploadDurationMs: 0,
    totalDurationMs: 0,
    sessionId: outcome.sessionId,
    command,
    timestamp: new Date().toISOString(),
    diagnostics: outcome.warnings.length > 0 ? { warnings: outcome.warnings } : undefined,
  };
}

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
  const dataDir = getDataDir(env);

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
      dataDir,
      storageAdapter: options.storageAdapter ?? buildStorageAdapter(config),
      trigger: options.trigger,
      profile,
      env,
      homeDir: options.homeDir,
      models: options.models,
      onProgress: (event) => writeHookProgress(stderr, label, event),
    });
    await emitTelemetry(dataDir, buildDevinTelemetryRecord(outcome, options.trigger, label));
    return { ok: true, outcome };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`devin-session-sync ${label} error: ${message}\n`);
    await emitTelemetry(
      dataDir,
      buildDevinTelemetryRecord(
        {
          sessionId: options.sessionId,
          uploaded: 0,
          skipped: 0,
          failed: 1,
          errors: [message],
          warnings: [],
        },
        options.trigger,
        label,
      ),
    );
    return { ok: false, reason: message };
  }
}
