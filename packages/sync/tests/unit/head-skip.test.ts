import type {
  HeadObjectInput,
  HeadObjectResult,
  PutObjectInput,
  PutObjectResult,
  StorageObjectScope,
} from '@lucasschirm/sal-sync-core';
import { StorageError } from '@lucasschirm/sal-sync-core';
import { describe, expect, it, vi } from 'vitest';

import type {
  ArtifactCandidate,
  ArtifactIdentity,
  CandidateResult,
  StorageAdapter,
  SyncConfig,
} from '../../src/index.js';
import {
  createEmptySyncState,
  getArtifactRecord,
  hashCandidate,
  processDelta,
  recordArtifactUploaded,
  runSessionEndUploadLoop,
  sha256Hex,
} from '../../src/index.js';

function makeCandidate(overrides: Partial<ArtifactCandidate> = {}): ArtifactCandidate {
  return {
    projectId: 'proj-1',
    sessionId: 'sess-1',
    scope: 'workspace',
    relativePath: 'CLAUDE.md',
    content: 'hello',
    ...overrides,
  };
}

function makeUploader(adapter: StorageAdapter) {
  return async (artifact: ArtifactIdentity, content: string): Promise<void> => {
    await adapter.putObject({
      projectId: artifact.projectId,
      sessionId: artifact.sessionId,
      scope: artifact.scope,
      relativePath: artifact.relativePath,
      body: new TextEncoder().encode(content),
      contentType: 'text/plain',
      contentSha256: artifact.sha256,
    });
  };
}

function makeStorage(opts: { headResult?: object | undefined; noHead?: boolean } = {}) {
  const headObject = opts.noHead ? undefined : vi.fn().mockResolvedValue(opts.headResult);
  const putObject = vi.fn().mockResolvedValue({
    key: 'proj-1/sess-1/workspace/CLAUDE.md',
    sha256: '0'.repeat(64),
  });
  const adapter: StorageAdapter = {
    putObject,
    ...(headObject ? { headObject } : {}),
  };
  return { adapter, headObject, putObject };
}

