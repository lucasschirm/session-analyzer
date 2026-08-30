import type { SyncManifest } from '@lucasschirm/sal-sync-core';
import { describe, expect, it } from 'vitest';
import type {
  FileToDownload,
  SessionFileDownloadedMessage,
  SyncMessageFromWorker,
  SyncMessageToWorker,
} from '../../src/sync/sync-protocol';

const encoder = new TextEncoder();

describe('sync-protocol', () => {
  it('supports every main→worker message type', () => {
    const start: SyncMessageToWorker = {
      type: 'START',
      projectId: 'proj',
      credentials: { accessKeyId: 'a', secretAccessKey: 's' },
      bucket: 'bucket',
      region: 'us-east-1',
      syncOnlyNew: false,
    };
    const cont: SyncMessageToWorker = {
      type: 'SESSION_SYNC_CONTINUE',
      sessionId: 'sess',
      sync: true,
    };
    const sync: SyncMessageToWorker = {
      type: 'SESSION_SYNC',
      sessionId: 'sess',
      sync: true,
      exists: false,
      filesToDownload: [],
    };
    const cancel: SyncMessageToWorker = { type: 'CANCEL' };

    expect(start.type).toBe('START');
    expect(cont.type).toBe('SESSION_SYNC_CONTINUE');
    expect(sync.type).toBe('SESSION_SYNC');
    expect(cancel.type).toBe('CANCEL');
    expect((sync as { filesToDownload?: FileToDownload[] }).filesToDownload).toEqual([]);
  });

  it('supports every worker→main message type with the required fields', () => {
    const connected: SyncMessageFromWorker = { type: 'CONNECTED', projectId: 'proj' };
    const batch: SyncMessageFromWorker = {
      type: 'SESSION_BATCH_FOUND',
      projectId: 'proj',
      sessionIds: ['s1'],
      final: true,
    };
    const folder: SyncMessageFromWorker = {
      type: 'PROJECT_FOLDER_FOUND',
      projectId: 'proj',
      totalSessions: 1,
    };
    const found: SyncMessageFromWorker = {
      type: 'SESSION_FOUND',
      projectId: 'proj',
      sessionId: 's1',
    };
    const manifest: SyncMessageFromWorker = {
      type: 'SESSION_MANIFEST_READY',
      projectId: 'proj',
      sessionId: 's1',
      manifest: { schemaVersion: 2 } as unknown as SyncManifest,
    };
    const progress: SyncMessageFromWorker = {
      type: 'SESSION_SYNC_PROGRESS',
      projectId: 'proj',
      sessionId: 's1',
      files_found: 1,
      files_downloaded: 0,
      files_failed: 0,
      bytes_received: 0,
      timestamp: new Date().toISOString(),
    };
    const complete: SyncMessageFromWorker = {
      type: 'SESSION_SYNC_COMPLETE',
      projectId: 'proj',
      sessionId: 's1',
      files: [],
    };
    const failed: SyncMessageFromWorker = {
      type: 'SESSION_SYNC_FAILED',
      projectId: 'proj',
      sessionId: 's1',
      error: { code: 'X', message: 'x' },
    };
    const done: SyncMessageFromWorker = {
      type: 'WORKER_DONE',
      projectId: 'proj',
      synced: 0,
      failed: 0,
      skipped: 0,
    };
    const error: SyncMessageFromWorker = {
      type: 'WORKER_ERROR',
      projectId: 'proj',
      error: { code: 'Y', message: 'y' },
    };

    const messages = [
      connected,
      batch,
      folder,
      found,
      manifest,
      progress,
      complete,
      failed,
      done,
      error,
    ];
    const types = messages.map((message) => message.type);
    expect(new Set(types).size).toBe(10);
  });

  it('uses an ArrayBuffer payload for SESSION_FILE_DOWNLOADED', () => {
    const buffer = encoder.encode('transcript').buffer;
    const message: SessionFileDownloadedMessage = {
      type: 'SESSION_FILE_DOWNLOADED',
      projectId: 'proj',
      sessionId: 's1',
      file: 'transcript.jsonl',
      hash: 'abc',
      content: buffer,
    };

    expect(message.content).toBeInstanceOf(ArrayBuffer);
    expect(message.content).toBe(buffer);
  });
});
