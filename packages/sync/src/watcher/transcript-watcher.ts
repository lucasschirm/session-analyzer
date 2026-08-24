import { Buffer } from 'node:buffer';
import type { Stats } from 'node:fs';
import fs, { createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import type {
  ArtifactIdentity,
  PutObjectInput,
  StorageAdapter,
  SyncConfig,
} from '@lucasschirm/sal-sync-core';
import { StorageError } from '@lucasschirm/sal-sync-core';
import { loadConfig } from '../config/index.js';
import { isTranscriptJsonl, processDelta, selectSanitizer } from '../hashing/index.js';
import { normalizeTranscriptDelta } from '../sanitization/index.js';
import { StateStore } from '../state/index.js';
import { S3StorageAdapter } from '../storage/index.js';

import {
  createWatcherMatcher,
  getWatchedRelativePath,
  isPathWatched,
  toStorageRelativePath,
} from './matcher.js';
import {
  getWatcherStatePath,
  readWatcherOffsets,
  type WatcherFileOffset,
  writeWatcherOffsets,
} from './offsets.js';
import {
  isProcessAlive,
  readWatcherPidFile,
  removeWatcherPidFile,
  writeWatcherPidFile,
} from './pid.js';

export interface WatchTranscriptsOptions {
  dataDir: string;
  sessionId: string;
  transcriptPath: string;
  /** Project root (session cwd) used to strip machine-specific path prefixes
   * from uploaded transcript deltas. */
  cwd?: string;
  env?: Record<string, string | undefined>;
  ownerPid?: number;
  storageAdapter?: StorageAdapter;
  debounceMs?: number;
  pollIntervalMs?: number;
  livenessIntervalMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_LIVENESS_INTERVAL_MS = 5000;
const WAIT_FOR_DEATH_TIMEOUT_MS = 2000;
const WAIT_FOR_DEATH_INTERVAL_MS = 100;

function contentTypeFor(relativePath: string): string {
  if (relativePath.endsWith('.jsonl')) {
    return 'application/x-jsonlines';
  }
  if (relativePath.endsWith('.json')) {
    return 'application/json';
  }
  return 'text/plain';
}

function buildStorageAdapter(config: SyncConfig): StorageAdapter {
  if (config.storage.type === 's3') {
    return new S3StorageAdapter(config.storage, { retries: config.retries });
  }
  throw new StorageError(
    'SYNC_CONFIG_MISSING',
    `Unsupported storage type: ${config.storage.type}`,
    false,
  );
}

function buildUploader(adapter: StorageAdapter, timeoutMs: number) {
  return async (artifact: ArtifactIdentity, content: string): Promise<void> => {
    const body = Buffer.from(content, 'utf8');
    const putPromise = adapter.putObject({
      projectId: artifact.projectId,
      sessionId: artifact.sessionId,
      scope: artifact.scope,
      relativePath: artifact.relativePath,
      body,
      contentType: contentTypeFor(artifact.relativePath),
      contentSha256: artifact.sha256,
    } as PutObjectInput);

    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(
          new StorageError('SYNC_NETWORK_TIMEOUT', `Upload timed out after ${timeoutMs}ms`, true),
        );
      }, timeoutMs);
      putPromise.finally(() => clearTimeout(timer)).catch(() => {});
    });

    await Promise.race([putPromise, timeoutPromise]);
  };
}

async function readFileDelta(filePath: string, start: number, end: number): Promise<string> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, { start, end: end - 1 });
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return Buffer.concat(chunks).toString('utf8');
}

async function waitForProcessDeath(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_FOR_DEATH_INTERVAL_MS));
  }
}

export class TranscriptWatcher {
  private readonly dataDir: string;
  private readonly sessionId: string;
  private readonly transcriptPath: string;
  private readonly projectRoot?: string;
  private readonly env: Record<string, string | undefined>;
  private readonly ownerPid?: number;
  private storageAdapter?: StorageAdapter;
  private readonly debounceMs: number;
  private readonly pollIntervalMs: number;
  private readonly livenessIntervalMs: number;

  private config?: SyncConfig;
  private stateStore?: StateStore;
  private uploader?: (artifact: ArtifactIdentity, content: string) => Promise<void>;
  private baseDir?: string;
  private matcher?: ReturnType<typeof createWatcherMatcher>;
  private offsets: Record<string, WatcherFileOffset> = {};
  private pending = new Set<string>();
  private stopped = false;
  private stopping = false;
  private isFirstPoll = true;
  private stopResolve?: () => void;
  private stopPromise: Promise<void>;
  private debounceTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private livenessTimer?: NodeJS.Timeout;
  private fsWatchers: fs.FSWatcher[] = [];
  private watchedDirs = new Set<string>();
  private processing = false;

