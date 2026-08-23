import { ManifestGenerator } from '../manifest/index.js';
import { FileLock } from '../state/index.js';
import {
  buildStorageAdapter,
  buildTelemetryRecord,
  type CliOptions,
  type CommandResult,
  emitTelemetry,
  getDataDir,
  getSessionSyncLockPath,
  normalizeTrigger,
  readHookInput,
  resolveConfig,
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