describe('processDelta HEAD skip', () => {
  it('skips PUT and records uploaded when a cold-start CAS artifact already exists remotely', async () => {
    const state = createEmptySyncState();
    const { adapter, headObject, putObject } = makeStorage({ headResult: { contentLength: 5 } });
    const candidate = makeCandidate();

    const result = await processDelta({
      state,
      trigger: 'session-start',
      candidates: [candidate],
      uploader: makeUploader(adapter),
      storageAdapter: adapter,
    });

    expect(headObject).toHaveBeenCalledTimes(1);
    expect(headObject).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        scope: 'workspace',
        relativePath: 'CLAUDE.md',
        contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(putObject).not.toHaveBeenCalled();
    expect(result.filesUploaded).toBe(1);
    expect(result.uploaded).toHaveLength(1);

    const record = getArtifactRecord(state, result.uploaded[0]);
    expect(record?.status).toBe('uploaded');
    expect(record?.lastUploadedHash).toBe(result.uploaded[0].sha256);
  });

  it('proceeds to PUT when HEAD returns undefined for a cold-start CAS artifact', async () => {
    const state = createEmptySyncState();
    const { adapter, headObject, putObject } = makeStorage({ headResult: undefined });
    const candidate = makeCandidate();

    const result = await processDelta({
      state,
      trigger: 'session-start',
      candidates: [candidate],
      uploader: makeUploader(adapter),
      storageAdapter: adapter,
    });

    expect(headObject).toHaveBeenCalledTimes(1);
    expect(putObject).toHaveBeenCalledTimes(1);
    expect(result.filesUploaded).toBe(1);

    const record = getArtifactRecord(state, result.uploaded[0]);
    expect(record?.status).toBe('uploaded');
  });

  it('proceeds to PUT when the storage adapter does not implement headObject', async () => {
    const state = createEmptySyncState();
    const { adapter, putObject } = makeStorage({ noHead: true });
    const candidate = makeCandidate();

    const result = await processDelta({
      state,
      trigger: 'session-start',
      candidates: [candidate],
      uploader: makeUploader(adapter),
      storageAdapter: adapter,
    });

    expect(putObject).toHaveBeenCalledTimes(1);
    expect(result.filesUploaded).toBe(1);

    const record = getArtifactRecord(state, result.uploaded[0]);
    expect(record?.status).toBe('uploaded');
  });

  it('does not issue HEAD for warm-state artifacts with a matching lastUploadedHash', async () => {
    const state = createEmptySyncState();
    const { adapter, headObject, putObject } = makeStorage({ headResult: { contentLength: 5 } });
    const candidate = makeCandidate();
    const identity = { ...candidate, sha256: sha256Hex(candidate.content) };
    recordArtifactUploaded(state, identity);

    const result = await processDelta({
      state,
      trigger: 'session-start',
      candidates: [candidate],
      uploader: makeUploader(adapter),
      storageAdapter: adapter,
    });

    expect(headObject).not.toHaveBeenCalled();
    expect(putObject).not.toHaveBeenCalled();
    expect(result.filesSkipped).toBe(1);
    expect(result.filesUploaded).toBe(0);
  });

  it('does not issue HEAD for session or runtime scoped artifacts', async () => {
    const state = createEmptySyncState();
    const { adapter, headObject, putObject } = makeStorage({ headResult: { contentLength: 5 } });
    const candidate = makeCandidate({
      scope: 'session',
      relativePath: 'transcript.jsonl',
      content: '{"type":"message"}\n',
    });

    const result = await processDelta({
      state,
      trigger: 'session-start',
      candidates: [candidate],
      uploader: makeUploader(adapter),
      storageAdapter: adapter,
    });

    expect(headObject).not.toHaveBeenCalled();
    expect(putObject).toHaveBeenCalledTimes(1);
    expect(result.filesUploaded).toBe(1);
  });

  it('does not issue HEAD for a CAS artifact whose hash has changed locally', async () => {
    const state = createEmptySyncState();
    const { adapter, headObject, putObject } = makeStorage({ headResult: { contentLength: 5 } });
    const candidate = makeCandidate({ content: 'new' });
    recordArtifactUploaded(state, { ...candidate, sha256: sha256Hex('old') });

    const result = await processDelta({
      state,
      trigger: 'session-start',
      candidates: [candidate],
      uploader: makeUploader(adapter),
      storageAdapter: adapter,
    });

    expect(headObject).not.toHaveBeenCalled();
    expect(putObject).toHaveBeenCalledTimes(1);
    expect(result.filesUploaded).toBe(1);
  });

  it('HEAD-verifies a skipped session-scoped artifact and re-uploads if missing from remote', async () => {
    const state = createEmptySyncState();
    const { adapter, headObject, putObject } = makeStorage({ headResult: undefined });
    const candidate = makeCandidate({
      scope: 'session',
      relativePath: 'transcript.jsonl',
      content: '{"type":"message"}\n',
    });
    // Simulate a previous upload: local state says it was uploaded with the
    // same hash, so without HEAD-verify the file would be skipped.
    const identity = { ...candidate, sha256: sha256Hex(candidate.content) };
    recordArtifactUploaded(state, identity);

    const result = await processDelta({
      state,
      trigger: 'session-start',
      candidates: [candidate],
      uploader: makeUploader(adapter),
      storageAdapter: adapter,
    });

    expect(headObject).toHaveBeenCalledTimes(1);
    expect(headObject).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'session',
        relativePath: 'transcript.jsonl',
      }),
    );
    expect(putObject).toHaveBeenCalledTimes(1);
    expect(result.filesUploaded).toBe(1);
    expect(result.filesSkipped).toBe(0);
  });

  it('skips re-upload when HEAD confirms a skipped session-scoped artifact exists remotely', async () => {
    const state = createEmptySyncState();
    const { adapter, headObject, putObject } = makeStorage({ headResult: { contentLength: 42 } });
    const candidate = makeCandidate({
      scope: 'session',
      relativePath: 'transcript.jsonl',
      content: '{"type":"message"}\n',
    });
    const identity = { ...candidate, sha256: sha256Hex(candidate.content) };
    recordArtifactUploaded(state, identity);

    const result = await processDelta({
      state,
      trigger: 'session-start',
      candidates: [candidate],
      uploader: makeUploader(adapter),
      storageAdapter: adapter,
    });

    expect(headObject).toHaveBeenCalledTimes(1);
    expect(putObject).not.toHaveBeenCalled();
    expect(result.filesSkipped).toBe(1);
    expect(result.filesUploaded).toBe(0);
  });

  it('trusts local state and skips when HEAD throws a mapped StorageError', async () => {
    const state = createEmptySyncState();
    const headObject = vi
      .fn()
      .mockRejectedValue(new StorageError('SYNC_STORAGE_ERROR', 'network down', true));
    const putObject = vi.fn().mockResolvedValue({ key: 'x', sha256: '0'.repeat(64) });
    const adapter: StorageAdapter = { putObject, headObject };
    const candidate = makeCandidate({
      scope: 'session',
      relativePath: 'transcript.jsonl',
      content: '{"type":"message"}\n',
    });
    const identity = { ...candidate, sha256: sha256Hex(candidate.content) };
    recordArtifactUploaded(state, identity);

    const result = await processDelta({
      state,
      trigger: 'session-start',
      candidates: [candidate],
      uploader: makeUploader(adapter),
      storageAdapter: adapter,
    });

    expect(headObject).toHaveBeenCalledTimes(1);
    expect(putObject).not.toHaveBeenCalled();
    expect(result.filesSkipped).toBe(1);
  });

  it('does not HEAD-verify skipped session artifacts when headObject is unavailable', async () => {
    const state = createEmptySyncState();
    const { adapter, putObject } = makeStorage({ noHead: true });
    const candidate = makeCandidate({
      scope: 'session',
      relativePath: 'transcript.jsonl',
      content: '{"type":"message"}\n',
    });
    const identity = { ...candidate, sha256: sha256Hex(candidate.content) };
    recordArtifactUploaded(state, identity);

    const result = await processDelta({
      state,
      trigger: 'session-start',
      candidates: [candidate],
      uploader: makeUploader(adapter),
      storageAdapter: adapter,
    });

    expect(putObject).not.toHaveBeenCalled();
    expect(result.filesSkipped).toBe(1);
  });
});

