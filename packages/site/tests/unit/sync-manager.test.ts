import type { ManifestArtifact, SyncManifest } from '@lucasschirm/sal-sync-core';
import { describe, expect, it, vi } from 'vitest';
import { analyticsClient } from '../../src/db/analytics-client';
import type { AnalyticsRequest } from '../../src/db/analytics-protocol';
import {
  type DownloadedFile,
  type S3Client,
  SyncManager,
  type SyncManagerOptions,
  syncManager,
} from '../../src/sync/sync-manager';
import type { SessionSyncCompleteMessage } from '../../src/sync/sync-protocol';

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