  constructor(options: WatchTranscriptsOptions) {
    this.dataDir = options.dataDir;
    this.sessionId = options.sessionId;
    this.transcriptPath = options.transcriptPath;
    this.projectRoot = options.cwd;
    this.env = options.env ?? process.env;
    this.ownerPid = options.ownerPid;
    this.storageAdapter = options.storageAdapter;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.livenessIntervalMs = options.livenessIntervalMs ?? DEFAULT_LIVENESS_INTERVAL_MS;
    this.stopPromise = new Promise<void>((resolve) => {
      this.stopResolve = resolve;
    });
  }

  async start(): Promise<void> {
    if (this.stopped) {
      throw new Error('Watcher has already been stopped');
    }

    const configResult = loadConfig(this.env);
    if (!configResult.ok) {
      if (configResult.disabled) {
        this.stopped = true;
        this.stopResolve?.();
        return;
      }
      throw new Error(configResult.error?.message ?? 'Invalid sync configuration');
    }

    this.config = configResult.config;

    if (!this.config.captureTranscripts) {
      this.stopped = true;
      this.stopResolve?.();
      return;
    }

    this.stateStore = new StateStore(this.dataDir);
    await this.stateStore.ensureDirectories();

    this.baseDir = path.dirname(path.resolve(this.transcriptPath));
    this.matcher = createWatcherMatcher(this.baseDir, this.sessionId);

    await this.acquireWatcherPidFile();

    this.offsets = await this.loadOffsets();

    this.storageAdapter = this.storageAdapter ?? buildStorageAdapter(this.config);
    this.uploader = buildUploader(this.storageAdapter, this.config.timeouts.hookUploadTimeoutMs);

    this.setupWatchers();
    await this.scanFiles();
    this.setupLivenessCheck();

    return this.stopPromise;
  }

  async stop(): Promise<void> {
    if (this.stopped || this.stopping) {
      return;
    }
    this.stopping = true;

    this.clearTimers();
    this.closeWatchers();

    try {
      await this.flush();
    } finally {
      if (this.stateStore) {
        await this.saveOffsets();
      }
      await removeWatcherPidFile(this.dataDir, this.sessionId);
      this.stopped = true;
      this.stopping = false;
      this.stopResolve?.();
    }
  }

  private async acquireWatcherPidFile(): Promise<void> {
    const existing = await readWatcherPidFile(this.dataDir, this.sessionId);
    if (existing && existing.pid !== process.pid) {
      if (isProcessAlive(existing.pid)) {
        try {
          process.kill(existing.pid, 'SIGTERM');
        } catch {
          // already gone
        }
        await waitForProcessDeath(existing.pid, WAIT_FOR_DEATH_TIMEOUT_MS);
      }
    }
    await writeWatcherPidFile(this.dataDir, this.sessionId, process.pid, this.ownerPid);
  }

  private async loadOffsets(): Promise<Record<string, WatcherFileOffset>> {
    return readWatcherOffsets(getWatcherStatePath(this.dataDir, this.sessionId));
  }

  private async saveOffsets(): Promise<void> {
    await writeWatcherOffsets(getWatcherStatePath(this.dataDir, this.sessionId), this.offsets);
  }

  private setupWatchers(): void {
    if (!this.baseDir) {
      this.schedulePoll();
      return;
    }

    if (fs.existsSync(this.baseDir)) {
      this.watchDirectory(this.baseDir);
    }

    const sessionDir = path.join(this.baseDir, this.sessionId);
    const subagentsDir = path.join(sessionDir, 'subagents');
    if (fs.existsSync(sessionDir) && fs.statSync(sessionDir).isDirectory()) {
      this.watchDirectory(sessionDir);
    }
    if (fs.existsSync(subagentsDir) && fs.statSync(subagentsDir).isDirectory()) {
      this.watchDirectory(subagentsDir);
    }

    this.schedulePoll();
  }

