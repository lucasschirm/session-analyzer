import process from 'node:process';

import {
  buildStorageAdapter,
  getDataDir,
  type HarnessProfile,
  readWorkdirConfig,
  StateStore,
  type StorageAdapter,
  type SyncConfig,
  workdirMatches,
} from '@lucasschirm/sal-sync';

import { DevinHarnessProfile } from '../devin-profile.js';
import { type DevinSnapshotHandle, openDevinSnapshotHandle } from '../devin-snapshot.js';
import type { DevinSessionRow } from '../extractor/types.js';
import { type CaptureDevinModelsOptions, captureDevinModels } from '../models/capture.js';
import {
  type DevinSessionSyncOutcome,
  type DevinSyncProgressEvent,
  runDevinSessionSync,
} from '../session-sync.js';
import { validateCliConfig } from './config.js';
import { resolveCliEnv } from './env.js';

export interface SyncCommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  storageAdapter?: StorageAdapter;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  force?: boolean;
  /** Sync all sessions regardless of working directory. Bypasses workdir filtering. */
  all?: boolean;
  /** Defaults to `DevinHarnessProfile`. See `.agents/rules` DS-B5 (#143): the harness
   * identity is always threaded from the profile, never a hardcoded literal. */
  harnessProfile?: HarnessProfile;
  /** Overrides `sessions.db`'s resolved path; primarily for tests. */
  sessionsDbPath?: string;
  homeDir?: string;
  /** Optional overrides for the Devin models-list capture (e.g. test fixtures). */
  models?: Partial<CaptureDevinModelsOptions>;
}

function writeProgressLine(stdout: NodeJS.WritableStream, event: DevinSyncProgressEvent): void {
  const prefix =
    event.type === 'progress' ? '...   ' : event.type === 'success' ? '[ok]  ' : '[fail]';
  stdout.write(`${prefix} ${event.timestamp} ${event.message}\n`);
}

