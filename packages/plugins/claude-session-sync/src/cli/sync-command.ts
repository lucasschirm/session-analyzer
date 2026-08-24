import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  buildCandidates,
  buildManifestArtifactsFromResults,
  buildSessionData,
  buildStorageAdapter,
  buildUploader,
  type CliOptions,
  contentTypeFor,
  type DiscoveryResult,
  discover,
  discoverSession,
  type HookInput,
  MAIN_TRANSCRIPT_STORAGE_NAME,
  parseObjectKey,
  processDelta,
  putArtifactWithTimeout,
  recordAndUploadManifest,
  resolveStorageError,
  StateStore,
  type SyncConfig,
  type SyncErrorCode,
} from '@lucasschirm/sal-sync';

import { validateCliConfig } from './config.js';
import { resolveCliEnv } from './env.js';
import { listLocalSessions, resolveClaudeProjectDir } from './project.js';

export interface SyncCommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  storageAdapter?: CliOptions['storageAdapter'];
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  force?: boolean;
}

interface SessionSyncOutcome {
  sessionId: string;
  uploaded: number;
  skipped: number;
  failed: number;
  alreadyExists: boolean;
  errors: string[];
}

/**
 * Check whether a session is fully synced in storage.
 *
 * A session is considered complete when both required artifacts are present:
 *   1. `manifest.json` — the session manifest
 *   2. `transcript.jsonl` — the main transcript (when transcript capture is
 *      enabled, which is the default)
 *
 * This replaces the old prefix-existence check that treated any object under
 * `<projectId>/<sessionId>/` as evidence of a complete session. A manifest-only
 * upload (e.g. from a failed sync that uploaded the manifest but not the
 * transcript) must not block re-syncing the missing transcript.
 */
async function isSessionCompleteInStorage(
  storageAdapter: NonNullable<SyncCommandOptions['storageAdapter']>,
  projectId: string,
  sessionId: string,
): Promise<boolean> {
  if (!storageAdapter.listObjects) return false;
  try {
    const result = await storageAdapter.listObjects({ projectId, sessionId });
    const keys = new Set(result.objects.map((o) => o.key));
    const hasManifest = result.objects.some((o) => {
      const parsed = parseObjectKey(o.key);
      return parsed?.scope === 'manifest' && parsed.relativePath === 'manifest.json';
    });
    if (!hasManifest) return false;

    // Check for the main transcript. With the new key layout it lives at
    // `<projectId>/<sessionId>/transcript.jsonl`. For backward compatibility
    // also accept the old `<projectId>/<sessionId>/session/transcript.jsonl`.
    const transcriptKeys = [
      `${projectId}/${sessionId}/${MAIN_TRANSCRIPT_STORAGE_NAME}`,
      `${projectId}/${sessionId}/session/${MAIN_TRANSCRIPT_STORAGE_NAME}`,
    ];
    const hasTranscript = transcriptKeys.some((k) => keys.has(k));
    // If transcript capture is disabled (no transcript expected), manifest
    // alone is sufficient. We can't know the capture setting without
    // downloading the manifest, so we err on the side of completeness:
    // require the transcript unless we can prove it's not expected.
    // In practice, transcript capture is the default and the vast majority
    // of sessions have transcripts.
    return hasTranscript;
  } catch {
    // If listing fails, proceed with upload (let putObject surface the error).
    return false;
  }
}

/**
 * Run a full sync (workspace + global + session scopes) for a single session.
 * Used for the first session uploaded so that workspace/global config is
 * captured exactly once.
 */
