import {
  type ArtifactScope,
  buildObjectKey,
  encodeKeySegment,
  type ManifestArtifact,
  S3Error,
  type S3GetObjectOptions,
  type S3ListObjectEntry,
  type S3ListObjectsOptions,
  type S3ListObjectsPage,
  type SyncManifest,
  sha256Hex,
} from '@lucasschirm/sal-sync-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FileToDownload,
  SessionBatchFoundMessage,
  SessionFileDownloadedMessage,
  SessionSyncCompleteMessage,
  SessionSyncProgressMessage,
  SyncMessageFromWorker,
  SyncMessageToWorker,
} from '../../src/sync/sync-protocol';
import type { ManifestFingerprint } from '../../src/types';
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
  private explicitPages: S3ListObjectsPage[] | undefined;
  private listingError: unknown;
  private pageGateEnabled = false;
  private releaseGate: (() => void) | undefined;

  inFlight = 0;
  maxInFlight = 0;
  getCalls: string[] = [];
  getObjectProgress: Array<{ key: string; bytes: number }> = [];
  listProjectObjectsCalls: Array<{ projectId: string; options?: S3ListObjectsOptions }> = [];

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

  /** Explicit pages for tests exercising pagination, ordering, or filtering. */
  setObjectPages(pages: S3ListObjectsPage[]): void {
    this.explicitPages = pages;
  }

  /** After serving all configured/default pages, the listing call rejects. */
  setListingError(error: unknown): void {
    this.listingError = error;
  }

  /** Pauses before each page after the first, released via `releaseNextPage`. */
  enablePageGate(): void {
    this.pageGateEnabled = true;
  }

  releaseNextPage(): void {
    this.releaseGate?.();
    this.releaseGate = undefined;
  }

  async listProjectObjects(
    projectId: string,
    options?: S3ListObjectsOptions,
  ): Promise<S3ListObjectEntry[]> {
    this.listProjectObjectsCalls.push({ projectId, options });
    const pages = this.explicitPages ?? this.defaultPagesFor(projectId);
    const all: S3ListObjectEntry[] = [];
    for (let index = 0; index < pages.length; index++) {
      if (this.pageGateEnabled && index > 0) {
        await new Promise<void>((resolve) => {
          this.releaseGate = resolve;
        });
      }
      if (options?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const page = pages[index] as S3ListObjectsPage;
      if (options?.onPage) await options.onPage(page);
      all.push(...page.objects);
    }
    if (this.listingError) throw this.listingError;
    return all;
  }

  private defaultPagesFor(projectId: string): S3ListObjectsPage[] {
    const prefix = `${encodeKeySegment(projectId)}/`;
    const objects: S3ListObjectEntry[] = [];
    for (const [key, buffer] of this.store) {
      if (key.startsWith(prefix)) {
        objects.push({ key, size: buffer.byteLength, etag: `"${key}-etag"` });
      }
    }
    objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return [{ objects, continuationToken: undefined }];
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
    file: file.scope === 'session' ? file.relativePath : `${file.scope}/${file.relativePath}`,
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
    syncRunsCount: 0,
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

function sessionFileKey(projectId: string, sessionId: string, relativePath: string): string {
  return buildObjectKey({ projectId, sessionId, scope: 'session', relativePath });
}

function objectEntry(
  key: string,
  opts?: { size?: number; etag?: string; lastModified?: string },
): S3ListObjectEntry {
  return { key, size: opts?.size ?? 0, etag: opts?.etag, lastModified: opts?.lastModified };
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
  localFileHashes?: Record<string, { sha256: string; etag?: string; status: string }>,
  options?: { sync?: boolean; exists?: boolean },
): SyncMessageToWorker {
  return {
    type: 'SESSION_SYNC',
    sessionId,
    sync: options?.sync ?? true,
    exists: options?.exists ?? false,
    localFileHashes,
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

/**
 * D3: every session now waits for `SESSION_SYNC_CONTINUE` before its manifest
 * is downloaded. Test harness helper mirroring the manager's #406 stopgap
 * (`sync-manager.ts` `handleSessionFound`), which always answers `sync: true`
 * for non-`syncOnlyNew` runs.
 */
async function continueSession(
  worker: SessionSyncWorker,
  posted: Array<{ message: SyncMessageFromWorker }>,
  sessionId: string,
): Promise<void> {
  await vi.waitUntil(() =>
    findMessages(posted, 'SESSION_FOUND').some(
      (p) => (p.message as { sessionId: string }).sessionId === sessionId,
    ),
  );
  worker.handleMessage(syncContinueMessage(sessionId, true));
}

interface ProgressSample {
  filesFound: number;
  filesDownloaded: number;
  filesFailed: number;
  bytesReceived: number;
  timestamp?: string;
}

function toProgressSample(message: SyncMessageFromWorker): ProgressSample | undefined {
  if (message.type !== 'SESSION_SYNC_PROGRESS') return undefined;
  const msg = message as SessionSyncProgressMessage;
  const withTimestamp = msg as unknown as { timestamp?: string };
  return {
    filesFound: msg.files_found,
    filesDownloaded: msg.files_downloaded,
    filesFailed: msg.files_failed,
    bytesReceived: msg.bytes_received,
    timestamp: withTimestamp.timestamp,
  };
}

function extractProgressSeries(
  posted: Array<{ message: SyncMessageFromWorker }>,
): ProgressSample[] {
  return findMessages(posted, 'SESSION_SYNC_PROGRESS')
    .map((p) => toProgressSample(p.message))
    .filter((s): s is ProgressSample => s !== undefined);
}

function assertMonotonicProgress(series: ProgressSample[]): void {
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    const curr = series[i];
    expect(curr.filesFound).toBeGreaterThanOrEqual(prev.filesFound);
    expect(curr.filesDownloaded).toBeGreaterThanOrEqual(prev.filesDownloaded);
    expect(curr.filesFailed).toBeGreaterThanOrEqual(prev.filesFailed);
    expect(curr.bytesReceived).toBeGreaterThanOrEqual(prev.bytesReceived);
    if (prev.timestamp !== undefined && curr.timestamp !== undefined) {
      expect(new Date(curr.timestamp).getTime()).toBeGreaterThan(
        new Date(prev.timestamp).getTime(),
      );
    }
  }
}

describe('SessionSyncWorker', () => {
  let client: MockS3Client;

  beforeEach(() => {
    client = new MockS3Client();
    client.setAutoResolve(true);
  });

  it('lists sessions, downloads manifest and files, then emits WORKER_DONE', async () => {
    const { worker, posted } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
      { scope: 'session', relativePath: 'subagents/agent-1.jsonl', content: 'sub line\n' },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-1', manifest, downloads);

    await worker.handleMessage(startMessage('proj'));
    await continueSession(worker, posted, 'sess-1');
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    const expectedFingerprint = { etag: `"${manifestKey('proj', 'sess-1')}-etag"` };
    const found = findOne(posted, 'SESSION_FOUND') as { fingerprint?: ManifestFingerprint };
    expect(found.fingerprint).toEqual(expectedFingerprint);
    const ready = findOne(posted, 'SESSION_MANIFEST_READY') as {
      fingerprint?: ManifestFingerprint;
    };
    expect(ready.fingerprint).toEqual(expectedFingerprint);

    worker.handleMessage(syncMessage('sess-1', undefined));
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
    client.setObjectPages([
      { objects: [objectEntry(manifestKey('proj', 'sess-a'))], continuationToken: 'token-1' },
      { objects: [objectEntry(manifestKey('proj', 'sess-b'))], continuationToken: undefined },
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
    // sess-a is the only key on page 1, so its buffer is still open at the
    // end of the page (D4: a session finalizes only when a different session
    // id arrives, or the listing completes) — it carries into page 2, where
    // sess-b's key finalizes it; sess-b itself finalizes via the final flush.
    expect(batches[0].message.sessionIds).toEqual([]);
    expect(batches[0].message.final).toBe(false);
    expect(batches[1].message.sessionIds).toEqual(['sess-a', 'sess-b']);
    expect(batches[1].message.final).toBe(true);

    const folder = findOne(posted, 'PROJECT_FOLDER_FOUND') as { totalSessions: number };
    expect(folder.totalSessions).toBe(2);

    worker.handleMessage(cancelMessage());
  });

  it('parks at SESSION_FOUND in sync-only-new mode and skips rejected sessions', async () => {
    client.setObjectPages([
      { objects: [objectEntry(manifestKey('proj', 'sess-1'))], continuationToken: undefined },
    ]);
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

  it('skips files whose local hash matches the manifest hash', async () => {
    const { worker, posted } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
      { scope: 'session', relativePath: 'subagents/agent-1.jsonl', content: 'sub line\n' },
      { scope: 'session', relativePath: 'subagents/agent-1.meta.json', content: '{}' },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-1', manifest, downloads);

    await worker.handleMessage(startMessage('proj'));
    await continueSession(worker, posted, 'sess-1');
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    // Pass local hashes for non-main files so the worker skips them.
    const localHashes: Record<string, { sha256: string; status: string }> = {};
    for (const file of downloads) {
      if (!file.isMainTranscript) {
        localHashes[file.file] = { sha256: file.hash, status: 'processed' };
      }
    }
    worker.handleMessage(syncMessage('sess-1', localHashes));
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const fileMessages = findMessages(posted, 'SESSION_FILE_DOWNLOADED') as Array<{
      message: SessionFileDownloadedMessage;
    }>;
    expect(fileMessages.length).toBe(1);
    expect(fileMessages[0].message.file).toBe('transcript.jsonl');
  });

  it('downloads files whose local hash differs from the manifest hash', async () => {
    const { worker, posted } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
      { scope: 'session', relativePath: 'subagents/agent-1.jsonl', content: 'sub line\n' },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-1', manifest, downloads);

    await worker.handleMessage(startMessage('proj'));
    await continueSession(worker, posted, 'sess-1');
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    // Pass a stale hash for the subagent file so it gets re-downloaded.
    const localHashes: Record<string, { sha256: string; status: string }> = {
      'subagents/agent-1.jsonl': { sha256: '0'.repeat(64), status: 'processed' },
    };
    worker.handleMessage(syncMessage('sess-1', localHashes));
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const fileMessages = findMessages(posted, 'SESSION_FILE_DOWNLOADED') as Array<{
      message: SessionFileDownloadedMessage;
    }>;
    const files = fileMessages.map((m) => m.message.file);
    expect(files).toContain('transcript.jsonl');
    expect(files).toContain('subagents/agent-1.jsonl');
  });

  it('downloads files whose local status is not processed even with matching hash', async () => {
    const { worker, posted } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
      { scope: 'session', relativePath: 'subagents/agent-1.jsonl', content: 'sub line\n' },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-1', manifest, downloads);

    await worker.handleMessage(startMessage('proj'));
    await continueSession(worker, posted, 'sess-1');
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    // Pass matching hash but 'failed' status for the subagent file.
    const subagent = downloads.find((f) => f.file === 'subagents/agent-1.jsonl')!;
    const localHashes: Record<string, { sha256: string; status: string }> = {
      'subagents/agent-1.jsonl': { sha256: subagent.hash, status: 'failed' },
    };
    worker.handleMessage(syncMessage('sess-1', localHashes));
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const fileMessages = findMessages(posted, 'SESSION_FILE_DOWNLOADED') as Array<{
      message: SessionFileDownloadedMessage;
    }>;
    const files = fileMessages.map((m) => m.message.file);
    expect(files).toContain('subagents/agent-1.jsonl');
  });

  it('downloads all in-scope files when localFileHashes is omitted', async () => {
    const { worker, posted } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
      { scope: 'session', relativePath: 'subagents/agent-1.jsonl', content: 'sub line\n' },
      { scope: 'global', relativePath: 'settings.json', content: '{"env":{}}\n' },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-1', manifest, downloads);

    await worker.handleMessage(startMessage('proj'));
    await continueSession(worker, posted, 'sess-1');
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    worker.handleMessage(syncMessage('sess-1'));
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const fileMessages = findMessages(posted, 'SESSION_FILE_DOWNLOADED') as Array<{
      message: SessionFileDownloadedMessage;
    }>;
    const files = fileMessages.map((m) => m.message.file);
    expect(files).toContain('transcript.jsonl');
    expect(files).toContain('subagents/agent-1.jsonl');
    // Workspace/global config artifacts are now downloaded so the transformer
    // can extract component identities (MCP, settings, skills, agents, rules).
    expect(files).toContain('global/settings.json');
  });

  it('downloads all files through the pool without a main-transcript gate', async () => {
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
    await continueSession(worker, posted, 'sess-1');
    await vi.waitUntil(() => client.pendingKeys().includes(manifestKey('proj', 'sess-1')));
    client.resolve(manifestKey('proj', 'sess-1'), client.getBuffer(manifestKey('proj', 'sess-1')));

    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);
    worker.handleMessage(syncMessage('sess-1', undefined));

    // All files are queued together — no main-transcript-first gate.
    await vi.waitUntil(() => client.pendingKeys().length === 2);
    const pending = client.pendingKeys();
    expect(pending).toContain(
      buildObjectKey({
        projectId: 'proj',
        sessionId: 'sess-1',
        scope: 'session',
        relativePath: 'transcript.jsonl',
        contentSha256: downloads.find((f) => f.isMainTranscript)?.hash as string,
      }),
    );
    expect(pending).toContain(
      buildObjectKey({
        projectId: 'proj',
        sessionId: 'sess-1',
        scope: 'session',
        relativePath: 'subagents/agent-1.jsonl',
        contentSha256: downloads.find((f) => f.file === 'subagents/agent-1.jsonl')?.hash as string,
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
    await continueSession(worker, posted, 'sess-1');
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    worker.handleMessage(syncMessage('sess-1', undefined));
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
    await continueSession(worker, posted, 'sess-1');
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    worker.handleMessage(syncMessage('sess-1', undefined));
    await vi.waitUntil(() => findMessages(posted, 'SESSION_FILE_DOWNLOADED').length > 0);

    const fileMessage = findOne(posted, 'SESSION_FILE_DOWNLOADED') as {
      file: string;
      content: ArrayBuffer;
    };
    const postedEntry = posted.find((p) => p.message === fileMessage);
    expect(fileMessage.file).toBe('transcript.jsonl');
    expect(postedEntry?.transfer).toHaveLength(1);
    expect(postedEntry?.transfer?.[0]).toBe(fileMessage.content);

    const progress = findMessages(posted, 'SESSION_SYNC_PROGRESS').pop()?.message as {
      bytes_received: number;
    };
    expect(progress.bytes_received).toBeGreaterThan(0);
  });

  it('never holds more than FILE_POOL_SIZE concurrent downloads', async () => {
    client.setAutoResolve(false);
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
    await continueSession(worker, posted, 'sess-1');
    await vi.waitUntil(() => client.pendingKeys().includes(manifestKey('proj', 'sess-1')));
    client.resolve(manifestKey('proj', 'sess-1'), client.getBuffer(manifestKey('proj', 'sess-1')));

    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);
    worker.handleMessage(syncMessage('sess-1', undefined));

    await vi.waitUntil(() => client.pendingKeys().length > 0);
    const mainKey = client.pendingKeys()[0];
    client.resolve(mainKey, client.getBuffer(mainKey));
    await flush();

    await vi.waitUntil(() => client.pendingKeys().length === 4);
    expect(client.maxInFlight).toBeLessThanOrEqual(8);

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
    await continueSession(worker, posted, 'sess-1');
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    worker.handleMessage(syncMessage('sess-1', undefined));
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const failed = findOne(posted, 'SESSION_SYNC_FAILED') as { error: { code: string } };
    expect(failed.error.code).toBe('HASH_MISMATCH');
  });

  it('downloads sibling files even when the main transcript fails', async () => {
    const { worker, posted } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
      { scope: 'session', relativePath: 'subagents/agent-1.jsonl', content: 'sub line\n' },
    ]);
    client.putBuffer(
      manifestKey('proj', 'sess-1'),
      encoder.encode(JSON.stringify(manifest)).buffer,
    );
    // Upload correct subagent, wrong main transcript.
    const main = downloads.find((f) => f.isMainTranscript) as FileToDownload & { content: string };
    const sub = downloads.find((f) => f.file === 'subagents/agent-1.jsonl') as FileToDownload & {
      content: string;
    };
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
    client.putBuffer(
      buildObjectKey({
        projectId: 'proj',
        sessionId: 'sess-1',
        scope: 'session',
        relativePath: sub.relativePath,
        contentSha256: sub.hash,
      }),
      encoder.encode(sub.content).buffer,
    );

    await worker.handleMessage(startMessage('proj'));
    await continueSession(worker, posted, 'sess-1');
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    worker.handleMessage(syncMessage('sess-1', undefined));
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    // Session is failed due to main transcript hash mismatch.
    const failed = findOne(posted, 'SESSION_SYNC_FAILED') as { error: { code: string } };
    expect(failed.error.code).toBe('HASH_MISMATCH');

    // Sibling file was still downloaded.
    const fileMessages = findMessages(posted, 'SESSION_FILE_DOWNLOADED') as Array<{
      message: SessionFileDownloadedMessage;
    }>;
    const files = fileMessages.map((m) => m.message.file);
    expect(files).toContain('subagents/agent-1.jsonl');
  });

  it('marks subagent files failed and continues when a subagent hash mismatches', async () => {
    const { worker, posted } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
      { scope: 'session', relativePath: 'subagents/agent-1.jsonl', content: 'sub line\n' },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-1', manifest, downloads);
    const bad = downloads.find((f) => f.file === 'subagents/agent-1.jsonl') as FileToDownload & {
      content: string;
    };
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
    await continueSession(worker, posted, 'sess-1');
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    worker.handleMessage(syncMessage('sess-1', undefined));
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const complete = findOne(posted, 'SESSION_SYNC_COMPLETE') as SessionSyncCompleteMessage;
    const subagent = complete.files.find((f) => f.file === 'subagents/agent-1.jsonl');
    expect(subagent?.status).toBe('failed');
    const done = findOne(posted, 'WORKER_DONE') as { synced: number; failed: number };
    expect(done.synced).toBe(1);
    expect(done.failed).toBe(0);
  });

  it('emits MANIFEST_NOT_FOUND and fingerprint:undefined for a manifest-less session folder', async () => {
    client.setObjectPages([
      {
        objects: [objectEntry(sessionFileKey('proj', 'sess-1', 'transcript.jsonl'))],
        continuationToken: undefined,
      },
    ]);
    const { worker, posted } = createWorker(client);
    worker.handleMessage(startMessage('proj'));
    await continueSession(worker, posted, 'sess-1');
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const found = findOne(posted, 'SESSION_FOUND') as { fingerprint?: ManifestFingerprint };
    expect(found.fingerprint).toBeUndefined();

    const failed = findOne(posted, 'SESSION_SYNC_FAILED') as { error: { code: string } };
    expect(failed.error.code).toBe('MANIFEST_NOT_FOUND');
  });

  it('emits MANIFEST_INVALID for malformed manifest JSON', async () => {
    client.putBuffer(manifestKey('proj', 'sess-1'), encoder.encode('not json').buffer);
    const { worker, posted } = createWorker(client);
    await worker.handleMessage(startMessage('proj'));
    await continueSession(worker, posted, 'sess-1');
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
    await continueSession(worker, posted, 'sess-1');
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
    await continueSession(worker, posted, 'sess-1');
    await vi.waitUntil(() => client.pendingKeys().includes(manifestKey('proj', 'sess-1')));
    client.resolve(manifestKey('proj', 'sess-1'), client.getBuffer(manifestKey('proj', 'sess-1')));

    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);
    worker.handleMessage(syncMessage('sess-1', undefined));

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
    await continueSession(worker, posted, 'sess-1');
    await vi.waitUntil(() => client.pendingKeys().includes(manifestKey('proj', 'sess-1')));
    client.resolve(manifestKey('proj', 'sess-1'), client.getBuffer(manifestKey('proj', 'sess-1')));

    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);
    worker.handleMessage(syncMessage('sess-1', undefined));

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
    await continueSession(worker, posted, 'sess-1');
    await vi.waitUntil(() => client.pendingKeys().includes(manifestKey('proj', 'sess-1')));
    client.resolve(manifestKey('proj', 'sess-1'), client.getBuffer(manifestKey('proj', 'sess-1')));

    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);
    worker.handleMessage(syncMessage('sess-1', undefined));

    // All 6 files are queued together through the pool (no main-transcript gate).
    await vi.waitUntil(() => client.pendingKeys().length === 6);
    expect(client.maxInFlight).toBeLessThanOrEqual(8);

    worker.handleMessage(cancelMessage());
    await flush();

    await vi.waitUntil(() => client.inFlight === 0);
  });

  it('honors targetSessionIds and ignores non-target sessions', async () => {
    client.setObjectPages([
      {
        objects: [
          objectEntry(manifestKey('proj', 'sess-a')),
          objectEntry(manifestKey('proj', 'sess-b')),
          objectEntry(sessionFileKey('proj', 'sess-c', 'transcript.jsonl')),
        ],
        continuationToken: undefined,
      },
    ]);
    client.putBuffer(manifestKey('proj', 'sess-a'), encoder.encode(JSON.stringify({})).buffer);
    client.putBuffer(manifestKey('proj', 'sess-b'), encoder.encode(JSON.stringify({})).buffer);

    const { worker, posted } = createWorker(client);
    worker.handleMessage(startMessage('proj', { targetSessionIds: ['sess-b'] }));
    await continueSession(worker, posted, 'sess-b');

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

    const folder = findOne(posted, 'PROJECT_FOLDER_FOUND') as { totalSessions: number };
    expect(folder.totalSessions).toBe(1);
  });

  it('skips a session when SESSION_SYNC has sync:false and exists:false', async () => {
    const { worker, posted } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-1', manifest, downloads);

    await worker.handleMessage(startMessage('proj'));
    await continueSession(worker, posted, 'sess-1');
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    worker.handleMessage(syncMessage('sess-1', undefined, { sync: false, exists: false }));
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const complete = findOne(posted, 'SESSION_SYNC_COMPLETE') as SessionSyncCompleteMessage;
    expect(complete.files).toEqual([]);

    const done = findOne(posted, 'WORKER_DONE') as { synced: number; skipped: number };
    expect(done.synced).toBe(1);
    expect(done.skipped).toBe(0);
    expect(client.getCalls).toEqual([manifestKey('proj', 'sess-1')]);
    // D6: exactly one project-listing call, no per-session listing calls.
    expect(client.listProjectObjectsCalls).toHaveLength(1);
  });

  it('emits an unchanged summary when SESSION_SYNC has sync:false and exists:true', async () => {
    const { worker, posted } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
      { scope: 'session', relativePath: 'subagents/agent-1.jsonl', content: 'sub line\n' },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-1', manifest, downloads);

    await worker.handleMessage(startMessage('proj'));
    await continueSession(worker, posted, 'sess-1');
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
    await continueSession(worker, posted, 'sess-1');
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    worker.handleMessage(syncMessage('sess-1'));
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const fileMessages = findMessages(posted, 'SESSION_FILE_DOWNLOADED') as Array<{
      message: SessionFileDownloadedMessage;
    }>;
    const files = fileMessages.map((m) => m.message.file);
    expect(files).toContain('transcript.jsonl');
    expect(files).toContain('subagents/agent-orphan.jsonl');

    const complete = findOne(posted, 'SESSION_SYNC_COMPLETE') as SessionSyncCompleteMessage;
    const orphan = complete.files.find((f) => f.file === 'subagents/agent-orphan.jsonl');
    expect(orphan).not.toBeUndefined();
    expect(orphan?.status).toBe('downloaded');
  });

  it('SYNC-013: a session straddling two pages emits one SESSION_FOUND with a fingerprint from whichever page carried manifest.json', async () => {
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-1', manifest, downloads);

    client.setObjectPages([
      {
        objects: [objectEntry(manifestKey('proj', 'sess-1'), { etag: '"page1-etag"' })],
        continuationToken: 'token-1',
      },
      {
        objects: [objectEntry(sessionFileKey('proj', 'sess-1', 'transcript.jsonl'))],
        continuationToken: undefined,
      },
    ]);

    const { worker, posted } = createWorker(client);
    worker.handleMessage(startMessage('proj'));
    await continueSession(worker, posted, 'sess-1');
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);
    worker.handleMessage(syncMessage('sess-1', undefined));
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    expect(findMessages(posted, 'SESSION_FOUND').length).toBe(1);
    const found = findOne(posted, 'SESSION_FOUND') as { fingerprint?: ManifestFingerprint };
    expect(found.fingerprint).toEqual({ etag: '"page1-etag"' });

    const batches = findMessages(posted, 'SESSION_BATCH_FOUND') as Array<{
      message: SessionBatchFoundMessage;
    }>;
    expect(batches.length).toBe(2);
    expect(batches[0].message.sessionIds).toEqual([]);
    expect(batches[1].message.sessionIds).toEqual(['sess-1']);
    expect(batches[1].message.final).toBe(true);
  });

  it('D4: a manifest.json key that arrives after its session already finalized backfills the fingerprint (best-effort)', async () => {
    const { manifest, downloads } = await makeManifest('proj', 'sess-a', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'a main\n' },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-a', manifest, downloads);
    client.putBuffer(manifestKey('proj', 'sess-b'), encoder.encode(JSON.stringify({})).buffer);

    client.setObjectPages([
      {
        // sess-a finalizes here (no manifest.json entry yet -> fingerprint
        // undefined) when sess-b's differing key arrives.
        objects: [
          objectEntry(sessionFileKey('proj', 'sess-a', 'transcript.jsonl')),
          objectEntry(manifestKey('proj', 'sess-b')),
        ],
        continuationToken: 'token-1',
      },
      {
        // Non-contiguous: sess-a's manifest.json arrives after sess-a
        // already finalized. appendToFinalizedSession backfills the
        // fingerprint since it was still undefined.
        objects: [objectEntry(manifestKey('proj', 'sess-a'), { etag: '"late-etag"' })],
        continuationToken: undefined,
      },
    ]);

    const { worker, posted } = createWorker(client);
    worker.handleMessage(startMessage('proj'));
    await continueSession(worker, posted, 'sess-a');
    await continueSession(worker, posted, 'sess-b');
    await vi.waitUntil(() =>
      findMessages(posted, 'SESSION_MANIFEST_READY').some(
        (p) => (p.message as { sessionId: string }).sessionId === 'sess-a',
      ),
    );

    const ready = findMessages(posted, 'SESSION_MANIFEST_READY').find(
      (p) => (p.message as { sessionId: string }).sessionId === 'sess-a',
    )?.message as { fingerprint?: ManifestFingerprint };
    expect(ready.fingerprint).toEqual({ etag: '"late-etag"' });

    worker.handleMessage(cancelMessage());
  });

  it('counts a session with 3+ listing entries exactly once in SESSION_BATCH_FOUND and PROJECT_FOLDER_FOUND', async () => {
    client.setObjectPages([
      {
        objects: [
          objectEntry(manifestKey('proj', 'sess-1')),
          objectEntry(sessionFileKey('proj', 'sess-1', 'subagents/agent-1.jsonl')),
          objectEntry(sessionFileKey('proj', 'sess-1', 'transcript.jsonl')),
        ],
        continuationToken: undefined,
      },
    ]);
    const { worker, posted } = createWorker(client);
    worker.handleMessage(startMessage('proj'));
    await vi.waitUntil(() => findMessages(posted, 'PROJECT_FOLDER_FOUND').length > 0);

    const batches = findMessages(posted, 'SESSION_BATCH_FOUND') as Array<{
      message: SessionBatchFoundMessage;
    }>;
    expect(batches.length).toBe(1);
    expect(batches[0].message.sessionIds).toEqual(['sess-1']);

    const folder = findOne(posted, 'PROJECT_FOLDER_FOUND') as { totalSessions: number };
    expect(folder.totalSessions).toBe(1);

    worker.handleMessage(cancelMessage());
  });

  it('D4: a non-contiguous listing order still yields exactly one SESSION_FOUND per session id, and the late key still feeds D6', async () => {
    const { manifest: manifestA, downloads: downloadsA } = await makeManifest('proj', 'sess-a', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'a main\n' },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-a', manifestA, downloadsA);
    client.putBuffer(manifestKey('proj', 'sess-b'), encoder.encode(JSON.stringify({})).buffer);

    const lateOrphanKey = sessionFileKey('proj', 'sess-a', 'subagents/late.jsonl');
    client.putBuffer(lateOrphanKey, encoder.encode('late orphan\n').buffer);

    client.setObjectPages([
      {
        objects: [
          objectEntry(manifestKey('proj', 'sess-a')),
          objectEntry(manifestKey('proj', 'sess-b')),
          // Non-contiguous: a late sess-a key arrives after sess-b's key.
          objectEntry(lateOrphanKey),
        ],
        continuationToken: undefined,
      },
    ]);

    const { worker, posted } = createWorker(client);
    worker.handleMessage(startMessage('proj'));
    await continueSession(worker, posted, 'sess-a');
    await continueSession(worker, posted, 'sess-b');

    expect(
      findMessages(posted, 'SESSION_FOUND').filter(
        (p) => (p.message as { sessionId: string }).sessionId === 'sess-a',
      ).length,
    ).toBe(1);
    const batches = findMessages(posted, 'SESSION_BATCH_FOUND') as Array<{
      message: SessionBatchFoundMessage;
    }>;
    const allBatchedIds = batches.flatMap((b) => b.message.sessionIds);
    expect(allBatchedIds.filter((id) => id === 'sess-a').length).toBe(1);
    expect(allBatchedIds.filter((id) => id === 'sess-b').length).toBe(1);

    worker.handleMessage(syncMessage('sess-a', undefined));
    await vi.waitUntil(() => findMessages(posted, 'SESSION_SYNC_COMPLETE').length > 0);

    const fileMessages = findMessages(posted, 'SESSION_FILE_DOWNLOADED') as Array<{
      message: SessionFileDownloadedMessage;
    }>;
    expect(fileMessages.map((m) => m.message.file)).toContain('subagents/late.jsonl');

    worker.handleMessage(cancelMessage());
  });

  it('ignores keys that fail parseObjectKey — they neither start nor extend a session buffer nor appear in any count', async () => {
    client.setObjectPages([
      {
        objects: [objectEntry('not-a-valid-key'), objectEntry(manifestKey('proj', 'sess-1'))],
        continuationToken: undefined,
      },
    ]);
    const { worker, posted } = createWorker(client);
    worker.handleMessage(startMessage('proj'));
    await vi.waitUntil(() => findMessages(posted, 'PROJECT_FOLDER_FOUND').length > 0);

    const folder = findOne(posted, 'PROJECT_FOLDER_FOUND') as { totalSessions: number };
    expect(folder.totalSessions).toBe(1);
    const found = findMessages(posted, 'SESSION_FOUND') as Array<{
      message: { sessionId: string };
    }>;
    expect(found.map((m) => m.message.sessionId)).toEqual(['sess-1']);

    worker.handleMessage(cancelMessage());
  });

  it('aborts mid-listing on CANCEL: stops further SESSION_FOUND emission without throwing', async () => {
    client.enablePageGate();
    // Page 1 carries two distinct sessions so sess-a finalizes (and its
    // SESSION_FOUND fires) within page 1 itself — sess-a2's buffer is left
    // open, straddling into the gated page 2.
    client.setObjectPages([
      {
        objects: [
          objectEntry(manifestKey('proj', 'sess-a')),
          objectEntry(manifestKey('proj', 'sess-a2')),
        ],
        continuationToken: 'token-1',
      },
      { objects: [objectEntry(manifestKey('proj', 'sess-b'))], continuationToken: undefined },
    ]);
    client.putBuffer(manifestKey('proj', 'sess-a'), encoder.encode(JSON.stringify({})).buffer);
    client.putBuffer(manifestKey('proj', 'sess-a2'), encoder.encode(JSON.stringify({})).buffer);
    client.putBuffer(manifestKey('proj', 'sess-b'), encoder.encode(JSON.stringify({})).buffer);

    const { worker, posted } = createWorker(client);
    const startPromise = worker.handleMessage(startMessage('proj'));
    await vi.waitUntil(() => findMessages(posted, 'SESSION_FOUND').length > 0);

    worker.handleMessage(cancelMessage());
    client.releaseNextPage();
    await startPromise;
    await flush();

    expect(findMessages(posted, 'SESSION_FOUND').length).toBe(1);
    expect(findMessages(posted, 'WORKER_ERROR').length).toBe(0);
    expect(findMessages(posted, 'WORKER_DONE').length).toBe(0);
  });

  it('D13: a listing 5xx surfaces as exactly one WORKER_ERROR, no WORKER_DONE; sessions from earlier pages may still emit', async () => {
    // Two distinct sessions on the (only, truncated) page so sess-a finalizes
    // — and its SESSION_FOUND fires — before the next page's fetch fails.
    client.setObjectPages([
      {
        objects: [
          objectEntry(manifestKey('proj', 'sess-a')),
          objectEntry(manifestKey('proj', 'sess-a2')),
        ],
        continuationToken: 'token-1',
      },
    ]);
    client.setListingError(
      new S3Error({ status: 500, code: 'InternalError', message: 'boom', kind: 's3' }),
    );

    const { worker, posted } = createWorker(client);
    await worker.handleMessage(startMessage('proj'));

    expect(findMessages(posted, 'SESSION_FOUND').length).toBe(1);
    expect(findMessages(posted, 'WORKER_ERROR').length).toBe(1);
    expect(findMessages(posted, 'WORKER_DONE').length).toBe(0);

    worker.handleMessage(cancelMessage());
  });

  it('SYNC-013: calls listProjectObjects exactly once per project run and never a per-session listing method', async () => {
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
      { scope: 'session', relativePath: 'subagents/agent-1.jsonl', content: 'sub line\n' },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-1', manifest, downloads);

    const { worker, posted } = createWorker(client);
    worker.handleMessage(startMessage('proj'));
    await continueSession(worker, posted, 'sess-1');
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);
    worker.handleMessage(syncMessage('sess-1', undefined));
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    expect(client.listProjectObjectsCalls).toHaveLength(1);
    expect('listSessionObjects' in client).toBe(false);
    expect('listSessionFolders' in client).toBe(false);
  });

  /**
   * ## Notes — SYNC-004 progress event contract
   *
   * The session sync worker is the source of the values the UI heartbeat
   * ultimately observes. `SESSION_SYNC_PROGRESS` messages carry monotonic
   * counts and bytes, plus (since TSK0048) a per-event `timestamp`. The sync
   * manager throttles and aggregates them into `SyncManagerSnapshot`, and
   * `sync-progress-bar` renders "Projects P/T | Sessions S/T | Files D/F".
   * TSK0010's `assertHeartbeat` polls that DOM text; it does not consume a
   * structured event with a timestamp field.
   *
   * This test asserts the worker-level values are non-decreasing and that
   * `timestamp` is strictly increasing.
   */
  it('emits monotonic progress events for a multi-file session (SYNC-004)', async () => {
    const { worker, posted } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-1', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'main line\n' },
      { scope: 'session', relativePath: 'subagents/agent-1.jsonl', content: 'sub one\n' },
      { scope: 'session', relativePath: 'subagents/agent-2.jsonl', content: 'sub two\n' },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-1', manifest, downloads);

    await worker.handleMessage(startMessage('proj'));
    await continueSession(worker, posted, 'sess-1');
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    worker.handleMessage(syncMessage('sess-1', undefined));
    await vi.waitUntil(() => findMessages(posted, 'WORKER_DONE').length > 0);

    const series = extractProgressSeries(posted);
    expect(series.length).toBeGreaterThanOrEqual(2);
    assertMonotonicProgress(series);

    // TSK0048 closed this gap: SESSION_SYNC_PROGRESS now carries a per-event
    // timestamp, verified strictly increasing by assertMonotonicProgress above.
    const hasTimestamps = series.some((s) => s.timestamp !== undefined);
    expect(hasTimestamps).toBe(true);
  });
});

describe('SessionSyncWorker watchdog timers', () => {
  let client: MockS3Client;

  beforeEach(() => {
    client = new MockS3Client();
    client.setAutoResolve(true);
    vi.useRealTimers();
  });

  it('waitForSync watchdog times out when main thread never replies, emitting SESSION_SYNC_FAILED', async () => {
    const { worker } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-timeout', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'data\n' },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-timeout', manifest, downloads);

    vi.useFakeTimers();
    try {
      // @ts-expect-error — testing private waitForSync method
      const syncPromise = worker.waitForSync('sess-timeout');
      const rejection = expect(syncPromise).rejects.toThrow(
        'Timed out waiting for sync decision on session sess-timeout',
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitForContinue watchdog times out when main thread never replies, resolving to true', async () => {
    const { worker } = createWorker(client);

    vi.useFakeTimers();
    try {
      // @ts-expect-error — testing private waitForContinue method
      const continuePromise = worker.waitForContinue('sess-continue');
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await continuePromise;
      expect(result).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears pending watchdog timers on CANCEL', async () => {
    const { worker, posted } = createWorker(client);
    const { manifest, downloads } = await makeManifest('proj', 'sess-cancel', [
      { scope: 'session', relativePath: 'transcript.jsonl', content: 'data\n' },
    ]);
    await uploadProjectFiles(client, 'proj', 'sess-cancel', manifest, downloads);

    const promise = worker.handleMessage(startMessage('proj'));
    await continueSession(worker, posted, 'sess-cancel');
    await vi.waitUntil(() => findMessages(posted, 'SESSION_MANIFEST_READY').length > 0);

    // @ts-expect-error — checking private map
    expect(worker.sessionSync.size).toBe(1);

    worker.handleMessage(cancelMessage());
    await promise;

    // @ts-expect-error — checking private map
    expect(worker.sessionSync.size).toBe(0);
    // @ts-expect-error — checking private map
    expect(worker.sessionContinue.size).toBe(0);
  });
});
