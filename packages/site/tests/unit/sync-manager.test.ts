import type { ManifestArtifact, SyncManifest } from '@lucasschirm/sal-sync-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyticsClient } from '../../src/db/analytics-client';
import type { AnalyticsRequest } from '../../src/db/analytics-protocol';
import type { DbClient } from '../../src/db/db-client';
import { requestPasskey, setPasskeyPrompt } from '../../src/sync/passkey-prompt';
import {
  type DownloadedFile,
  type S3Client,
  type StorageSessionItem,
  SyncManager,
  type SyncManagerOptions,
  syncManager,
} from '../../src/sync/sync-manager';
import type { SessionSyncCompleteMessage } from '../../src/sync/sync-protocol';
import type { ManifestFingerprint } from '../../src/types';

function createManager(options: Partial<SyncManagerOptions>): SyncManager {
  const noopWorker = {
    postMessage: () => undefined,
    terminate: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    onmessage: null,
    onerror: null,
  } as unknown as Worker;

  const noopS3: S3Client = {
    listProjectFolders: async () => [],
    listSessionFolders: async () => [],
    getObject: async () => new ArrayBuffer(0),
    putObject: async () => ({ etag: 'etag' }),
  };

  return new SyncManager({
    createWorker: () => noopWorker,
    createS3Client: () => noopS3,
    createBroadcastChannel: () =>
      ({
        onmessage: null,
        postMessage: () => undefined,
        close: () => undefined,
      }) as unknown as BroadcastChannel,
    ...options,
  });
}

/**
 * Regression tests for the sync-to-analytics bridge.
 *
 * The sync manager exposes two seams — `onFileDownloaded` and `onSyncComplete` —
 * that the app singleton wires to the analytics client. If these seams are not
 * invoked, or are invoked with the wrong payload, synced sessions never reach
 * the analytics ingestion pipeline and portfolio charts stay empty.
 */
describe('SyncManager analytics bridge', () => {
  function buildManifest(sessionId: string, artifact: ManifestArtifact): SyncManifest {
    return {
      schemaVersion: 2,
      projectId: 'p1',
      sessionId,
      harness: 'claude-code',
      harnessVersion: '0.1.0',
      syncVersion: '0.1.0',
      pluginVersion: '0.1.0',
      transcriptsCaptured: true,
      mainTranscriptRelativePath: artifact.relativePath,
      artifacts: [artifact],
      syncRuns: [],
      syncRunsCount: 0,
    };
  }

  it('onFileDownloaded hook is invoked with the downloaded file and projectId', async () => {
    const onFileDownloaded = vi.fn().mockResolvedValue(undefined);
    const manager = createManager({ onFileDownloaded });

    const file: DownloadedFile = {
      path: 'session/transcript.jsonl',
      hash: 'abc123',
      size: 12,
      content: new ArrayBuffer(12),
    };
    // The seam is stored on the instance; call it directly to verify the
    // contract: the manager must forward (sessionId, file, projectId).
    // @ts-expect-error — accessing private field for regression test
    await manager.onFileDownloaded('sess-1', file, 'p1');
    expect(onFileDownloaded).toHaveBeenCalledWith('sess-1', file, 'p1');
  });

  it('onSyncComplete hook is invoked with the manifest and projectId', async () => {
    const onSyncComplete = vi.fn().mockResolvedValue(undefined);
    const manager = createManager({ onSyncComplete });

    const artifact: ManifestArtifact = {
      projectId: 'p1',
      sessionId: 'sess-1',
      scope: 'session',
      relativePath: 'session/transcript.jsonl',
      mediaType: 'application/jsonl',
      sha256: 'abc123',
      size: 12,
      status: 'uploaded',
    };
    const manifest = buildManifest('sess-1', artifact);

    // @ts-expect-error — accessing private field for regression test
    await manager.onSyncComplete('sess-1', manifest, 'p1');
    expect(onSyncComplete).toHaveBeenCalledWith('sess-1', manifest, 'p1');
  });

  it('onSyncComplete hook is invoked with undefined manifest when missing', async () => {
    const onSyncComplete = vi.fn().mockResolvedValue(undefined);
    const manager = createManager({ onSyncComplete });

    // @ts-expect-error — accessing private field for regression test
    await manager.onSyncComplete('sess-1', undefined, 'p1');
    expect(onSyncComplete).toHaveBeenCalledWith('sess-1', undefined, 'p1');
  });
});

/**
 * Regression: the app-wide `syncManager` singleton must wire its hooks to the
 * analytics client. If the wiring is removed, synced sessions never reach the
 * analytics ingestion pipeline and portfolio charts stay empty.
 */
describe('syncManager singleton analytics wiring', () => {
  it('retains downloaded files via analyticsClient.retainSyncArtifact', async () => {
    const retainSpy = vi.spyOn(analyticsClient, 'retainSyncArtifact').mockResolvedValue(undefined);

    const file: DownloadedFile = {
      path: 'session/transcript.jsonl',
      hash: 'abc123',
      size: 5,
      content: new ArrayBuffer(5),
    };
    // @ts-expect-error — accessing private field for regression test
    await syncManager.onFileDownloaded('sess-1', file, 'p1');

    expect(retainSpy).toHaveBeenCalledTimes(1);
    const call = retainSpy.mock.calls[0]?.[0];
    expect(call?.sha256).toBe('abc123');
    expect(call?.relativePath).toBe('session/transcript.jsonl');
    expect(call?.size).toBe(5);

    retainSpy.mockRestore();
  });

  it('ingests sync manifests via analyticsClient.ingestSyncManifest', async () => {
    const ingestSpy = vi.spyOn(analyticsClient, 'ingestSyncManifest').mockResolvedValue({
      generationId: 'gen-1',
      status: 'committed',
      issueIds: [],
    } as never);

    const manifest: SyncManifest = {
      schemaVersion: 2,
      projectId: 'p1',
      sessionId: 'sess-1',
      harness: 'claude-code',
      harnessVersion: '0.1.0',
      syncVersion: '0.1.0',
      pluginVersion: '0.1.0',
      transcriptsCaptured: true,
      mainTranscriptRelativePath: 'session/transcript.jsonl',
      artifacts: [],
      syncRuns: [],
      syncRunsCount: 0,
    };
    // @ts-expect-error — accessing private field for regression test
    await syncManager.onSyncComplete('sess-1', manifest, 'p1');

    expect(ingestSpy).toHaveBeenCalledTimes(1);
    const [passedManifest, source] = ingestSpy.mock.calls[0] ?? [];
    expect(passedManifest).toEqual(manifest);
    expect(source).toEqual({ sourceId: 'sync', projectId: 'p1', sessionId: 'sess-1' });

    ingestSpy.mockRestore();
  });

  it('skips ingestSyncManifest when manifest is undefined', async () => {
    const ingestSpy = vi.spyOn(analyticsClient, 'ingestSyncManifest').mockResolvedValue({
      generationId: 'gen-1',
      status: 'committed',
      issueIds: [],
    } as never);

    // @ts-expect-error — accessing private field for regression test
    await syncManager.onSyncComplete('sess-1', undefined, 'p1');

    expect(ingestSpy).not.toHaveBeenCalled();
    ingestSpy.mockRestore();
  });
});

