import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DbClient } from '../../src/db/db-client';
import type { DbRequest, DbResponse } from '../../src/db/db-protocol';
import type {
  Connection,
  PasskeyState,
  SessionFileRecord,
  SessionStub,
  StoredS3Credentials,
  SyncManifest,
} from '../../src/types';

/** Minimal Worker double that records posted messages and lets tests reply. */
class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: DbRequest[] = [];

  postMessage(request: DbRequest): void {
    this.posted.push(request);
  }

  respond(response: DbResponse): void {
    this.onmessage?.({ data: response } as MessageEvent);
  }

  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

describe('DbClient', () => {
  let worker: FakeWorker;
  let client: DbClient;

  beforeEach(() => {
    worker = new FakeWorker();
    client = new DbClient(() => worker as unknown as Worker);
  });

  it('initializes once and reports the storage backend', async () => {
    const ready = client.ensureReady();
    expect(worker.posted.length).toBe(1);
    expect(worker.posted[0].type).toBe('init');

    worker.respond({ id: worker.posted[0].id, ok: true, storage: 'opfs' });
    await expect(ready).resolves.toBe('opfs');

    // Second call reuses the first initialization.
    await expect(client.ensureReady()).resolves.toBe('opfs');
    expect(worker.posted.length).toBe(1);
  });

  it('correlates concurrent requests by id', async () => {
    void client.ensureReady();
    worker.respond({ id: 1, ok: true, storage: 'memory' });

    const projectsPromise = client.getProjects();
    const projectPromise = client.getProject('p1');

    worker.respond({ id: 3, ok: true, result: { id: 'p1', name: 'One' } });
    worker.respond({ id: 2, ok: true, result: [{ id: 'p1' }] });

    await expect(projectsPromise).resolves.toEqual([{ id: 'p1' }]);
    await expect(projectPromise).resolves.toEqual({ id: 'p1', name: 'One' });
    expect(worker.posted.map((request) => request.type)).toEqual([
      'init',
      'getProjects',
      'getProject',
    ]);
  });

  it('rejects when the worker reports an error response', async () => {
    void client.ensureReady();
    worker.respond({ id: 1, ok: true, storage: 'memory' });

    const promise = client.getProjects();
    worker.respond({ id: worker.posted[1].id, ok: false, error: 'boom' });

    await expect(promise).rejects.toThrow('boom');
  });

  it('rejects all pending calls on worker failure', async () => {
    const ready = client.ensureReady();
    const projects = client.getProjects();

    worker.fail('worker crashed');

    await expect(ready).rejects.toThrow('worker crashed');
    await expect(projects).rejects.toThrow('worker crashed');
  });

  it('lazily initializes on the first ordinary call', async () => {
    const promise = client.getProjects();
    expect(worker.posted[0].type).toBe('init');
    worker.respond({ id: 1, ok: true, storage: 'memory' });
    worker.respond({ id: 2, ok: true, result: [] });

    await expect(promise).resolves.toEqual([]);
  });

  it('resolves exportDatabase with the transferred bytes', async () => {
    void client.ensureReady();
    worker.respond({ id: 1, ok: true, storage: 'memory' });

    const bytes = new Uint8Array([1, 2, 3]);
    const promise = client.exportDatabase();
    worker.respond({ id: worker.posted[1].id, ok: true, bytes });

    await expect(promise).resolves.toBe(bytes);
  });

  it('posts the full payloads for write operations', async () => {
    void client.ensureReady();
    worker.respond({ id: 1, ok: true, storage: 'memory' });

    const project = {
      id: 'p1',
      name: 'N',
      description: 'D',
      created_at: 1,
      updated_at: 1,
      session_count: 0,
    };
    void client.createProject(project);
    void client.updateProject('p1', { name: 'N2' });
    void client.deleteProject('p1');
    void client.searchSessions('p1', 'query');
    void client.deleteSession('s1');

    expect(worker.posted[1]).toMatchObject({ type: 'createProject', project });
    expect(worker.posted[2]).toMatchObject({
      type: 'updateProject',
      projectId: 'p1',
      fields: { name: 'N2' },
    });
    expect(worker.posted[3]).toMatchObject({ type: 'deleteProject', projectId: 'p1' });
    expect(worker.posted[4]).toMatchObject({
      type: 'searchSessions',
      projectId: 'p1',
      query: 'query',
    });
    expect(worker.posted[5]).toMatchObject({ type: 'deleteSession', sessionId: 's1' });
  });

  it('exports and triggers a download', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
    const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    void client.ensureReady();
    worker.respond({ id: 1, ok: true, storage: 'memory' });

    const promise = client.exportAndDownload();
    worker.respond({
      id: worker.posted[1].id,
      ok: true,
      bytes: new Uint8Array([83, 81, 76, 105, 116, 101]),
    });
    await promise;

    expect(clickSpy).toHaveBeenCalled();
    expect(createObjectURLSpy).toHaveBeenCalled();
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:mock-url');

    clickSpy.mockRestore();
    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
  });

  it('stores the fallback reason reported by init', async () => {
    const ready = client.ensureReady();
    worker.respond({ id: 1, ok: true, storage: 'memory', fallbackReason: 'locked' });
    await expect(ready).resolves.toBe('memory');
    expect(client.fallbackReason).toBe('locked');
  });

  it('posts sync, connection, passkey and session-file payloads', () => {
    void client.ensureReady();
    worker.respond({ id: 1, ok: true, storage: 'memory' });

    const connection: Connection = {
      id: 'c1',
      name: 'S3 Dev',
      storage_type: 's3',
      sync_only_new: true,
      created_at: 1,
      updated_at: 2,
    };
    const credentials: StoredS3Credentials = {
      connection_id: 'c1',
      region: 'us-east-1',
      bucket: 'dev',
      access_key_id: 'AKIA...',
      secret_access_key_ct: 'ct',
      secret_access_key_iv: 'iv',
      created_at: 1,
      updated_at: 2,
    };
    const passkey: PasskeyState = {
      id: 1,
      kdf_salt: 'salt',
      verifier_iv: 'iv',
      verifier_ct: 'ct',
      created_at: 1,
    };
    const stub: SessionStub = {
      id: 'stub',
      project_id: 'p1',
      source: 'sync',
      title: 'Stub',
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: '2026-01-01T00:00:00.000Z',
      sync_session_id: 'remote-1',
      sync_status: 'pending',
    };
    const manifest: SyncManifest = {
      sessionId: 'remote-1',
      schemaVersion: 1,
      artifacts: [{ path: 't.json' }],
      syncRuns: [{ id: 'run-1' }],
    };
    const file: SessionFileRecord = {
      id: 'f1',
      project_id: 'p1',
      session_id: 's1',
      path: 't.json',
      scope: 'session',
      sha256: 'deadbeef',
      size: 42,
      status: 'downloaded',
      updated_at: 1,
    };

    void client.createConnection(connection);
    void client.updateConnection('c1', { name: 'S3 Prod' });
    void client.deleteConnection('c1');
    void client.getConnections();
    void client.saveS3Credentials(credentials);
    void client.getS3Credentials('c1');
    void client.deleteAllCredentials();
    void client.getPasskeyState();
    void client.savePasskeyState(passkey);
    void client.getProjectByReadableId('my-project');
    void client.setProjectSyncStatus('p1', 'syncing');
    void client.backfillReadableIds();
    void client.getSessionBySyncId('p1', 'remote-1');
    void client.upsertSessionStub(stub);
    void client.setSessionSyncStatus('stub', 'in_sync', 'ok');
    void client.updateSessionManifest('stub', manifest);
    void client.getSyncRunCount('stub');
    void client.failStaleSessions('p1', 'worker lost');
    void client.reconcileSyncStates('restarted');
    void client.getSessionFiles('s1');
    void client.upsertSessionFile(file);

    const types = worker.posted.slice(1).map((request) => request.type);
    expect(types).toEqual([
      'createConnection',
      'updateConnection',
      'deleteConnection',
      'getConnections',
      'saveS3Credentials',
      'getS3Credentials',
      'deleteAllCredentials',
      'getPasskeyState',
      'savePasskeyState',
      'getProjectByReadableId',
      'setProjectSyncStatus',
      'backfillReadableIds',
      'getSessionBySyncId',
      'upsertSessionStub',
      'setSessionSyncStatus',
      'updateSessionManifest',
      'getSyncRunCount',
      'failStaleSessions',
      'reconcileSyncStates',
      'getSessionFiles',
      'upsertSessionFile',
    ]);

    const createRequest = worker.posted[1] as DbRequest & { type: 'createConnection' };
    expect(createRequest.connection).toEqual(connection);

    const fileRequest = worker.posted[worker.posted.length - 1] as DbRequest & {
      type: 'upsertSessionFile';
    };
    expect(fileRequest.file).toEqual(file);
  });
});
