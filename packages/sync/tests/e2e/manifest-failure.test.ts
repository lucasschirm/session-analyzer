import * as fsp from 'node:fs/promises';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type ArtifactStateRecord,
  buildObjectKey,
  type CommandResult,
  type GetObjectInput,
  type GetObjectResult,
  type HeadObjectInput,
  type HeadObjectResult,
  type HookInput,
  type PutObjectInput,
  type PutObjectResult,
  StateStore,
  type StorageAdapter,
  StorageError,
  type SyncState,
  sha256Hex,
  sync,
} from '../../src/index.js';

interface StoredObject {
  body: Uint8Array;
  sha256: string;
  contentType?: string;
  metadata?: Record<string, string>;
}

interface FailureRule {
  scope: string;
  relativePath: string;
  nth: number;
  error: StorageError;
}

class FaultyStorageAdapter implements StorageAdapter {
  readonly calls: PutObjectInput[] = [];
  private readonly objects = new Map<string, StoredObject>();
  private readonly callCounts = new Map<string, number>();
  private readonly failureRules: FailureRule[] = [];

  failOnNthPut(scope: string, relativePath: string, nth: number, error: StorageError): void {
    this.failureRules.push({ scope, relativePath, nth, error });
  }

  clearFailures(): void {
    this.failureRules.length = 0;
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const countKey = `${input.scope}:${input.relativePath}`;
    const count = (this.callCounts.get(countKey) ?? 0) + 1;
    this.callCounts.set(countKey, count);

    const failingRule = this.failureRules.find(
      (rule) =>
        rule.scope === input.scope &&
        rule.relativePath === input.relativePath &&
        count === rule.nth,
    );
    if (failingRule) throw failingRule.error;

    return this.recordPut(input);
  }

  private recordPut(input: PutObjectInput): PutObjectResult {
    const actualSha256 = sha256Hex(Buffer.from(input.body).toString('utf8'));
    if (input.contentSha256 && input.contentSha256 !== actualSha256) {
      throw new StorageError(
        'SYNC_STORAGE_ERROR',
        `SHA256 mismatch for ${input.relativePath}`,
        false,
      );
    }

    const keyInput = { ...input, contentSha256: input.contentSha256 ?? actualSha256 };
    const key = buildObjectKey(keyInput);
    this.calls.push(keyInput);
    this.objects.set(key, {
      body: input.body,
      sha256: actualSha256,
      contentType: input.contentType,
      metadata: input.metadata,
    });

    return { key, sha256: actualSha256, etag: `"${actualSha256}"` };
  }

  async getObject(input: GetObjectInput): Promise<GetObjectResult | undefined> {
    const stored = this.objects.get(buildObjectKey(input as PutObjectInput));
    if (!stored) return undefined;
    return {
      body: stored.body,
      etag: `"${stored.sha256}"`,
      contentType: stored.contentType,
      metadata: stored.metadata,
    };
  }

  async headObject(input: HeadObjectInput): Promise<HeadObjectResult | undefined> {
    const stored = this.objects.get(buildObjectKey(input as PutObjectInput));
    if (!stored) return undefined;
    return {
      contentLength: stored.body.length,
      etag: `"${stored.sha256}"`,
      contentType: stored.contentType,
      metadata: stored.metadata,
    };
  }

  wasPathUploaded(relativePath: string, scope: string): boolean {
    return this.getStoredContent(relativePath, scope) !== undefined;
  }

  getStoredContent(relativePath: string, scope: string): string | undefined {
    const put = this.calls.find(
      (call) => call.relativePath === relativePath && call.scope === scope,
    );
    if (!put) return undefined;
    const stored = this.objects.get(buildObjectKey(put));
    if (!stored) return undefined;
    return Buffer.from(stored.body).toString('utf8');
  }
}

async function writeMinimalWorkspace(workspaceDir: string): Promise<void> {
  await mkdir(path.join(workspaceDir, '.claude'), { recursive: true });
  await writeFile(path.join(workspaceDir, 'CLAUDE.md'), '# guide\n');
  await writeFile(path.join(workspaceDir, '.claude', 'settings.json'), '{"ok":true}\n');
  await writeFile(path.join(workspaceDir, 'transcript.jsonl'), '{"type":"message"}\n');
}

function testEnv(dataDir: string): Record<string, string> {
  return {
    ...process.env,
    SAL_PROJECT_ID: 'proj-manifest',
    SAL_STORAGE_TYPE: 's3',
    SAL_STORAGE_BUCKET: 'test-bucket',
    SAL_STORAGE_ENDPOINT: 'http://localhost:4566',
    SAL_STORAGE_REGION: 'us-east-1',
    SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    SAL_STORAGE_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    SAL_SYNC_TIMEOUT: '5000',
    SAL_SESSION_END_BUDGET_MS: '5000',
    SAL_HOOK_UPLOAD_TIMEOUT: '5000',
    SAL_SYNC_RETRIES: '0',
    SAL_DATA_DIR: dataDir,
    SAL_MAX_FILE_BYTES: '10485760',
    SAL_MAX_TOTAL_BYTES: '104857600',
    SAL_MAX_FILES: '1000',
    SAL_CAPTURE_TRANSCRIPTS: 'true',
  } as Record<string, string>;
}

