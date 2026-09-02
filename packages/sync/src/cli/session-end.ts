import type { SyncManifest } from '@lucasschirm/sal-sync-core';
import { DEFAULT_HARNESS_PROFILE } from '../discovery/default-profile.js';
import { FileLock, StateStore } from '../state/index.js';
import {
  buildCandidates,
  buildManifestArtifactsFromResults,
  buildSessionData,
  buildStorageAdapter,
  buildTelemetryRecord,
  type CliOptions,
  type CommandResult,
  type DiscoveryResult,
  defaultWatcherTerminator,
  discover,
  emitTelemetry,
  getDataDir,
  getSessionSyncLockPath,
  readHookInput,
  readWatcherPid,
  recordAndUploadManifest,
  removeWatcherPid,
  resolveConfig,
  resolveStorageError,
  runSessionEndUploadLoop,
  type SyncErrorCode,
  sanitizeHookInput,
  validateHookInput,
  zeroRun,
} from './common.js';

function computeDurationMs(
  startedAt: string | undefined,
  endedAt: string | undefined,
  fallback: number | undefined,
): number | undefined {
  if (startedAt && endedAt) {
    return new Date(endedAt).getTime() - new Date(startedAt).getTime();
  }
  return fallback;
}

/**
 * Session end: perform an awaited final delta sync, upload the manifest, and
 * shut down the watcher. The entire operation is bounded by
 * `SAL_SESSION_END_BUDGET_MS`. If the budget is exhausted, any remaining delta
 * is left in durable state and the hook exits successfully.
 */
export async function sessionEnd(options: CliOptions = {}): Promise<CommandResult> {
  const dataDir = options.dataDir ?? getDataDir(options.env);
  const resolved = await resolveConfig(options);

  const rawInput = await readHookInput(options);
  const sanitized = sanitizeHookInput(rawInput);
  const validation = validateHookInput(sanitized, [
    'session_id',
    'cwd',
    'transcript_path',
    'reason',
  ]);

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
    const zero = zeroRun('session-end', sessionId, 'session-end');
    zero.errors = errors;
    await emitTelemetry(
      dataDir,
      buildTelemetryRecord({
        run: zero,
        sessionId,
        command: 'session-end',
        diagnostics,
        sessionEndReason: validation.ok ? rawInput?.reason : undefined,
      }),
    );
    return { exitCode: 0, skipped: true };
  }

  const input = validation.input;
  const config = resolved.config;
  const storageAdapter = options.storageAdapter ?? buildStorageAdapter(config);
  const stateStore = new StateStore(dataDir);

  const existing = await stateStore.getSession(input.session_id);
  const session = buildSessionData(input, config);
  session.startedAt = session.startedAt ?? existing?.startedAt;
  session.endedAt = session.endedAt ?? new Date().toISOString();
  session.durationMs = computeDurationMs(
    session.startedAt,
    session.endedAt,
    input.duration_ms ?? existing?.durationMs,
  );
  session.endReason = input.reason;

  await stateStore.setSession(input.session_id, session);

  const start = Date.now();
  const budget = config.timeouts.sessionEndBudgetMs;
  const deadline = start + budget;

  const lockPath = getSessionSyncLockPath(dataDir, input.session_id);
  const lock = new FileLock(lockPath, { acquireTimeoutMs: budget });

  let discovery: DiscoveryResult | undefined;

  try {
    const lockResult = await lock.withLock(async () => {
      if (Date.now() >= deadline) {
        const zero = zeroRun('session-end', input.session_id, 'session-end');
        return {
          run: zero,
          budgetExhausted: true,
          manifest: undefined as SyncManifest | undefined,
        };
      }

      const discoveryStart = Date.now();
      discovery = await discover(
        {
          projectId: config.projectId,
          sessionId: input.session_id,
          workspaceRoot: input.cwd,
          transcriptPath: input.transcript_path,
          captureTranscripts: config.captureTranscripts,
          limits: config.limits,
        },
        options.harnessProfile ?? DEFAULT_HARNESS_PROFILE,
      );
      const discoveryDuration = Date.now() - discoveryStart;

      const sanitizationStart = Date.now();
      const candidateResults = await buildCandidates(discovery, config, {
        projectRoot: input.cwd,
      });
      const sanitizationDuration = Date.now() - sanitizationStart;

      for (const error of discovery.errors) {
        if (!errors.includes(error.code)) {
          errors.push(error.code);
        }
      }

      const loopResult = await stateStore.withState((state) =>
        runSessionEndUploadLoop({
          state,
          candidateResults,
          storageAdapter,
          config,
          deadline,
          start,
        }),
      );

      const { run, budgetExhausted, uploaded, failed, skipped } = loopResult;
      run.discoveryDurationMs = discoveryDuration;
      run.sanitizationDurationMs = sanitizationDuration;
      run.errors = run.errors ?? [];
      for (const code of errors) {
        if (!run.errors.includes(code)) {
          run.errors.push(code);
        }
      }

      const manifestArtifacts = buildManifestArtifactsFromResults(candidateResults, {
        uploaded,
        skipped,
        failed,
      });

      let manifest: SyncManifest | undefined;
      if (!budgetExhausted && Date.now() < deadline) {
        try {
          manifest = await recordAndUploadManifest({
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
      }

      return { run, budgetExhausted, manifest };
    });

    // Shut down the watcher if it is still alive.
    const watcherPid = await readWatcherPid(dataDir, input.session_id);
    if (watcherPid !== undefined) {
      const terminator = options.watcherTerminator ?? defaultWatcherTerminator;
      await terminator(watcherPid);
      await removeWatcherPid(dataDir, input.session_id);
    }

    const telemetry = buildTelemetryRecord({
      run: lockResult.run,
      sessionId: input.session_id,
      command: 'session-end',
      budgetExhausted: lockResult.budgetExhausted,
      sessionEndReason: input.reason,
      durationBudgetMs: budget,
      diagnostics: { watcherPid },
    });
    await emitTelemetry(dataDir, telemetry);

    return {
      exitCode: 0,
      run: lockResult.run,
      manifest: lockResult.manifest,
      budgetExhausted: lockResult.budgetExhausted,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Failed to acquire lock')) {
      await emitTelemetry(
        dataDir,
        buildTelemetryRecord({
          run: zeroRun('session-end', input.session_id, 'session-end'),
          sessionId: input.session_id,
          command: 'session-end',
          budgetExhausted: true,
          sessionEndReason: input.reason,
          durationBudgetMs: budget,
          diagnostics: { alreadyRunning: true },
        }),
      );
      return { exitCode: 0, budgetExhausted: true };
    }
    throw err;
  }
}
