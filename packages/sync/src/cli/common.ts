import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import type {
  ArtifactIdentity,
  ArtifactScope,
  ArtifactStatus,
  ManifestArtifact,
} from '../artifact.js';
import { loadConfig, type SyncConfig } from '../config/index.js';
import { type DiscoveryResult, discover } from '../discovery/index.js';
import { SYNC_ERROR_CATALOG, type SyncErrorCode } from '../errors.js';
import {
  type ArtifactCandidate,
  type DeltaEngineResult,
  hashCandidate,
  processDelta,
  selectSanitizer,
} from '../hashing/index.js';
import { ManifestGenerator, type SyncManifest } from '../manifest/index.js';
import { DEFAULT_SANITIZATION_POLICY, sanitizeJson } from '../sanitization/index.js';
import type { SessionData } from '../session.js';
import {
  FileLock,
  getArtifactRecord,
  isArtifactPending,
  recordArtifactFailure,
  recordArtifactHashed,
  recordArtifactUploaded,
  recordArtifactUploading,
  StateStore,
  type SyncState,
} from '../state/index.js';
import type { PutObjectInput } from '../storage/index.js';
import { S3StorageAdapter, type StorageAdapter, StorageError } from '../storage/index.js';
import type { SyncRun, SyncTrigger } from '../sync-run.js';
import { DEFAULT_PLUGIN_VERSION, UNKNOWN_HARNESS_VERSION } from '../versions.js';

export type { SyncErrorCode } from '../errors.js';

import { type SyncTelemetry, TelemetryLogger } from '../telemetry/index.js';

export interface HookInput {
  session_id: string;
  cwd: string;
  transcript_path: string;
  reason?: string;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  model?: string;
  harness?: string;
  harness_version?: string;
  trigger?: string;
  target_path?: string;
  [key: string]: unknown;
}

export interface CliOptions {
  input?: HookInput | string;
  stdin?: NodeJS.ReadableStream;
  argv?: string[];
  env?: Record<string, string | undefined>;
  dataDir?: string;
  storageAdapter?: StorageAdapter;
  spawnWatcher?: WatcherSpawner;
  watcher?: WatcherFn;
  watcherTerminator?: WatcherTerminator;
}

export type WatcherFn = (options: {
  dataDir: string;
  sessionId: string;
  transcriptPath: string;
}) => Promise<void>;

export type WatcherSpawner = (args: string[]) => WatcherHandle;

export interface WatcherHandle {
  unref(): void;
  pid?: number;
  on?(event: 'error' | 'exit', listener: (code?: number, signal?: string) => void): this;
}

export type WatcherTerminator = (pid: number) => Promise<void> | void;

export interface CommandResult {
  exitCode: number;
  skipped?: boolean;
  budgetExhausted?: boolean;
  run?: SyncRun;
  manifest?: SyncManifest;
  status?: StatusReport;
}

export interface StatusReport {
  sessionId?: string;
  projectId?: string;
  watcherAlive: boolean;
  syncRunning: boolean;
  artifacts: StatusArtifact[];
  pendingFiles: number;
  pendingBytes: number;
  lastErrors: SyncErrorCode[];
}

export interface StatusArtifact {
  scope: ArtifactScope;
  relativePath: string;
  sha256: string;
  size?: number;
  status: ArtifactStatus;
  lastError?: SyncErrorCode;
  lastUploadedAt?: string;
}

const VALID_TRIGGERS: readonly SyncTrigger[] = [
  'session-start',
  'file-changed',
  'pre-compact',
  'post-compact',
  'stop',
  'stop-failure',
  'subagent-stop',
  'session-end',
  'manual',
];

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.sal-sync');

export function getDataDir(env: Record<string, string | undefined> = process.env): string {
  return env.SAL_DATA_DIR ?? DEFAULT_DATA_DIR;
}

export function safeSessionId(sessionId: string): string {
  if (!sessionId) {
    throw new Error('sessionId is required');
  }
  return encodeURIComponent(sessionId);
}

function safePath(...parts: string[]): string {
  return path.join(...parts);
}

export function getSessionSyncLockPath(dataDir: string, sessionId: string): string {
  return safePath(dataDir, 'locks', `${safeSessionId(sessionId)}.sync.lock`);
}

