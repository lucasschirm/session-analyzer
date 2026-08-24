import {
  type ArtifactScope,
  buildObjectKey,
  encodeKeySegment,
  type ManifestArtifact,
  parseObjectKey,
  S3Error,
  type S3GetObjectOptions,
  type S3ListObjectEntry,
  type S3ListObjectsOptions,
  type S3ListOptions,
  type S3ListPage,
  type SyncManifest,
  sha256Hex,
} from '@lucasschirm/sal-sync-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FileToDownload,
  SessionBatchFoundMessage,
  SessionFileDownloadedMessage,
  SessionSyncCompleteMessage,
  SyncMessageFromWorker,
  SyncMessageToWorker,
} from '../../src/sync/sync-protocol';
import { type S3Client, SessionSyncWorker } from '../../src/workers/session-sync.worker';

const encoder = new TextEncoder();

class MockS3Client implements S3Client {
  private readonly store = new Map<string, ArrayBuffer>();
  private readonly pending: Array<{
    key: string;
    options: S3GetObjectOptions | undefined;
    resolve: (buffer: ArrayBuffer) => void;
    reject: (error: unknown) => void;
  }> = [];
  private _autoResolve = true;

  inFlight = 0;
  maxInFlight = 0;
  getCalls: string[] = [];
  getObjectProgress: Array<{ key: string; bytes: number }> = [];
  listSessionFoldersCalls: Array<{ projectId: string; options?: S3ListOptions }> = [];
  listSessionFoldersPages: S3ListPage[] = [];
  listSessionObjectsCalls: Array<{
    projectId: string;
    sessionId: string;
    options?: S3ListObjectsOptions;
  }> = [];
  listSessionObjectsResult: S3ListObjectEntry[] | undefined;

  setAutoResolve(value: boolean): void {
    this._autoResolve = value;
  }

  putBuffer(key: string, buffer: ArrayBuffer): void {
    this.store.set(key, buffer);
  }

  getBuffer(key: string): ArrayBuffer {
    const buffer = this.store.get(key);
    if (!buffer) {
      throw new Error(`No buffer stored for ${key}`);
    }
    return buffer;
  }

  setListPages(pages: S3ListPage[]): void {
    this.listSessionFoldersPages = pages;
  }

  setListSessionObjectsResult(result: S3ListObjectEntry[]): void {
    this.listSessionObjectsResult = result;
  }

  async listSessionFolders(projectId: string, options?: S3ListOptions): Promise<string[]> {
    this.listSessionFoldersCalls.push({ projectId, options });
    const all: string[] = [];
    for (let index = 0; index < this.listSessionFoldersPages.length; index++) {
      const page = this.listSessionFoldersPages[index] as S3ListPage;
      const isFinal = index === this.listSessionFoldersPages.length - 1;
      const pageWithToken = isFinal
        ? { ...page, continuationToken: undefined }
        : { ...page, continuationToken: `token-${index}` };
      if (options?.onPage) await options.onPage(pageWithToken);
      all.push(...page.prefixes);
    }
    return all;
  }