function syncInput(workspaceDir: string, sessionId: string): HookInput {
  return {
    session_id: sessionId,
    cwd: workspaceDir,
    transcript_path: path.join(workspaceDir, 'transcript.jsonl'),
  };
}

function findManifestRecord(
  state: SyncState,
  projectId: string,
  sessionId: string,
): ArtifactStateRecord | undefined {
  return Object.values(state.artifacts).find(
    (record) =>
      record.projectId === projectId &&
      record.sessionId === sessionId &&
      record.scope === 'runtime' &&
      record.relativePath === 'manifest.json',
  );
}

function sessionRecords(
  state: SyncState,
  projectId: string,
  sessionId: string,
): ArtifactStateRecord[] {
  return Object.values(state.artifacts).filter(
    (record) => record.projectId === projectId && record.sessionId === sessionId,
  );
}

async function assertNoStrayStateFiles(dataDir: string): Promise<void> {
  const stateFiles = await fsp.readdir(path.join(dataDir, 'state'));
  expect(stateFiles).toEqual(['state.json']);
}

async function assertManifestFailure(
  result: CommandResult,
  stateStore: StateStore,
  projectId: string,
  sessionId: string,
): Promise<void> {
  expect(result.exitCode).toBe(0);
  expect(result.manifest).toBeUndefined();
  expect(result.run?.errors).toContain('SYNC_STORAGE_ERROR');

  const state = await stateStore.readState();
  const record = findManifestRecord(state, projectId, sessionId);
  expect(record).toBeDefined();
  expect(record?.status).toBe('failed');
  expect(record?.lastUploadedHash).toBeUndefined();
  expect(record?.lastUploadedAt).toBeUndefined();
  expect(record?.lastError).toBe('SYNC_STORAGE_ERROR');

  for (const r of sessionRecords(state, projectId, sessionId)) {
    if (r.relativePath !== 'manifest.json') {
      expect(r.status).toBe('uploaded');
    }
  }
}

async function assertManifestRetryConverged(
  result: CommandResult,
  stateStore: StateStore,
  storage: FaultyStorageAdapter,
  projectId: string,
  sessionId: string,
): Promise<void> {
  expect(result.exitCode).toBe(0);
  expect(result.manifest).toBeDefined();
  expect(result.run?.errors).toHaveLength(0);
  expect(storage.wasPathUploaded('manifest.json', 'manifest')).toBe(true);

  const state = await stateStore.readState();
  const record = findManifestRecord(state, projectId, sessionId);
  expect(record?.status).toBe('uploaded');
  expect(record?.lastError).toBeUndefined();
  expect(record?.lastUploadedHash).toBe(record?.lastDiscoveredHash);

  const manifestJson = storage.getStoredContent('manifest.json', 'manifest');
  expect(manifestJson).toBeDefined();
  if (!manifestJson) throw new Error('manifest was not stored');
  const manifest = JSON.parse(manifestJson) as { sessionId: string };
  expect(manifest.sessionId).toBe(sessionId);

  const manifestCalls = storage.calls.filter(
    (call) => call.scope === 'manifest' && call.relativePath === 'manifest.json',
  );
  expect(manifestCalls).toHaveLength(1);
}

describe('manifest upload failure mid-session (SYNC-002)', () => {
  let tempRoot: string;
  let workspaceDir: string;
  let dataDir: string;
  let storage: FaultyStorageAdapter;
  let env: Record<string, string>;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'sal-sync-manifest-'));
    workspaceDir = path.join(tempRoot, 'workspace');
    dataDir = path.join(tempRoot, 'data');
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeMinimalWorkspace(workspaceDir);
    storage = new FaultyStorageAdapter();
    env = testEnv(dataDir);
  });

  afterEach(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it('records a failed manifest explicitly and converges on retry', async () => {
    const projectId = 'proj-manifest';
    const sessionId = 'sess-manifest';
    const input = syncInput(workspaceDir, sessionId);
    const stateStore = new StateStore(dataDir);

    storage.failOnNthPut(
      'manifest',
      'manifest.json',
      1,
      new StorageError('SYNC_STORAGE_ERROR', 'Simulated manifest upload failure', true),
    );

    const first = await sync({ dataDir, env, input, storageAdapter: storage });
    await assertManifestFailure(first, stateStore, projectId, sessionId);

    storage.clearFailures();

    const retry = await sync({ dataDir, env, input, storageAdapter: storage });
    await assertManifestRetryConverged(retry, stateStore, storage, projectId, sessionId);
    await assertNoStrayStateFiles(dataDir);
  });
});
