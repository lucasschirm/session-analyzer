/**
 * Mandatory watcher daemon (`bin/watcher`) polling `sessions.db` watermarks
 * — the primary mitigation for Devin Cloud sessions, which never fire
 * `SessionStart`/`SessionEnd` command hooks at all (verified, Part A3).
 *
 * Unlike `claude-session-sync`'s `transcript-watcher` (spawned per session
 * by `SessionStart`, tailing one transcript file via `fs.watch`), this
 * watcher is a single long-running, global process: it polls the shared
 * `sessions.db` on an interval, computes a composite watermark signature per
 * session (`sessions.last_activity_at` + the high-water `row_id`/`id` across
 * `message_nodes`/`tool_call_state`/`prompt_history`), and re-syncs only the
 * sessions whose signature changed since the previous poll. It is started
 * independently (not spawned by a hook), since the hook that would spawn it
 * (`SessionStart`) is exactly the one Cloud sessions never fire.
 */
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  buildStorageAdapter,
  getDataDir,
  type HarnessProfile,
  type StorageAdapter,
  type SyncConfig,
} from '@lucasschirm/sal-sync';

import { validateCliConfig } from './cli/config.js';
import { resolveCliEnv } from './cli/env.js';
import { DevinHarnessProfile } from './devin-profile.js';
import { type DevinSnapshot, readDevinSnapshot } from './devin-snapshot.js';
import type { DevinExtractedTables, DevinSessionRow } from './extractor/types.js';
import { isMainModule } from './is-main-module.js';
import { captureDevinModels } from './models/capture.js';
import {
  type DevinSessionSyncOutcome,
  hasSyncFailure,
  runDevinSessionSync,
} from './session-sync.js';

export const DEFAULT_WATCHER_POLL_INTERVAL_MS = 15_000;

type WatcherSignatures = Record<string, string>;

function watcherStatePath(dataDir: string): string {
  return path.join(dataDir, 'devin', 'watcher-state.json');
}

async function readWatcherSignatures(dataDir: string): Promise<WatcherSignatures> {
  try {
    const raw = await fsp.readFile(watcherStatePath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as WatcherSignatures)
      : {};
  } catch {
    return {};
  }
}

async function writeWatcherSignatures(
  dataDir: string,
  signatures: WatcherSignatures,
): Promise<void> {
  const filePath = watcherStatePath(dataDir);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(signatures, null, 2), 'utf8');
}

function maxRowId(rows: ReadonlyArray<{ row_id: number }>): number {
  return rows.length === 0 ? -1 : Math.max(...rows.map((r) => r.row_id));
}

/**
 * Composite watermark signature for one session — the "polling `sessions.db`
 * watermarks" mechanism the mandatory watcher must use (Part A3), never a
 * file-tail. Comparing this against the prior poll's stored value determines
 * whether a session needs re-syncing this tick.
 */
export function computeSessionWatermarkSignature(
  tables: DevinExtractedTables,
  sessionId: string,
): string {
  const session = tables.sessions.find((s) => s.id === sessionId);
  const messageMax = maxRowId(tables.messageNodes.filter((m) => m.session_id === sessionId));
  const toolMax = maxRowId(tables.toolCallStates.filter((t) => t.session_id === sessionId));
  const promptMax = tables.promptHistory
    .filter((p) => p.session_id === sessionId)
    .reduce((max, p) => Math.max(max, p.id), -1);
  return JSON.stringify([session?.last_activity_at ?? null, messageMax, toolMax, promptMax]);
}

export interface RunDevinWatcherOptions {
  dataDir?: string;
  env?: Record<string, string | undefined>;
  pollIntervalMs?: number;
  /** Run at most this many poll passes then return — used by tests; omit to loop forever. */
  maxPolls?: number;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  storageAdapter?: StorageAdapter;
  profile?: HarnessProfile;
  cwd?: string;
  /** Overrides `sessions.db`'s resolved path; primarily for tests. */
  sessionsDbPath?: string;
  homeDir?: string;
}

function writeWatcherLine(stdout: NodeJS.WritableStream, message: string): void {
  stdout.write(`${new Date().toISOString()} devin-watcher: ${message}\n`);
}

