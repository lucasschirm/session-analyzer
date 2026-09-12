/**
 * Session Sync Web Worker
 *
 * One worker instance per project. It derives session ids and manifest
 * fingerprints from a single non-delimited project object listing, fetches
 * and validates manifests, downloads only the requested files as transferred
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
  type S3ListObjectsPage,
  type SyncManifest,
  sha256Hex,
} from '@lucasschirm/sal-sync-core';
import type {
  FileSummary,
  FileToDownload,
  LocalFileHash,
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
import type { ManifestFingerprint } from '../types';

const SESSION_POOL_SIZE = 6;
const FILE_POOL_SIZE = 8;
const FALLBACK_MAIN_TRANSCRIPT = 'transcript.jsonl';

type PostFn = (message: SyncMessageFromWorker, transfer?: Transferable[]) => void;

/**
 * Minimal S3 client seam used by the worker. The real `S3FetchClient`
 * satisfies this interface; tests can substitute a fake implementation.
 */
export interface S3Client {
  listProjectObjects(
    projectId: string,
    options?: S3ListObjectsOptions,
  ): Promise<S3ListObjectEntry[]>;
  getObject(key: string, options?: S3GetObjectOptions): Promise<ArrayBuffer>;
}

/** Buffered entries and derived fingerprint for one finalized session. */
interface SessionListingData {
  entries: S3ListObjectEntry[];
  fingerprint: ManifestFingerprint | undefined;
}

interface SessionSyncDecision {
  sync: boolean;
  exists: boolean;
  localFileHashes?: Record<string, LocalFileHash>;
}

interface SessionState {
  files: Array<
    FileToDownload & {
      status: 'downloaded' | 'failed' | 'unchanged';
      code?: string;
    }
  >;
  filesFound: number;
  downloadedCount: number;
  failedCount: number;
  bytesReceived: number;
}

interface FileDownloadResult {
  status: 'downloaded' | 'failed' | 'hash-mismatch';
  code?: string;
}

const MAIN_THREAD_TIMEOUT_MS = 30_000;