async function runFullScopeSync(
  config: SyncConfig,
  hookInput: HookInput,
  storageAdapter: NonNullable<SyncCommandOptions['storageAdapter']>,
  dataDir: string,
): Promise<SessionSyncOutcome> {
  const stateStore = new StateStore(dataDir);
  await stateStore.ensureDirectories();

  const session = buildSessionData(hookInput, config);
  session.startedAt = session.startedAt ?? new Date().toISOString();
  await stateStore.setSession(hookInput.session_id, session);

  const discovery = await discover({
    projectId: config.projectId,
    sessionId: hookInput.session_id,
    workspaceRoot: hookInput.cwd,
    transcriptPath: hookInput.transcript_path,
    captureTranscripts: config.captureTranscripts,
    limits: config.limits,
  });

  const candidateResults = await buildCandidates(discovery, config, {
    projectRoot: hookInput.cwd,
  });
  const candidates = candidateResults.map((r) => r.candidate);
  const uploader = buildUploader({
    storageAdapter,
    timeoutMs: config.timeouts.syncTimeoutMs,
  });

  const deltaResult = await stateStore.withState((state) =>
    processDelta({
      state,
      trigger: 'manual',
      candidates,
      uploader,
      storageAdapter,
      session,
      transcriptsCaptured: config.captureTranscripts,
    }),
  );

  const manifestArtifacts = buildManifestArtifactsFromResults(candidateResults, {
    uploaded: deltaResult.uploaded,
    skipped: deltaResult.skipped,
    failed: deltaResult.failed,
  });

  const errors = [...deltaResult.errors];
  try {
    await recordAndUploadManifest({
      dataDir,
      session,
      run: { ...deltaResult, trigger: 'manual' },
      manifestArtifacts,
      storageAdapter,
      captureTranscripts: config.captureTranscripts,
    });
  } catch (err) {
    const code = resolveStorageError(err);
    if (!errors.includes(code)) errors.push(code);
  }

  return {
    sessionId: hookInput.session_id,
    uploaded: deltaResult.filesUploaded,
    skipped: deltaResult.filesSkipped,
    failed: deltaResult.filesFailed,
    alreadyExists: false,
    errors,
  };
}

/**
 * Run a session-only sync (transcripts only). Used for subsequent sessions
 * after the first one has already captured workspace/global config.
 */
async function runSessionOnlySync(
  config: SyncConfig,
  hookInput: HookInput,
  storageAdapter: NonNullable<SyncCommandOptions['storageAdapter']>,
  dataDir: string,
): Promise<SessionSyncOutcome> {
  const stateStore = new StateStore(dataDir);
  await stateStore.ensureDirectories();

  const session = buildSessionData(hookInput, config);
  session.startedAt = session.startedAt ?? new Date().toISOString();
  await stateStore.setSession(hookInput.session_id, session);

  const discovery = await discoverSession({
    projectId: config.projectId,
    sessionId: hookInput.session_id,
    transcriptPath: hookInput.transcript_path,
    captureTranscripts: config.captureTranscripts,
    limits: config.limits,
  });

  const candidateResults = await buildCandidates(discovery, config, {
    projectRoot: hookInput.cwd,
  });
  const candidates = candidateResults.map((r) => r.candidate);
  const uploader = buildUploader({
    storageAdapter,
    timeoutMs: config.timeouts.syncTimeoutMs,
  });

  const deltaResult = await stateStore.withState((state) =>
    processDelta({
      state,
      trigger: 'manual',
      candidates,
      uploader,
      storageAdapter,
      session,
      transcriptsCaptured: config.captureTranscripts,
    }),
  );

  const manifestArtifacts = buildManifestArtifactsFromResults(candidateResults, {
    uploaded: deltaResult.uploaded,
    skipped: deltaResult.skipped,
    failed: deltaResult.failed,
  });

  const errors = [...deltaResult.errors];
  try {
    await recordAndUploadManifest({
      dataDir,
      session,
      run: { ...deltaResult, trigger: 'manual' },
      manifestArtifacts,
      storageAdapter,
      captureTranscripts: config.captureTranscripts,
    });
  } catch (err) {
    const code = resolveStorageError(err);
    if (!errors.includes(code)) errors.push(code);
  }

  return {
    sessionId: hookInput.session_id,
    uploaded: deltaResult.filesUploaded,
    skipped: deltaResult.filesSkipped,
    failed: deltaResult.filesFailed,
    alreadyExists: false,
    errors,
  };
}

/**
 * Manually upload all local sessions for the current project to S3 storage.
 *
 * - Discovers the Claude Code project folder from `cwd`.
 * - Lists all local `.jsonl` transcript files.
 * - For each session, checks if it already exists in storage; if so, skips it.
 * - The first session uploaded captures workspace + global + session scopes.
 * - Subsequent sessions capture only session-scoped transcripts.
 */