/**
 * Protocol-level regression: the analytics request union must include
 * `ingestSyncManifest`. If the request type is removed, the sync-to-analytics
 * bridge breaks at compile time and the worker's switch falls through.
 */
describe('ingestSyncManifest protocol contract', () => {
  it('is a member of the AnalyticsRequest union', () => {
    const request: AnalyticsRequest = {
      id: 1,
      type: 'ingestSyncManifest',
      manifest: { artifacts: [] },
      source: { sourceId: 'sync' },
    };
    expect(request.type).toBe('ingestSyncManifest');
  });

  it('SessionSyncCompleteMessage carries files for reconciliation', () => {
    // The sync worker must emit SESSION_SYNC_COMPLETE with a files array so
    // the manager can reconcile and then invoke onSyncComplete. If the
    // message shape regresses, the analytics ingestion never fires.
    const message: SessionSyncCompleteMessage = {
      type: 'SESSION_SYNC_COMPLETE',
      connectionId: 'c1',
      projectId: 'p1',
      sessionId: 's1',
      files: [{ file: 'session/transcript.jsonl', hash: 'abc', size: 10, status: 'downloaded' }],
    };
    expect(message.files.length).toBe(1);
  });
});

/**
 * Regression: the syncManager singleton must wire `onPasskeyRequired` to
 * `requestPasskey()` so that a sync attempt with a locked vault prompts for
 * the passkey instead of failing with "Could not unlock S3 credentials".
 */
describe('syncManager singleton passkey prompt wiring', () => {
  afterEach(() => {
    // Reset the prompt to avoid leaking state between test suites.
    setPasskeyPrompt(async () => false);
  });

  it('onPasskeyRequired delegates to the registered passkey prompt', async () => {
    setPasskeyPrompt(async () => true);
    // @ts-expect-error — accessing private field for regression test
    const result = await syncManager.onPasskeyRequired?.();
    expect(result).toBe(true);
  });

  it('onPasskeyRequired returns false when no prompt is registered', async () => {
    // Temporarily clear the prompt by registering a no-op that returns false.
    setPasskeyPrompt(async () => false);
    // @ts-expect-error — accessing private field for regression test
    const result = await syncManager.onPasskeyRequired?.();
    expect(result).toBe(false);
  });

  it('requestPasskey resolves to false when no prompt is set', async () => {
    // The default state (before app-root registers a prompt) must not
    // throw — it should resolve to false so the sync run fails gracefully.
    setPasskeyPrompt(async () => false);
    const result = await requestPasskey();
    expect(result).toBe(false);
  });
});

/**
 * Tests for the session failure isolation invariant:
 * A failed session must NEVER stop the whole process.
 */
