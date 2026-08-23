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