export function getWatcherPidPath(dataDir: string, sessionId: string): string {
  return safePath(dataDir, 'watcher', `${safeSessionId(sessionId)}.pid`);
}

export async function writeWatcherPid(
  dataDir: string,
  sessionId: string,
  pid: number,
): Promise<void> {
  const pidPath = getWatcherPidPath(dataDir, sessionId);
  const dir = path.dirname(pidPath);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(pidPath, JSON.stringify({ pid, startedAt: Date.now() }));
}

export async function readWatcherPid(
  dataDir: string,
  sessionId: string,
): Promise<number | undefined> {
  try {
    const raw = await fsp.readFile(getWatcherPidPath(dataDir, sessionId), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && 'pid' in parsed) {
      return (parsed as { pid: number }).pid;
    }
  } catch {
    // missing or unreadable pid file
  }
  return undefined;
}

export async function removeWatcherPid(dataDir: string, sessionId: string): Promise<void> {
  try {
    await fsp.unlink(getWatcherPidPath(dataDir, sessionId));
  } catch {
    // best effort
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ParsedArgs {
  sessionId?: string;
  cwd?: string;
  transcriptPath?: string;
  dataDir?: string;
  reason?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  model?: string;
  harness?: string;
  harnessVersion?: string;
  trigger?: string;
  targetPath?: string;
}

export function parseCliArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined) break;
    switch (key) {
      case '--session-id':
        result.sessionId = value;
        break;
      case '--cwd':
        result.cwd = value;
        break;
      case '--transcript-path':
        result.transcriptPath = value;
        break;
      case '--data-dir':
        result.dataDir = value;
        break;
      case '--reason':
        result.reason = value;
        break;
      case '--started-at':
        result.startedAt = value;
        break;
      case '--ended-at':
        result.endedAt = value;
        break;
      case '--duration-ms':
        result.durationMs = value ? Number(value) : undefined;
        break;
      case '--model':
        result.model = value;
        break;
      case '--harness':
        result.harness = value;
        break;
      case '--harness-version':
        result.harnessVersion = value;
        break;
      case '--trigger':
        result.trigger = value;
        break;
      case '--target-path':
        result.targetPath = value;
        break;
      default:
        // Preserve unknown flags? For forward compatibility, skip value pairs we
        // do not understand.
        break;
    }
  }
  return result;
}

function parsedArgsToHookInput(args: ParsedArgs): HookInput | undefined {
  if (!args.sessionId) return undefined;
  return {
    session_id: args.sessionId,
    cwd: args.cwd ?? '',
    transcript_path: args.transcriptPath ?? '',
    reason: args.reason,
    started_at: args.startedAt,
    ended_at: args.endedAt,
    duration_ms: args.durationMs,
    model: args.model,
    harness: args.harness,
    harness_version: args.harnessVersion,
    trigger: args.trigger,
    target_path: args.targetPath,
  };
}

function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: string | Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
    });
    stream.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    stream.on('error', reject);
  });
}

export async function readHookInput(options: CliOptions): Promise<HookInput | undefined> {
  if (options.input && typeof options.input === 'object') {
    return options.input;
  }

  let raw = '';
  if (typeof options.input === 'string') {
    raw = options.input;
  } else if (options.stdin) {
    raw = await readStream(options.stdin);
  }

  if (raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as HookInput;
      }
    } catch {
      // malformed JSON; fall through to argv
    }
  }

  const args = parseCliArgs(options.argv ?? process.argv.slice(2));
  return parsedArgsToHookInput(args);
}

export function sanitizeHookInput(input: HookInput | undefined): HookInput | undefined {
  if (!input) return undefined;
  try {
    const sanitized = sanitizeJson(input, { policy: DEFAULT_SANITIZATION_POLICY });
    if (sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)) {
      return { ...input, ...(sanitized as Record<string, unknown>) } as HookInput;
    }
  } catch {
    // Could not sanitize; use raw input and redact at the string level if needed.
  }
  return input;
}

