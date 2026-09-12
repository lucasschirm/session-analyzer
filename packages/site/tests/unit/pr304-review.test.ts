import { expect, it, vi } from 'vitest';
import { SyncManager, type SyncManagerOptions } from '../../src/sync/sync-manager';

it('review: reconciliation failure is converted into session success', async () => {
  const onSyncComplete = vi.fn().mockResolvedValue(undefined);
  const status = vi.fn().mockResolvedValue(undefined);
  const worker = { postMessage: vi.fn(), terminate: vi.fn() };
  const manager = new SyncManager({
    createWorker: () => worker,
    createS3Client: () => ({}),
    createBroadcastChannel: () => ({ onmessage: null, postMessage: vi.fn(), close: vi.fn() }),
    dbClient: {
      getSessionFiles: vi.fn().mockResolvedValue([]),
      upsertSessionFile: vi.fn().mockRejectedValue(new Error('write failed')),
      bulkUpsertSessionFiles: vi.fn().mockResolvedValue(undefined),
      setSessionSyncStatus: status,
    },
    onSyncComplete,
  } as unknown as SyncManagerOptions);
  const project = {
    projectId: 'p',
    localProjectId: 'local-p',
    worker,
    status: 'running',
    sessions: new Map(),
    totalSessions: 1,
    sessionsDone: 0,
    sessionsFailed: 0,
    filesFound: 1,
    filesDownloaded: 1,
    filesFailed: 0,
    bytesReceived: 1,
    isNew: false,
  };
  const session = Reflect.get(manager, 'getOrCreateSessionState').call(
    manager,
    project,
    's',
    'local-s',
  );
  session.syncStatus = 'processing';
  vi.spyOn(
    manager as unknown as Record<string, (...args: unknown[]) => unknown>,
    'reconcileCompleteFile',
  ).mockImplementation(() => {
    throw new Error('reconcile failed');
  });
  await Reflect.get(manager, 'handleSessionSyncComplete').call(manager, project, {
    type: 'SESSION_SYNC_COMPLETE',
    sessionId: 's',
    files: [{ file: 'transcript.jsonl', hash: 'a'.repeat(64), size: 1, status: 'downloaded' }],
  });
  expect(onSyncComplete).toHaveBeenCalled();
  expect(session.syncStatus).toBe('in_sync');
  expect(project.sessionsFailed).toBe(0);
});