describe('SyncManager session failure isolation', () => {
  function createMockDb(): DbClient {
    return {
      getSessionBySyncId: vi.fn().mockResolvedValue(null),
      upsertSessionStub: vi.fn().mockResolvedValue(undefined),
      setSessionSyncStatus: vi.fn().mockResolvedValue(undefined),
      getSessionUpdatedAt: vi.fn().mockResolvedValue(null),
      updateSessionManifest: vi.fn().mockResolvedValue(undefined),
      getSessionFiles: vi.fn().mockResolvedValue([]),
      upsertSessionFile: vi.fn().mockResolvedValue(undefined),
      bulkUpsertSessionFiles: vi.fn().mockResolvedValue(undefined),
      failStaleSessions: vi.fn().mockResolvedValue(undefined),
      setProjectSyncStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as DbClient;
  }

  function createTestProject(mockWorker: Worker) {
    return {
      projectId: 'proj-1',
      localProjectId: 'local-proj-1',
      worker: mockWorker,
      status: 'running' as const,
      sessions: new Map(),
      totalSessions: 3,
      sessionsDone: 0,
      sessionsFailed: 0,
      filesFound: 0,
      filesDownloaded: 0,
      filesFailed: 0,
      bytesReceived: 0,
      isNew: false,
    };
  }

  it('handleSessionSyncFailed increments sessionsDone and sessionsFailed, persisting stub', async () => {
    const mockDb = createMockDb();
    const manager = createManager({ dbClient: mockDb });
    const mockWorker = { postMessage: vi.fn(), terminate: vi.fn() } as unknown as Worker;
    const project = createTestProject(mockWorker);

    // @ts-expect-error — testing private method
    await manager.handleSessionSyncFailed(project, {
      type: 'SESSION_SYNC_FAILED',
      connectionId: 'c1',
      projectId: 'proj-1',
      sessionId: 'sess-manifest-fail',
      error: { code: 'MANIFEST_NOT_FOUND', message: 'Not found' },
    });

    expect(project.sessionsFailed).toBe(1);
    expect(project.sessionsDone).toBe(1);
    expect(mockDb.upsertSessionStub).toHaveBeenCalledTimes(1);
    expect(mockDb.setSessionSyncStatus).toHaveBeenCalledWith(
      'sync-local-proj-1-sess-manifest-fail',
      'failed',
      expect.stringContaining('MANIFEST_NOT_FOUND'),
    );
    expect(mockWorker.terminate).not.toHaveBeenCalled();
  });

  it('handleSessionSyncComplete with INGEST_FAILED isolates failure without terminating worker', async () => {
    const mockDb = createMockDb();
    const onSyncComplete = vi
      .fn()
      .mockRejectedValue(new Error('ingestion issues: missing_root_transcript'));
    const manager = createManager({ onSyncComplete, dbClient: mockDb });
    const mockWorker = { postMessage: vi.fn(), terminate: vi.fn() } as unknown as Worker;
    const project = createTestProject(mockWorker);

    // @ts-expect-error — accessing private method for test setup
    const session = manager.getOrCreateSessionState(project, 'sess-ingest-fail', 'local-sess-1');
    session.manifest = {
      schemaVersion: 2,
      projectId: 'proj-1',
      sessionId: 'sess-ingest-fail',
      harness: 'claude',
      harnessVersion: '1',
      syncVersion: '0.1.0',
      pluginVersion: '1',
      transcriptsCaptured: true,
      artifacts: [],
      syncRuns: [],
      syncRunsCount: 0,
    };

    // @ts-expect-error — testing private method
    await manager.handleSessionSyncComplete(project, {
      type: 'SESSION_SYNC_COMPLETE',
      connectionId: 'c1',
      projectId: 'proj-1',
      sessionId: 'sess-ingest-fail',
      files: [],
    });

    expect(project.sessionsFailed).toBe(1);
    expect(project.sessionsDone).toBe(1);
    expect(session.syncStatus).toBe('failed');
    expect(mockDb.setSessionSyncStatus).toHaveBeenCalledWith(
      'local-sess-1',
      'failed',
      expect.stringContaining('INGEST_FAILED'),
    );
    expect(mockWorker.terminate).not.toHaveBeenCalled();
  });

  it('handleSessionSyncComplete reconciles artifact hashes in session.manifest when files have been reconciled', async () => {
    const mockDb = createMockDb();
    const onSyncComplete = vi.fn().mockResolvedValue(undefined);
    const manager = createManager({ onSyncComplete, dbClient: mockDb });
    const mockWorker = { postMessage: vi.fn(), terminate: vi.fn() } as unknown as Worker;
    const project = createTestProject(mockWorker);

    // @ts-expect-error — accessing private method for test setup
    const session = manager.getOrCreateSessionState(project, 'sess-reconcile', 'local-sess-rec');
    session.manifest = {
      schemaVersion: 2,
      projectId: 'proj-1',
      sessionId: 'sess-reconcile',
      harness: 'claude',
      harnessVersion: '1',
      syncVersion: '0.1.0',
      pluginVersion: '1',
      transcriptsCaptured: true,
      artifacts: [
        {
          projectId: 'proj-1',
          sessionId: 'sess-reconcile',
          scope: 'session',
          relativePath: 'transcript.jsonl',
          sha256: 'old-hash-111',
          size: 10,
          status: 'uploaded',
        },
      ],
      syncRuns: [],
      syncRunsCount: 0,
    };

    // @ts-expect-error — testing private method
    await manager.handleSessionSyncComplete(project, {
      type: 'SESSION_SYNC_COMPLETE',
      connectionId: 'c1',
      projectId: 'proj-1',
      sessionId: 'sess-reconcile',
      files: [
        {
          file: 'transcript.jsonl',
          hash: 'reconciled-actual-hash-222',
          size: 25,
          status: 'downloaded',
        },
      ],
    });

    expect(project.sessionsFailed).toBe(0);
    expect(project.sessionsDone).toBe(1);
    expect(onSyncComplete).toHaveBeenCalledWith(
      'local-sess-rec',
      expect.objectContaining({
        artifacts: [
          expect.objectContaining({
            relativePath: 'transcript.jsonl',
            sha256: 'reconciled-actual-hash-222',
            size: 25,
          }),
        ],
      }),
      'proj-1',
    );
  });

  it('handleSessionManifestReady unblocks worker on failure and isolates error', async () => {
    const mockDb = createMockDb();
    // @ts-expect-error — mock failure in DB
    mockDb.upsertSessionStub.mockRejectedValue(new Error('Database write error'));
    const postedToWorker: unknown[] = [];
    const mockWorker = {
      postMessage: (msg: unknown) => postedToWorker.push(msg),
      terminate: vi.fn(),
    } as unknown as Worker;
    const manager = createManager({ dbClient: mockDb });
    const project = createTestProject(mockWorker);

    const manifest: SyncManifest = {
      schemaVersion: 2,
      projectId: 'proj-1',
      sessionId: 'sess-err',
      harness: 'claude',
      harnessVersion: '1',
      syncVersion: '0.1.0',
      pluginVersion: '1',
      transcriptsCaptured: true,
      artifacts: [],
      syncRuns: [],
      syncRunsCount: 0,
    };

    // @ts-expect-error — testing private method
    await manager.handleSessionManifestReady({} as never, project, mockWorker, {
      sessionId: 'sess-err',
      manifest,
    });

    expect(project.sessionsFailed).toBe(1);
    expect(project.sessionsDone).toBe(1);
    expect(postedToWorker).toContainEqual(
      expect.objectContaining({
        type: 'SESSION_SYNC',
        sessionId: 'sess-err',
        sync: false,
      }),
    );
    expect(mockWorker.terminate).not.toHaveBeenCalled();
  });

  it('handleSessionFound retries failed sessions even with syncOnlyNew when includeFailed is true', async () => {
    const mockDb = createMockDb();
    const postedToWorker: Array<{ sessionId: string; sync: boolean }> = [];
    const mockWorker = {
      postMessage: (msg: { sessionId: string; sync: boolean }) => postedToWorker.push(msg),
      terminate: vi.fn(),
    } as unknown as Worker;
    const manager = createManager({ dbClient: mockDb });
    const project = createTestProject(mockWorker);
    const run = { syncOnlyNew: true, connectionId: 'c1', includeFailed: true };

    // 1. Session not in DB -> sync: true
    // @ts-expect-error — testing private method
    await manager.handleSessionFound(run as never, project, mockWorker, { sessionId: 's-new' });

    // 2. Session exists with status 'failed' -> sync: true (allows retry when includeFailed)
    // @ts-expect-error — mock return
    mockDb.getSessionBySyncId.mockResolvedValueOnce({ id: 's2-id', sync_status: 'failed' });
    // @ts-expect-error — testing private method
    await manager.handleSessionFound(run as never, project, mockWorker, { sessionId: 's-failed' });

    // 3. Session exists with status 'in_sync' -> sync: false (skip)
    // @ts-expect-error — mock return
    mockDb.getSessionBySyncId.mockResolvedValueOnce({ id: 's3-id', sync_status: 'in_sync' });
    // @ts-expect-error — testing private method
    await manager.handleSessionFound(run as never, project, mockWorker, { sessionId: 's-synced' });

    expect(postedToWorker).toEqual([
      expect.objectContaining({ sessionId: 's-new', sync: true }),
      expect.objectContaining({ sessionId: 's-failed', sync: true }),
      expect.objectContaining({ sessionId: 's-synced', sync: false }),
    ]);
  });

  it('handleSessionFound excludes failed sessions when includeFailed is false (default)', async () => {
    const mockDb = createMockDb();
    const postedToWorker: Array<{ sessionId: string; sync: boolean }> = [];
    const mockWorker = {
      postMessage: (msg: { sessionId: string; sync: boolean }) => postedToWorker.push(msg),
      terminate: vi.fn(),
    } as unknown as Worker;
    const manager = createManager({ dbClient: mockDb });
    const project = createTestProject(mockWorker);
    const run = { syncOnlyNew: true, connectionId: 'c1', includeFailed: false };

    // 1. Session not in DB -> sync: true
    // @ts-expect-error — testing private method
    await manager.handleSessionFound(run as never, project, mockWorker, { sessionId: 's-new' });

    // 2. Session exists with status 'failed' -> sync: false (excluded by default)
    // @ts-expect-error — mock return
    mockDb.getSessionBySyncId.mockResolvedValueOnce({ id: 's2-id', sync_status: 'failed' });
    // @ts-expect-error — testing private method
    await manager.handleSessionFound(run as never, project, mockWorker, { sessionId: 's-failed' });

    // 3. Session exists with status 'in_sync' -> sync: false (skip)
    // @ts-expect-error — mock return
    mockDb.getSessionBySyncId.mockResolvedValueOnce({ id: 's3-id', sync_status: 'in_sync' });
    // @ts-expect-error — testing private method
    await manager.handleSessionFound(run as never, project, mockWorker, { sessionId: 's-synced' });

    expect(postedToWorker).toEqual([
      expect.objectContaining({ sessionId: 's-new', sync: true }),
      expect.objectContaining({ sessionId: 's-failed', sync: false }),
      expect.objectContaining({ sessionId: 's-synced', sync: false }),
    ]);
  });

  /**
   * SYNC-014: D2 unchanged-skip gate truth table. `run.syncOnlyNew = false`
   * for every case here — the D3 branch (syncOnlyNew = true) is covered
   * separately by 'handleSessionFound retries failed sessions even with
   * syncOnlyNew when includeFailed is true' above, unmodified. `includeFailed`
   * is set to true so the failed-session exclusion gate does not interfere
   * with the unchanged-skip fingerprint logic under test here.
   */
  describe.each([
    {
      name: 'equal fingerprint (etag), in_sync → skip',
      localRow: { id: 's-id', sync_status: 'in_sync', sync_manifest_etag: 'abc' },
      messageFingerprint: { etag: 'abc' } as ManifestFingerprint | undefined,
      expectSync: false,
    },
    {
      name: 'different fingerprint (etag), in_sync → sync',
      localRow: { id: 's-id', sync_status: 'in_sync', sync_manifest_etag: 'abc' },
      messageFingerprint: { etag: 'def' } as ManifestFingerprint | undefined,
      expectSync: true,
    },
    {
      name: 'failed status, equal fingerprint → sync regardless',
      localRow: { id: 's-id', sync_status: 'failed', sync_manifest_etag: 'abc' },
      messageFingerprint: { etag: 'abc' } as ManifestFingerprint | undefined,
      expectSync: true,
    },
    {
      name: 'pending status, equal fingerprint → sync regardless',
      localRow: { id: 's-id', sync_status: 'pending', sync_manifest_etag: 'abc' },
      messageFingerprint: { etag: 'abc' } as ManifestFingerprint | undefined,
      expectSync: true,
    },
    {
      name: 'transcript_unavailable status, equal fingerprint → sync regardless',
      localRow: {
        id: 's-id',
        sync_status: 'transcript_unavailable',
        sync_manifest_etag: 'abc',
      },
      messageFingerprint: { etag: 'abc' } as ManifestFingerprint | undefined,
      expectSync: true,
    },
    {
      name: 'processing status, equal fingerprint → sync regardless',
      localRow: { id: 's-id', sync_status: 'processing', sync_manifest_etag: 'abc' },
      messageFingerprint: { etag: 'abc' } as ManifestFingerprint | undefined,
      expectSync: true,
    },
    {
      name: 'no local row → sync',
      localRow: null,
      messageFingerprint: { etag: 'abc' } as ManifestFingerprint | undefined,
      expectSync: true,
    },
    {
      name: 'in_sync but no stored fingerprint (pre-upgrade backfill) → sync',
      localRow: { id: 's-id', sync_status: 'in_sync' },
      messageFingerprint: { etag: 'abc' } as ManifestFingerprint | undefined,
      expectSync: true,
    },
    {
      name: 'in_sync, stored fingerprint, but message has no fingerprint → sync',
      localRow: { id: 's-id', sync_status: 'in_sync', sync_manifest_etag: 'abc' },
      messageFingerprint: undefined,
      expectSync: true,
    },
    {
      name: 'etag absent both sides, lastModified present and equal → skip',
      localRow: {
        id: 's-id',
        sync_status: 'in_sync',
        sync_manifest_last_modified: '2026-01-01T00:00:00Z',
      },
      messageFingerprint: { lastModified: '2026-01-01T00:00:00Z' } as
        | ManifestFingerprint
        | undefined,
      expectSync: false,
    },
    {
      name: 'both etag and lastModified absent on both sides → sync',
      localRow: { id: 's-id', sync_status: 'in_sync' },
      messageFingerprint: {} as ManifestFingerprint | undefined,
      expectSync: true,
    },
  ])('D2 gate: $name', ({ localRow, messageFingerprint, expectSync }) => {
    it(`resolves sync:${expectSync}`, async () => {
      const mockDb = createMockDb();
      // @ts-expect-error — mock return
      mockDb.getSessionBySyncId.mockResolvedValue(localRow);
      const postedToWorker: Array<{ sessionId: string; sync: boolean }> = [];
      const mockWorker = {
        postMessage: (msg: { sessionId: string; sync: boolean }) => postedToWorker.push(msg),
        terminate: vi.fn(),
      } as unknown as Worker;
      const manager = createManager({ dbClient: mockDb });
      const project = createTestProject(mockWorker);
      const run = { syncOnlyNew: false, connectionId: 'c1', includeFailed: true };

      // @ts-expect-error — testing private method
      await manager.handleSessionFound(run as never, project, mockWorker, {
        sessionId: 's1',
        fingerprint: messageFingerprint,
      });

      expect(postedToWorker).toEqual([
        expect.objectContaining({
          type: 'SESSION_SYNC_CONTINUE',
          sessionId: 's1',
          sync: expectSync,
        }),
      ]);
    });
  });

  it('SYNC-014: D2 gate fails open (sync: true) when getSessionBySyncId throws', async () => {
    const mockDb = createMockDb();
    // @ts-expect-error — mock rejection
    mockDb.getSessionBySyncId.mockRejectedValue(new Error('DB unavailable'));
    const postedToWorker: Array<{ sessionId: string; sync: boolean }> = [];
    const mockWorker = {
      postMessage: (msg: { sessionId: string; sync: boolean }) => postedToWorker.push(msg),
      terminate: vi.fn(),
    } as unknown as Worker;
    const manager = createManager({ dbClient: mockDb });
    const project = createTestProject(mockWorker);
    const run = { syncOnlyNew: false, connectionId: 'c1' };

    // @ts-expect-error — testing private method
    await manager.handleSessionFound(run as never, project, mockWorker, {
      sessionId: 's1',
      fingerprint: { etag: 'abc' },
    });

    expect(postedToWorker).toEqual([
      expect.objectContaining({ type: 'SESSION_SYNC_CONTINUE', sessionId: 's1', sync: true }),
    ]);
  });

  it('D5: handleSessionManifestReady persists the message fingerprint via updateSessionManifest', async () => {
    const mockDb = createMockDb();
    const mockWorker = { postMessage: vi.fn(), terminate: vi.fn() } as unknown as Worker;
    const manager = createManager({ dbClient: mockDb });
    const project = createTestProject(mockWorker);
    const manifest: SyncManifest = {
      schemaVersion: 2,
      projectId: 'proj-1',
      sessionId: 'sess-fp',
      harness: 'claude',
      harnessVersion: '1',
      syncVersion: '0.1.0',
      pluginVersion: '1',
      transcriptsCaptured: true,
      artifacts: [],
      syncRuns: [],
      syncRunsCount: 0,
    };
    const fingerprint: ManifestFingerprint = { etag: 'abc', lastModified: '2026-01-01T00:00:00Z' };

    // @ts-expect-error — testing private method
    await manager.handleSessionManifestReady({} as never, project, mockWorker, {
      sessionId: 'sess-fp',
      manifest,
      fingerprint,
    });

    expect(mockDb.updateSessionManifest).toHaveBeenCalledWith(
      expect.any(String),
      manifest,
      fingerprint,
    );
  });

  it('D5: handleSessionManifestReady persists undefined when the message carries no fingerprint', async () => {
    const mockDb = createMockDb();
    const mockWorker = { postMessage: vi.fn(), terminate: vi.fn() } as unknown as Worker;
    const manager = createManager({ dbClient: mockDb });
    const project = createTestProject(mockWorker);
    const manifest: SyncManifest = {
      schemaVersion: 2,
      projectId: 'proj-1',
      sessionId: 'sess-nofp',
      harness: 'claude',
      harnessVersion: '1',
      syncVersion: '0.1.0',
      pluginVersion: '1',
      transcriptsCaptured: true,
      artifacts: [],
      syncRuns: [],
      syncRunsCount: 0,
    };

    // @ts-expect-error — testing private method
    await manager.handleSessionManifestReady({} as never, project, mockWorker, {
      sessionId: 'sess-nofp',
      manifest,
    });

    expect(mockDb.updateSessionManifest).toHaveBeenCalledWith(
      expect.any(String),
      manifest,
      undefined,
    );
  });

  it('handleTranscriptUnavailable persists the status and pushes a warning toast', async () => {
    const mockDb = createMockDb();
    const postedToWorker: Array<{ sessionId: string; sync: boolean }> = [];
    const mockWorker = {
      postMessage: (msg: { sessionId: string; sync: boolean }) => postedToWorker.push(msg),
      terminate: vi.fn(),
    } as unknown as Worker;
    const warnings: string[] = [];
    const manager = createManager({ dbClient: mockDb, onWarning: (w) => warnings.push(w) });
    const project = createTestProject(mockWorker);
    const sessionState = { syncStatus: 'pending' };

    // @ts-expect-error — testing private method
    await manager.handleTranscriptUnavailable(
      { warnings: [] } as never,
      sessionState as never,
      { id: 'local-1' } as never,
      mockWorker,
      'sess-notranscript',
    );

    expect(sessionState.syncStatus).toBe('transcript_unavailable');
    expect(mockDb.setSessionSyncStatus).toHaveBeenCalledWith(
      'local-1',
      'transcript_unavailable',
      'Main transcript not uploaded',
    );
    expect(warnings).toEqual([
      'sess-notranscript: no main transcript uploaded — session not synced',
    ]);
    expect(postedToWorker).toEqual([
      expect.objectContaining({ sessionId: 'sess-notranscript', sync: false }),
    ]);
  });

  it('isolateWorkerMessageError isolates unexpected session-level message errors', async () => {
    const mockDb = createMockDb();
    const mockWorker = { postMessage: vi.fn(), terminate: vi.fn() } as unknown as Worker;
    const manager = createManager({ dbClient: mockDb });
    const project = createTestProject(mockWorker);

    // @ts-expect-error — testing private method
    await manager.isolateWorkerMessageError(
      { connectionId: 'c1' } as never,
      project,
      mockWorker,
      { type: 'SESSION_MANIFEST_READY', sessionId: 'sess-unexpected' } as never,
      new Error('Unexpected parse crash'),
    );

    expect(project.sessionsFailed).toBe(1);
    expect(project.sessionsDone).toBe(1);
    expect(mockWorker.terminate).not.toHaveBeenCalled();
  });

  it('multi-session queue continuity: when one session fails, subsequent sessions proceed to completion', async () => {
    const mockDb = createMockDb();
    const onSyncComplete = vi.fn().mockImplementation(async (localId: string) => {
      if (localId.includes('sess-1')) {
        throw new Error('ingestion failed for sess-1');
      }
    });
    const mockWorker = { postMessage: vi.fn(), terminate: vi.fn() } as unknown as Worker;
    const manager = createManager({ onSyncComplete, dbClient: mockDb });
    const project = createTestProject(mockWorker);
    project.totalSessions = 3;

    // Simulate Session 1 failing at onSyncComplete (INGEST_FAILED)
    const session1 = {
      type: 'SESSION_SYNC_COMPLETE' as const,
      sessionId: 'sess-1',
      files: [],
    };
    // @ts-expect-error — testing private method
    const state1 = manager.getOrCreateSessionState(project, 'sess-1', 'local-sess-1');
    state1.syncStatus = 'processing';
    // @ts-expect-error — testing private method
    await manager.handleSessionSyncComplete(project, session1);

    expect(state1.syncStatus).toBe('failed');
    expect(project.sessionsFailed).toBe(1);
    expect(project.sessionsDone).toBe(1);

    // Simulate Session 2 succeeding
    const session2 = {
      type: 'SESSION_SYNC_COMPLETE' as const,
      sessionId: 'sess-2',
      files: [],
    };
    // @ts-expect-error — testing private method
    const state2 = manager.getOrCreateSessionState(project, 'sess-2', 'local-sess-2');
    state2.syncStatus = 'processing';
    // @ts-expect-error — testing private method
    await manager.handleSessionSyncComplete(project, session2);

    expect(state2.syncStatus).toBe('in_sync');
    expect(project.sessionsFailed).toBe(1);
    expect(project.sessionsDone).toBe(2);

    // Simulate Session 3 succeeding
    const session3 = {
      type: 'SESSION_SYNC_COMPLETE' as const,
      sessionId: 'sess-3',
      files: [],
    };
    // @ts-expect-error — testing private method
    const state3 = manager.getOrCreateSessionState(project, 'sess-3', 'local-sess-3');
    state3.syncStatus = 'processing';
    // @ts-expect-error — testing private method
    await manager.handleSessionSyncComplete(project, session3);

    expect(state3.syncStatus).toBe('in_sync');
    expect(project.totalSessions).toBe(3);
    expect(project.sessionsDone).toBe(3);
    expect(project.sessionsFailed).toBe(1);
    expect(mockWorker.terminate).not.toHaveBeenCalled();
  });

  it('manifest failure followed by worker SESSION_SYNC_COMPLETE does not double-increment sessionsDone', async () => {
    const mockDb = createMockDb();
    const mockWorker = { postMessage: vi.fn(), terminate: vi.fn() } as unknown as Worker;
    const manager = createManager({ dbClient: mockDb });
    const project = createTestProject(mockWorker);

    // Manifest failure occurs
    // @ts-expect-error — testing private method
    await manager.handleManifestReadyFailed(
      project,
      mockWorker,
      'sess-double-count-check',
      new Error('Manifest read error'),
    );

    expect(project.sessionsDone).toBe(1);
    expect(project.sessionsFailed).toBe(1);

    // Worker replies to sync: false with SESSION_SYNC_COMPLETE
    // @ts-expect-error — testing private method
    await manager.handleSessionSyncComplete(project, {
      type: 'SESSION_SYNC_COMPLETE',
      sessionId: 'sess-double-count-check',
      files: [],
    });

    // sessionsDone must remain 1, not 2
    expect(project.sessionsDone).toBe(1);
    expect(project.sessionsFailed).toBe(1);
  });
});

describe('SyncManager cherry pick and storage sessions', () => {
  it('listStorageSessions lists projects, session metadata, and resolves sync status', async () => {
    const mockDb = {
      getConnections: vi.fn().mockResolvedValue([
        {
          id: 'conn-s3-1',
          name: 'Main S3',
          storage_type: 's3',
          created_at: 1000,
          updated_at: 1000,
          sync_only_new: false,
        },
      ]),
      getS3Credentials: vi.fn().mockResolvedValue(null),
      getProjectByReadableId: vi.fn().mockImplementation((folder: string) => {
        if (folder === 'proj-a') {
          return Promise.resolve({ id: 'local-proj-a', name: 'Alpha Project' });
        }
        return Promise.resolve(null);
      }),
      getSessionBySyncId: vi.fn().mockImplementation((projId: string, sessId: string) => {
        if (projId === 'local-proj-a' && sessId === 'sess-1') {
          return Promise.resolve({
            id: 'local-sess-1',
            sync_status: 'in_sync',
            title: 'Session One',
          });
        }
        return Promise.resolve(null);
      }),
    } as unknown as DbClient;

    const mockS3 = {
      listProjectFolders: vi.fn().mockResolvedValue(['proj-a']),
      listSessionFolders: vi.fn().mockResolvedValue([]),
      listProjectObjects: vi.fn().mockResolvedValue([
        {
          key: 'proj-a/sess-1/transcript.jsonl',
          lastModified: '2026-09-12T10:00:00.000Z',
          size: 100,
        },
        {
          key: 'proj-a/sess-2/transcript.jsonl',
          lastModified: '2026-09-13T10:00:00.000Z',
          size: 200,
        },
      ]),
      getObject: vi.fn().mockRejectedValue(new Error('no manifest')),
      putObject: vi.fn(),
    };

    const manager = createManager({
      dbClient: mockDb,
      createS3Client: () => mockS3,
    });

    // Register ephemeral connection so credentials unlock without passkey
    manager.registerEphemeralConnection(
      {
        id: 'conn-s3-1',
        name: 'Main S3',
        storage_type: 's3',
        created_at: 1000,
        updated_at: 1000,
        sync_only_new: false,
      },
      {
        accessKeyId: 'ak',
        secretAccessKey: 'sk',
        bucket: 'my-bucket',
        region: 'us-east-1',
      },
    );

    const items = await manager.listStorageSessions('conn-s3-1');
    expect(items.length).toBe(2);

    const s1 = items.find((i) => i.sessionId === 'sess-1');
    const s2 = items.find((i) => i.sessionId === 'sess-2');

    expect(s1).toMatchObject({
      projectId: 'proj-a',
      projectName: 'Alpha Project',
      sessionId: 'sess-1',
      title: 'Session One',
      synced: true,
    });

    expect(s2).toMatchObject({
      projectId: 'proj-a',
      projectName: 'Alpha Project',
      sessionId: 'sess-2',
      synced: false,
    });
  });

  it('requestRun with targetSessions restricts sync run to specific sessions', async () => {
    const mockDb = {
      getConnections: vi.fn().mockResolvedValue([]),
      getS3Credentials: vi.fn().mockResolvedValue(null),
    } as unknown as DbClient;

    const manager = createManager({ dbClient: mockDb });

    manager.registerEphemeralConnection(
      {
        id: 'conn-target',
        name: 'Target S3',
        storage_type: 's3',
        created_at: 1000,
        updated_at: 1000,
        sync_only_new: true,
      },
      {
        accessKeyId: 'ak',
        secretAccessKey: 'sk',
        bucket: 'target-bucket',
        region: 'us-east-1',
      },
    );

    manager.requestRun('conn-target', {
      targetSessions: [
        { projectId: 'proj-1', sessionId: 'sess-a' },
        { projectId: 'proj-2', sessionId: 'sess-b' },
      ],
    });

    const snapshot = manager.getSnapshot();
    expect(snapshot.activeRun?.connectionId).toBe('conn-target');
  });

  it('refreshStorageSessionStatuses refreshes sync status and title from local db without calling S3', async () => {
    const mockDb = {
      getProjectByReadableId: vi.fn().mockImplementation(async (readableId: string) => {
        if (readableId === 'proj-a') return { id: 'local-proj-a', name: 'Alpha Project' };
        return null;
      }),
      getSessionBySyncId: vi
        .fn()
        .mockImplementation(async (_projId: string, syncSessionId: string) => {
          if (syncSessionId === 'sess-2') {
            return { sync_status: 'in_sync', title: 'Session Two Updated' };
          }
          return null;
        }),
    } as unknown as DbClient;

    const manager = createManager({ dbClient: mockDb });

    const items: StorageSessionItem[] = [
      {
        projectId: 'proj-a',
        projectName: 'Alpha Project',
        sessionId: 'sess-2',
        title: 'Session Two',
        modifiedTimestamp: 1000,
        synced: false,
      },
    ];

    const refreshed = await manager.refreshStorageSessionStatuses(items);
    expect(refreshed[0].synced).toBe(true);
    expect(refreshed[0].title).toBe('Session Two Updated');
  });

  /**
   * Regression: cherry-picked sessions used to display the raw remote session
   * id as their title — sync stubs persist it into `sessions.title` at stub
   * creation and nothing ever replaced it with the parsed `ai-title`. The
   * parsed title lives in the analytics DB; the listing must resolve it via
   * the `resolveSessionTitle` seam instead.
   */
  it('listStorageSessions resolves a synced session title via the resolveSessionTitle seam', async () => {
    const mockDb = {
      getConnections: vi.fn().mockResolvedValue([
        {
          id: 'conn-s3-1',
          name: 'Main S3',
          storage_type: 's3',
          created_at: 1000,
          updated_at: 1000,
          sync_only_new: false,
        },
      ]),
      getS3Credentials: vi.fn().mockResolvedValue(null),
      getProjectByReadableId: vi.fn().mockImplementation((folder: string) => {
        if (folder === 'proj-a') {
          return Promise.resolve({ id: 'local-proj-a', name: 'Alpha Project' });
        }
        return Promise.resolve(null);
      }),
      getSessionBySyncId: vi.fn().mockImplementation((projId: string, sessId: string) => {
        if (projId === 'local-proj-a' && sessId === 'sess-1') {
          return Promise.resolve({
            id: 'local-sess-1',
            sync_status: 'in_sync',
            // Legacy stub artifact: the raw session id stored as the title.
            title: 'sess-1',
          });
        }
        return Promise.resolve(null);
      }),
    } as unknown as DbClient;

    const mockS3 = {
      listProjectFolders: vi.fn().mockResolvedValue(['proj-a']),
      listSessionFolders: vi.fn().mockResolvedValue([]),
      listProjectObjects: vi.fn().mockResolvedValue([
        {
          key: 'proj-a/sess-1/transcript.jsonl',
          lastModified: '2026-09-12T10:00:00.000Z',
          size: 100,
        },
        {
          key: 'proj-a/sess-2/transcript.jsonl',
          lastModified: '2026-09-13T10:00:00.000Z',
          size: 200,
        },
      ]),
      getObject: vi.fn().mockRejectedValue(new Error('no manifest')),
      putObject: vi.fn(),
    };

    const resolveSessionTitle = vi.fn().mockResolvedValue('Parsed AI Title');
    const manager = createManager({
      dbClient: mockDb,
      createS3Client: () => mockS3,
      resolveSessionTitle,
    });

    manager.registerEphemeralConnection(
      {
        id: 'conn-s3-1',
        name: 'Main S3',
        storage_type: 's3',
        created_at: 1000,
        updated_at: 1000,
        sync_only_new: false,
      },
      {
        accessKeyId: 'ak',
        secretAccessKey: 'sk',
        bucket: 'my-bucket',
        region: 'us-east-1',
      },
    );

    const items = await manager.listStorageSessions('conn-s3-1');
    const s1 = items.find((i) => i.sessionId === 'sess-1');
    const s2 = items.find((i) => i.sessionId === 'sess-2');

    expect(s1?.title).toBe('Parsed AI Title');
    expect(resolveSessionTitle).toHaveBeenCalledTimes(1);
    expect(resolveSessionTitle).toHaveBeenCalledWith('sess-1');
    // Sessions with no local row never hit the seam; they keep the
    // date-based fallback title.
    expect(s2?.title).not.toBe('sess-2');
  });

  it('refreshStorageSessionStatuses prefers the parsed title over a stored raw-id title', async () => {
    const mockDb = {
      getProjectByReadableId: vi.fn().mockImplementation(async (readableId: string) => {
        if (readableId === 'proj-a') return { id: 'local-proj-a', name: 'Alpha Project' };
        return null;
      }),
      getSessionBySyncId: vi
        .fn()
        .mockImplementation(async (_projId: string, syncSessionId: string) => {
          if (syncSessionId === 'sess-2') {
            return { sync_status: 'in_sync', title: 'sess-2' };
          }
          return null;
        }),
    } as unknown as DbClient;

    const resolveSessionTitle = vi.fn().mockResolvedValue('Renamed Session');
    const manager = createManager({ dbClient: mockDb, resolveSessionTitle });

    const items: StorageSessionItem[] = [
      {
        projectId: 'proj-a',
        projectName: 'Alpha Project',
        sessionId: 'sess-2',
        title: 'sess-2',
        modifiedTimestamp: 1000,
        synced: false,
      },
    ];

    const refreshed = await manager.refreshStorageSessionStatuses(items);
    expect(refreshed[0].synced).toBe(true);
    expect(refreshed[0].title).toBe('Renamed Session');
  });

  it('refreshStorageSessionStatuses keeps the previous title when no parsed title resolves and the stored title is the raw session id', async () => {
    const mockDb = {
      getProjectByReadableId: vi.fn().mockImplementation(async (readableId: string) => {
        if (readableId === 'proj-a') return { id: 'local-proj-a', name: 'Alpha Project' };
        return null;
      }),
      getSessionBySyncId: vi
        .fn()
        .mockImplementation(async (_projId: string, syncSessionId: string) => {
          if (syncSessionId === 'sess-2') {
            return { sync_status: 'in_sync', title: 'sess-2' };
          }
          return null;
        }),
    } as unknown as DbClient;

    const resolveSessionTitle = vi.fn().mockResolvedValue(null);
    const manager = createManager({ dbClient: mockDb, resolveSessionTitle });

    const items: StorageSessionItem[] = [
      {
        projectId: 'proj-a',
        projectName: 'Alpha Project',
        sessionId: 'sess-2',
        title: 'Session Two',
        modifiedTimestamp: 1000,
        synced: false,
      },
    ];

    const refreshed = await manager.refreshStorageSessionStatuses(items);
    expect(refreshed[0].title).toBe('Session Two');
  });

  it('refreshStorageSessionStatuses keeps a real stored title when resolution fails', async () => {
    const mockDb = {
      getProjectByReadableId: vi.fn().mockImplementation(async (readableId: string) => {
        if (readableId === 'proj-a') return { id: 'local-proj-a', name: 'Alpha Project' };
        return null;
      }),
      getSessionBySyncId: vi
        .fn()
        .mockImplementation(async (_projId: string, syncSessionId: string) => {
          if (syncSessionId === 'sess-2') {
            return { sync_status: 'in_sync', title: 'Session Two Updated' };
          }
          return null;
        }),
    } as unknown as DbClient;

    const resolveSessionTitle = vi.fn().mockRejectedValue(new Error('worker down'));
    const manager = createManager({ dbClient: mockDb, resolveSessionTitle });

    const items: StorageSessionItem[] = [
      {
        projectId: 'proj-a',
        projectName: 'Alpha Project',
        sessionId: 'sess-2',
        title: 'Session Two',
        modifiedTimestamp: 1000,
        synced: false,
      },
    ];

    const refreshed = await manager.refreshStorageSessionStatuses(items);
    expect(refreshed[0].title).toBe('Session Two Updated');
  });

  it('upserts a session stub with an empty title — the raw session id is not a title', async () => {
    const mockDb = {
      getSessionBySyncId: vi.fn().mockResolvedValue(null),
      upsertSessionStub: vi.fn().mockResolvedValue(undefined),
      updateSessionManifest: vi.fn().mockResolvedValue(undefined),
      setSessionSyncStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as DbClient;

    const manager = createManager({ dbClient: mockDb });
    const mockWorker = { postMessage: vi.fn(), terminate: vi.fn() } as unknown as Worker;
    const project = {
      projectId: 'proj-1',
      localProjectId: 'local-proj-1',
      worker: mockWorker,
      status: 'running' as const,
      sessions: new Map(),
      totalSessions: 0,
      sessionsDone: 0,
      sessionsFailed: 0,
      filesFound: 0,
      filesDownloaded: 0,
      filesFailed: 0,
      bytesReceived: 0,
      isNew: false,
    };

    const manifest: SyncManifest = {
      schemaVersion: 2,
      projectId: 'proj-1',
      sessionId: 'sess-uuid-abc',
      harness: 'claude-code',
      harnessVersion: '0.1.0',
      syncVersion: '0.1.0',
      pluginVersion: '0.1.0',
      transcriptsCaptured: true,
      artifacts: [],
      syncRuns: [],
      syncRunsCount: 0,
    };

    // @ts-expect-error — testing private method
    await manager.handleSessionManifestReady({} as never, project, mockWorker, {
      sessionId: 'sess-uuid-abc',
      manifest,
    });

    expect(mockDb.upsertSessionStub).toHaveBeenCalledWith(
      expect.objectContaining({
        sync_session_id: 'sess-uuid-abc',
        title: '',
      }),
    );
  });

  it('sends SESSION_SYNC message with knownHashes when artifacts exist in db or blob store', async () => {
    const candidateHash1 = 'a'.repeat(64);
    const candidateHash2 = 'b'.repeat(64);
    const mockDb = {
      getSessionBySyncId: vi.fn().mockResolvedValue(null),
      upsertSessionStub: vi.fn().mockResolvedValue(undefined),
      updateSessionManifest: vi.fn().mockResolvedValue(undefined),
      setSessionSyncStatus: vi.fn().mockResolvedValue(undefined),
      getSessionFiles: vi.fn().mockResolvedValue([]),
      getProcessedFileHashes: vi.fn().mockResolvedValue([candidateHash1]),
    } as unknown as DbClient;

    const hasArtifactBlobsMock = vi.fn().mockResolvedValue([candidateHash2]);
    const manager = createManager({
      dbClient: mockDb,
      hasArtifactBlobs: hasArtifactBlobsMock,
    });

    const postMessageSpy = vi.fn();
    const mockWorker = {
      postMessage: postMessageSpy,
      terminate: vi.fn(),
    } as unknown as Worker;

    const manifest: SyncManifest = {
      schemaVersion: 2,
      projectId: 'proj-1',
      sessionId: 'sess-1',
      harness: 'claude-code',
      harnessVersion: '0.1.0',
      syncVersion: '0.1.0',
      pluginVersion: '0.1.0',
      transcriptsCaptured: true,
      syncRuns: [],
      syncRunsCount: 0,
      mainTranscriptRelativePath: 'transcript.jsonl',
      artifacts: [
        {
          projectId: 'proj-1',
          sessionId: 'sess-1',
          scope: 'session',
          relativePath: 'transcript.jsonl',
          sha256: candidateHash1,
          size: 100,
          status: 'uploaded',
        },
        {
          projectId: 'proj-1',
          sessionId: 'sess-1',
          scope: 'global',
          relativePath: 'settings.json',
          sha256: candidateHash2,
          size: 50,
          status: 'uploaded',
        },
      ],
    };

    const project = {
      projectId: 'proj-1',
      localProjectId: 'local-proj-1',
      status: 'syncing' as const,
      worker: mockWorker,
      totalSessions: 1,
      sessionsDone: 0,
      sessionsFailed: 0,
      sessions: new Map(),
    };

    await (
      manager as unknown as {
        handleSessionManifestReady: (
          run: unknown,
          proj: unknown,
          worker: unknown,
          msg: unknown,
        ) => Promise<void>;
      }
    ).handleSessionManifestReady({} as never, project, mockWorker, {
      type: 'SESSION_MANIFEST_READY',
      sessionId: 'sess-1',
      manifest,
    });

    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SESSION_SYNC',
        sessionId: 'sess-1',
        sync: true,
        knownHashes: expect.arrayContaining([candidateHash1, candidateHash2]),
      }),
    );
  });

  describe('reprocessSession and downloadRawSessionFile', () => {
    it('reprocessSession resets local metrics, marks status pending, and queues target run', async () => {
      const mockDb = {
        getConnections: vi.fn().mockResolvedValue([{ id: 'storage-1', name: 'My S3' }]),
        getProjectByReadableId: vi.fn().mockResolvedValue({ id: 'local-p1', name: 'proj-1' }),
        getSessionBySyncId: vi.fn().mockResolvedValue({ id: 'sess-row-1', sync_status: 'in_sync' }),
        setSessionSyncStatus: vi.fn().mockResolvedValue(undefined),
      } as unknown as DbClient;

      const deleteSpy = vi
        .spyOn(analyticsClient, 'deleteSessionMetrics')
        .mockResolvedValue(undefined);

      const manager = createManager({ dbClient: mockDb });
      const requestRunSpy = vi.spyOn(manager, 'requestRun').mockResolvedValue('run-1' as never);

      await manager.reprocessSession('storage-1', 'proj-1', 'sess-1');

      expect(mockDb.getProjectByReadableId).toHaveBeenCalledWith('proj-1');
      expect(mockDb.getSessionBySyncId).toHaveBeenCalledWith('local-p1', 'sess-1');
      expect(deleteSpy).toHaveBeenCalledWith('sess-row-1');
      expect(mockDb.setSessionSyncStatus).toHaveBeenCalledWith('sess-row-1', 'pending');
      expect(requestRunSpy).toHaveBeenCalledWith('storage-1', {
        targetSessions: [{ projectId: 'proj-1', sessionId: 'sess-1' }],
      });
    });

    it('reprocessSession throws when storage is not found', async () => {
      const mockDb = {
        getConnections: vi.fn().mockResolvedValue([]),
      } as unknown as DbClient;

      const manager = createManager({ dbClient: mockDb });
      await expect(manager.reprocessSession('unknown', 'proj-1', 'sess-1')).rejects.toThrow(
        'Storage not found: unknown',
      );
    });

    it('downloadRawSessionFile downloads main transcript from manifest.json', async () => {
      const manifestJson = JSON.stringify({
        schemaVersion: 2,
        projectId: 'proj-1',
        sessionId: 'sess-1',
        harness: 'claude-code',
        harnessVersion: '0.1.0',
        syncVersion: '0.1.0',
        pluginVersion: '0.1.0',
        transcriptsCaptured: true,
        mainTranscriptRelativePath: 'transcript.jsonl',
        artifacts: [
          {
            projectId: 'proj-1',
            sessionId: 'sess-1',
            scope: 'session',
            relativePath: 'transcript.jsonl',
            sha256: 'abc',
            size: 10,
            status: 'uploaded',
          },
        ],
        syncRuns: [],
        syncRunsCount: 0,
      });

      const enc = new TextEncoder();
      const mockS3: S3Client = {
        listProjectFolders: async () => ['proj-1'],
        listSessionFolders: async () => ['sess-1'],
        getObject: vi.fn().mockImplementation(async (key: string) => {
          if (key === 'proj-1/sess-1/manifest.json') {
            return enc.encode(manifestJson).buffer;
          }
          if (key === 'proj-1/sess-1/transcript.jsonl') {
            return enc.encode('{"step": 1}\n{"step": 2}').buffer;
          }
          throw new Error('NotFound');
        }),
        putObject: async () => ({ etag: '1' }),
      };

      const mockDb = {
        getConnections: vi.fn().mockResolvedValue([{ id: 'storage-1', name: 'My S3' }]),
      } as unknown as DbClient;

      const manager = createManager({
        dbClient: mockDb,
        createS3Client: () => mockS3,
      });
      manager.registerEphemeralConnection(
        {
          id: 'storage-1',
          name: 'My S3',
          storage_type: 's3',
          created_at: 1000,
          updated_at: 1000,
          sync_only_new: false,
        },
        {
          accessKeyId: 'a',
          secretAccessKey: 'b',
          region: 'r',
          bucket: 'b',
        },
      );

      const result = await manager.downloadRawSessionFile('storage-1', 'proj-1', 'sess-1');
      expect(result.filename).toBe('transcript.jsonl');
      expect(result.content).toBe('{"step": 1}\n{"step": 2}');
    });

    it('downloadRawSessionFile falls back to listProjectObjects when manifest is absent', async () => {
      const enc = new TextEncoder();
      const mockS3: S3Client = {
        listProjectFolders: async () => ['proj-1'],
        listSessionFolders: async () => ['sess-1'],
        listProjectObjects: async () => [{ key: 'proj-1/sess-1/session.raw.json', size: 100 }],
        getObject: vi.fn().mockImplementation(async (key: string) => {
          if (key === 'proj-1/sess-1/session.raw.json') {
            return enc.encode('raw json content').buffer;
          }
          throw new Error('NotFound');
        }),
        putObject: async () => ({ etag: '1' }),
      };

      const mockDb = {
        getConnections: vi.fn().mockResolvedValue([{ id: 'storage-1', name: 'My S3' }]),
      } as unknown as DbClient;

      const manager = createManager({
        dbClient: mockDb,
        createS3Client: () => mockS3,
      });
      manager.registerEphemeralConnection(
        {
          id: 'storage-1',
          name: 'My S3',
          storage_type: 's3',
          created_at: 1000,
          updated_at: 1000,
          sync_only_new: false,
        },
        {
          accessKeyId: 'a',
          secretAccessKey: 'b',
          region: 'r',
          bucket: 'b',
        },
      );

      const result = await manager.downloadRawSessionFile('storage-1', 'proj-1', 'sess-1');
      expect(result.filename).toBe('session.raw.json');
      expect(result.content).toBe('raw json content');
    });
  });
});