export function validateHookInput(
  input: HookInput | undefined,
  required: string[],
): { ok: true; input: HookInput } | { ok: false; missing: string[] } {
  if (!input) {
    return { ok: false, missing: required };
  }
  const missing = required.filter((field) => {
    const value = input[field as keyof HookInput];
    return typeof value !== 'string' || value.trim() === '';
  });
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return { ok: true, input };
}

export function normalizeTrigger(value: unknown): SyncTrigger {
  if (typeof value === 'string' && VALID_TRIGGERS.includes(value as SyncTrigger)) {
    return value as SyncTrigger;
  }
  return 'manual';
}

export function buildStorageAdapter(config: SyncConfig): StorageAdapter {
  if (config.storage.type === 's3') {
    return new S3StorageAdapter(config.storage, { retries: config.retries });
  }
  throw new StorageError(
    'SYNC_CONFIG_MISSING',
    `${SYNC_ERROR_CATALOG.SYNC_CONFIG_MISSING.description} (unsupported storage type: ${config.storage.type})`,
    false,
  );
}

export async function resolveConfig(options: CliOptions): Promise<{
  dataDir: string;
  config?: SyncConfig;
  configError?: { code: SyncErrorCode; message: string };
}> {
  const dataDir = options.dataDir ?? getDataDir(options.env);
  const store = new StateStore(dataDir);
  await store.ensureDirectories();

  const configResult = loadConfig(options.env ?? process.env);
  if (!configResult.ok) {
    if (configResult.error) {
      return {
        dataDir,
        configError: { code: configResult.error.code, message: configResult.error.message },
      };
    }
    return { dataDir };
  }
  return { dataDir, config: configResult.config };
}

export function contentTypeFor(relativePath: string): string {
  if (relativePath.endsWith('.jsonl')) {
    return 'application/x-jsonlines';
  }
  if (relativePath.endsWith('.json')) {
    return 'application/json';
  }
  return 'text/plain';
}

export interface CandidateResult {
  candidate: ArtifactCandidate;
  size: number;
  sha256: string;
}

export async function buildCandidates(
  discovery: DiscoveryResult,
  _config: SyncConfig,
): Promise<CandidateResult[]> {
  const results: CandidateResult[] = [];
  for (const artifact of discovery.artifacts) {
    const raw = await fsp.readFile(artifact.absolutePath, 'utf8');
    const sanitizer = selectSanitizer(artifact.relativePath, artifact.scope);
    const sanitized = sanitizer(raw);
    const hashed = hashCandidate({
      projectId: artifact.projectId,
      sessionId: artifact.sessionId,
      scope: artifact.scope,
      relativePath: artifact.relativePath,
      content: sanitized,
      sanitizer: (content) => content,
    });
    results.push({
      candidate: {
        projectId: artifact.projectId,
        sessionId: artifact.sessionId,
        scope: artifact.scope,
        relativePath: artifact.relativePath,
        content: sanitized,
        sanitizer: (content) => content,
      },
      size: hashed.size,
      sha256: hashed.artifact.sha256,
    });
  }
  return results;
}

export function buildUploader(context: {
  storageAdapter: StorageAdapter;
  timeoutMs: number;
}): (artifact: ArtifactIdentity, content: string) => Promise<void> {
  return async (artifact, content) => {
    const body = Buffer.from(content, 'utf8');
    const putPromise = context.storageAdapter.putObject({
      projectId: artifact.projectId,
      sessionId: artifact.sessionId,
      scope: artifact.scope,
      relativePath: artifact.relativePath,
      body,
      contentType: contentTypeFor(artifact.relativePath),
      contentSha256: artifact.sha256,
    } as PutObjectInput);
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(
          new StorageError(
            'SYNC_NETWORK_TIMEOUT',
            `Upload timed out after ${context.timeoutMs}ms`,
            true,
          ),
        );
      }, context.timeoutMs);
      // If the put wins the race, the timeout promise is abandoned; the timer
      // should not keep the process alive.
      putPromise.finally(() => clearTimeout(timer)).catch(() => {});
    });
    await Promise.race([putPromise, timeoutPromise]);
  };
}