  private watchDirectory(dirPath: string): void {
    if (this.watchedDirs.has(dirPath)) {
      return;
    }

    try {
      const watcher = fs.watch(dirPath, (event, filename) => {
        if (this.stopped) {
          return;
        }
        if (filename === null) {
          // Some platforms report a generic change; rescan everything.
          void this.scanFiles();
          return;
        }

        const filePath = path.join(dirPath, filename);
        void this.handleFileEvent(filePath);

        if (event !== 'rename' || !this.baseDir) {
          return;
        }

        const sessionDir = path.join(this.baseDir, this.sessionId);
        const subagentsDir = path.join(sessionDir, 'subagents');

        // Watch the per-session directory when it appears in the project dir.
        if (dirPath === this.baseDir && filename === this.sessionId) {
          if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
            this.watchDirectory(filePath);
            if (fs.existsSync(subagentsDir) && fs.statSync(subagentsDir).isDirectory()) {
              this.watchDirectory(subagentsDir);
            }
            void this.scanFiles();
          }
          return;
        }

        // Watch the per-session subagents directory when it appears.
        if (dirPath === sessionDir && filename === 'subagents') {
          if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
            this.watchDirectory(filePath);
            void this.scanFiles();
          }
          return;
        }

        // If a subagent file inside the per-session subagents dir appears,
        // scanFiles will pick it up through the existing poll.
      });

      watcher.on('error', (err) => {
        if (!this.stopped) {
          console.error(`Watcher error for ${dirPath}: ${(err as Error).message}`);
          void this.stop();
        }
      });

