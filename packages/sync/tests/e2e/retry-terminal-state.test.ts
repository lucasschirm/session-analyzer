import * as fsp from 'node:fs/promises';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type ArtifactStateRecord,
  buildObjectKey,
  DEFAULT_SYNC_RETRIES,
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

const PROJECT_ID = 'proj-retry';
const SESSION_ID = 'sess-retry';
const MANIFEST_SCOPE = 'manifest';
const MANIFEST_PATH = 'manifest.json';

class FaultyStorageAdapter implements StorageAdapter {
  readonly calls: PutObjectInput[] = [];
  private readonly objects = new Map<string, StoredObject>();
  private readonly callCounts = new Map<string, number>();
  private readonly failureRules: FailureRule[] = [];

  failOnNthPut(scope: string, relativePath: string, nth: number, error: StorageError): void {
    this.failureRules.push({ scope, relativePath, nth, error });
  }

  failPutsUpTo(scope: string, relativePath: string, count: number, error: StorageError): void {
    for (let nth = 1; nth <= count; nth++) {
      this.failOnNthPut(scope, relativePath, nth, error);
    }
  }

  clearFailures(): void {
    this.failureRules.length = 0;
  }

  getAttemptCount(scope: string, relativePath: string): number {
    return this.callCounts.get(`${scope}:${relativePath}`) ?? 0;
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
    SAL_PROJECT_ID: PROJECT_ID,
    SAL_STORAGE_TYPE: 's3',
    SAL_STORAGE_BUCKET: 'test-bucket',
    SAL_STORAGE_ENDPOINT: 'http://localhost:4566',
    SAL_STORAGE_REGION: 'us-east-1',
    SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    SAL_STORAGE_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    SAL_SYNC_TIMEOUT: '5000',
    SAL_SESSION_END_BUDGET_MS: '5000',
    SAL_HOOK_UPLOAD_TIMEOUT: '5000',
    SAL_SYNC_RETRIES: String(DEFAULT_SYNC_RETRIES),
    SAL_DATA_DIR: dataDir,
    SAL_MAX_FILE_BYTES: '10485760',
    SAL_MAX_TOTAL_BYTES: '104857600',
    SAL_MAX_FILES: '1000',
    SAL_CAPTURE_TRANSCRIPTS: 'true',
  } as Record<string, string>;
}

function syncInput(workspaceDir: string): HookInput {
  return {
    session_id: SESSION_ID,
    cwd: workspaceDir,
    transcript_path: path.join(workspaceDir, 'transcript.jsonl'),
  };
}

function findManifestRecord(state: SyncState): ArtifactStateRecord | undefined {
  return Object.values(state.artifacts).find(
    (record) =>
      record.projectId === PROJECT_ID &&
      record.sessionId === SESSION_ID &&
      record.scope === 'runtime' &&
      record.relativePath === MANIFEST_PATH,
  );
}

function isConvergedRecord(record: ArtifactStateRecord): boolean {
  return record.status === 'failed' || record.lastUploadedHash === record.lastDiscoveredHash;
}

function assertNoAmbiguouslyPendingState(state: SyncState): void {
  const ambiguous = Object.values(state.artifacts).filter((record) => !isConvergedRecord(record));
  expect(ambiguous).toEqual([]);
}

async function assertNoStrayStateFiles(dataDir: string): Promise<void> {
  const stateFiles = await fsp.readdir(path.join(dataDir, 'state'));
  expect(stateFiles).toEqual(['state.json']);
}

function makeTransientError(message: string): StorageError {
  return new StorageError('SYNC_STORAGE_ERROR', message, true);
}

async function runUntilManifestConverges(
  dataDir: string,
  env: Record<string, string>,
  input: HookInput,
  storage: FaultyStorageAdapter,
  stateStore: StateStore,
  maxAttempts: number,
): Promise<ArtifactStateRecord | undefined> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await sync({ dataDir, env, input, storageAdapter: storage });
    expect(result.exitCode).toBe(0);

    const state = await stateStore.readState();
    assertNoAmbiguouslyPendingState(state);
    const record = findManifestRecord(state);
    if (record?.status === 'uploaded') {
      return record;
    }
    if (attempt === maxAttempts) {
      expect(record?.status).toBe('uploaded');
    }
  }
  return undefined;
}

describe('retry drives to a known terminal state (SYNC-003)', () => {
  let tempRoot: string;
  let workspaceDir: string;
  let dataDir: string;
  let storage: FaultyStorageAdapter;
  let env: Record<string, string>;
  let stateStore: StateStore;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'sal-sync-retry-'));
    workspaceDir = path.join(tempRoot, 'workspace');
    dataDir = path.join(tempRoot, 'data');
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeMinimalWorkspace(workspaceDir);
    storage = new FaultyStorageAdapter();
    env = testEnv(dataDir);
    stateStore = new StateStore(dataDir);
  });

  afterEach(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it('converges to uploaded after repeated transient failures within the retry bound', async () => {
    const input = syncInput(workspaceDir);
    const maxAttempts = DEFAULT_SYNC_RETRIES + 1;

    storage.failPutsUpTo(
      MANIFEST_SCOPE,
      MANIFEST_PATH,
      DEFAULT_SYNC_RETRIES,
      makeTransientError('Simulated transient manifest upload failure'),
    );

    const record = await runUntilManifestConverges(
      dataDir,
      env,
      input,
      storage,
      stateStore,
      maxAttempts,
    );

    expect(record).toBeDefined();
    expect(record?.status).toBe('uploaded');
    expect(record?.lastError).toBeUndefined();
    expect(record?.lastUploadedHash).toBe(record?.lastDiscoveredHash);
    expect(storage.getAttemptCount(MANIFEST_SCOPE, MANIFEST_PATH)).toBe(maxAttempts);
    expect(storage.wasPathUploaded(MANIFEST_PATH, MANIFEST_SCOPE)).toBe(true);

    const finalState = await stateStore.readState();
    assertNoAmbiguouslyPendingState(finalState);
    await assertNoStrayStateFiles(dataDir);
  });

  it('converges to explicit failed when transient failures persist past the retry bound', async () => {
    const input = syncInput(workspaceDir);
    const maxAttempts = DEFAULT_SYNC_RETRIES + 1;

    storage.failPutsUpTo(
      MANIFEST_SCOPE,
      MANIFEST_PATH,
      maxAttempts,
      makeTransientError('Simulated persistent manifest upload failure'),
    );

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await sync({ dataDir, env, input, storageAdapter: storage });
      expect(result.exitCode).toBe(0);

      const state = await stateStore.readState();
      assertNoAmbiguouslyPendingState(state);
    }

    const finalState = await stateStore.readState();
    const record = findManifestRecord(finalState);
    expect(record?.status).toBe('failed');
    expect(record?.lastError).toBe('SYNC_STORAGE_ERROR');
    expect(record?.lastUploadedHash).toBeUndefined();
    expect(storage.getAttemptCount(MANIFEST_SCOPE, MANIFEST_PATH)).toBe(maxAttempts);
    assertNoAmbiguouslyPendingState(finalState);
    await assertNoStrayStateFiles(dataDir);
  });
});