async function syncOneSessionSafely(
  session: DevinSessionRow,
  handle: DevinSnapshotHandle,
  config: SyncConfig,
  dataDir: string,
  storageAdapter: StorageAdapter,
  profile: HarnessProfile,
  env: Record<string, string | undefined>,
  stdout: NodeJS.WritableStream,
  homeDir: string | undefined,
  models: Partial<CaptureDevinModelsOptions> | undefined,
): Promise<DevinSessionSyncOutcome> {
  try {
    // Read only this session's tables — paginated, memory-bounded. Only one
    // session's data is in JS memory at a time, fixing the OOM that occurred
    // when the full snapshot loaded all sessions' rows simultaneously.
    const tables = handle.readSessionTables(session.id);
    return await runDevinSessionSync({
      tables,
      schemaDescriptor: handle.schemaDescriptor,
      sessionId: session.id,
      cwd: session.working_directory ?? process.cwd(),
      config,
      dataDir,
      storageAdapter,
      trigger: 'manual',
      profile,
      env,
      homeDir,
      models,
      releaseTablesAfterMaterialization: true,
      onProgress: (event) => writeProgressLine(stdout, event),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stdout.write(`[fail] session ${session.id} — ${message}\n`);
    return {
      sessionId: session.id,
      uploaded: 0,
      skipped: 0,
      failed: 1,
      errors: [message],
      warnings: [],
    };
  }
}

async function clearForceState(
  force: boolean,
  dataDir: string,
  projectId: string,
  stdout: NodeJS.WritableStream,
): Promise<void> {
  if (!force) return;
  const stateStore = new StateStore(dataDir);
  await stateStore.ensureDirectories();
  const removed = await stateStore.clearArtifactsForProject(projectId);
  if (removed > 0) {
    stdout.write(
      `[force] Cleared ${removed} local state record(s) for project "${projectId}".\n\n`,
    );
  }
}

async function openSnapshotHandleOrReport(
  env: Record<string, string | undefined>,
  cwd: string,
  devinCliVersion: string,
  stderr: NodeJS.WritableStream,
  sessionsDbPath: string | undefined,
  homeDir: string | undefined,
  workdirPatterns?: readonly string[],
): Promise<DevinSnapshotHandle | undefined> {
  try {
    return await openDevinSnapshotHandle({
      env,
      cwd,
      devinCliVersion,
      sessionsDbPath,
      home: homeDir,
      workdirPatterns,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`Error: could not read Devin sessions.db: ${message}\n`);
    return undefined;
  }
}

function summarizeTotals(
  outcomes: DevinSessionSyncOutcome[],
  stdout: NodeJS.WritableStream,
): { errors: string[] } {
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const outcome of outcomes) {
    uploaded += outcome.uploaded;
    skipped += outcome.skipped;
    failed += outcome.failed;
    errors.push(...outcome.errors.map((e) => `${outcome.sessionId}: ${e}`));
    warnings.push(...outcome.warnings.map((w) => `${outcome.sessionId}: ${w}`));
  }
  stdout.write('\n');
  stdout.write(
    `Synced ${outcomes.length} session(s): ${uploaded} files uploaded, ${skipped} skipped, ${failed} failed.\n`,
  );
  // Best-effort side-capture warnings (e.g. Devin models-list) never flip the
  // exit code, but per `.agents/rules/sync-progress-observability.md` they
  // must still be user-visible, not silently dropped.
  if (warnings.length > 0) {
    stdout.write(`Warnings: ${warnings.join('; ')}\n`);
  }
  return { errors };
}

/**
 * Manually upload all local Devin CLI sessions to S3 storage.
 *
 * - Reads the `sessions` list from `sessions.db` (lightweight), then reads
 *   each session's heavy tables (message_nodes, tool_call_state,
 *   prompt_history) one session at a time — never all sessions at once —
 *   so a store with hundreds of sessions doesn't OOM.
 * - For each session: materializes its transcript, discovers workspace/global
 *   config + session-linked plans, uploads the delta, and records the
 *   manifest.
 */
export async function runSyncCommand(options: SyncCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const force = options.force ?? false;
  const syncAll = options.all ?? false;
  const profile = options.harnessProfile ?? DevinHarnessProfile;

  const env = options.env ?? (await resolveCliEnv(cwd));
  const validation = validateCliConfig(env, cwd);
  if (!validation.ok || !validation.config) {
    stderr.write(`${validation.errorMessage ?? 'Configuration error.'}\n`);
    return 1;
  }
  const config = validation.config;
  const dataDir = getDataDir(env);

  // Resolve workdir patterns up front so sessions.db can filter rows directly
  // via SQL (`WHERE working_directory LIKE "/path/%"`).
  let activePatterns: string[] | undefined;
  let configuredPatterns: string[] = [];
  let hasConfiguredPatterns = false;
  if (!syncAll) {
    const workdirConfig = await readWorkdirConfig(dataDir, config.projectId);
    configuredPatterns = workdirConfig.workdirs;
    hasConfiguredPatterns = configuredPatterns.length > 0;
    if (hasConfiguredPatterns) {
      activePatterns = workdirMatches(cwd, configuredPatterns)
        ? configuredPatterns
        : [cwd, ...configuredPatterns];
    } else {
      activePatterns = [cwd];
    }
  }

  // Reading the session list from sessions.db can take a moment on large
  // stores — show the user we're working before the first per-session
  // progress line appears.
  stdout.write('Finding sessions...\n');

  let handle = await openSnapshotHandleOrReport(
    env,
    cwd,
    profile.harnessVersion,
    stderr,
    options.sessionsDbPath,
    options.homeDir,
    activePatterns,
  );
  if (!handle) return 1;

  try {
    if (handle.sessions.length === 0) {
      if (!handle.hasAnySessions()) {
        stdout.write('No local Devin sessions found to sync.\n');
        return 0;
      }
      if (!syncAll && activePatterns) {
        stdout.write(
          `No sessions found matching the configured working directories for project "${config.projectId}".\n`,
        );
        stdout.write(
          `Use \`${profile.harness === 'devin' ? 'devin-sync' : 'claude-sync'} workdir add\` to configure working directories, or \`sync --all\` to sync everything.\n`,
        );
        return 0;
      }
      stdout.write('No local Devin sessions found to sync.\n');
      return 0;
    }

    const storageAdapter = options.storageAdapter ?? buildStorageAdapter(config);
    await clearForceState(force, dataDir, config.projectId, stdout);

    const models = await captureDevinModels({
      dataDir,
      devinCliVersion: profile.harnessVersion,
      ...options.models,
    });
    if (models.error) {
      stderr.write(`devin-sync: models capture warning: ${models.error}\n`);
    }

    // Filter sessions by working directory unless --all is set. The filter
    // uses the project's workdir config (`~/.sal-sync/projects/<projectId>/
    // config.json`); if no config exists, defaults to the current cwd so
    // `devin-sync sync` run from a project directory only syncs that
    // project's sessions — not every session on the machine.
    let sessionsToSync = handle.sessions;
    if (!syncAll && activePatterns) {
      sessionsToSync = handle.sessions.filter((s) => {
        if (!s.working_directory) return false;
        return workdirMatches(s.working_directory, activePatterns);
      });
      if (hasConfiguredPatterns) {
        stdout.write(
          `Filtering project folder and ${configuredPatterns.length} workdir pattern(s): ${configuredPatterns.join(', ')}\n`,
        );
      } else {
        stdout.write(`Filtering by current directory: ${cwd}\n`);
      }

      if (sessionsToSync.length === 0) {
        stdout.write(
          `No sessions found matching the configured working directories for project "${config.projectId}".\n`,
        );
        stdout.write(
          `Use \`${profile.harness === 'devin' ? 'devin-sync' : 'claude-sync'} workdir add\` to configure working directories, or \`sync --all\` to sync everything.\n`,
        );
        return 0;
      }
    }

    stdout.write(
      `Syncing ${sessionsToSync.length} session(s) for project "${config.projectId}"...\n\n`,
    );

    // Reopen the database every N sessions to clear SQLite's internal page
    // cache and allow V8 to GC accumulated StatementSync objects. Each
    // per-session read creates new prepared statements via db.prepare(); on
    // large stores (hundreds of sessions), these accumulate in V8's old
    // space and are not reclaimed until a major GC runs. Reopening
    // periodically forces a clean slate without the overhead of reopening
    // per session.
    const SESSIONS_PER_DB_HANDLE = 25;
    const outcomes: DevinSessionSyncOutcome[] = [];
    for (let i = 0; i < sessionsToSync.length; i++) {
      if (i > 0 && i % SESSIONS_PER_DB_HANDLE === 0) {
        handle.close();
        handle = await openSnapshotHandleOrReport(
          env,
          cwd,
          profile.harnessVersion,
          stderr,
          options.sessionsDbPath,
          options.homeDir,
          activePatterns,
        );
        if (!handle) {
          stderr.write('Error: could not reopen Devin sessions.db during sync.\n');
          return 1;
        }
      }
      outcomes.push(
        await syncOneSessionSafely(
          sessionsToSync[i],
          handle,
          config,
          dataDir,
          storageAdapter,
          profile,
          env,
          stdout,
          options.homeDir,
          options.models,
        ),
      );
    }

    const { errors } = summarizeTotals(outcomes, stdout);
    return errors.length > 0 ? 1 : 0;
  } finally {
    handle?.close();
  }
}
