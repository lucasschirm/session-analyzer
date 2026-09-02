import process from 'node:process';

import {
  buildStorageAdapter,
  getDataDir,
  type HarnessProfile,
  StateStore,
  type StorageAdapter,
  type SyncConfig,
} from '@lucasschirm/sal-sync';

import { DevinHarnessProfile } from '../devin-profile.js';
import { type DevinSnapshot, readDevinSnapshot } from '../devin-snapshot.js';
import type { DevinSessionRow } from '../extractor/types.js';
import { captureDevinModels } from '../models/capture.js';
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
  /** Defaults to `DevinHarnessProfile`. See `.agents/rules` DS-B5 (#143): the harness
   * identity is always threaded from the profile, never a hardcoded literal. */
  harnessProfile?: HarnessProfile;
  /** Overrides `sessions.db`'s resolved path; primarily for tests. */
  sessionsDbPath?: string;
  homeDir?: string;
}

function writeProgressLine(stdout: NodeJS.WritableStream, event: DevinSyncProgressEvent): void {
  const prefix =
    event.type === 'progress' ? '...   ' : event.type === 'success' ? '[ok]  ' : '[fail]';
  stdout.write(`${prefix} ${event.timestamp} ${event.message}\n`);
}

async function syncOneSessionSafely(
  session: DevinSessionRow,
  snapshot: DevinSnapshot,
  config: SyncConfig,
  dataDir: string,
  storageAdapter: StorageAdapter,
  profile: HarnessProfile,
  env: Record<string, string | undefined>,
  stdout: NodeJS.WritableStream,
  homeDir: string | undefined,
): Promise<DevinSessionSyncOutcome> {
  try {
    return await runDevinSessionSync({
      tables: snapshot.tables,
      schemaDescriptor: snapshot.schemaDescriptor,
      sessionId: session.id,
      cwd: session.working_directory ?? process.cwd(),
      config,
      dataDir,
      storageAdapter,
      trigger: 'manual',
      profile,
      env,
      homeDir,
      onProgress: (event) => writeProgressLine(stdout, event),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stdout.write(`[fail] session ${session.id} — ${message}\n`);
    return { sessionId: session.id, uploaded: 0, skipped: 0, failed: 1, errors: [message] };
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

async function readSnapshotOrReport(
  env: Record<string, string | undefined>,
  cwd: string,
  devinCliVersion: string,
  stderr: NodeJS.WritableStream,
  sessionsDbPath: string | undefined,
  homeDir: string | undefined,
): Promise<DevinSnapshot | undefined> {
  try {
    return await readDevinSnapshot({ env, cwd, devinCliVersion, sessionsDbPath, home: homeDir });
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
  for (const outcome of outcomes) {
    uploaded += outcome.uploaded;
    skipped += outcome.skipped;
    failed += outcome.failed;
    errors.push(...outcome.errors.map((e) => `${outcome.sessionId}: ${e}`));
  }
  stdout.write('\n');
  stdout.write(
    `Synced ${outcomes.length} session(s): ${uploaded} files uploaded, ${skipped} skipped, ${failed} failed.\n`,
  );
  return { errors };
}

/**
 * Manually upload all local Devin CLI sessions to S3 storage.
 *
 * - Reads every session directly from `sessions.db` (`cli/project.ts`'s
 *   `listDevinSessions`, reused via `readDevinSnapshot`) — never scoped to
 *   the invoking cwd.
 * - For each session: materializes its transcript, discovers workspace/global
 *   config + session-linked plans, uploads the delta, and records the
 *   manifest.
 */
export async function runSyncCommand(options: SyncCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const force = options.force ?? false;
  const profile = options.harnessProfile ?? DevinHarnessProfile;

  const env = options.env ?? (await resolveCliEnv(cwd));
  const validation = validateCliConfig(env, cwd);
  if (!validation.ok || !validation.config) {
    stderr.write(`${validation.errorMessage ?? 'Configuration error.'}\n`);
    return 1;
  }
  const config = validation.config;

  const snapshot = await readSnapshotOrReport(
    env,
    cwd,
    profile.harnessVersion,
    stderr,
    options.sessionsDbPath,
    options.homeDir,
  );
  if (!snapshot) return 1;

  if (snapshot.tables.sessions.length === 0) {
    stdout.write('No local Devin sessions found to sync.\n');
    return 0;
  }

  const storageAdapter = options.storageAdapter ?? buildStorageAdapter(config);
  const dataDir = getDataDir(env);
  await clearForceState(force, dataDir, config.projectId, stdout);

  const models = await captureDevinModels({ dataDir, devinCliVersion: profile.harnessVersion });
  if (models.error) {
    stderr.write(`devin-sync: models capture warning: ${models.error}\n`);
  }

  stdout.write(
    `Syncing ${snapshot.tables.sessions.length} session(s) for project "${config.projectId}"...\n\n`,
  );

  const outcomes: DevinSessionSyncOutcome[] = [];
  for (const session of snapshot.tables.sessions) {
    outcomes.push(
      await syncOneSessionSafely(
        session,
        snapshot,
        config,
        dataDir,
        storageAdapter,
        profile,
        env,
        stdout,
        options.homeDir,
      ),
    );
  }

  const { errors } = summarizeTotals(outcomes, stdout);
  return errors.length > 0 ? 1 : 0;
}