export interface RunFullSyncOptions {
  config: SyncConfig;
  hookInput: HookInput;
  dataDir: string;
  storageAdapter: StorageAdapter;
  trigger: SyncTrigger;
  uploadTimeoutMs: number;
  session?: SessionData;
  pluginVersion?: string;
}

export interface RunFullSyncResult {
  result: DeltaEngineResult;
  candidateResults: CandidateResult[];
}

export async function runFullSync(options: RunFullSyncOptions): Promise<RunFullSyncResult> {
  const start = Date.now();

  const discoveryStart = Date.now();
  const discovery = await discover({
    projectId: options.config.projectId,
    sessionId: options.hookInput.session_id,
    workspaceRoot: options.hookInput.cwd,
    transcriptPath: options.hookInput.transcript_path,
    captureTranscripts: options.config.captureTranscripts,
    limits: options.config.limits,
  });
  const discoveryDuration = Date.now() - discoveryStart;

  const sanitizationStart = Date.now();
  const candidateResults = await buildCandidates(discovery, options.config);
  const sanitizationDuration = Date.now() - sanitizationStart;

  const candidates = candidateResults.map((result) => result.candidate);
  const uploader = buildUploader({
    storageAdapter: options.storageAdapter,
    timeoutMs: options.uploadTimeoutMs,
  });

  const stateStore = new StateStore(options.dataDir);
  const processStart = Date.now();
  const deltaResult = await stateStore.withState((state) =>
    processDelta({
      state,
      trigger: options.trigger,
      candidates,
      uploader,
      session: options.session,
      pluginVersion: options.pluginVersion ?? DEFAULT_PLUGIN_VERSION,
      transcriptsCaptured: options.config.captureTranscripts,
      targetRelativePath: options.hookInput.target_path,
    }),
  );
  const processDuration = Date.now() - processStart;

  const discoveryErrorCodes = discovery.errors.map((error) => error.code);
  for (const code of discoveryErrorCodes) {
    if (!deltaResult.errors.includes(code)) {
      deltaResult.errors.push(code);
    }
  }
  for (const error of discovery.errors) {
    deltaResult.errorDetails = deltaResult.errorDetails ?? [];
    if (
      !deltaResult.errorDetails.some((d) => d.code === error.code && d.message === error.message)
    ) {
      deltaResult.errorDetails.push({ code: error.code, message: error.message });
    }
  }

  deltaResult.discoveryDurationMs = discoveryDuration;
  deltaResult.sanitizationDurationMs = sanitizationDuration;
  deltaResult.hashDurationMs = Math.max(0, processDuration - deltaResult.uploadDurationMs);
  deltaResult.totalDurationMs = Date.now() - start;

  return { result: deltaResult, candidateResults };
}

export function buildManifestArtifactsFromResults(
  candidateResults: CandidateResult[],
  result: Pick<DeltaEngineResult, 'uploaded' | 'skipped' | 'failed'>,
): ManifestArtifact[] {
  const uploaded = new Set(
    result.uploaded.map((artifact) => `${artifact.scope}:${artifact.relativePath}`),
  );
  const skipped = new Set(
    result.skipped.map((artifact) => `${artifact.scope}:${artifact.relativePath}`),
  );
  const failed = new Set(
    result.failed.map((artifact) => `${artifact.scope}:${artifact.relativePath}`),
  );

  return candidateResults.map((resultItem) => {
    const { content, sanitizer, ...identity } = resultItem.candidate;
    const key = `${identity.scope}:${identity.relativePath}`;
    let status: ArtifactStatus = 'pending';
    if (uploaded.has(key)) {
      status = 'uploaded';
    } else if (failed.has(key)) {
      status = 'failed';
    } else if (skipped.has(key)) {
      status = 'skipped';
    }
    return { ...identity, sha256: resultItem.sha256, size: resultItem.size, status };
  });
}

export async function recordAndUploadManifest(options: {
  dataDir: string;
  session: SessionData;
  run: SyncRun;
  manifestArtifacts: ManifestArtifact[];
  storageAdapter: StorageAdapter;
  captureTranscripts: boolean;
  pluginVersion?: string;
}): Promise<SyncManifest> {
  const generator = new ManifestGenerator(options.dataDir, {
    storageAdapter: options.storageAdapter,
    pluginVersion: options.pluginVersion,
  });
  await generator.recordRun(options.session.sessionId, options.run);
  const manifest = await generator.generate(options.session, options.manifestArtifacts, {
    captureTranscripts: options.captureTranscripts,
    pluginVersion: options.pluginVersion,
  });
  await generator.upload(manifest);
  return manifest;
}

