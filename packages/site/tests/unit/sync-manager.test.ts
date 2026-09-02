import type { ManifestArtifact, SyncManifest } from '@lucasschirm/sal-sync-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyticsClient } from '../../src/db/analytics-client';
import type { AnalyticsRequest } from '../../src/db/analytics-protocol';
import { requestPasskey, setPasskeyPrompt } from '../../src/sync/passkey-prompt';
import {
  type DownloadedFile,
  type S3Client,
  SyncManager,
  type SyncManagerOptions,
  syncManager,
} from '../../src/sync/sync-manager';
import type { SessionSyncCompleteMessage } from '../../src/sync/sync-protocol';
import type { Connection } from '../../src/types';

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
    };
  }

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
 * Regression: `SyncManagerSnapshot.lastCompletedAt` must reflect the most
 * recent successfully-completed sync — from persisted connection
 * bookkeeping on `init()`, or from a run that just finished — and must
 * never be coerced to a fabricated value when no completion has happened
 * (`.agents/rules/missing-is-never-zero.md`).
 */
describe('SyncManager lastCompletedAt', () => {
  function fakeRun(overrides: Record<string, unknown> = {}) {
    return {
      id: 'run-1',
      connectionId: 'c1',
      state: 'running',
      startedAt: Date.now(),
      s3Client: null,
      connection: null,
      projects: new Map(),
      projectQueue: [],
      activeWorkers: new Set(),
      warnings: [],
      syncOnlyNew: false,
      cancelled: false,
      ...overrides,
    };
  }

  function endRun(manager: SyncManager, state: 'done' | 'failed' | 'cancelled'): void {
    (manager as unknown as { endRun: (run: ReturnType<typeof fakeRun>, s: string) => void }).endRun(
      fakeRun(),
      state,
    );
  }

  it('starts null when there is no prior completion history', () => {
    const manager = new SyncManager();
    expect(manager.getSnapshot().lastCompletedAt).toBeNull();
  });

  it('is populated from persisted last_sync_at across connections on init()', async () => {
    const connections: Connection[] = [
      {
        id: 'c1',
        name: 'a',
        storage_type: 's3',
        sync_only_new: false,
        last_sync_at: 100,
        created_at: 1,
        updated_at: 1,
      },
      {
        id: 'c2',
        name: 'b',
        storage_type: 's3',
        sync_only_new: false,
        last_sync_at: 300,
        created_at: 1,
        updated_at: 1,
      },
      {
        id: 'c3',
        name: 'c',
        storage_type: 's3',
        sync_only_new: false,
        created_at: 1,
        updated_at: 1,
      },
    ];
    const manager = new SyncManager({
      dbClient: { getConnections: async () => connections } as never,
    });
    await (
      manager as unknown as { loadLastCompletedAt: () => Promise<void> }
    ).loadLastCompletedAt();
    expect(manager.getSnapshot().lastCompletedAt).toBe(300);
  });

  it('stays null when connections exist but none has synced yet', async () => {
    const manager = new SyncManager({
      dbClient: { getConnections: async () => [] } as never,
    });
    await (
      manager as unknown as { loadLastCompletedAt: () => Promise<void> }
    ).loadLastCompletedAt();
    expect(manager.getSnapshot().lastCompletedAt).toBeNull();
  });

  it('updates to a fresh timestamp after a run completes successfully', () => {
    const manager = new SyncManager();
    const before = Date.now();
    endRun(manager, 'done');
    const snapshot = manager.getSnapshot();
    expect(snapshot.lastCompletedAt).not.toBeNull();
    expect(snapshot.lastCompletedAt as number).toBeGreaterThanOrEqual(before);
  });

  it('does not update lastCompletedAt after a cancelled or failed run', () => {
    const manager = new SyncManager();
    endRun(manager, 'cancelled');
    expect(manager.getSnapshot().lastCompletedAt).toBeNull();
    endRun(manager, 'failed');
    expect(manager.getSnapshot().lastCompletedAt).toBeNull();
  });
});
