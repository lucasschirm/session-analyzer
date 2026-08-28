/**
 * Session Sync Web Worker
 *
 * One worker instance per project. It lists session folders, fetches and
 * validates manifests, downloads only the requested files as transferred
 * `ArrayBuffer`s, and never touches SQLite.
 *
 * The constructor accepts an optional `S3Client` so unit tests can inject a
 * mock client. In production, the `START` message builds an `S3FetchClient`
 * from the provided in-memory credentials.
 */

import {
  buildObjectKey,
  type ManifestArtifact,
  parseObjectKey,
  parseSyncManifest,
  type S3ClientConfig,
  S3FetchClient,
  type S3GetObjectOptions,
  type S3ListObjectEntry,
  type S3ListObjectsOptions,
  type S3ListOptions,
  type S3ListPage,
  type SyncManifest,
  sha256Hex,
} from '@lucasschirm/sal-sync-core';
import type {
  FileSummary,
  FileToDownload,
  SessionFileDownloadedMessage,
  SessionSyncCompleteMessage,
  SessionSyncContinueMessage,
  SessionSyncFailedMessage,
  SessionSyncMessage,
  SessionSyncProgressMessage,
  StartMessage,
  SyncMessageFromWorker,
  SyncMessageToWorker,
} from '../sync/sync-protocol';

const SESSION_POOL_SIZE = 6;
const FILE_POOL_SIZE = 8;
const FALLBACK_MAIN_TRANSCRIPT = 'transcript.jsonl';

type PostFn = (message: SyncMessageFromWorker, transfer?: Transferable[]) => void;

/**
 * Minimal S3 client seam used by the worker. The real `S3FetchClient`
 * satisfies this interface; tests can substitute a fake implementation.
 */
export interface S3Client {
  listSessionFolders(projectId: string, options?: S3ListOptions): Promise<string[]>;
  listSessionObjects(
    projectId: string,
    sessionId: string,
    options?: S3ListObjectsOptions,
  ): Promise<S3ListObjectEntry[]>;
  getObject(key: string, options?: S3GetObjectOptions): Promise<ArrayBuffer>;
}

interface SessionSyncDecision {
  sync: boolean;
  exists: boolean;
  filesToDownload?: FileToDownload[];
  localFileEtas?: Record<string, string>;
}

interface SessionState {
  files: Array<FileToDownload & { status: 'downloaded' | 'failed' | 'unchanged' }>;
  filesFound: number;
  downloadedCount: number;
  failedCount: number;
  bytesReceived: number;
}

interface FileDownloadResult {
  status: 'downloaded' | 'failed' | 'hash-mismatch';
  code?: string;
}

interface PendingContinue {
  resolve: (sync: boolean) => void;
  reject: (error: Error) => void;
}

interface PendingSync {
  resolve: (decision: SessionSyncDecision) => void;
  reject: (error: Error) => void;
}

/**
 * Drives the per-project sync pipeline in a Web Worker.
 */
export class SessionSyncWorker {
  private client: S3Client | undefined;
  private readonly post: PostFn;
  private projectId = '';
  private connectionId = '';
  private syncOnlyNew = false;
  private targetSessionIds: Set<string> | undefined;
  private cancelled = false;
  private connected = false;
  private listingComplete = false;
  private doneEmitted = false;
  private sessionsInFlight = 0;
  private runningSessions = 0;
  private readonly counts = { synced: 0, failed: 0, skipped: 0 };
  private readonly sessionQueue: Array<() => Promise<void>> = [];
  private readonly sessionContinue = new Map<string, PendingContinue>();
  private readonly sessionSync = new Map<string, PendingSync>();
  private readonly listControllers = new Set<AbortController>();
  private readonly fileControllers = new Map<string, AbortController>();
  private readonly fileProgress = new Map<string, number>();
  private readonly sessionStates = new Map<string, SessionState>();

  constructor(post: PostFn, client?: S3Client) {
    this.post = post;
    this.client = client;
  }