async function syncChangedSession(
  session: DevinSessionRow,
  snapshot: DevinSnapshot,
  config: SyncConfig,
  dataDir: string,
  storageAdapter: StorageAdapter,
  profile: HarnessProfile,
  env: Record<string, string | undefined>,
  stdout: NodeJS.WritableStream,
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
      trigger: 'file-changed',
      profile,
      env,
      onProgress: (event) => writeWatcherLine(stdout, event.message),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeWatcherLine(stdout, `session ${session.id} failed: ${message}`);
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

interface PollDependencies {
  config: SyncConfig;
  dataDir: string;
  env: Record<string, string | undefined>;
  storageAdapter: StorageAdapter;
  profile: HarnessProfile;
  stderr: NodeJS.WritableStream;
  sessionsDbPath?: string;
  homeDir?: string;
}

async function pollOnce(
  deps: PollDependencies,
  signatures: WatcherSignatures,
  stdout: NodeJS.WritableStream,
): Promise<{ checked: number; changed: number; failed: number }> {
  const models = await captureDevinModels({
    dataDir: deps.dataDir,
    devinCliVersion: deps.profile.harnessVersion,
  });
  if (models.error) {
    deps.stderr.write(`devin-watcher: models capture warning: ${models.error}\n`);
  }

  const snapshot = await readDevinSnapshot({
    env: deps.env,
    devinCliVersion: deps.profile.harnessVersion,
    sessionsDbPath: deps.sessionsDbPath,
    home: deps.homeDir,
  });
  let changed = 0;
  let failed = 0;

  for (const session of snapshot.tables.sessions) {
    const signature = computeSessionWatermarkSignature(snapshot.tables, session.id);
    if (signatures[session.id] === signature) continue;

    changed += 1;
    const outcome = await syncChangedSession(
      session,
      snapshot,
      deps.config,
      deps.dataDir,
      deps.storageAdapter,
      deps.profile,
      deps.env,
      stdout,
    );
    if (hasSyncFailure(outcome)) {
      failed += 1;
    } else {
      signatures[session.id] = signature;
    }
  }

  return { checked: snapshot.tables.sessions.length, changed, failed };
}

async function resolveWatcherDependencies(
  options: RunDevinWatcherOptions,
): Promise<PollDependencies | { errorMessage: string }> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? (await resolveCliEnv(cwd));
  const validation = validateCliConfig(env, cwd);
  if (!validation.ok || !validation.config) {
    return { errorMessage: validation.errorMessage ?? 'configuration error' };
  }
  const config = validation.config;
  const profile = options.profile ?? DevinHarnessProfile;
  return {
    config,
    dataDir: options.dataDir ?? getDataDir(env),
    env,
    storageAdapter: options.storageAdapter ?? buildStorageAdapter(config),
    profile,
    stderr: options.stderr ?? process.stderr,
    sessionsDbPath: options.sessionsDbPath,
    homeDir: options.homeDir,
  };
}

function installShutdownHandlers(stop: () => void): () => void {
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return () => {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  };
}

async function runPollLoop(
  deps: PollDependencies,
  options: RunDevinWatcherOptions,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WATCHER_POLL_INTERVAL_MS;
  const signatures = await readWatcherSignatures(deps.dataDir);

  let stopped = false;
  const removeHandlers = installShutdownHandlers(() => {
    stopped = true;
  });

  let pollCount = 0;
  try {
    while (!stopped) {
      pollCount += 1;
      try {
        const result = await pollOnce(deps, signatures, stdout);
        await writeWatcherSignatures(deps.dataDir, signatures);
        writeWatcherLine(
          stdout,
          `poll #${pollCount}: ${result.checked} session(s) checked, ${result.changed} changed, ${result.failed} failed`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stderr.write(`devin-watcher: poll #${pollCount} failed: ${message}\n`);
      }
      if (options.maxPolls !== undefined && pollCount >= options.maxPolls) break;
      if (stopped) break;
      await delay(pollIntervalMs);
    }
  } finally {
    removeHandlers();
  }
  writeWatcherLine(stdout, 'stopped');
}

/**
 * Runs the watcher: validates configuration, then polls `sessions.db` on an
 * interval until stopped (`SIGTERM`/`SIGINT`, or `maxPolls` is reached — used
 * by tests). Every poll emits a monotonic, timestamped progress line
 * (advancing progress) and a per-session terminal success/failure is
 * reported for any session that changed, per
 * `.agents/rules/sync-progress-observability.md`. A per-poll failure (e.g. a
 * transient `sessions.db` read error) is reported to stderr but does not
 * kill the daemon — only a configuration error at startup is fatal.
 */
export async function runDevinWatcher(options: RunDevinWatcherOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const deps = await resolveWatcherDependencies(options);
  if ('errorMessage' in deps) {
    stderr.write(`devin-watcher: ${deps.errorMessage}\n`);
    return 1;
  }

  writeWatcherLine(
    stdout,
    `starting — polling sessions.db every ${options.pollIntervalMs ?? DEFAULT_WATCHER_POLL_INTERVAL_MS}ms`,
  );
  await runPollLoop(deps, options, stdout, stderr);
  return 0;
}

async function main(): Promise<number> {
  return runDevinWatcher({});
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
