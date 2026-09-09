import { ManifestGenerator } from '../manifest/index.js';
import { FileLock, StateStore } from '../state/index.js';
import {
  buildManifestArtifactsFromResults,
  buildSessionData,
  buildStorageAdapter,
  buildTelemetryRecord,
  type CliOptions,
  type CommandResult,
  defaultSpawnWatcher,
  emitTelemetry,
  getDataDir,
  getSessionSyncLockPath,
  readHookInput,
  recordAndUploadManifest,
  resolveConfig,
  resolveStorageError,
  runFullSync,
  type SyncErrorCode,
  sanitizeHookInput,
  validateHookInput,
  type WatcherHandle,
  zeroRun,
} from './common.js';

function spawnWatcherWithArgs(
  spawner: (args: string[]) => WatcherHandle,
  dataDir: string,
  sessionId: string,
  transcriptPath: string,
  cwd?: string,
): WatcherHandle {
  const args = [
    '--session-id',
    sessionId,
    '--transcript-path',
    transcriptPath,
    '--data-dir',
    dataDir,
  ];
  if (cwd) {
    args.push('--cwd', cwd);
  }
  return spawner(args);
}

/**
 * Session start: record session metadata, spawn the long-running watcher, and
 * perform an initial bulk upload.
 *
 * This is a fire-and-forget style hook: it validates input, guards against
 * duplicate spawns, spawns the watcher detached, and exits promptly.
 */
export async function sessionStart(options: CliOptions = {}): Promise<CommandResult> {
  const dataDir = options.dataDir ?? getDataDir(options.env);
  const resolved = await resolveConfig(options);

  const rawInput = await readHookInput(options);
  const sanitized = sanitizeHookInput(rawInput);
  const validation = validateHookInput(sanitized, ['session_id', 'cwd', 'transcript_path']);

  const sessionId =
    validation.ok && rawInput
      ? rawInput.session_id
      : typeof rawInput?.session_id === 'string'
        ? rawInput.session_id
        : 'unknown';

  const diagnostics: Record<string, unknown> = {};
  const errors: SyncErrorCode[] = [];
  if (!validation.ok) {
    diagnostics.malformed = true;
    diagnostics.missingFields = validation.missing;
    errors.push('SYNC_JSON_PARSE_FAILED');
  }
  if (resolved.configError) {
    diagnostics.configError = resolved.configError.code;
    errors.push(resolved.configError.code);
  }
  if (!resolved.config) {
    diagnostics.disabled = true;
  }

  if (!validation.ok || !resolved.config) {
    const zero = zeroRun('session-start', sessionId, 'session-start');
    zero.errors = errors;
    await emitTelemetry(
      dataDir,
      buildTelemetryRecord({
        run: zero,
        sessionId,
        command: 'session-start',
        diagnostics,
      }),
    );
    return { exitCode: 0, skipped: true };
  }

  const input = validation.input;
  const config = resolved.config;
  const storageAdapter = options.storageAdapter ?? buildStorageAdapter(config);

  const lockPath = getSessionSyncLockPath(dataDir, input.session_id);
  const lock = new FileLock(lockPath, { acquireTimeoutMs: 0 });

  try {
    const syncResult = await lock.withLock(async () => {
      const session = buildSessionData(input, config);
      session.startedAt = session.startedAt ?? new Date().toISOString();

      const stateStore = new StateStore(dataDir);
      await stateStore.setSession(input.session_id, session);

      // Spawn the watcher before the bulk upload so it can begin monitoring
      // immediately. The watcher is detached and unref'd.
      const spawner = options.spawnWatcher ?? defaultSpawnWatcher;
      const watcherHandle = spawnWatcherWithArgs(
        spawner,
        dataDir,
        input.session_id,
        input.transcript_path,
        input.cwd,
      );
      watcherHandle.unref();

      const fullResult = await runFullSync({
        config,
        hookInput: input,
        dataDir,
        storageAdapter,
        trigger: 'session-start',
        uploadTimeoutMs: config.timeouts.syncTimeoutMs,
        session,
        harnessProfile: options.harnessProfile,
      });

      const generator = new ManifestGenerator(dataDir, { storageAdapter });
      const run = { ...fullResult.result, trigger: 'session-start' as const };
      await generator.recordRun(input.session_id, run);

      // Upload the session manifest so the session is immediately
      // discoverable by the dashboard, even if session-end never runs.
      const manifestArtifacts = buildManifestArtifactsFromResults(
        fullResult.candidateResults,
        fullResult.result,
      );
      try {
        await recordAndUploadManifest({
          dataDir,
          session,
          run,
          manifestArtifacts,
          storageAdapter,
          captureTranscripts: config.captureTranscripts,
        });
      } catch (err) {
        const code = resolveStorageError(err);
        if (!run.errors.includes(code)) {
          run.errors.push(code);
        }
      }

      const telemetry = buildTelemetryRecord({
        run,
        sessionId: input.session_id,
        command: 'session-start',
        diagnostics: { watcherPid: watcherHandle.pid },
      });
      await emitTelemetry(dataDir, telemetry);

      return fullResult;
    });

    return { exitCode: 0, run: { ...syncResult.result, trigger: 'session-start' } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Failed to acquire lock')) {
      await emitTelemetry(
        dataDir,
        buildTelemetryRecord({
          run: zeroRun('session-start', input.session_id, 'session-start'),
          sessionId: input.session_id,
          command: 'session-start',
          diagnostics: { duplicate: true },
        }),
      );
      return { exitCode: 0, skipped: true };
    }
    throw err;
  }
}