  /**
   * Dispatch an incoming main→worker message.
   *
   * Never throws; worker-level errors are posted as `WORKER_ERROR`.
   */
  async handleMessage(message: SyncMessageToWorker): Promise<void> {
    try {
      switch (message.type) {
        case 'START':
          await this.handleStart(message);
          break;
        case 'SESSION_SYNC_CONTINUE':
          this.handleContinue(message);
          break;
        case 'SESSION_SYNC':
          this.handleSyncDecision(message);
          break;
        case 'CANCEL':
          await this.handleCancel();
          break;
        default: {
          const unknown = message as { type?: string };
          this.emitWorkerError(
            'UNKNOWN_MESSAGE',
            `Unknown message type: ${unknown.type ?? 'undefined'}`,
          );
        }
      }
    } catch (error) {
      if (this.cancelled) return;
      this.emitWorkerError('WORKER_ERROR', this.errorMessage(error));
    }
  }

  private async handleStart(message: StartMessage): Promise<void> {
    this.projectId = message.projectId;
    this.connectionId = message.connectionId ?? '';
    this.syncOnlyNew = message.syncOnlyNew;
    this.targetSessionIds = message.targetSessionIds
      ? new Set(message.targetSessionIds)
      : undefined;
    this.client = this.client ?? this.buildClient(message);
    await this.listProjectSessions();
  }

  private buildClient(message: StartMessage): S3Client {
    const config: S3ClientConfig = {
      accessKeyId: message.credentials.accessKeyId,
      secretAccessKey: message.credentials.secretAccessKey,
      sessionToken: message.credentials.sessionToken,
      region: message.region,
      bucket: message.bucket,
      endpoint: message.endpoint,
    };
    return new S3FetchClient(config);
  }

  private async listProjectSessions(): Promise<void> {
    if (!this.client) return;
    const controller = new AbortController();
    this.listControllers.add(controller);
    const foundSessionIds: string[] = [];
    try {
      await this.client.listSessionFolders(this.projectId, {
        signal: controller.signal,
        onPage: (page) => this.handleSessionListPage(page, foundSessionIds),
      });
      this.listingComplete = true;
      this.emitProjectFolderFound(foundSessionIds.length);
    } catch (error) {
      if (this.cancelled) return;
      throw error;
    } finally {
      this.listControllers.delete(controller);
    }
    this.checkDone();
  }

  private handleSessionListPage(page: S3ListPage, foundSessionIds: string[]): void {
    if (this.cancelled) return;
    const sessionIds = this.filterTargetSessionIds(page.prefixes);
    foundSessionIds.push(...sessionIds);
    this.markConnected();
    this.emitSessionBatch(sessionIds, page.continuationToken === undefined);
    for (const sessionId of sessionIds) this.queueSession(sessionId);
  }

  private filterTargetSessionIds(sessionIds: string[]): string[] {
    if (!this.targetSessionIds) return sessionIds;
    return sessionIds.filter((id) => this.targetSessionIds?.has(id));
  }

  private markConnected(): void {
    if (this.connected) return;
    this.connected = true;
    this.emitConnected();
  }

  private queueSession(sessionId: string): void {
    this.sessionsInFlight++;
    this.sessionQueue.push(() => this.runSession(sessionId));
    this.startNextSession();
  }

  private startNextSession(): void {
    if (this.cancelled) return;
    while (this.runningSessions < SESSION_POOL_SIZE && this.sessionQueue.length > 0) {
      this.runningSessions++;
      const run = this.sessionQueue.shift() as () => Promise<void>;
      run()
        .catch(() => undefined)
        .finally(() => {
          this.runningSessions--;
          this.sessionsInFlight--;
          this.checkDone();
          this.startNextSession();
        });
    }
  }

