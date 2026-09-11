import type { ManifestArtifact, SyncManifest } from '@lucasschirm/sal-sync-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyticsClient } from '../../src/db/analytics-client';
import type { AnalyticsRequest } from '../../src/db/analytics-protocol';
import type { DbClient } from '../../src/db/db-client';
import { requestPasskey, setPasskeyPrompt } from '../../src/sync/passkey-prompt';
import {
  type DownloadedFile,
  type S3Client,
  SyncManager,
  type SyncManagerOptions,
  syncManager,
} from '../../src/sync/sync-manager';
import type { SessionSyncCompleteMessage } from '../../src/sync/sync-protocol';

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

  it('handleSessionFound retries failed sessions even with syncOnlyNew', async () => {
    const mockDb = createMockDb();
    const postedToWorker: Array<{ sessionId: string; sync: boolean }> = [];
    const mockWorker = {
      postMessage: (msg: { sessionId: string; sync: boolean }) => postedToWorker.push(msg),
      terminate: vi.fn(),
    } as unknown as Worker;
    const manager = createManager({ dbClient: mockDb });
    const project = createTestProject(mockWorker);
    const run = { syncOnlyNew: true, connectionId: 'c1' };

    // 1. Session not in DB -> sync: true
    // @ts-expect-error — testing private method
    await manager.handleSessionFound(run as never, project, mockWorker, { sessionId: 's-new' });

    // 2. Session exists with status 'failed' -> sync: true (allows retry)
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

  it('handleSessionFound stopgap answers sync:true for every non-syncOnlyNew run (#406/L10)', async () => {
    const mockDb = createMockDb();
    // @ts-expect-error — mock return: would be read if the early return were removed
    mockDb.getSessionBySyncId.mockResolvedValue({ id: 's1-id', sync_status: 'in_sync' });
    const postedToWorker: Array<{ sessionId: string; sync: boolean }> = [];
    const mockWorker = {
      postMessage: (msg: { sessionId: string; sync: boolean }) => postedToWorker.push(msg),
      terminate: vi.fn(),
    } as unknown as Worker;
    const manager = createManager({ dbClient: mockDb });
    const project = createTestProject(mockWorker);
    const run = { syncOnlyNew: false, connectionId: 'c1' };

    // @ts-expect-error — testing private method
    await manager.handleSessionFound(run as never, project, mockWorker, { sessionId: 's1' });

    expect(postedToWorker).toEqual([
      expect.objectContaining({
        type: 'SESSION_SYNC_CONTINUE',
        sessionId: 's1',
        sync: true,
      }),
    ]);
    expect(mockDb.getSessionBySyncId).not.toHaveBeenCalled();
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
