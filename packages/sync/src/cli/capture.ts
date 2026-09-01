import { StorageError } from '@lucasschirm/sal-sync-core';
import { ManifestGenerator } from '../manifest/index.js';
import { FileLock, StateStore } from '../state/index.js';
import {
  buildManifestArtifactsFromResults,
  buildSessionData,
  buildStorageAdapter,
  buildTelemetryRecord,
  type CliOptions,
  type CommandResult,
  emitTelemetry,
  getDataDir,
  getSessionSyncLockPath,
  normalizeTrigger,
  readHookInput,
  recordAndUploadManifest,
  resolveConfig,
  resolveStorageError,
  runFullSync,
  type SyncErrorCode,
  sanitizeHookInput,
  validateHookInput,
  zeroRun,
} from './common.js';

/**
 * Fire-and-forget one-shot sync: discover, sanitize, hash, upload the delta.
 *
 * This command is the spawned work for hook events. It reads the hook input
 * from stdin, validates the required fields, and exits 0 even when the input
 * is malformed or the sync is skipped. It never intentionally fails the hook.
 */
export async function capture(options: CliOptions = {}): Promise<CommandResult> {
  const dataDir = options.dataDir ?? getDataDir(options.env);
  const resolved = await resolveConfig(options);

  if (resolved.configError) {
    const sessionId = 'unknown';
    const zero = zeroRun('manual', sessionId, 'capture');
    zero.errors = [resolved.configError.code];
    zero.errorDetails = [
      { code: resolved.configError.code, message: resolved.configError.message },
    ];
    await emitTelemetry(
      dataDir,
      buildTelemetryRecord({
        run: zero,
        sessionId,
        command: 'capture',
        diagnostics: { configError: resolved.configError.code },
      }),
    );
    return { exitCode: 0 };
  }

  const rawInput = await readHookInput(options);
  const sanitized = sanitizeHookInput(rawInput);
  const validation = validateHookInput(sanitized, ['session_id', 'cwd', 'transcript_path']);
  if (!validation.ok) {
    const sessionId = typeof rawInput?.session_id === 'string' ? rawInput.session_id : 'unknown';
    const errors: SyncErrorCode[] = ['SYNC_JSON_PARSE_FAILED'];
    const zero = zeroRun('manual', sessionId, 'capture');
    zero.errors = errors;
    await emitTelemetry(
      dataDir,
      buildTelemetryRecord({
        run: zero,
        sessionId,
        command: 'capture',
        diagnostics: { malformed: true, missingFields: validation.missing },
      }),
    );
    return { exitCode: 0, skipped: true };
  }

  const input = validation.input;

  if (!resolved.config) {
    const zero = zeroRun('manual', input.session_id, 'capture');
    await emitTelemetry(
      dataDir,
      buildTelemetryRecord({
        run: zero,
        sessionId: input.session_id,
        command: 'capture',
        diagnostics: { disabled: true },
      }),
    );
    return { exitCode: 0, skipped: true };
  }

  const config = resolved.config;
  const storageAdapter = options.storageAdapter ?? buildStorageAdapter(config);
  const lockPath = getSessionSyncLockPath(dataDir, input.session_id);
  const lock = new FileLock(lockPath, { acquireTimeoutMs: 0 });

  try {
    const trigger =
      input.trigger === 'file-changed' && input.target_path
        ? 'file-changed'
        : normalizeTrigger(input.trigger);

    // Ensure session data exists in the state store. If session-start failed
    // or never ran, subsequent hooks (Stop, SubagentStop, etc.) must still
    // record the session so a manifest can be generated.
    const stateStore = new StateStore(dataDir);
    const existing = await stateStore.getSession(input.session_id);
    if (!existing) {
      const session = buildSessionData(input, config);
      session.startedAt = session.startedAt ?? new Date().toISOString();
      await stateStore.setSession(input.session_id, session);
    }

    const fullResult = await lock.withLock(() =>
      runFullSync({
        config,
        hookInput: input,
        dataDir,
        storageAdapter,
        trigger,
        uploadTimeoutMs: config.timeouts.hookUploadTimeoutMs,
      }),
    );

    const generator = new ManifestGenerator(dataDir, { storageAdapter });
    const run = { ...fullResult.result, trigger };
    await generator.recordRun(input.session_id, run);

    // Upload the manifest on every hook fire so the session is always
    // discoverable by the dashboard, even if session-start or session-end
    // failed. This acts as the recovery path: each hook re-uploads the
    // manifest with the latest artifact list. The manifest upload is bounded
    // by the hook upload timeout so a stuck storage call cannot hang the
    // fire-and-forget hook.
    const session =
      (await stateStore.getSession(input.session_id)) ?? buildSessionData(input, config);
    const manifestArtifacts = buildManifestArtifactsFromResults(
      fullResult.candidateResults,
      fullResult.result,
    );
    try {
      const manifestPromise = recordAndUploadManifest({
        dataDir,
        session,
        run,
        manifestArtifacts,
        storageAdapter,
        captureTranscripts: config.captureTranscripts,
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          reject(
            new StorageError(
              'SYNC_NETWORK_TIMEOUT',
              `Manifest upload timed out after ${config.timeouts.hookUploadTimeoutMs}ms`,
              true,
            ),
          );
        }, config.timeouts.hookUploadTimeoutMs);
        manifestPromise.finally(() => clearTimeout(timer)).catch(() => {});
      });
      await Promise.race([manifestPromise, timeoutPromise]);
    } catch (err) {
      const code = resolveStorageError(err);
      if (!run.errors.includes(code)) {
        run.errors.push(code);
      }
    }

    const telemetry = buildTelemetryRecord({
      run,
      sessionId: input.session_id,
      command: 'capture',
      diagnostics: { targetPath: input.target_path },
    });
    await emitTelemetry(dataDir, telemetry);

    return { exitCode: 0, run };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Failed to acquire lock')) {
      const zero = zeroRun('manual', input.session_id, 'capture');
      await emitTelemetry(
        dataDir,
        buildTelemetryRecord({
          run: zero,
          sessionId: input.session_id,
          command: 'capture',
          diagnostics: { duplicate: true },
        }),
      );
      return { exitCode: 0, skipped: true };
    }
    throw err;
  }
}