export function resolveStorageError(err: unknown): SyncErrorCode {
  if (err instanceof StorageError) {
    return err.code;
  }
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string' && code in SYNC_ERROR_CATALOG) {
      return code as SyncErrorCode;
    }
  }
  return 'SYNC_STORAGE_ERROR';
}

export async function putArtifactWithTimeout(
  storageAdapter: StorageAdapter,
  artifact: ArtifactIdentity,
  content: string,
  timeoutMs: number,
): Promise<void> {
  const body = Buffer.from(content, 'utf8');
  const putPromise = storageAdapter.putObject({
    projectId: artifact.projectId,
    sessionId: artifact.sessionId,
    scope: artifact.scope,
    relativePath: artifact.relativePath,
    body,
    contentType: contentTypeFor(artifact.relativePath),
    contentSha256: artifact.sha256,
  } as PutObjectInput);
  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(
        new StorageError('SYNC_NETWORK_TIMEOUT', `Upload timed out after ${timeoutMs}ms`, true),
      );
    }, timeoutMs);
    putPromise.finally(() => clearTimeout(timer)).catch(() => {});
  });
  await Promise.race([putPromise, timeoutPromise]);
}

export async function runSessionEndUploadLoop(options: {
  state: SyncState;
  candidateResults: CandidateResult[];
  storageAdapter: StorageAdapter;
  config: SyncConfig;
  deadline: number;
  start: number;
}): Promise<{
  run: SyncRun;
  budgetExhausted: boolean;
  uploaded: ArtifactIdentity[];
  failed: ArtifactIdentity[];
  skipped: ArtifactIdentity[];
}> {
  const { state, candidateResults, storageAdapter, config, deadline, start } = options;

  const run: SyncRun = {
    trigger: 'session-end',
    filesDiscovered: 0,
    filesChanged: 0,
    filesUploaded: 0,
    filesFailed: 0,
    filesSkipped: 0,
    bytesDiscovered: 0,
    bytesChanged: 0,
    bytesUploaded: 0,
    errors: [],
    discoveryDurationMs: 0,
    sanitizationDurationMs: 0,
    hashDurationMs: 0,
    uploadDurationMs: 0,
    totalDurationMs: 0,
  };

  let budgetExhausted = false;
  const uploaded: ArtifactIdentity[] = [];
  const failed: ArtifactIdentity[] = [];
  const skipped: ArtifactIdentity[] = [];

  const hashStart = Date.now();
  for (const resultItem of candidateResults) {
    const { content, sanitizer, ...identity } = resultItem.candidate;
    const artifact: ArtifactIdentity = { ...identity, sha256: resultItem.sha256 };
    run.filesDiscovered += 1;
    run.bytesDiscovered += resultItem.size;

    recordArtifactHashed(state, artifact);
    const record = getArtifactRecord(state, artifact);
    const pending = isArtifactPending(record, artifact.sha256);

    if (!pending) {
      run.filesSkipped += 1;
      skipped.push(artifact);
      continue;
    }

    run.filesChanged += 1;
    run.bytesChanged += resultItem.size;

    if (Date.now() >= deadline) {
      budgetExhausted = true;
      continue;
    }

    recordArtifactUploading(state, artifact);
    const remaining = Math.max(0, deadline - Date.now());
    const timeoutMs = Math.min(config.timeouts.syncTimeoutMs, remaining);
    const uploadStart = Date.now();
    try {
      await putArtifactWithTimeout(
        storageAdapter,
        artifact,
        resultItem.candidate.content,
        timeoutMs,
      );
      recordArtifactUploaded(state, artifact);
      run.filesUploaded += 1;
      run.bytesUploaded += resultItem.size;
      run.uploadDurationMs += Date.now() - uploadStart;
      uploaded.push(artifact);
    } catch (err) {
      run.uploadDurationMs += Date.now() - uploadStart;
      const code = resolveStorageError(err);
      const message = err instanceof Error ? err.message : String(err);
      recordArtifactFailure(state, artifact, code);
      run.filesFailed += 1;
      run.errors = run.errors ?? [];
      if (!run.errors.includes(code)) {
        run.errors.push(code);
      }
      run.errorDetails = run.errorDetails ?? [];
      if (!run.errorDetails.some((d) => d.code === code && d.message === message)) {
        run.errorDetails.push({ code, message });
      }
      failed.push(artifact);
    }
  }
  run.hashDurationMs = Date.now() - hashStart;
  run.totalDurationMs = Date.now() - start;

  return { run, budgetExhausted, uploaded, failed, skipped };
}