export async function runSyncCommand(options: SyncCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const force = options.force ?? false;

  const env = options.env ?? (await resolveCliEnv(cwd));
  const validation = validateCliConfig(env, cwd);
  if (!validation.ok || !validation.config) {
    stderr.write(`${validation.errorMessage ?? 'Configuration error.'}\n`);
    return 1;
  }

  const config = validation.config;
  const projectDir = await resolveClaudeProjectDir(cwd);
  if (!projectDir) {
    stderr.write(
      `Error: could not find a Claude Code project folder for ${cwd} in ~/.claude/projects/.\n` +
        `Run "claude" in this directory first to create session transcripts.\n`,
    );
    return 1;
  }

  const sessions = await listLocalSessions(projectDir);
  if (sessions.length === 0) {
    stdout.write('No local sessions found to sync.\n');
    return 0;
  }

  const storageAdapter = options.storageAdapter ?? buildStorageAdapter(config);
  if (!storageAdapter.listObjects) {
    stderr.write('Error: the configured storage adapter does not support listing objects.\n');
    return 1;
  }

  const dataDir = env.SAL_DATA_DIR ?? path.join(os.homedir(), '.sal-sync');

  if (force) {
    const stateStore = new StateStore(dataDir);
    await stateStore.ensureDirectories();
    const removed = await stateStore.clearArtifactsForProject(config.projectId);
    if (removed > 0) {
      stdout.write(
        `[force] Cleared ${removed} local state record(s) for project "${config.projectId}".\n\n`,
      );
    }
  }

  stdout.write(`Syncing ${sessions.length} session(s) for project "${config.projectId}"...\n\n`);

  let totalUploaded = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  let totalAlreadyExists = 0;
  let firstSessionUploaded = false;
  const allErrors: string[] = [];

  for (const session of sessions) {
    // With --force, skip the completeness check and always re-sync.
    const complete = force
      ? false
      : await isSessionCompleteInStorage(storageAdapter, config.projectId, session.sessionId);

    if (complete) {
      stdout.write(`[skip] session ${session.sessionId} — already synced\n`);
      totalAlreadyExists += 1;
      continue;
    }

    const hookInput: HookInput = {
      session_id: session.sessionId,
      cwd,
      transcript_path: session.transcriptPath,
      harness: 'claude',
      harness_version: '0.1.0',
      trigger: 'manual',
    };

    let outcome: SessionSyncOutcome;
    try {
      if (!firstSessionUploaded) {
        outcome = await runFullScopeSync(config, hookInput, storageAdapter, dataDir);
        firstSessionUploaded = true;
      } else {
        outcome = await runSessionOnlySync(config, hookInput, storageAdapter, dataDir);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stdout.write(`[fail] session ${session.sessionId} — ${message}\n`);
      allErrors.push(`${session.sessionId}: ${message}`);
      totalFailed += 1;
      continue;
    }

    const parts: string[] = [];
    if (outcome.uploaded > 0) parts.push(`${outcome.uploaded} uploaded`);
    if (outcome.skipped > 0) parts.push(`${outcome.skipped} skipped`);
    if (outcome.failed > 0) parts.push(`${outcome.failed} failed`);
    const summary = parts.length > 0 ? parts.join(', ') : 'no changes';

    if (outcome.failed > 0 || outcome.errors.length > 0) {
      stdout.write(`[fail] session ${session.sessionId} — ${summary}\n`);
      for (const code of outcome.errors) {
        stdout.write(`       error: ${code}\n`);
        allErrors.push(`${session.sessionId}: ${code}`);
      }
      totalFailed += outcome.failed;
    } else {
      stdout.write(`[ok]   session ${session.sessionId} — ${summary}\n`);
    }
    totalUploaded += outcome.uploaded;
    totalSkipped += outcome.skipped;
  }

  stdout.write('\n');
  stdout.write(
    `Synced ${sessions.length} session(s): ` +
      `${totalUploaded} files uploaded, ` +
      `${totalSkipped} skipped, ` +
      `${totalFailed} failed, ` +
      `${totalAlreadyExists} already synced.\n`,
  );

  if (allErrors.length > 0) {
    return 1;
  }
  return 0;
}

export type { DiscoveryResult, SyncErrorCode };
// Re-export for tests and downstream use.
export { contentTypeFor, parseObjectKey, putArtifactWithTimeout };