describe('processDelta HEAD skip with class-based adapter', () => {
  // Regression tests for the receiver-loss bug: extracting headObject into a
  // local variable and calling it unbound loses `this` for class-based
  // adapters like S3StorageAdapter. These tests use a class that reads
  // instance state through `this` to catch that pattern.

  class ReceiverDependentAdapter implements StorageAdapter {
    private readonly headResult: HeadObjectResult | undefined;
    private readonly hasObject: boolean;
    readonly headCalls: HeadObjectInput[] = [];
    readonly putCalls: PutObjectInput[] = [];

    constructor(opts: { headResult?: HeadObjectResult | undefined; hasObject?: boolean }) {
      this.headResult = opts.headResult;
      this.hasObject = opts.hasObject ?? !!opts.headResult;
    }

    async headObject(input: HeadObjectInput): Promise<HeadObjectResult | undefined> {
      // Reads `this.headResult` — will throw if `this` is lost.
      this.headCalls.push(input);
      return this.headResult;
    }

    async putObject(input: PutObjectInput): Promise<PutObjectResult> {
      this.putCalls.push(input);
      return { key: 'test-key', sha256: input.contentSha256 ?? '0'.repeat(64) };
    }
  }

  it('HEAD-verifies a skipped session artifact with receiver intact and re-uploads if missing', async () => {
    const state = createEmptySyncState();
    const adapter = new ReceiverDependentAdapter({ headResult: undefined });
    const candidate = makeCandidate({
      scope: 'session',
      relativePath: 'transcript.jsonl',
      content: '{"type":"message"}\n',
    });
    const identity = { ...candidate, sha256: sha256Hex(candidate.content) };
    recordArtifactUploaded(state, identity);

    const result = await processDelta({
      state,
      trigger: 'session-start',
      candidates: [candidate],
      uploader: makeUploader(adapter),
      storageAdapter: adapter,
    });

    expect(adapter.headCalls).toHaveLength(1);
    expect(adapter.headCalls[0]).toMatchObject({
      scope: 'session',
      relativePath: 'transcript.jsonl',
    });
    expect(adapter.putCalls).toHaveLength(1);
    expect(result.filesUploaded).toBe(1);
    expect(result.filesSkipped).toBe(0);
  });

  it('skips re-upload when HEAD confirms a skipped session artifact exists remotely (class-based)', async () => {
    const state = createEmptySyncState();
    const adapter = new ReceiverDependentAdapter({ headResult: { contentLength: 42 } });
    const candidate = makeCandidate({
      scope: 'session',
      relativePath: 'transcript.jsonl',
      content: '{"type":"message"}\n',
    });
    const identity = { ...candidate, sha256: sha256Hex(candidate.content) };
    recordArtifactUploaded(state, identity);

    const result = await processDelta({
      state,
      trigger: 'session-start',
      candidates: [candidate],
      uploader: makeUploader(adapter),
      storageAdapter: adapter,
    });

    expect(adapter.headCalls).toHaveLength(1);
    expect(adapter.putCalls).toHaveLength(0);
    expect(result.filesSkipped).toBe(1);
    expect(result.filesUploaded).toBe(0);
  });

  it('trusts local state and skips when HEAD throws a mapped StorageError', async () => {
    const state = createEmptySyncState();

    class StorageErrorAdapter implements StorageAdapter {
      async headObject(): Promise<HeadObjectResult | undefined> {
        throw new StorageError('SYNC_STORAGE_ERROR', 'network down', true);
      }
      async putObject(input: PutObjectInput): Promise<PutObjectResult> {
        return { key: 'x', sha256: input.contentSha256 ?? '0'.repeat(64) };
      }
    }

    const adapter = new StorageErrorAdapter();
    const candidate = makeCandidate({
      scope: 'session',
      relativePath: 'transcript.jsonl',
      content: '{"type":"message"}\n',
    });
    const identity = { ...candidate, sha256: sha256Hex(candidate.content) };
    recordArtifactUploaded(state, identity);

    const result = await processDelta({
      state,
      trigger: 'session-start',
      candidates: [candidate],
      uploader: makeUploader(adapter),
      storageAdapter: adapter,
    });

    expect(result.filesSkipped).toBe(1);
    expect(result.filesUploaded).toBe(0);
  });

  it('propagates unexpected HEAD errors instead of silently skipping', async () => {
    const state = createEmptySyncState();

    class TypeErrorAdapter implements StorageAdapter {
      async headObject(): Promise<HeadObjectResult | undefined> {
        // Simulates the receiver-loss TypeError that caused the production bug.
        throw new TypeError("Cannot read properties of undefined (reading 'client')");
      }
      async putObject(input: PutObjectInput): Promise<PutObjectResult> {
        return { key: 'x', sha256: input.contentSha256 ?? '0'.repeat(64) };
      }
    }

    const adapter = new TypeErrorAdapter();
    const candidate = makeCandidate({
      scope: 'session',
      relativePath: 'transcript.jsonl',
      content: '{"type":"message"}\n',
    });
    const identity = { ...candidate, sha256: sha256Hex(candidate.content) };
    recordArtifactUploaded(state, identity);

    await expect(
      processDelta({
        state,
        trigger: 'session-start',
        candidates: [candidate],
        uploader: makeUploader(adapter),
        storageAdapter: adapter,
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe('runSessionEndUploadLoop HEAD skip', () => {
  it('skips PUT and records uploaded when a cold-start CAS artifact already exists remotely', async () => {
    const state = createEmptySyncState();
    const { adapter, headObject, putObject } = makeStorage({ headResult: { contentLength: 5 } });
    const candidate = makeCandidate();
    const hashed = hashCandidate(candidate);
    const candidateResults: CandidateResult[] = [
      { candidate, sha256: hashed.artifact.sha256, size: hashed.size },
    ];

    const result = await runSessionEndUploadLoop({
      state,
      candidateResults,
      storageAdapter: adapter,
      config: {
        timeouts: { syncTimeoutMs: 5000, hookUploadTimeoutMs: 5000, sessionEndBudgetMs: 30000 },
      } as unknown as SyncConfig,
      deadline: Date.now() + 10000,
      start: Date.now(),
    });

    expect(headObject).toHaveBeenCalledTimes(1);
    expect(headObject).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        scope: 'workspace',
        relativePath: 'CLAUDE.md',
        contentSha256: hashed.artifact.sha256,
      }),
    );
    expect(putObject).not.toHaveBeenCalled();
    expect(result.uploaded).toHaveLength(1);
    expect(result.run.filesUploaded).toBe(1);

    const record = getArtifactRecord(state, result.uploaded[0]);
    expect(record?.status).toBe('uploaded');
    expect(record?.lastUploadedHash).toBe(result.uploaded[0].sha256);
  });
});