export function getWatchScriptPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, 'watch.js');
}

export function defaultSpawnWatcher(args: string[]): WatcherHandle {
  const child = spawn(process.execPath, [getWatchScriptPath(), ...args], {
    detached: true,
    stdio: 'ignore',
  });
  const handle: WatcherHandle = {
    unref: () => child.unref(),
    pid: child.pid ?? undefined,
    on: (event, listener) => {
      child.on(event, listener as () => void);
      return handle;
    },
  };
  return handle;
}

export function defaultWatcherTerminator(pid: number): void {
  try {
    if (isProcessAlive(pid)) {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // already gone
  }
}

export type SyncLockResult<T> =
  | { ok: true; result: T }
  | { ok: false; reason: 'already-running' | 'budget-exhausted' };

export async function withSessionSyncLock<T>(
  dataDir: string,
  sessionId: string,
  options: { timeoutMs: number },
  fn: () => Promise<T>,
): Promise<SyncLockResult<T>> {
  const lockPath = getSessionSyncLockPath(dataDir, sessionId);
  const lock = new FileLock(lockPath, { acquireTimeoutMs: options.timeoutMs });
  try {
    const result = await lock.withLock(fn);
    return { ok: true, result };
  } catch (err) {
    if (err instanceof Error && err.message.includes('Failed to acquire lock')) {
      return { ok: false, reason: 'already-running' };
    }
    throw err;
  }
}

export function buildTelemetryRecord(options: {
  run: SyncRun;
  sessionId: string;
  command: string;
  budgetExhausted?: boolean;
  sessionEndReason?: string;
  durationBudgetMs?: number;
  diagnostics?: Record<string, unknown>;
}): SyncTelemetry {
  return {
    ...options.run,
    sessionId: options.sessionId,
    command: options.command,
    timestamp: new Date().toISOString(),
    durationBudgetMs: options.durationBudgetMs,
    budgetExhausted: options.budgetExhausted,
    sessionEndReason: options.sessionEndReason,
    diagnostics: options.diagnostics,
  };
}

export type { DiscoveryResult };
export { discover };

export function zeroRun(trigger: SyncTrigger, sessionId: string, command: string): SyncTelemetry {
  return buildTelemetryRecord({
    run: {
      trigger,
      filesDiscovered: 0,
      filesChanged: 0,
      filesUploaded: 0,
      filesFailed: 0,
      filesSkipped: 0,
      bytesDiscovered: 0,
      bytesChanged: 0,
      bytesUploaded: 0,
      errors: [] as SyncErrorCode[],
      discoveryDurationMs: 0,
      sanitizationDurationMs: 0,
      hashDurationMs: 0,
      uploadDurationMs: 0,
      totalDurationMs: 0,
    },
    sessionId,
    command,
  });
}

export function buildSessionData(input: HookInput, config: SyncConfig): SessionData {
  return {
    sessionId: input.session_id,
    projectId: config.projectId,
    harness: input.harness ?? 'unknown',
    harnessVersion: input.harness_version ?? UNKNOWN_HARNESS_VERSION,
    model: input.model,
    startedAt: input.started_at,
    endedAt: input.ended_at,
    durationMs: input.duration_ms,
    endReason: input.reason,
  };
}

export async function emitTelemetry(dataDir: string, record: SyncTelemetry): Promise<void> {
  const telemetry = new TelemetryLogger({ dataDir });
  await telemetry.log(record);
}