  async listSessionObjects(
    projectId: string,
    sessionId: string,
    options?: S3ListObjectsOptions,
  ): Promise<S3ListObjectEntry[]> {
    this.listSessionObjectsCalls.push({ projectId, sessionId, options });
    if (options?.signal?.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    if (this.listSessionObjectsResult) {
      return this.listSessionObjectsResult;
    }
    const prefix = `${encodeKeySegment(projectId)}/${encodeKeySegment(sessionId)}/session/`;
    const result: S3ListObjectEntry[] = [];
    for (const [key, buffer] of this.store) {
      if (key.startsWith(prefix) && !key.endsWith('/')) {
        const parsed = parseObjectKey(key);
        if (parsed?.scope === 'session' && parsed.relativePath) {
          result.push({ key, size: buffer.byteLength, etag: `"${key}-etag"` });
        }
      }
    }
    return result;
  }

  async getObject(key: string, options?: S3GetObjectOptions): Promise<ArrayBuffer> {
    this.getCalls.push(key);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);

    if (options?.signal?.aborted) {
      this.inFlight--;
      throw new DOMException('aborted', 'AbortError');
    }

    if (this._autoResolve && this.store.has(key)) {
      const buffer = this.store.get(key) as ArrayBuffer;
      this.inFlight--;
      this.getObjectProgress.push({ key, bytes: buffer.byteLength });
      options?.onProgress?.(buffer.byteLength);
      return buffer;
    }

    if (this._autoResolve && !this.store.has(key)) {
      this.inFlight--;
      throw new S3Error({ status: 404, code: 'NoSuchKey', message: 'not found', kind: 's3' });
    }

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.inFlight--;
        reject(new DOMException('aborted', 'AbortError'));
      };
      if (options?.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
      this.pending.push({
        key,
        options,
        resolve: (buffer: ArrayBuffer) => {
          if (options?.signal) options.signal.removeEventListener('abort', onAbort);
          this.inFlight--;
          this.getObjectProgress.push({ key, bytes: buffer.byteLength });
          options?.onProgress?.(buffer.byteLength);
          resolve(buffer);
        },
        reject: (error: unknown) => {
          if (options?.signal) options.signal.removeEventListener('abort', onAbort);
          this.inFlight--;
          reject(error);
        },
      });
    });
  }

  resolve(key: string, buffer: ArrayBuffer): void {
    const index = this.pending.findIndex((p) => p.key === key);
    if (index === -1) throw new Error(`No pending getObject for ${key}`);
    const [pending] = this.pending.splice(index, 1);
    pending.resolve(buffer);
  }

  resolveNext(buffer: ArrayBuffer): void {
    const pending = this.pending.shift();
    if (!pending) throw new Error('No pending getObject calls');
    pending.resolve(buffer);
  }

  rejectNext(error: unknown): void {
    const pending = this.pending.shift();
    if (!pending) throw new Error('No pending getObject calls');
    pending.reject(error);
  }

  reject(key: string, error: unknown): void {
    const index = this.pending.findIndex((p) => p.key === key);
    if (index === -1) throw new Error(`No pending getObject for ${key}`);
    const [pending] = this.pending.splice(index, 1);
    pending.reject(error);
  }

  pendingKeys(): string[] {
    return this.pending.map((p) => p.key);
  }
}