      this.fsWatchers.push(watcher);
      this.watchedDirs.add(dirPath);
    } catch {
      // best effort: fall back to polling
    }
  }

  private async handleFileEvent(filePath: string): Promise<void> {
    if (!this.matcher) {
      return;
    }

    try {
      const stat = await fsp.stat(filePath).catch(() => undefined);
      if (stat?.isFile() && isPathWatched(this.matcher, filePath)) {
        const relative = getWatchedRelativePath(this.matcher, filePath);
        if (relative) {
          this.addPending(relative);
        }
      }
    } catch {
      // transient file; ignore
    }
  }

  private schedulePoll(): void {
    if (this.stopped) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      void this.scanFiles().finally(() => this.schedulePoll());
    }, this.pollIntervalMs);
  }

  private setupLivenessCheck(): void {
    if (this.stopped) {
      return;
    }
    this.livenessTimer = setTimeout(() => {
      void this.checkLiveness();
    }, this.livenessIntervalMs);
  }

  private async checkLiveness(): Promise<void> {
    if (this.stopped) {
      return;
    }

    const pidFile = await readWatcherPidFile(this.dataDir, this.sessionId);

    // If the PID file no longer belongs to us, another watcher/SessionStart has
    // taken over and we should exit.
    if (pidFile && pidFile.pid !== process.pid) {
      await this.stop();
      return;
    }

    // If an owner was provided and is now gone, exit.
    if (this.ownerPid !== undefined && !isProcessAlive(this.ownerPid)) {
      await this.stop();
      return;
    }

    // If the session has ended, the watcher no longer has work to do.
    if (this.stateStore) {
      const session = await this.stateStore.getSession(this.sessionId).catch(() => undefined);
      if (session?.endedAt) {
        await this.stop();
        return;
      }
    }

    this.setupLivenessCheck();
  }

  private clearTimers(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.livenessTimer) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = undefined;
    }
  }

  private closeWatchers(): void {
    for (const watcher of this.fsWatchers) {
      try {
        watcher.close();
      } catch {
        // best effort
      }
    }
    this.fsWatchers = [];
    this.watchedDirs.clear();
  }

  private addPending(relativePath: string): void {
    if (this.stopped) {
      return;
    }
    this.pending.add(relativePath);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.flush();
    }, this.debounceMs);
  }

  private async flush(): Promise<void> {
    if (this.processing || this.stopped) {
      return;
    }
    this.processing = true;

    try {
      while (this.pending.size > 0 && !this.stopped) {
        const relative = this.pending.values().next().value as string;
        this.pending.delete(relative);
        await this.processFile(relative);
      }
    } finally {
      this.processing = false;
    }
  }

  private async scanFiles(): Promise<void> {
    if (this.stopped || !this.matcher || !this.baseDir) {
      return;
    }

    const base = this.baseDir;
    const mainTranscript = path.join(base, `${this.sessionId}.jsonl`);
    const sessionDir = path.join(base, this.sessionId);
    const subagents = path.join(sessionDir, 'subagents');

    if (fs.existsSync(subagents) && fs.statSync(subagents).isDirectory()) {
      this.watchDirectory(subagents);
    }

    const entries: string[] = [];

    try {
      const stat = await fsp.stat(mainTranscript);
      if (stat.isFile()) {
        entries.push(mainTranscript);
      }
    } catch {
      // Main transcript may not exist yet.
    }

    try {
      const subEntries = await fsp.readdir(subagents, { withFileTypes: true });
      for (const entry of subEntries) {
        if (entry.isFile()) {
          entries.push(path.join(subagents, entry.name));
        }
      }
    } catch {
      // subagents may not exist yet.
    }

    for (const filePath of entries) {
      const relative = getWatchedRelativePath(this.matcher, filePath);
      if (!relative) {
        continue;
      }

      let stat: Stats | undefined;
      try {
        stat = await fsp.stat(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }

      const current = this.offsets[relative];

      if (current === undefined) {
        if (this.isFirstPoll) {
          // File already existed when the watcher started; avoid re-uploading.
          this.offsets[relative] = { offset: stat.size, lastProcessedSize: stat.size };
        } else {
          // New file detected after start; process from the beginning.
          this.offsets[relative] = { offset: 0, lastProcessedSize: stat.size };
          this.addPending(relative);
        }
        continue;
      }

      if (stat.size > current.lastProcessedSize) {
        current.lastProcessedSize = stat.size;
        this.addPending(relative);
      } else if (stat.size < current.lastProcessedSize) {
        current.offset = 0;
        current.lastProcessedSize = stat.size;
        this.addPending(relative);
      }
    }

    // Remove offsets for files that no longer exist.
    for (const relative of Object.keys(this.offsets)) {
      const filePath = path.join(base, relative);
      try {
        const stat = await fsp.stat(filePath);
        if (!stat.isFile()) {
          delete this.offsets[relative];
        }
      } catch {
        delete this.offsets[relative];
      }
    }

    this.isFirstPoll = false;
  }

  private async processFile(relativePath: string): Promise<void> {
    if (!this.matcher || !this.baseDir || !this.config || !this.uploader || !this.stateStore) {
      return;
    }

    const config = this.config;
    const uploader = this.uploader;

    const filePath = path.join(this.baseDir, relativePath);
    let stat: Stats;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      delete this.offsets[relativePath];
      return;
    }
    if (!stat.isFile()) {
      delete this.offsets[relativePath];
      return;
    }

    const maxTranscriptBytes = config.limits.maxTranscriptBytes;
    if (!this.offsets[relativePath]) {
      this.offsets[relativePath] = { offset: 0, lastProcessedSize: stat.size };
    }
    const fileState = this.offsets[relativePath] as WatcherFileOffset;
    const targetSize = Math.min(stat.size, maxTranscriptBytes);

    if (fileState.offset >= targetSize) {
      fileState.lastProcessedSize = stat.size;
      return;
    }

    const delta = await readFileDelta(filePath, fileState.offset, targetSize);
    // Strip the machine-specific project-root prefix so uploaded paths are
    // portable. Limited to complete lines: a delta may end mid-line while the
    // writer is still appending, and a prefix at the end of such a fragment
    // cannot be boundary-checked safely (see normalizeTranscriptDelta).
    const normalizedDelta = isTranscriptJsonl(relativePath, 'session')
      ? normalizeTranscriptDelta(delta, this.projectRoot, os.homedir())
      : delta;
    const sanitizer = selectSanitizer(relativePath, 'session');
    const sanitized = sanitizer(normalizedDelta);

    // Convert the filesystem-relative path (which includes the <sessionId>/
    // prefix) to a storage-relative path so the sessionId is not repeated in
    // the S3 key.
    const storageRelativePath = toStorageRelativePath(this.sessionId, relativePath);

    try {
      const result = await this.stateStore.withState((state) =>
        processDelta({
          state,
          trigger: 'file-changed',
          candidates: [
            {
              projectId: config.projectId,
              sessionId: this.sessionId,
              scope: 'session',
              relativePath: storageRelativePath,
              content: sanitized,
              sanitizer: (content) => content,
            },
          ],
          uploader,
          targetRelativePath: storageRelativePath,
          transcriptsCaptured: true,
        }),
      );

      const uploaded = result.uploaded.some(
        (a) => a.scope === 'session' && a.relativePath === storageRelativePath,
      );
      const failed = result.failed.some(
        (a) => a.scope === 'session' && a.relativePath === storageRelativePath,
      );

      if (uploaded) {
        fileState.offset = targetSize;
        fileState.lastProcessedSize = stat.size;
      } else if (failed) {
        fileState.lastProcessedSize = stat.size;
      } else {
        // skipped because hash matches; nothing changed from last upload
        fileState.offset = targetSize;
        fileState.lastProcessedSize = stat.size;
      }

      await this.saveOffsets();
    } catch {
      // do not advance offset on unexpected state error
    }
  }
}

export async function watchTranscripts(options: WatchTranscriptsOptions): Promise<void> {
  const watcher = new TranscriptWatcher(options);
  return watcher.start();
}
