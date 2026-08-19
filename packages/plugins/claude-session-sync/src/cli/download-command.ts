import * as fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  buildObjectKey,
  buildStorageAdapter,
  type GetObjectInput,
  type ManifestArtifact,
  parseObjectKey,
  type StorageAdapter,
  type StorageObjectScope,
  type SyncConfig,
  type SyncManifest,
} from '@lucasschirm/sal-sync';

import { validateCliConfig } from './config.js';
import { resolveCliEnv } from './env.js';

export interface DownloadCommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  storageAdapter?: StorageAdapter;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface DownloadArgs {
  /** Specific session ID to download, or `all` for every session. */
  target: string;
  /** Output directory (required). */
  output: string;
}

function tryMatchOption(
  argv: string[],
  i: number,
  name: string,
): { value: string; newIndex: number } | undefined {
  const arg = argv[i];
  if (!arg) return undefined;
  if (arg.startsWith(`${name}=`)) {
    return { value: arg.slice(name.length + 1), newIndex: i };
  }
  if (arg === name) {
    const next = argv[i + 1];
    if (!next) return undefined;
    return { value: next, newIndex: i + 1 };
  }
  return undefined;
}

/**
 * Parse download command arguments.
 *
 * Accepted forms:
 *   download --session-id=<id> --output=<dir>
 *   download --session-id <id> --output <dir>
 *   download all --output=<dir>
 *   download all --output <dir>
 */
export function parseDownloadArgs(argv: string[]): DownloadArgs | undefined {
  let target: string | undefined;
  let output: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === 'all') {
      target = 'all';
      continue;
    }
    const sessionMatch = tryMatchOption(argv, i, '--session-id');
    if (sessionMatch) {
      target = sessionMatch.value;
      i = sessionMatch.newIndex;
      continue;
    }
    const outputMatch = tryMatchOption(argv, i, '--output');
    if (outputMatch) {
      output = outputMatch.value;
      i = outputMatch.newIndex;
    }
  }

  if (!target || !output) return undefined;
  return { target, output };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isCasScope(scope: ManifestArtifact['scope']): boolean {
  return scope === 'workspace' || scope === 'global';
}

function manifestGetObjectInput(projectId: string, sessionId: string): GetObjectInput {
  return { projectId, sessionId, scope: 'manifest', relativePath: 'manifest.json' };
}

function artifactGetObjectInput(artifact: ManifestArtifact): GetObjectInput {
  const base: GetObjectInput = {
    projectId: artifact.projectId,
    sessionId: artifact.sessionId,
    scope: artifact.scope as StorageObjectScope,
    relativePath: artifact.relativePath,
  };
  if (isCasScope(artifact.scope)) {
    base.contentSha256 = artifact.sha256;
  }
  return base;
}

function buildLocalPath(
  output: string,
  projectId: string,
  sessionId: string,
  scope: string,
  relativePath: string,
): string {
  return scope === 'manifest'
    ? path.join(output, projectId, sessionId, relativePath)
    : path.join(output, projectId, sessionId, scope, relativePath);
}

interface DownloadResult {
  ok: boolean;
  bytes: number;
  key: string;
  error?: string;
}

async function fetchArtifactBody(
  storageAdapter: StorageAdapter,
  artifact: ManifestArtifact,
  getInput: GetObjectInput,
  casCache: Map<string, Uint8Array>,
): Promise<Uint8Array | undefined> {
  if (isCasScope(artifact.scope)) {
    const cached = casCache.get(artifact.sha256);
    if (cached) return cached;
    const result = await storageAdapter.getObject?.(getInput);
    if (!result) return undefined;
    casCache.set(artifact.sha256, result.body);
    return result.body;
  }
  const result = await storageAdapter.getObject?.(getInput);
  return result?.body;
}

async function downloadArtifact(
  storageAdapter: StorageAdapter,
  artifact: ManifestArtifact,
  casCache: Map<string, Uint8Array>,
  output: string,
  stdout: NodeJS.WritableStream,
): Promise<DownloadResult> {
  const getInput = artifactGetObjectInput(artifact);
  const key = buildObjectKey(getInput);
  const localPath = buildLocalPath(
    output,
    artifact.projectId,
    artifact.sessionId,
    artifact.scope,
    artifact.relativePath,
  );

  const body = await fetchArtifactBody(storageAdapter, artifact, getInput, casCache);
  if (!body) {
    return { ok: false, bytes: 0, key, error: 'object not found' };
  }

  await fsp.mkdir(path.dirname(localPath), { recursive: true });
  await fsp.writeFile(localPath, body);

  const relativeDisplay = path.relative(output, localPath);
  stdout.write(`[download] ${relativeDisplay} (${formatBytes(body.length)})\n`);

  return { ok: true, bytes: body.length, key };
}

interface ManifestDownloadResult {
  ok: boolean;
  bytes: number;
  missing?: boolean;
  error?: string;
  body?: Uint8Array;
}