interface PendingContinue {
  resolve: (sync: boolean) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface PendingSync {
  resolve: (decision: SessionSyncDecision) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
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
  // Monotonic within this worker instance only — not globally ordered across
  // the parallel SessionSyncWorker instances SyncManager spawns per project.
  private lastProgressTimestampMs = 0;
  private readonly sessionStates = new Map<string, SessionState>();
  // D4 session-discovery buffering: the currently-open contiguous run of
  // listing entries for one session id, flushed when a different session id
  // arrives or the listing completes.
  private currentBufferSessionId: string | undefined;
  private currentBufferEntries: S3ListObjectEntry[] = [];
  // Session ids whose buffer has already been finalized (flushed). A later,
  // non-contiguous key for a finalized id is appended to its stored entries
  // but never re-finalized, re-emitted, or re-queued.
  private readonly finalizedSessionIds = new Set<string>();
  // Populated at finalize time; cleared per session by runSession's finally.
  // A session starts downloading (and reconcileSessionFiles reads this map)
  // as soon as its buffer finalizes, independent of overall listing progress
  // — so on a non-contiguous (non-AWS-compatible) endpoint, a late key for an
  // already-downloading session is a best-effort addition, not a guarantee;
  // standard AWS S3 never reorders same-prefix keys, so this only matters off
  // AWS. See appendToFinalizedSession.
  private readonly sessionListingData = new Map<string, SessionListingData>();

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
      await this.client.listProjectObjects(this.projectId, {
        signal: controller.signal,
        onPage: (page) => this.handleObjectListingPage(page, foundSessionIds),
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

  /**
   * Handle one page of the non-delimited project object listing (D4). Keys
   * arrive in lexicographic order, so a session's keys are contiguous; this
   * buffers them and finalizes (flushes) a session when a different session
   * id arrives, or — on the last page — once every entry has been buffered.
   */
  private handleObjectListingPage(page: S3ListObjectsPage, foundSessionIds: string[]): void {
    if (this.cancelled) return;
    const isLastPage = page.continuationToken === undefined;
    const finalizedIds = this.bufferPageEntries(page.objects, isLastPage);
    foundSessionIds.push(...finalizedIds);
    this.markConnected();
    this.emitSessionBatch(finalizedIds, isLastPage);
    for (const sessionId of finalizedIds) this.queueSession(sessionId);
  }

  private bufferPageEntries(objects: S3ListObjectEntry[], isLastPage: boolean): string[] {
    const finalized: string[] = [];
    for (const entry of objects) {
      const id = this.processListingEntry(entry);
      if (id !== undefined) finalized.push(id);
    }
    if (isLastPage) {
      const last = this.finalizeCurrentBuffer();
      if (last !== undefined) finalized.push(last);
    }
    return finalized;
  }

  /**
   * Buffer a single listing entry. Returns the session id that got
   * finalized as a side effect (a different session id arrived while a
   * buffer was open), or `undefined` when no finalize happened.
   */
  private processListingEntry(entry: S3ListObjectEntry): string | undefined {
    const sessionId = parseObjectKey(entry.key)?.sessionId;
    if (!sessionId) return undefined;
    if (this.finalizedSessionIds.has(sessionId)) {
      this.appendToFinalizedSession(sessionId, entry);
      return undefined;
    }
    if (this.currentBufferSessionId !== undefined && this.currentBufferSessionId !== sessionId) {
      const finalizedId = this.finalizeCurrentBuffer();
      this.openBuffer(sessionId, entry);
      return finalizedId;
    }
    this.openBuffer(sessionId, entry);
    return undefined;
  }

  /**
   * A non-contiguous listing order (D4) can deliver a session's manifest.json
   * key after that session already finalized. Append the entry to its stored
   * buffer, and — since the fingerprint (D1) is otherwise only computed once,
   * at finalize time — backfill it here too so a late manifest key is not
   * silently lost. Once a session starts downloading its files, whether this
   * late key arrives before `reconcileSessionFiles` reads the buffer depends
   * on page-fetch timing relative to the session's own manifest/download
   * latency; standard AWS S3 never reorders same-prefix keys, so this path
   * exists only for non-AWS-compatible endpoints, where it is best-effort.
   */
  private appendToFinalizedSession(sessionId: string, entry: S3ListObjectEntry): void {
    const data = this.sessionListingData.get(sessionId);
    if (!data) return;
    data.entries.push(entry);
    if (data.fingerprint !== undefined) return;
    const parsed = parseObjectKey(entry.key);
    if (parsed?.scope === 'manifest' && parsed.relativePath === 'manifest.json') {
      data.fingerprint = { etag: entry.etag, lastModified: entry.lastModified };
    }
  }

  private openBuffer(sessionId: string, entry: S3ListObjectEntry): void {
    if (this.currentBufferSessionId !== sessionId) {
      this.currentBufferSessionId = sessionId;
      this.currentBufferEntries = [];
    }
    this.currentBufferEntries.push(entry);
  }

  /**
   * Flush the currently-open buffer, applying `targetSessionIds` filtering
   * (D4). Returns the finalized session id when it passed the filter (and
   * should be queued/counted), or `undefined` when there was no open buffer
   * or it was filtered out (discarded, never queued or counted).
   */
  private finalizeCurrentBuffer(): string | undefined {
    const sessionId = this.currentBufferSessionId;
    if (sessionId === undefined) return undefined;
    const entries = this.currentBufferEntries;
    this.currentBufferSessionId = undefined;
    this.currentBufferEntries = [];
    this.finalizedSessionIds.add(sessionId);
    if (!this.passesTargetFilter(sessionId)) return undefined;
    this.sessionListingData.set(sessionId, {
      entries,
      fingerprint: this.extractFingerprint(entries),
    });
    return sessionId;
  }

  private passesTargetFilter(sessionId: string): boolean {
    return !this.targetSessionIds || this.targetSessionIds.has(sessionId);
  }

  /** D1 fingerprint: the manifest.json entry's raw etag/lastModified, or undefined. */
  private extractFingerprint(entries: S3ListObjectEntry[]): ManifestFingerprint | undefined {
    for (const entry of entries) {
      const parsed = parseObjectKey(entry.key);
      if (parsed?.scope === 'manifest' && parsed.relativePath === 'manifest.json') {
        return { etag: entry.etag, lastModified: entry.lastModified };
      }
    }
    return undefined;
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
      // D3: every run now awaits SESSION_SYNC_CONTINUE, not only syncOnlyNew
      // runs; the 30s watchdog in waitForContinue still resolves to true.
      const shouldSync = await this.waitForContinue(sessionId);
      if (!shouldSync) {
        this.counts.skipped++;
        return;
      }
      await this.runSessionManifestPhase(sessionId);
    } catch (error) {
      if (this.cancelled) return;
      this.counts.failed++;
      this.emitSessionFailed(sessionId, 'WORKER_ERROR', this.errorMessage(error));
    } finally {
      // Every exit path (skip, manifest failure/cancel, sync decision, or
      // normal completion) releases this session's buffered listing data.
      this.sessionListingData.delete(sessionId);
    }
  }

  private async runSessionManifestPhase(sessionId: string): Promise<void> {
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
    await this.downloadSessionFiles(sessionId, manifest, decision.localFileHashes);
  }

  private waitForContinue(sessionId: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.sessionContinue.delete(sessionId);
        resolve(true);
      }, MAIN_THREAD_TIMEOUT_MS);
      this.sessionContinue.set(sessionId, {
        resolve: (sync) => {
          clearTimeout(timer);
          resolve(sync);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      });
    });
  }

  private handleContinue(message: SessionSyncContinueMessage): void {
    const pending = this.sessionContinue.get(message.sessionId);
    if (pending) {
      this.sessionContinue.delete(message.sessionId);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(message.sync);
    }
  }

  private waitForSync(sessionId: string): Promise<SessionSyncDecision> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.sessionSync.delete(sessionId);
        reject(new Error(`Timed out waiting for sync decision on session ${sessionId}`));
      }, MAIN_THREAD_TIMEOUT_MS);
      this.sessionSync.set(sessionId, {
        resolve: (decision) => {
          clearTimeout(timer);
          resolve(decision);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      });
    });
  }

  private handleSyncDecision(message: SessionSyncMessage): void {
    const pending = this.sessionSync.get(message.sessionId);
    if (pending) {
      this.sessionSync.delete(message.sessionId);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve({
        sync: message.sync,
        exists: message.exists,
        localFileHashes: message.localFileHashes,
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
    localFileHashes?: Record<string, LocalFileHash>,
  ): Promise<void> {
    if (this.cancelled) return;
    const files = await this.resolveRequestedFiles(manifest, sessionId, localFileHashes);
    if (this.cancelled) return;
    if (files.length === 0) {
      this.emitSyncComplete(sessionId, []);
      this.counts.synced++;
      return;
    }
    const state = this.createSessionState(sessionId, files);
    try {
      // All files go through the download pool together — no main-transcript
      // gate. A main transcript failure does not prevent sibling files from
      // downloading. The main transcript status is inspected at completion to
      // determine session viability.
      if (!this.cancelled) {
        await this.downloadFilesInPool(sessionId, files, state);
      }
      if (this.cancelled) return;
      const mainFile = files.find((file) => file.isMainTranscript);
      const mainResult = mainFile ? state.files.find((f) => f.file === mainFile.file) : undefined;
      if (mainResult && mainResult.status === 'failed') {
        this.counts.failed++;
        this.emitSessionFailed(
          sessionId,
          this.mainTranscriptErrorCode(mainResult),
          'Main transcript failed',
        );
        return;
      }
      this.emitSyncComplete(sessionId, this.buildFileSummary(state));
      this.counts.synced++;
    } finally {
      this.sessionStates.delete(sessionId);
    }
  }

  private async resolveRequestedFiles(
    manifest: SyncManifest,
    sessionId: string,
    localFileHashes?: Record<string, LocalFileHash>,
  ): Promise<FileToDownload[]> {
    return this.resolveInScopeFiles(manifest, sessionId, localFileHashes);
  }

  private async resolveInScopeFiles(
    manifest: SyncManifest,
    sessionId: string,
    localFileHashes?: Record<string, LocalFileHash>,
  ): Promise<FileToDownload[]> {
    const mainPath = manifest.mainTranscriptRelativePath ?? FALLBACK_MAIN_TRANSCRIPT;
    const fileMap = new Map<string, FileToDownload>();
    for (const artifact of manifest.artifacts) {
      if (this.isInScopeArtifact(artifact, mainPath)) {
        const file = this.toFileToDownload(artifact, mainPath);
        fileMap.set(file.file, file);
      }
    }
    this.reconcileSessionFiles(fileMap, sessionId, mainPath);
    // Hash-based skip: remove files whose local SHA-256 matches the manifest
    // hash and whose status is 'processed'. Files with a different hash, a
    // non-processed status (e.g. 'failed'), or no local entry are downloaded.
    if (localFileHashes) {
      for (const [path, file] of fileMap) {
        const local = localFileHashes[path];
        if (local && local.sha256 === file.hash && local.status === 'processed') {
          fileMap.delete(path);
        }
      }
    }
    return [...fileMap.values()];
  }

  /**
   * D6: feed session-scoped files from the buffered project-listing entries
   * (populated at discovery finalize time) instead of a redundant per-session
   * listing call.
   */
  private reconcileSessionFiles(
    fileMap: Map<string, FileToDownload>,
    sessionId: string,
    mainPath: string,
  ): void {
    const entries = this.sessionListingData.get(sessionId)?.entries ?? [];
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
        if (this.isTranscriptFile(file) && this.isParsableTranscript(buffer)) {
          file.hash = actualHash;
          this.setFileStatus(state, file, 'downloaded');
          this.emitProgress(sessionId, state);
          this.emitFileDownloaded(sessionId, file, buffer);
          return { status: 'downloaded' };
        }
        file.hash = actualHash;
        this.setFileStatus(state, file, 'failed', 'HASH_MISMATCH');
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
      this.setFileStatus(state, file, 'failed', code);
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
    code?: string,
  ): void {
    const entry = state.files.find((f) => f.file === file.file);
    if (!entry) return;
    entry.status = status;
    entry.code = code;
    entry.hash = file.hash;
    if (status === 'downloaded') state.downloadedCount++;
    if (status === 'failed') state.failedCount++;
  }

  private mainTranscriptErrorCode(mainResult: SessionState['files'][number]): string {
    if (mainResult.code) return mainResult.code;
    return 'DOWNLOAD_FAILED';
  }

  private isTranscriptFile(file: FileToDownload): boolean {
    if (file.isMainTranscript) return true;
    const path = file.relativePath.toLowerCase();
    return (
      path.endsWith('.jsonl') ||
      path.endsWith('/transcript.json') ||
      path === 'transcript.json' ||
      path.includes('subagents/')
    );
  }

  private isParsableTranscript(buffer: ArrayBuffer): boolean {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      const trimmed = text.trim();
      if (!trimmed) return false;

      // 1. Single JSON document check (e.g. ATIF or Antigravity JSON transcripts)
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'object' && parsed !== null) {
          return true;
        }
      } catch {
        // Not a single JSON document, continue to JSONL check
      }

      // 2. JSON Lines (JSONL) check
      const lines = trimmed
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      if (lines.length === 0) return false;

      let validCount = 0;
      let invalidCount = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        try {
          const obj = JSON.parse(line);
          if (typeof obj === 'object' && obj !== null) {
            validCount++;
          } else {
            invalidCount++;
          }
        } catch {
          // Tolerate trailing incomplete line if earlier lines are valid JSON entries
          // (e.g., interrupted stream or append in progress)
          if (i === lines.length - 1 && validCount > 0) {
            // Trailing cut-off line
          } else {
            invalidCount++;
          }
        }
      }

      return validCount > 0 && invalidCount === 0;
    } catch {
      return false;
    }
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
    const ms = Math.max(Date.now(), this.lastProgressTimestampMs + 1);
    this.lastProgressTimestampMs = ms;
    this.emit<SessionSyncProgressMessage['type']>('SESSION_SYNC_PROGRESS', {
      connectionId: this.connectionId,
      projectId: this.projectId,
      sessionId,
      files_found: state.filesFound,
      files_downloaded: state.downloadedCount,
      files_failed: state.failedCount,
      bytes_received: state.bytesReceived,
      timestamp: new Date(ms).toISOString(),
    });
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
      fingerprint: this.sessionListingData.get(sessionId)?.fingerprint,
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
      fingerprint: this.sessionListingData.get(sessionId)?.fingerprint,
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
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error('cancelled'));
    });
    this.sessionContinue.clear();
    this.sessionSync.forEach((pending) => {
      if (pending.timer) clearTimeout(pending.timer);
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