function createWorker(client: S3Client) {
  const posted: Array<{ message: SyncMessageFromWorker; transfer?: Transferable[] }> = [];
  const worker = new SessionSyncWorker((message, transfer) => {
    posted.push({ message, transfer });
  }, client);
  return { worker, posted };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

interface TestFile {
  scope: ArtifactScope;
  relativePath: string;
  content: string;
}

async function buildFileInfo(file: TestFile, mainPath: string) {
  const bytes = encoder.encode(file.content);
  const hash = await sha256Hex(bytes);
  return {
    file: `${file.scope}/${file.relativePath}`,
    scope: file.scope,
    relativePath: file.relativePath,
    hash,
    size: bytes.length,
    isMainTranscript: file.relativePath === mainPath,
    content: file.content,
  };
}

async function makeManifest(
  projectId: string,
  sessionId: string,
  files: TestFile[],
): Promise<{ manifest: SyncManifest; downloads: Array<FileToDownload & { content: string }> }> {
  const mainPath = 'transcript.jsonl';
  const downloads: Array<FileToDownload & { content: string }> = [];
  const artifacts: ManifestArtifact[] = [];

  for (const file of files) {
    const info = await buildFileInfo(file, mainPath);
    artifacts.push({
      projectId,
      sessionId,
      scope: file.scope,
      relativePath: file.relativePath,
      sha256: info.hash,
      size: info.size,
      status: 'uploaded',
    });
    downloads.push(info);
  }

  const manifest: SyncManifest = {
    schemaVersion: 2,
    projectId,
    sessionId,
    harness: 'claude',
    harnessVersion: '1',
    syncVersion: '0.1.0',
    pluginVersion: '1',
    transcriptsCaptured: true,
    mainTranscriptRelativePath: mainPath,
    artifacts,
    syncRuns: [],
  };

  return { manifest, downloads };
}

function manifestKey(projectId: string, sessionId: string): string {
  return buildObjectKey({
    projectId,
    sessionId,
    scope: 'manifest',
    relativePath: 'manifest.json',
  });
}

async function uploadProjectFiles(
  client: MockS3Client,
  projectId: string,
  sessionId: string,
  manifest: SyncManifest,
  downloads: Array<FileToDownload & { content: string }>,
): Promise<void> {
  client.putBuffer(
    manifestKey(projectId, sessionId),
    encoder.encode(JSON.stringify(manifest)).buffer,
  );
  for (const file of downloads) {
    const key = buildObjectKey({
      projectId,
      sessionId,
      scope: file.scope,
      relativePath: file.relativePath,
      contentSha256: file.hash,
    });
    client.putBuffer(key, encoder.encode(file.content).buffer);
  }
}

function startMessage(
  projectId: string,
  options?: { syncOnlyNew?: boolean; targetSessionIds?: string[] },
): SyncMessageToWorker {
  return {
    type: 'START',
    projectId,
    credentials: { accessKeyId: 'a', secretAccessKey: 's' },
    bucket: 'bucket',
    region: 'us-east-1',
    syncOnlyNew: options?.syncOnlyNew ?? false,
    targetSessionIds: options?.targetSessionIds,
  };
}

function syncMessage(
  sessionId: string,
  filesToDownload?: FileToDownload[],
  options?: { sync?: boolean; exists?: boolean },
): SyncMessageToWorker {
  return {
    type: 'SESSION_SYNC',
    sessionId,
    sync: options?.sync ?? true,
    exists: options?.exists ?? false,
    filesToDownload,
  };
}

function syncContinueMessage(sessionId: string, sync: boolean): SyncMessageToWorker {
  return {
    type: 'SESSION_SYNC_CONTINUE',
    sessionId,
    sync,
  };
}

function cancelMessage(): SyncMessageToWorker {
  return { type: 'CANCEL' };
}

function findMessages(posted: Array<{ message: SyncMessageFromWorker }>, type: string) {
  return posted.filter((p) => p.message.type === type);
}

function findOne(posted: Array<{ message: SyncMessageFromWorker }>, type: string) {
  const found = findMessages(posted, type);
  if (found.length !== 1) throw new Error(`Expected one ${type}, got ${found.length}`);
  return found[0].message;
}

describe('SessionSyncWorker', () => {
  let client: MockS3Client;

  beforeEach(() => {
    client = new MockS3Client();
    client.setAutoResolve(true);
    client.setListPages([{ prefixes: ['sess-1'], continuationToken: undefined }]);
  });

  it('lists sessions, downloads manifest and files, then emits WORKER_DONE', async () => {
    const { worker, posted } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
      { scope: 'session', relativePath: 'subagents/agent-1.jsonl', content: 'sub line\n' },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-1', manifest, downloads);

    await worker.handleMessage(startMessage('proj'));
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    worker.handleMessage(
      syncMessage(
        'sess-1',
        downloads.map(({ content: _content, ...rest }) => rest),
      ),
    );
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const done = findOne(posted, 'WORKER_DONE') as {
      synced: number;
      failed: number;
      skipped: number;
    };
    expect(done.synced).toBe(1);
    expect(done.failed).toBe(0);
    expect(done.skipped).toBe(0);

    expect(findMessages(posted, 'SESSION_FILE_DOWNLOADED').length).toBe(2);
    expect(findMessages(posted, 'SESSION_SYNC_COMPLETE').length).toBe(1);
  });

  it('emits per-page SESSION_BATCH_FOUND and a final PROJECT_FOLDER_FOUND', async () => {
    client.setListPages([
      { prefixes: ['sess-a'], continuationToken: 'token-1' },
      { prefixes: ['sess-b'], continuationToken: undefined },
    ]);
    client.putBuffer(manifestKey('proj', 'sess-a'), encoder.encode(JSON.stringify({})).buffer);
    client.putBuffer(manifestKey('proj', 'sess-b'), encoder.encode(JSON.stringify({})).buffer);

    const { worker, posted } = createWorker(client);
    worker.handleMessage(startMessage('proj'));

    await vi.waitUntil(() => findMessages(posted, 'PROJECT_FOLDER_FOUND').length > 0);

    const batches = findMessages(posted, 'SESSION_BATCH_FOUND') as Array<{
      message: SessionBatchFoundMessage;
    }>;
    expect(batches.length).toBe(2);
    expect(batches[0].message.final).toBe(false);
    expect(batches[1].message.final).toBe(true);

    const folder = findOne(posted, 'PROJECT_FOLDER_FOUND') as { totalSessions: number };
    expect(folder.totalSessions).toBe(2);
  });

  it('parks at SESSION_FOUND in sync-only-new mode and skips rejected sessions', async () => {
    client.setListPages([{ prefixes: ['sess-1'], continuationToken: undefined }]);
    const { worker, posted } = createWorker(client);

    worker.handleMessage(startMessage('proj', { syncOnlyNew: true }));
    await vi.waitUntil(() => findMessages(posted, 'SESSION_FOUND').length > 0);

    worker.handleMessage(syncContinueMessage('sess-1', false));
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const done = findOne(posted, 'WORKER_DONE') as { synced: number; skipped: number };
    expect(done.skipped).toBe(1);
    expect(done.synced).toBe(0);
    expect(client.getCalls.length).toBe(0);
  });

  it('downloads only the files requested in SESSION_SYNC', async () => {
    const { worker, posted } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
      { scope: 'session', relativePath: 'subagents/agent-1.jsonl', content: 'sub line\n' },
      { scope: 'session', relativePath: 'subagents/agent-1.meta.json', content: '{}' },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-1', manifest, downloads);

    await worker.handleMessage(startMessage('proj'));
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    const onlyMain = downloads
      .filter((file) => file.isMainTranscript)
      .map(({ content: _content, ...rest }) => rest);
    worker.handleMessage(syncMessage('sess-1', onlyMain));
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const fileMessages = findMessages(posted, 'SESSION_FILE_DOWNLOADED') as Array<{
      message: SessionFileDownloadedMessage;
    }>;
    expect(fileMessages.length).toBe(1);
    expect(fileMessages[0].message.file).toBe('session/transcript.jsonl');
  });

  it('falls back to the in-scope manifest list when filesToDownload is omitted', async () => {
    const { worker, posted } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
      { scope: 'session', relativePath: 'subagents/agent-1.jsonl', content: 'sub line\n' },
      { scope: 'global', relativePath: 'ignored.jsonl', content: 'cas line\n' },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-1', manifest, downloads);

    await worker.handleMessage(startMessage('proj'));
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    worker.handleMessage(syncMessage('sess-1'));
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const fileMessages = findMessages(posted, 'SESSION_FILE_DOWNLOADED') as Array<{
      message: SessionFileDownloadedMessage;
    }>;
    const files = fileMessages.map((m) => m.message.file);
    expect(files).toContain('session/transcript.jsonl');
    expect(files).toContain('session/subagents/agent-1.jsonl');
    expect(files).not.toContain('global/ignored.jsonl');
  });

  it('downloads the main transcript before other files', async () => {
    client.setAutoResolve(false);
    const { worker, posted } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'subagents/agent-1.jsonl', content: 'sub line\n' },
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
    ]);
    client.putBuffer(
      manifestKey('proj', 'sess-1'),
      encoder.encode(JSON.stringify(manifest)).buffer,
    );

    worker.handleMessage(startMessage('proj'));
    await vi.waitUntil(() => client.pendingKeys().includes(manifestKey('proj', 'sess-1')));
    client.resolve(manifestKey('proj', 'sess-1'), client.getBuffer(manifestKey('proj', 'sess-1')));

    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);
    worker.handleMessage(
      syncMessage(
        'sess-1',
        downloads.map(({ content: _content, ...rest }) => rest),
      ),
    );

    await vi.waitUntil(() => client.pendingKeys().length > 0);
    expect(client.pendingKeys()[0]).toBe(
      buildObjectKey({
        projectId: 'proj',
        sessionId: 'sess-1',
        scope: 'session',
        relativePath: 'transcript.jsonl',
        contentSha256: downloads.find((f) => f.isMainTranscript)?.hash as string,
      }),
    );
  });

  it('derives legacy and CAS keys and requests the exact S3 keys', async () => {
    const { worker, posted } = createWorker(client);
    const casContent = 'cas file';
    const casBytes = encoder.encode(casContent);
    const casHash = await sha256Hex(casBytes);
    const legacyContent = 'main line\n';

    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: legacyContent },
      { scope: 'workspace', relativePath: 'workspace.jsonl', content: casContent },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-1', manifest, downloads);

    await worker.handleMessage(startMessage('proj'));
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    worker.handleMessage(
      syncMessage(
        'sess-1',
        downloads.map(({ content: _content, ...rest }) => rest),
      ),
    );
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const expectedLegacy = buildObjectKey({
      projectId: 'proj',
      sessionId: 'sess-1',
      scope: 'session',
      relativePath: 'transcript.jsonl',
      contentSha256: downloads[0].hash,
    });
    const expectedCas = buildObjectKey({
      projectId: 'proj',
      sessionId: 'sess-1',
      scope: 'workspace',
      relativePath: 'workspace.jsonl',
      contentSha256: casHash,
    });
    expect(client.getCalls).toContain(expectedLegacy);
    expect(client.getCalls).toContain(expectedCas);
  });

  it('emits progress and transfers downloaded file buffers', async () => {
    const { worker, posted } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-1', manifest, downloads);

    await worker.handleMessage(startMessage('proj'));
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    worker.handleMessage(
      syncMessage(
        'sess-1',
        downloads.map(({ content: _content, ...rest }) => rest),
      ),
    );
    await vi.waitUntil(() => findMessages(posted, 'SESSION_FILE_DOWNLOADED').length > 0);

    const fileMessage = findOne(posted, 'SESSION_FILE_DOWNLOADED') as {
      file: string;
      content: ArrayBuffer;
    };
    const postedEntry = posted.find((p) => p.message === fileMessage);
    expect(fileMessage.file).toBe('session/transcript.jsonl');
    expect(postedEntry?.transfer).toHaveLength(1);
    expect(postedEntry?.transfer?.[0]).toBe(fileMessage.content);

    const progress = findMessages(posted, 'SESSION_SYNC_PROGRESS').pop()?.message as {
      bytes_received: number;
    };
    expect(progress.bytes_received).toBeGreaterThan(0);
  });

  it('never holds more than FILE_POOL_SIZE concurrent downloads', async () => {
    client.setAutoResolve(false);
    client.setListPages([{ prefixes: ['sess-1'], continuationToken: undefined }]);
    const { worker, posted } = createWorker(client);
    const files: TestFile[] = [];
    for (let index = 0; index < 4; index++) {
      files.push({
        scope: 'session',
        relativePath: `subagents/agent-${index}.jsonl`,
        content: `sub ${index}\n`,
      });
    }
    files.unshift({ scope: 'session', relativePath: 'transcript.jsonl', content: 'main\n' });
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', files);
    client.putBuffer(
      manifestKey('proj', 'sess-1'),
      encoder.encode(JSON.stringify(manifest)).buffer,
    );
    await uploadProjectFiles(client, 'proj', 'sess-1', manifest, downloads);

    worker.handleMessage(startMessage('proj'));
    await vi.waitUntil(() => client.pendingKeys().includes(manifestKey('proj', 'sess-1')));
    client.resolve(manifestKey('proj', 'sess-1'), client.getBuffer(manifestKey('proj', 'sess-1')));

    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);
    worker.handleMessage(
      syncMessage(
        'sess-1',
        downloads.map(({ content: _content, ...rest }) => rest),
      ),
    );

    await vi.waitUntil(() => client.pendingKeys().length > 0);
    const mainKey = client.pendingKeys()[0];
    client.resolve(mainKey, client.getBuffer(mainKey));
    await flush();

    await vi.waitUntil(() => client.pendingKeys().length === 4);
    expect(client.maxInFlight).toBeLessThanOrEqual(4);

    for (const key of client.pendingKeys()) {
      client.resolve(key, client.getBuffer(key));
      await flush();
    }

    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);
  });

  it('fails the session when the main transcript hash mismatches', async () => {
    const { worker, posted } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
    ]);
    client.putBuffer(
      manifestKey('proj', 'sess-1'),
      encoder.encode(JSON.stringify(manifest)).buffer,
    );
    const main = downloads.find((f) => f.isMainTranscript) as FileToDownload & { content: string };
    client.putBuffer(
      buildObjectKey({
        projectId: 'proj',
        sessionId: 'sess-1',
        scope: 'session',
        relativePath: main.relativePath,
        contentSha256: main.hash,
      }),
      encoder.encode('wrong content\n').buffer,
    );

    await worker.handleMessage(startMessage('proj'));
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    worker.handleMessage(
      syncMessage(
        'sess-1',
        downloads.map(({ content: _content, ...rest }) => rest),
      ),
    );
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const failed = findOne(posted, 'SESSION_SYNC_FAILED') as { error: { code: string } };
    expect(failed.error.code).toBe('HASH_MISMATCH');
  });

  it('marks subagent files failed and continues when a subagent hash mismatches', async () => {
    const { worker, posted } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
      { scope: 'session', relativePath: 'subagents/agent-1.jsonl', content: 'sub line\n' },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-1', manifest, downloads);
    const bad = downloads.find(
      (f) => f.file === 'session/subagents/agent-1.jsonl',
    ) as FileToDownload & { content: string };
    client.putBuffer(
      buildObjectKey({
        projectId: 'proj',
        sessionId: 'sess-1',
        scope: 'session',
        relativePath: bad.relativePath,
        contentSha256: bad.hash,
      }),
      encoder.encode('not sub\n').buffer,
    );

    await worker.handleMessage(startMessage('proj'));
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    worker.handleMessage(
      syncMessage(
        'sess-1',
        downloads.map(({ content: _content, ...rest }) => rest),
      ),
    );
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const complete = findOne(posted, 'SESSION_SYNC_COMPLETE') as SessionSyncCompleteMessage;
    const subagent = complete.files.find((f) => f.file === 'session/subagents/agent-1.jsonl');
    expect(subagent?.status).toBe('failed');
    const done = findOne(posted, 'WORKER_DONE') as { synced: number; failed: number };
    expect(done.synced).toBe(1);
    expect(done.failed).toBe(0);
  });

  it('emits MANIFEST_NOT_FOUND for a missing manifest', async () => {
    const { worker, posted } = createWorker(client);
    await worker.handleMessage(startMessage('proj'));
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const failed = findOne(posted, 'SESSION_SYNC_FAILED') as { error: { code: string } };
    expect(failed.error.code).toBe('MANIFEST_NOT_FOUND');
  });

  it('emits MANIFEST_INVALID for malformed manifest JSON', async () => {
    client.putBuffer(manifestKey('proj', 'sess-1'), encoder.encode('not json').buffer);
    const { worker, posted } = createWorker(client);
    await worker.handleMessage(startMessage('proj'));
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const failed = findOne(posted, 'SESSION_SYNC_FAILED') as { error: { code: string } };
    expect(failed.error.code).toBe('MANIFEST_INVALID');
  });

  it('emits MANIFEST_UNSUPPORTED_SCHEMA for schemaVersion 1', async () => {
    client.putBuffer(
      manifestKey('proj', 'sess-1'),
      encoder.encode(JSON.stringify({ schemaVersion: 1 })).buffer,
    );
    const { worker, posted } = createWorker(client);
    await worker.handleMessage(startMessage('proj'));
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const failed = findOne(posted, 'SESSION_SYNC_FAILED') as { error: { code: string } };
    expect(failed.error.code).toBe('MANIFEST_UNSUPPORTED_SCHEMA');
  });

  it('fails the session on a main-transcript stall and emits STALL_TIMEOUT', async () => {
    client.setAutoResolve(false);
    const { worker, posted } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
    ]);
    client.putBuffer(
      manifestKey('proj', 'sess-1'),
      encoder.encode(JSON.stringify(manifest)).buffer,
    );

    worker.handleMessage(startMessage('proj'));
    await vi.waitUntil(() => client.pendingKeys().includes(manifestKey('proj', 'sess-1')));
    client.resolve(manifestKey('proj', 'sess-1'), client.getBuffer(manifestKey('proj', 'sess-1')));

    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);
    worker.handleMessage(
      syncMessage(
        'sess-1',
        downloads.map(({ content: _content, ...rest }) => rest),
      ),
    );

    await vi.waitUntil(() => client.pendingKeys().length > 0);
    client.rejectNext(
      new S3Error({ status: 0, code: 'StallTimeout', message: 'stall', kind: 'stall' }),
    );
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const failed = findOne(posted, 'SESSION_SYNC_FAILED') as { error: { code: string } };
    expect(failed.error.code).toBe('STALL_TIMEOUT');
  });

  it('aborts in-flight downloads and stops cleanly on CANCEL', async () => {
    client.setAutoResolve(false);
    const { worker, posted } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
      { scope: 'session', relativePath: 'subagents/agent-1.jsonl', content: 'sub line\n' },
    ]);
    client.putBuffer(
      manifestKey('proj', 'sess-1'),
      encoder.encode(JSON.stringify(manifest)).buffer,
    );

    worker.handleMessage(startMessage('proj'));
    await vi.waitUntil(() => client.pendingKeys().includes(manifestKey('proj', 'sess-1')));
    client.resolve(manifestKey('proj', 'sess-1'), client.getBuffer(manifestKey('proj', 'sess-1')));

    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);
    worker.handleMessage(
      syncMessage(
        'sess-1',
        downloads.map(({ content: _content, ...rest }) => rest),
      ),
    );

    await vi.waitUntil(() => client.pendingKeys().length > 0);
    worker.handleMessage(cancelMessage());
    await flush();

    expect(findMessages(posted, 'SESSION_FILE_DOWNLOADED').length).toBe(0);
    expect(client.inFlight).toBe(0);
  });

  it('stops cleanly on CANCEL when more than FILE_POOL_SIZE files are queued', async () => {
    client.setAutoResolve(false);
    const { worker, posted } = createWorker(client);
    const files: TestFile[] = [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
    ];
    for (let index = 0; index < 5; index++) {
      files.push({
        scope: 'session',
        relativePath: `subagents/agent-${index}.jsonl`,
        content: `sub ${index}\n`,
      });
    }
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', files);
    client.putBuffer(
      manifestKey('proj', 'sess-1'),
      encoder.encode(JSON.stringify(manifest)).buffer,
    );
    await uploadProjectFiles(client, 'proj', 'sess-1', manifest, downloads);

    worker.handleMessage(startMessage('proj'));
    await vi.waitUntil(() => client.pendingKeys().includes(manifestKey('proj', 'sess-1')));
    client.resolve(manifestKey('proj', 'sess-1'), client.getBuffer(manifestKey('proj', 'sess-1')));

    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);
    worker.handleMessage(
      syncMessage(
        'sess-1',
        downloads.map(({ content: _content, ...rest }) => rest),
      ),
    );

    await vi.waitUntil(() => client.pendingKeys().length === 1);
    const mainKey = client.pendingKeys()[0];
    client.resolve(mainKey, client.getBuffer(mainKey));
    await flush();

    await vi.waitUntil(() => client.pendingKeys().length === 4);
    expect(client.maxInFlight).toBeLessThanOrEqual(4);

    worker.handleMessage(cancelMessage());
    await flush();

    await vi.waitUntil(() => client.inFlight === 0);
    expect(findMessages(posted, 'SESSION_FILE_DOWNLOADED').length).toBe(1);
  });

  it('honors targetSessionIds and ignores non-target sessions', async () => {
    client.setListPages([
      { prefixes: ['sess-a', 'sess-b', 'sess-c'], continuationToken: undefined },
    ]);
    client.putBuffer(manifestKey('proj', 'sess-a'), encoder.encode(JSON.stringify({})).buffer);
    client.putBuffer(manifestKey('proj', 'sess-b'), encoder.encode(JSON.stringify({})).buffer);

    const { worker, posted } = createWorker(client);
    worker.handleMessage(startMessage('proj', { targetSessionIds: ['sess-b'] }));

    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const batches = findMessages(posted, 'SESSION_BATCH_FOUND') as Array<{
      message: SessionBatchFoundMessage;
    }>;
    expect(batches.length).toBe(1);
    expect(batches[0].message.sessionIds).toEqual(['sess-b']);

    const found = findMessages(posted, 'SESSION_FOUND') as Array<{
      message: { sessionId: string };
    }>;
    expect(found.map((m) => m.message.sessionId)).toEqual(['sess-b']);
  });

  it('skips a session when SESSION_SYNC has sync:false and exists:false', async () => {
    client.setListPages([{ prefixes: ['sess-1'], continuationToken: undefined }]);
    const { worker, posted } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-1', manifest, downloads);

    await worker.handleMessage(startMessage('proj'));
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    worker.handleMessage(syncMessage('sess-1', undefined, { sync: false, exists: false }));
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const complete = findOne(posted, 'SESSION_SYNC_COMPLETE') as SessionSyncCompleteMessage;
    expect(complete.files).toEqual([]);

    const done = findOne(posted, 'WORKER_DONE') as { synced: number; skipped: number };
    expect(done.synced).toBe(1);
    expect(done.skipped).toBe(0);
    expect(client.getCalls).toEqual([manifestKey('proj', 'sess-1')]);
    expect(client.listSessionObjectsCalls).toHaveLength(0);
  });

  it('emits an unchanged summary when SESSION_SYNC has sync:false and exists:true', async () => {
    client.setListPages([{ prefixes: ['sess-1'], continuationToken: undefined }]);
    const { worker, posted } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
      { scope: 'session', relativePath: 'subagents/agent-1.jsonl', content: 'sub line\n' },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-1', manifest, downloads);

    await worker.handleMessage(startMessage('proj'));
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    worker.handleMessage(syncMessage('sess-1', undefined, { sync: false, exists: true }));
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const complete = findOne(posted, 'SESSION_SYNC_COMPLETE') as SessionSyncCompleteMessage;
    expect(complete.files.length).toBe(2);
    expect(complete.files.every((f) => f.status === 'unchanged')).toBe(true);

    const done = findOne(posted, 'WORKER_DONE') as { synced: number; skipped: number };
    expect(done.synced).toBe(1);
    expect(done.skipped).toBe(0);
    expect(findMessages(posted, 'SESSION_FILE_DOWNLOADED').length).toBe(0);
  });

  it('includes session files discovered by S3 listing but missing from the manifest', async () => {
    client.setListPages([{ prefixes: ['sess-1'], continuationToken: undefined }]);
    const { worker, posted } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-1', manifest, downloads);

    const orphanContent = 'orphan sub line\n';
    const orphanKey = buildObjectKey({
      projectId: 'proj',
      sessionId: 'sess-1',
      scope: 'session',
      relativePath: 'subagents/agent-orphan.jsonl',
    });
    client.putBuffer(orphanKey, encoder.encode(orphanContent).buffer);

    await worker.handleMessage(startMessage('proj'));
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    worker.handleMessage(syncMessage('sess-1'));
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const fileMessages = findMessages(posted, 'SESSION_FILE_DOWNLOADED') as Array<{
      message: SessionFileDownloadedMessage;
    }>;
    const files = fileMessages.map((m) => m.message.file);
    expect(files).toContain('session/transcript.jsonl');
    expect(files).toContain('session/subagents/agent-orphan.jsonl');

    const complete = findOne(posted, 'SESSION_SYNC_COMPLETE') as SessionSyncCompleteMessage;
    const orphan = complete.files.find((f) => f.file === 'session/subagents/agent-orphan.jsonl');
    expect(orphan).not.toBeUndefined();
    expect(orphan?.status).toBe('downloaded');
  });
});