async function downloadManifest(
  storageAdapter: StorageAdapter,
  projectId: string,
  sessionId: string,
  output: string,
  stdout: NodeJS.WritableStream,
): Promise<ManifestDownloadResult> {
  const input = manifestGetObjectInput(projectId, sessionId);
  const result = await storageAdapter.getObject?.(input);
  if (!result) {
    return { ok: false, bytes: 0, missing: true, error: 'manifest not found' };
  }

  const localPath = buildLocalPath(output, projectId, sessionId, 'manifest', 'manifest.json');
  await fsp.mkdir(path.dirname(localPath), { recursive: true });
  await fsp.writeFile(localPath, result.body);

  const relativeDisplay = path.relative(output, localPath);
  stdout.write(`[download] ${relativeDisplay} (${formatBytes(result.body.length)})\n`);

  return { ok: true, bytes: result.body.length, body: result.body };
}

function parseManifest(body: Uint8Array): SyncManifest {
  const text = new TextDecoder().decode(body);
  return JSON.parse(text) as SyncManifest;
}

interface SessionDownloadResult {
  downloaded: number;
  failed: number;
  totalBytes: number;
  errors: string[];
  missingManifest?: boolean;
}

async function downloadArtifacts(
  storageAdapter: StorageAdapter,
  manifest: SyncManifest,
  casCache: Map<string, Uint8Array>,
  output: string,
  stdout: NodeJS.WritableStream,
): Promise<Omit<SessionDownloadResult, 'missingManifest'>> {
  let downloaded = 0;
  let failed = 0;
  let totalBytes = 0;
  const errors: string[] = [];

  for (const artifact of manifest.artifacts) {
    const result = await downloadArtifact(storageAdapter, artifact, casCache, output, stdout);
    if (result.ok) {
      downloaded += 1;
      totalBytes += result.bytes;
    } else {
      failed += 1;
      stdout.write(`[fail] ${result.key} — ${result.error}\n`);
      errors.push(`${result.key}: ${result.error}`);
    }
  }

  return { downloaded, failed, totalBytes, errors };
}

async function continueSessionDownload(
  storageAdapter: StorageAdapter,
  manifest: SyncManifest,
  manifestBytes: number,
  casCache: Map<string, Uint8Array>,
  output: string,
  stdout: NodeJS.WritableStream,
): Promise<SessionDownloadResult> {
  const artifacts = await downloadArtifacts(storageAdapter, manifest, casCache, output, stdout);
  return {
    downloaded: artifacts.downloaded + 1,
    failed: artifacts.failed,
    totalBytes: manifestBytes + artifacts.totalBytes,
    errors: artifacts.errors,
  };
}

async function downloadSession(
  storageAdapter: StorageAdapter,
  projectId: string,
  sessionId: string,
  output: string,
  casCache: Map<string, Uint8Array>,
  stdout: NodeJS.WritableStream,
): Promise<SessionDownloadResult> {
  const manifestResult = await downloadManifest(
    storageAdapter,
    projectId,
    sessionId,
    output,
    stdout,
  );
  if (manifestResult.missing) {
    return { downloaded: 0, failed: 0, totalBytes: 0, errors: [], missingManifest: true };
  }
  if (!manifestResult.ok || !manifestResult.body) {
    return {
      downloaded: 0,
      failed: 0,
      totalBytes: 0,
      errors: [manifestResult.error ?? 'manifest download failed'],
    };
  }

  try {
    const manifest = parseManifest(manifestResult.body);
    return continueSessionDownload(
      storageAdapter,
      manifest,
      manifestResult.bytes,
      casCache,
      output,
      stdout,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      downloaded: 0,
      failed: 0,
      totalBytes: 0,
      errors: [`manifest parse failed: ${message}`],
    };
  }
}

/**
 * Discover a project's sessions by filtering a full `listObjects({ projectId })`
 * result for manifest-scope entries, rather than adding a dedicated
 * manifest-pattern list API to `StorageAdapter` — this keeps the adapter
 * surface unchanged since manifest keys are unaffected by the CAS layout.
 */
async function discoverSessionIds(
  storageAdapter: StorageAdapter,
  projectId: string,
): Promise<string[]> {
  const result = await storageAdapter.listObjects?.({ projectId });
  if (!result) throw new Error('storage adapter does not support listObjects');

  const sessionIds = new Set<string>();
  for (const entry of result.objects) {
    const parsed = parseObjectKey(entry.key);
    if (parsed && parsed.scope === 'manifest' && parsed.sessionId) {
      sessionIds.add(parsed.sessionId);
    }
  }

  return [...sessionIds].sort();
}

interface DownloadMetrics {
  downloaded: number;
  failed: number;
  totalBytes: number;
  errors: string[];
  missingManifest?: boolean;
}

async function downloadSingleSession(
  storageAdapter: StorageAdapter,
  projectId: string,
  sessionId: string,
  output: string,
  stdout: NodeJS.WritableStream,
): Promise<DownloadMetrics> {
  stdout.write(`Downloading session "${sessionId}" to ${output}...\n\n`);
  const result = await downloadSession(
    storageAdapter,
    projectId,
    sessionId,
    output,
    new Map(),
    stdout,
  );
  return { ...result, missingManifest: result.missingManifest ?? false };
}

