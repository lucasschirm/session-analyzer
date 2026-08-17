import type { SyncManifest } from '../manifest/index.js';
import { StateStore } from '../state/index.js';
import {
  buildManifestArtifactsFromResults,
  buildSessionData,
  buildStorageAdapter,
  buildTelemetryRecord,
  type CliOptions,
  type CommandResult,
  emitTelemetry,
  getDataDir,
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
 * Manual sync: perform a full capture + upload + manifest.
 *
 * This is intended for recovery or ad-hoc use. It validates input, loads
 * configuration, discovers and uploads the current delta, then uploads a
 * manifest for the session.
 */
export async function sync(options: CliOptions = {}): Promise<CommandResult> {
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
    await emitTelemetry(
      dataDir,
      buildTelemetryRecord({
        run: {
          ...zeroRun('manual', sessionId, 'sync'),
          errors,
        },
        sessionId,
        command: 'sync',
        diagnostics,
      }),
    );
    return { exitCode: 0, skipped: true };
  }

  const input = validation.input;
  const config = resolved.config;
  const storageAdapter = options.storageAdapter ?? buildStorageAdapter(config);

  const session = buildSessionData(input, config);
  session.startedAt = session.startedAt ?? new Date().toISOString();

  const stateStore = new StateStore(dataDir);
  await stateStore.setSession(input.session_id, session);

  const { result: runResult, candidateResults } = await runFullSync({
    config,
    hookInput: input,
    dataDir,
    storageAdapter,
    trigger: 'manual',
    uploadTimeoutMs: config.timeouts.syncTimeoutMs,
    session,
  });

  const run = { ...runResult, trigger: 'manual' as const };

  const manifestArtifacts = buildManifestArtifactsFromResults(candidateResults, runResult);

  let manifest: SyncManifest | undefined;
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

  const telemetry = buildTelemetryRecord({
    run,
    sessionId: input.session_id,
    command: 'sync',
  });
  await emitTelemetry(dataDir, telemetry);

  return { exitCode: 0, run, manifest };
}
