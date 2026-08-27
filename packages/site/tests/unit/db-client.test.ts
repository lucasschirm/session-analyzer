import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceCheckpoint } from '../../src/db/database';
import { DbClient } from '../../src/db/db-client';
import type { DbRequest, DbResponse } from '../../src/db/db-protocol';
import type {
  Connection,
  Project,
  SessionFileRecord,
  SessionStub,
  StoredS3Credentials,
} from '../../src/types';

/** Minimal Worker double that records posted messages and lets tests reply. */
class FakeWorker {
  onmessage: ((event: MessageEvent<DbResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: DbRequest[] = [];

  postMessage(request: DbRequest): void {
    this.posted.push(request);
  }

  respond(response: DbResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<DbResponse>);
  }

  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

function sampleProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Project One',
    description: 'desc',
    created_at: 1,
    updated_at: 2,
    session_count: 0,
    ...overrides,
  };
}

function sampleConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'c1',
    name: 'Conn One',
    storage_type: 's3',
    sync_only_new: false,
    created_at: 1,
    updated_at: 2,
    ...overrides,
  };
}

describe('DbClient', () => {
  let worker: FakeWorker;
  let client: DbClient;

  beforeEach(() => {
    worker = new FakeWorker();
    client = new DbClient(() => worker as unknown as Worker);
  });

  // ---------------- ensureReady ----------------

  it('ensureReady sends init and resolves with the storage backend', async () => {
    const ready = client.ensureReady();
    expect(worker.posted.length).toBe(1);
    expect(worker.posted[0].type).toBe('init');

    worker.respond({ id: worker.posted[0].id, ok: true, storage: 'opfs' });
    await expect(ready).resolves.toBe('opfs');
  });

  it('ensureReady only initializes once', async () => {
    const ready = client.ensureReady();
    worker.respond({ id: worker.posted[0].id, ok: true, storage: 'opfs' });
    await expect(ready).resolves.toBe('opfs');

    // Second call reuses the cached init promise; no new init posted.
    await expect(client.ensureReady()).resolves.toBe('opfs');
    expect(worker.posted.length).toBe(1);
  });

  it('ensureReady defaults to memory when storage is omitted', async () => {
    const ready = client.ensureReady();
    worker.respond({ id: worker.posted[0].id, ok: true });
    await expect(ready).resolves.toBe('memory');
  });

  // ---------------- Lazy init ----------------

  it('lazily initializes on the first ordinary call', async () => {
    const promise = client.getProjects();
    // First posted message is the auto-queued init.
    expect(worker.posted[0].type).toBe('init');
    worker.respond({ id: 1, ok: true, storage: 'opfs' });
    worker.respond({ id: 2, ok: true, result: [sampleProject()] });

    await expect(promise).resolves.toEqual([sampleProject()]);
  });

  // ---------------- storageReady getter ----------------

  it('storageReady is false before init and true after', async () => {
    expect(client.storageReady).toBe(false);
    const ready = client.ensureReady();
    expect(client.storageReady).toBe(true);
    worker.respond({ id: worker.posted[0].id, ok: true, storage: 'opfs' });
    await expect(ready).resolves.toBe('opfs');
    expect(client.storageReady).toBe(true);
  });

  // ---------------- Request correlation ----------------

  it('correlates concurrent calls by id', async () => {
    void client.ensureReady();
    worker.respond({ id: 1, ok: true, storage: 'opfs' });

    const a = client.getProject('p1');
    const b = client.getProjects();

    worker.respond({ id: 3, ok: true, result: [sampleProject()] });
    worker.respond({ id: 2, ok: true, result: sampleProject() });

    await expect(b).resolves.toEqual([sampleProject()]);
    await expect(a).resolves.toEqual(sampleProject());
    expect(worker.posted.map((r) => r.type)).toEqual(['init', 'getProject', 'getProjects']);
  });

  // ---------------- Error response ----------------

  it('rejects when the worker reports an error response', async () => {
    void client.ensureReady();
    worker.respond({ id: 1, ok: true, storage: 'opfs' });

    const promise = client.getProject('p1');
    worker.respond({ id: worker.posted[1].id, ok: false, error: 'not found' });

    await expect(promise).rejects.toThrow('not found');
  });

  // ---------------- failAll ----------------

  it('failAll rejects all pending calls on worker error', async () => {
    const ready = client.ensureReady();
    const projects = client.getProjects();

    const readyAssertion = expect(ready).rejects.toThrow('worker crashed');
    const projectsAssertion = expect(projects).rejects.toThrow('worker crashed');

    worker.fail('worker crashed');

    await readyAssertion;
    await projectsAssertion;
  });

  // ---------------- fallbackReason ----------------

  it('sets fallbackReason on init when the worker reports it', async () => {
    const ready = client.ensureReady();
    worker.respond({
      id: worker.posted[0].id,
      ok: true,
      storage: 'memory',
      fallbackReason: 'unsupported',
    });
    await expect(ready).resolves.toBe('memory');
    expect(client.fallbackReason).toBe('unsupported');
  });

  it('leaves fallbackReason undefined when init uses opfs', async () => {
    const ready = client.ensureReady();
    worker.respond({ id: worker.posted[0].id, ok: true, storage: 'opfs' });
    await expect(ready).resolves.toBe('opfs');
    expect(client.fallbackReason).toBeUndefined();
  });

  // ---------------- exportControlDatabase ----------------

  it('exportControlDatabase resolves with bytes', async () => {
    void client.ensureReady();
    worker.respond({ id: 1, ok: true, storage: 'opfs' });

    const bytes = new Uint8Array([1, 2, 3]);
    const promise = client.exportControlDatabase();
    worker.respond({ id: worker.posted[1].id, ok: true, bytes });

    await expect(promise).resolves.toEqual(bytes);
  });

  it('exportControlDatabase resolves with empty bytes when omitted', async () => {
    void client.ensureReady();
    worker.respond({ id: 1, ok: true, storage: 'opfs' });

    const promise = client.exportControlDatabase();
    worker.respond({ id: worker.posted[1].id, ok: true });

    await expect(promise).resolves.toEqual(new Uint8Array());
  });

  // ---------------- Typed method payloads ----------------

  it('posts the correct request type and payload for typed methods', async () => {
    void client.ensureReady();
    worker.respond({ id: 1, ok: true, storage: 'opfs' });

    const project = sampleProject();
    void client.createProject(project);
    void client.getProjects();
    void client.getProject('p1');
    void client.deleteProject('p1');
    void client.createConnection(sampleConnection());
    void client.saveS3Credentials({
      connection_id: 'c1',
      region: 'us-east-1',
      bucket: 'b',
      access_key_id: 'ak',
      secret_access_key_ct: 'ct',
      secret_access_key_iv: 'iv',
      created_at: 1,
      updated_at: 2,
    } satisfies StoredS3Credentials);
    const stub: SessionStub = {
      id: 's1',
      project_id: 'p1',
      source: 'claude',
      title: 't',
      started_at: '2024-01-01T00:00:00Z',
      ended_at: '2024-01-01T01:00:00Z',
      sync_session_id: 'sync-1',
      sync_status: 'pending',
    };
    void client.upsertSessionStub(stub);
    void client.setSessionSyncStatus('s1', 'in_sync');
    const file: SessionFileRecord = {
      id: 'f1',
      project_id: 'p1',
      session_id: 's1',
      path: 'a.jsonl',
      scope: 'session',
      sha256: 'h',
      size: 10,
      status: 'downloaded',
      updated_at: 1,
    };
    void client.getSessionFiles('s1');
    void client.setUiPreference('theme', 'dark');
    void client.getUiPreference('theme');
    const checkpoint: SourceCheckpoint = {
      source_id: 'src1',
      source_type: 'sync',
    };
    void client.commitSourceCheckpoint('src1', checkpoint, { generationId: 'gen-1' });
    void client.getSourceCheckpoint('src1');

    expect(worker.posted[1]).toMatchObject({ type: 'createProject', project });
    expect(worker.posted[2]).toMatchObject({ type: 'getProjects' });
    expect(worker.posted[3]).toMatchObject({ type: 'getProject', projectId: 'p1' });
    expect(worker.posted[4]).toMatchObject({ type: 'deleteProject', projectId: 'p1' });
    expect(worker.posted[5]).toMatchObject({
      type: 'createConnection',
      connection: sampleConnection(),
    });
    expect(worker.posted[6]).toMatchObject({
      type: 'saveS3Credentials',
      credentials: {
        connection_id: 'c1',
        region: 'us-east-1',
        bucket: 'b',
        access_key_id: 'ak',
      },
    });
    expect(worker.posted[7]).toMatchObject({ type: 'upsertSessionStub', stub });
    expect(worker.posted[8]).toMatchObject({
      type: 'setSessionSyncStatus',
      sessionId: 's1',
      status: 'in_sync',
    });
    expect(worker.posted[9]).toMatchObject({ type: 'getSessionFiles', sessionId: 's1' });
    expect(worker.posted[10]).toMatchObject({
      type: 'setUiPreference',
      key: 'theme',
      value: 'dark',
    });
    expect(worker.posted[11]).toMatchObject({ type: 'getUiPreference', key: 'theme' });
    expect(worker.posted[12]).toMatchObject({
      type: 'commitSourceCheckpoint',
      sourceId: 'src1',
      checkpoint,
      receipt: { generationId: 'gen-1' },
    });
    expect(worker.posted[13]).toMatchObject({
      type: 'getSourceCheckpoint',
      sourceId: 'src1',
    });
  });

  it('forwards setSessionSyncStatus details when provided', async () => {
    void client.ensureReady();
    worker.respond({ id: 1, ok: true, storage: 'opfs' });

    void client.setSessionSyncStatus('s1', 'failed', 'timeout');
    expect(worker.posted[1]).toMatchObject({
      type: 'setSessionSyncStatus',
      sessionId: 's1',
      status: 'failed',
      details: 'timeout',
    });
  });

  it('resolves typed method results from the worker result field', async () => {
    void client.ensureReady();
    worker.respond({ id: 1, ok: true, storage: 'opfs' });

    const promise = client.getProjects();
    worker.respond({ id: worker.posted[1].id, ok: true, result: [sampleProject()] });
    await expect(promise).resolves.toEqual([sampleProject()]);
  });

  it('getSourceCheckpoint resolves with the result', async () => {
    void client.ensureReady();
    worker.respond({ id: 1, ok: true, storage: 'opfs' });

    const checkpoint: SourceCheckpoint = {
      source_id: 'src1',
      source_type: 'sync',
      last_sequence: '10',
    };
    const promise = client.getSourceCheckpoint('src1');
    worker.respond({ id: worker.posted[1].id, ok: true, result: checkpoint });
    await expect(promise).resolves.toEqual(checkpoint);
  });

  // ---------------- exportAndDownload ----------------

  it('exportAndDownload creates a blob and triggers a download', async () => {
    void client.ensureReady();
    worker.respond({ id: 1, ok: true, storage: 'opfs' });

    const bytes = new Uint8Array([9, 9, 9]);
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-url');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clickSpy = vi.fn();
    const anchor = { href: '', download: '', click: clickSpy } as unknown as HTMLAnchorElement;
    const createElementSpy = vi.spyOn(document, 'createElement').mockReturnValue(anchor);

    // Kick off the download flow; it posts exportControlDatabase synchronously.
    const promise = client.exportAndDownload();
    expect(worker.posted[1].type).toBe('exportControlDatabase');
    worker.respond({ id: worker.posted[1].id, ok: true, bytes });
    await promise;

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
    expect(createElementSpy).toHaveBeenCalledWith('a');
    expect(clickSpy).toHaveBeenCalled();
    expect((anchor as unknown as { download: string }).download).toMatch(
      /^session-analyzer-\d{4}-\d{2}-\d{2}\.sqlite$/,
    );

    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
    createElementSpy.mockRestore();
  });
});