  private async runSession(sessionId: string): Promise<void> {
    try {
      if (this.cancelled) return;
      this.emitSessionFound(sessionId);
      if (this.syncOnlyNew) {
        const shouldSync = await this.waitForContinue(sessionId);
        if (!shouldSync) {
          this.counts.skipped++;
          return;
        }
      }
      const manifest = await this.downloadManifest(sessionId);
      if (!manifest || this.cancelled) return;
      this.emitSessionManifestReady(sessionId, manifest);
      const decision = await this.waitForSync(sessionId);
      if (this.cancelled) return;
      if (!decision.sync) {
        this.counts.synced++;
        if (decision.exists) {
          await this.emitUnchangedSummary(sessionId, manifest);
        } else {
          this.emitSyncComplete(sessionId, []);
        }
        return;
      }
      await this.downloadSessionFiles(
        sessionId,
        manifest,
        decision.filesToDownload,
        decision.localFileEtas,
      );
    } catch (error) {
      if (this.cancelled) return;
      this.counts.failed++;
      this.emitSessionFailed(sessionId, 'WORKER_ERROR', this.errorMessage(error));
    }
  }

  private waitForContinue(sessionId: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.sessionContinue.set(sessionId, { resolve, reject });
    });
  }

  private handleContinue(message: SessionSyncContinueMessage): void {
    const pending = this.sessionContinue.get(message.sessionId);
    if (pending) {
      this.sessionContinue.delete(message.sessionId);
      pending.resolve(message.sync);
    }
  }

  private waitForSync(sessionId: string): Promise<SessionSyncDecision> {
    return new Promise((resolve, reject) => {
      this.sessionSync.set(sessionId, { resolve, reject });
    });
  }

  private handleSyncDecision(message: SessionSyncMessage): void {
    const pending = this.sessionSync.get(message.sessionId);
    if (pending) {
      this.sessionSync.delete(message.sessionId);
      pending.resolve({
        sync: message.sync,
        exists: message.exists,
        filesToDownload: message.filesToDownload,
        localFileEtas: message.localFileEtas,
      });
    }
  }

  private async downloadManifest(sessionId: string): Promise<SyncManifest | undefined> {
    if (!this.client) return undefined;
    const controller = new AbortController();
    this.listControllers.add(controller);
    try {
      const key = buildObjectKey({
        projectId: this.projectId,
        sessionId,
        scope: 'manifest',
        relativePath: 'manifest.json',
      });
      const buffer = await this.client.getObject(key, { signal: controller.signal });
      const text = new TextDecoder().decode(new Uint8Array(buffer));
      const json = JSON.parse(text) as unknown;
      return parseSyncManifest(json);
    } catch (error) {
      if (this.cancelled) return undefined;
      const { code, message } = this.classifyManifestError(error);
      this.counts.failed++;
      this.emitSessionFailed(sessionId, code, message);
      return undefined;
    } finally {
      this.listControllers.delete(controller);
    }
  }

  private classifyManifestError(error: unknown): { code: string; message: string } {
    if (this.isUnsupportedSchemaError(error)) {
      return { code: 'MANIFEST_UNSUPPORTED_SCHEMA', message: this.errorMessage(error) };
    }
    if (this.isNotFoundError(error)) {
      return { code: 'MANIFEST_NOT_FOUND', message: this.errorMessage(error) };
    }
    if (this.isInvalidManifestError(error)) {
      return { code: 'MANIFEST_INVALID', message: this.errorMessage(error) };
    }
    return { code: 'MANIFEST_INVALID', message: this.errorMessage(error) };
  }

  private isUnsupportedSchemaError(error: unknown): boolean {
    return this.hasErrorCode(error) && error.code === 'MANIFEST_UNSUPPORTED_SCHEMA';
  }

  private isNotFoundError(error: unknown): boolean {
    const e = error as { status?: number; code?: string };
    return e.status === 404 || e.code === 'NoSuchKey' || e.code === 'NotFound';
  }

  private isInvalidManifestError(error: unknown): boolean {
    if (error instanceof SyntaxError) return true;
    return this.hasErrorCode(error) && error.code === 'SYNC_JSON_PARSE_FAILED';
  }

  private hasErrorCode(error: unknown): error is { code: string; message?: string } {
    return typeof (error as { code?: unknown }).code === 'string';
  }

  private async emitUnchangedSummary(sessionId: string, manifest: SyncManifest): Promise<void> {
    const files = (await this.resolveInScopeFiles(manifest, sessionId)).map((file) => ({
      ...file,
      status: 'unchanged' as const,
    }));
    this.emitSyncComplete(sessionId, files);
  }

  private async downloadSessionFiles(
    sessionId: string,
    manifest: SyncManifest,
    filesToDownload?: FileToDownload[],
    localFileEtas?: Record<string, string>,
  ): Promise<void> {
    if (this.cancelled) return;
    const files = await this.resolveRequestedFiles(
      manifest,
      filesToDownload,
      sessionId,
      localFileEtas,
    );
    if (this.cancelled) return;
    if (files.length === 0) {
      this.emitSyncComplete(sessionId, []);
      this.counts.synced++;
      return;
    }
    const state = this.createSessionState(sessionId, files);
    try {
      const mainFile = files.find((file) => file.isMainTranscript);
      const otherFiles = files.filter((file) => file !== mainFile);
      if (this.cancelled) return;
      if (mainFile) {
        const result = await this.downloadAndVerifyFile(sessionId, mainFile, state);
        if (this.cancelled) return;
        if (result.status !== 'downloaded') {
          this.counts.failed++;
          this.emitSessionFailed(
            sessionId,
            this.downloadErrorCode(result),
            'Main transcript failed',
          );
          return;
        }
      }
      if (!this.cancelled) {
        await this.downloadFilesInPool(sessionId, otherFiles, state);
      }
      if (this.cancelled) return;
      this.emitSyncComplete(sessionId, this.buildFileSummary(state));
      this.counts.synced++;
    } finally {
      this.sessionStates.delete(sessionId);
    }
  }

  private async resolveRequestedFiles(
    manifest: SyncManifest,
    filesToDownload: FileToDownload[] | undefined,
    sessionId: string,
    localFileEtas?: Record<string, string>,
  ): Promise<FileToDownload[]> {
    if (filesToDownload === undefined) {
      return this.resolveInScopeFiles(manifest, sessionId, localFileEtas);
    }
    return filesToDownload;
  }

  private async resolveInScopeFiles(
    manifest: SyncManifest,
    sessionId: string,
    localFileEtas?: Record<string, string>,
  ): Promise<FileToDownload[]> {
    const mainPath = manifest.mainTranscriptRelativePath ?? FALLBACK_MAIN_TRANSCRIPT;
    const fileMap = new Map<string, FileToDownload>();
    for (const artifact of manifest.artifacts) {
      if (this.isInScopeArtifact(artifact, mainPath)) {
        const file = this.toFileToDownload(artifact, mainPath);
        fileMap.set(file.file, file);
      }
    }
    await this.reconcileSessionFiles(fileMap, sessionId, mainPath);
    // ETag-based skip: remove files whose S3 listing ETag matches the locally
    // stored ETag. This avoids redundant GET calls for unchanged files when
    // the sync manager couldn't pre-compute filesToDownload (no manifest hashes).
    if (localFileEtas) {
      for (const [path, file] of fileMap) {
        if (file.etag && localFileEtas[path] === file.etag) {
          fileMap.delete(path);
        }
      }
    }
    return [...fileMap.values()];
  }

  private async reconcileSessionFiles(
    fileMap: Map<string, FileToDownload>,
    sessionId: string,
    mainPath: string,
  ): Promise<void> {
    if (!this.client) return;
    const controller = new AbortController();
    this.listControllers.add(controller);
    try {
      const entries = await this.client.listSessionObjects(this.projectId, sessionId, {
        signal: controller.signal,
      });
      for (const entry of entries) {
        const parsed = parseObjectKey(entry.key);
        if (parsed?.scope !== 'session' || !parsed.relativePath) continue;
        if (!this.isInScopeRelativePath(parsed.relativePath, mainPath)) continue;
        const file = this.toFileToDownloadFromListing(
          parsed.relativePath,
          entry.size ?? 0,
          mainPath,
          entry.etag,
        );
        if (!fileMap.has(file.file)) fileMap.set(file.file, file);
      }
    } finally {
      this.listControllers.delete(controller);
    }
  }

  private isInScopeArtifact(artifact: ManifestArtifact, mainPath: string): boolean {
    // Session-scoped transcripts and subagent files are always in scope.
    if (
      artifact.scope === 'session' &&
      (artifact.status === 'uploaded' || artifact.status === 'skipped') &&
      this.isInScopeRelativePath(artifact.relativePath, mainPath)
    ) {
      return true;
    }
    // Workspace/global config artifacts (MCP, settings, skills, agents, rules)
    // are needed by the transformer to populate component identities and
    // exposures. Download artifacts that were uploaded to S3 OR were skipped
    // (already in CAS from a prior session's sync). Skipped artifacts are still
    // in S3 under global/cas/<sha256> and must be downloaded to the local blob
    // store so the transformer can read them during ingestion. The ETag-based
    // skip in resolveInScopeFiles avoids redundant downloads when the local
    // blob store already has the same content.
    if (
      (artifact.scope === 'workspace' || artifact.scope === 'global') &&
      (artifact.status === 'uploaded' || artifact.status === 'skipped')
    ) {
      return true;
    }
    return false;
  }

  private isInScopeRelativePath(relativePath: string, mainPath: string): boolean {
    return relativePath === mainPath || this.isSubagentFile(relativePath);
  }

  private isSubagentFile(relativePath: string): boolean {
    return (
      /^subagents\/[^/]+\.jsonl$/.test(relativePath) ||
      /^subagents\/[^/]+\.meta\.json$/.test(relativePath)
    );
  }

  private toFileToDownload(artifact: ManifestArtifact, mainPath: string): FileToDownload {
    return {
      file:
        artifact.scope === 'session'
          ? artifact.relativePath
          : `${artifact.scope}/${artifact.relativePath}`,
      scope: artifact.scope,
      relativePath: artifact.relativePath,
      hash: artifact.sha256,
      size: artifact.size,
      isMainTranscript: artifact.relativePath === mainPath,
    };
  }

  private toFileToDownloadFromListing(
    relativePath: string,
    size: number,
    mainPath: string,
    etag?: string,
  ): FileToDownload {
    return {
      file: relativePath,
      scope: 'session',
      relativePath,
      hash: '',
      etag,
      size,
      isMainTranscript: relativePath === mainPath,
    };
  }

  private createSessionState(sessionId: string, files: FileToDownload[]): SessionState {
    const state: SessionState = {
      files: files.map((file) => ({ ...file, status: 'downloaded' as const })),
      filesFound: files.length,
      downloadedCount: 0,
      failedCount: 0,
      bytesReceived: 0,
    };
    this.sessionStates.set(sessionId, state);
    return state;
  }

  private async downloadFilesInPool(
    sessionId: string,
    files: FileToDownload[],
    state: SessionState,
  ): Promise<void> {
    if (files.length === 0) return;
    const tasks = files.map((file) => () => this.downloadAndVerifyFile(sessionId, file, state));
    await this.runWithFilePool(tasks);
  }

  private runWithFilePool(tasks: Array<() => Promise<unknown>>): Promise<void> {
    return new Promise((resolve) => {
      if (tasks.length === 0) {
        resolve();
        return;
      }
      let running = 0;
      let nextIndex = 0;
      let settled = 0;
      const total = tasks.length;
      const startNext = () => {
        while (running < FILE_POOL_SIZE && nextIndex < total && !this.cancelled) {
          running++;
          const task = tasks[nextIndex++] as () => Promise<unknown>;
          task().finally(() => {
            running--;
            settled++;
            if (this.cancelled || settled === total) {
              resolve();
              return;
            }
            startNext();
          });
        }
        if (this.cancelled) {
          resolve();
        }
      };
      startNext();
    });
  }

  private async downloadAndVerifyFile(
    sessionId: string,
    file: FileToDownload,
    state: SessionState,
  ): Promise<FileDownloadResult> {
    const controller = new AbortController();
    this.fileControllers.set(file.file, controller);
    try {
      if (!this.client) return { status: 'failed', code: 'DOWNLOAD_FAILED' };
      const key = buildObjectKey({
        projectId: this.projectId,
        sessionId,
        scope: file.scope,
        relativePath: file.relativePath,
        contentSha256: file.hash,
      });
      const buffer = await this.client.getObject(key, {
        streaming: true,
        onProgress: (bytes) => this.updateProgress(sessionId, file, bytes, state),
        signal: controller.signal,
      });
      if (this.cancelled) return { status: 'failed' };
      const actualHash = await sha256Hex(new Uint8Array(buffer));
      if (file.hash && actualHash !== file.hash.toLowerCase()) {
        file.hash = actualHash;
        this.setFileStatus(state, file, 'failed');
        this.emitProgress(sessionId, state);
        return { status: 'hash-mismatch' };
      }
      file.hash = actualHash;
      this.setFileStatus(state, file, 'downloaded');
      this.emitProgress(sessionId, state);
      this.emitFileDownloaded(sessionId, file, buffer);
      return { status: 'downloaded' };
    } catch (error) {
      if (this.cancelled) return { status: 'failed' };
      const code = this.classifyDownloadError(error);
      this.setFileStatus(state, file, 'failed');
      this.emitProgress(sessionId, state);
      return { status: 'failed', code };
    } finally {
      this.fileControllers.delete(file.file);
      this.fileProgress.delete(file.file);
    }
  }

  private setFileStatus(
    state: SessionState,
    file: FileToDownload,
    status: 'downloaded' | 'failed' | 'unchanged',
  ): void {
    const entry = state.files.find((f) => f.file === file.file);
    if (!entry) return;
    entry.status = status;
    entry.hash = file.hash;
    if (status === 'downloaded') state.downloadedCount++;
    if (status === 'failed') state.failedCount++;
  }

  private updateProgress(
    sessionId: string,
    file: FileToDownload,
    bytes: number,
    state: SessionState,
  ): void {
    const last = this.fileProgress.get(file.file) ?? 0;
    this.fileProgress.set(file.file, bytes);
    state.bytesReceived += bytes - last;
    this.emitProgress(sessionId, state);
  }

  private emitProgress(sessionId: string, state: SessionState): void {
    this.emit<SessionSyncProgressMessage['type']>('SESSION_SYNC_PROGRESS', {
      connectionId: this.connectionId,
      projectId: this.projectId,
      sessionId,
      files_found: state.filesFound,
      files_downloaded: state.downloadedCount,
      files_failed: state.failedCount,
      bytes_received: state.bytesReceived,
    });
  }

  private downloadErrorCode(result: FileDownloadResult): string {
    if (result.status === 'hash-mismatch') return 'HASH_MISMATCH';
    return result.code ?? 'DOWNLOAD_FAILED';
  }

  private classifyDownloadError(error: unknown): string {
    if (this.isStallError(error)) return 'STALL_TIMEOUT';
    if (this.isNetworkError(error)) return 'NETWORK_FAILURE';
    return 'DOWNLOAD_FAILED';
  }

  private isStallError(error: unknown): boolean {
    const e = error as { kind?: string; code?: string };
    return e.kind === 'stall' || e.code === 'StallTimeout';
  }

  private isNetworkError(error: unknown): boolean {
    const e = error as { kind?: string; code?: string };
    return (
      e.kind === 'network' ||
      e.kind === 'cors' ||
      e.code === 'NetworkTimeout' ||
      e.code === 'CORSBlocked'
    );
  }

  private buildFileSummary(state: SessionState): FileSummary[] {
    return state.files.map((file) => ({
      file: file.file,
      hash: file.hash,
      size: file.size,
      status: file.status,
    }));
  }

  private emitFileDownloaded(sessionId: string, file: FileToDownload, buffer: ArrayBuffer): void {
    this.emit<SessionFileDownloadedMessage['type']>(
      'SESSION_FILE_DOWNLOADED',
      {
        connectionId: this.connectionId,
        projectId: this.projectId,
        sessionId,
        file: file.file,
        hash: file.hash,
        etag: file.etag,
        content: buffer,
      },
      [buffer],
    );
  }

  private emitSyncComplete(sessionId: string, files: FileSummary[]): void {
    this.emit<SessionSyncCompleteMessage['type']>('SESSION_SYNC_COMPLETE', {
      connectionId: this.connectionId,
      projectId: this.projectId,
      sessionId,
      files,
    });
  }

  private emitSessionFailed(sessionId: string, code: string, message: string): void {
    this.emit<SessionSyncFailedMessage['type']>('SESSION_SYNC_FAILED', {
      connectionId: this.connectionId,
      projectId: this.projectId,
      sessionId,
      error: { code, message },
    });
  }

  private emitSessionFound(sessionId: string): void {
    this.emit('SESSION_FOUND', {
      connectionId: this.connectionId,
      projectId: this.projectId,
      sessionId,
    });
  }

  private emitSessionBatch(sessionIds: string[], final: boolean): void {
    this.emit('SESSION_BATCH_FOUND', {
      connectionId: this.connectionId,
      projectId: this.projectId,
      sessionIds,
      final,
    });
  }

  private emitProjectFolderFound(totalSessions: number): void {
    this.emit('PROJECT_FOLDER_FOUND', {
      connectionId: this.connectionId,
      projectId: this.projectId,
      totalSessions,
    });
  }

  private emitConnected(): void {
    this.emit('CONNECTED', { connectionId: this.connectionId, projectId: this.projectId });
  }

  private emitSessionManifestReady(sessionId: string, manifest: SyncManifest): void {
    this.emit('SESSION_MANIFEST_READY', {
      connectionId: this.connectionId,
      projectId: this.projectId,
      sessionId,
      manifest,
    });
  }

  private emitWorkerError(code: string, message: string): void {
    this.emit('WORKER_ERROR', {
      connectionId: this.connectionId,
      projectId: this.projectId,
      error: { code, message },
    });
  }

  private async handleCancel(): Promise<void> {
    this.cancelled = true;
    this.sessionQueue.length = 0;
    this.sessionContinue.forEach((pending) => {
      pending.reject(new Error('cancelled'));
    });
    this.sessionContinue.clear();
    this.sessionSync.forEach((pending) => {
      pending.reject(new Error('cancelled'));
    });
    this.sessionSync.clear();
    this.listControllers.forEach((controller) => {
      controller.abort();
    });
    this.listControllers.clear();
    this.fileControllers.forEach((controller) => {
      controller.abort();
    });
    this.fileControllers.clear();
  }

  private checkDone(): void {
    if (this.cancelled) return;
    if (this.doneEmitted) return;
    if (!this.listingComplete) return;
    if (this.sessionsInFlight > 0) return;
    this.doneEmitted = true;
    this.emit('WORKER_DONE', {
      connectionId: this.connectionId,
      projectId: this.projectId,
      synced: this.counts.synced,
      failed: this.counts.failed,
      skipped: this.counts.skipped,
    });
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  private emit<T extends SyncMessageFromWorker['type']>(
    type: T,
    payload: Omit<Extract<SyncMessageFromWorker, { type: T }>, 'type'>,
    transfer?: Transferable[],
  ): void {
    this.post({ type, ...payload } as SyncMessageFromWorker, transfer);
  }
}

let workerInstance: SessionSyncWorker | undefined;

self.onmessage = (event: MessageEvent<SyncMessageToWorker>) => {
  if (!workerInstance) {
    workerInstance = new SessionSyncWorker((message, transfer) => {
      const options = transfer ? ({ transfer } as StructuredSerializeOptions) : undefined;
      self.postMessage(message, options);
    });
  }
  workerInstance.handleMessage(event.data).catch((error) => {
    if (typeof console !== 'undefined') {
      console.error('Sync worker fatal error:', error);
    }
  });
};
