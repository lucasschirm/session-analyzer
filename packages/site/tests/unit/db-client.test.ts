import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DbClient } from '../../src/db/db-client';
import type { DbRequest, DbResponse } from '../../src/db/db-protocol';

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
    expect(worker.posted.map((request) => request.type)).toEqual(['init', 'getProjects', 'getProject']);
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
    expect(worker.posted[2]).toMatchObject({ type: 'updateProject', projectId: 'p1', fields: { name: 'N2' } });
    expect(worker.posted[3]).toMatchObject({ type: 'deleteProject', projectId: 'p1' });
    expect(worker.posted[4]).toMatchObject({ type: 'searchSessions', projectId: 'p1', query: 'query' });
    expect(worker.posted[5]).toMatchObject({ type: 'deleteSession', sessionId: 's1' });
  });

  it('exports and triggers a download', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const createObjectURLSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:mock-url');
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
});