async function downloadSessionList(
  storageAdapter: StorageAdapter,
  projectId: string,
  sessionIds: string[],
  output: string,
  stdout: NodeJS.WritableStream,
): Promise<DownloadMetrics> {
  const casCache = new Map<string, Uint8Array>();
  let downloaded = 0;
  let failed = 0;
  let totalBytes = 0;
  const errors: string[] = [];

  for (const sessionId of sessionIds) {
    const result = await downloadSession(
      storageAdapter,
      projectId,
      sessionId,
      output,
      casCache,
      stdout,
    );
    if (result.missingManifest) {
      failed += 1;
      const message = `manifest not found for session ${sessionId}`;
      errors.push(message);
      stdout.write(`[fail] ${sessionId} — ${message}\n`);
      continue;
    }
    downloaded += result.downloaded;
    failed += result.failed;
    totalBytes += result.totalBytes;
    errors.push(...result.errors);
  }

  return { downloaded, failed, totalBytes, errors };
}

async function downloadAllSessions(
  storageAdapter: StorageAdapter,
  projectId: string,
  output: string,
  stdout: NodeJS.WritableStream,
): Promise<DownloadMetrics> {
  const sessionIds = await discoverSessionIds(storageAdapter, projectId);
  if (sessionIds.length === 0) {
    stdout.write(`No sessions found for project "${projectId}".\n`);
    return { downloaded: 0, failed: 0, totalBytes: 0, errors: [] };
  }

  stdout.write(`Downloading ${sessionIds.length} session(s) to ${output}...\n\n`);
  return downloadSessionList(storageAdapter, projectId, sessionIds, output, stdout);
}

function printSummary(
  metrics: { downloaded: number; failed: number; totalBytes: number },
  output: string,
  stdout: NodeJS.WritableStream,
): void {
  stdout.write('\n');
  stdout.write(
    `Downloaded ${metrics.downloaded} file(s), ${formatBytes(metrics.totalBytes)} total, ` +
      `${metrics.failed} failed to ${output}\n`,
  );
}

function normalizeOptions(options: DownloadCommandOptions) {
  return {
    cwd: options.cwd ?? process.cwd(),
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
  };
}

function printUsage(stderr: NodeJS.WritableStream): void {
  stderr.write(
    'Usage: claude-sync download --session-id=<id> --output=<dir>\n' +
      '       claude-sync download all --output=<dir>\n',
  );
}

async function resolveDownloadConfig(
  cwd: string,
  env: Record<string, string | undefined> | undefined,
  stderr: NodeJS.WritableStream,
): Promise<SyncConfig | undefined> {
  const merged = env ?? (await resolveCliEnv(cwd));
  const validation = validateCliConfig(merged, cwd);
  if (!validation.ok || !validation.config) {
    stderr.write(`${validation.errorMessage ?? 'Configuration error.'}\n`);
    return undefined;
  }
  return validation.config;
}

function hasDownloadSupport(
  storageAdapter: StorageAdapter,
  target: string,
  stderr: NodeJS.WritableStream,
): boolean {
  if (!storageAdapter.getObject) {
    stderr.write('Error: the configured storage adapter does not support getting objects.\n');
    return false;
  }
  if (target === 'all' && !storageAdapter.listObjects) {
    stderr.write('Error: the configured storage adapter does not support listing objects.\n');
    return false;
  }
  return true;
}

async function executeDownload(
  args: DownloadArgs,
  projectId: string,
  storageAdapter: StorageAdapter,
  stdout: NodeJS.WritableStream,
): Promise<DownloadMetrics> {
  if (args.target === 'all') {
    return downloadAllSessions(storageAdapter, projectId, args.output, stdout);
  }
  return downloadSingleSession(storageAdapter, projectId, args.target, args.output, stdout);
}

function finalizeDownload(
  metrics: DownloadMetrics,
  target: string,
  output: string,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): number {
  if (metrics.missingManifest) {
    stderr.write(`Error: manifest not found for session "${target}".\n`);
    return 1;
  }
  if (metrics.downloaded === 0 && metrics.failed === 0) {
    return 0;
  }
  printSummary(metrics, output, stdout);
  return metrics.errors.length > 0 ? 1 : 0;
}

/**
 * Download session(s) from S3 storage to a local directory.
 *
 * - `download --session-id=<id> --output=<dir>` — download a specific session
 * - `download all --output=<dir>` — download all sessions for the project
 */
export async function runDownloadCommand(
  argv: string[],
  options: DownloadCommandOptions = {},
): Promise<number> {
  const { cwd, stdout, stderr } = normalizeOptions(options);

  const args = parseDownloadArgs(argv);
  if (!args) {
    printUsage(stderr);
    return 1;
  }

  const config = await resolveDownloadConfig(cwd, options.env, stderr);
  if (!config) return 1;

  const storageAdapter = options.storageAdapter ?? buildStorageAdapter(config);
  if (!hasDownloadSupport(storageAdapter, args.target, stderr)) return 1;

  await fsp.mkdir(args.output, { recursive: true });
  const metrics = await executeDownload(args, config.projectId, storageAdapter, stdout);
  return finalizeDownload(metrics, args.target, args.output, stdout, stderr);
}
