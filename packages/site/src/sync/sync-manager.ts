/**
 * Sync orchestrator (main thread).
 *
 * `SyncManager` owns the SQLite state machine for remote sync: boot
 * reconciliation, a single-run queue, project discovery, capped worker
 * dispatch, the `SESSION_MANIFEST_READY` gate + diff, multi-tab
 * coordination, and cancellation/offline abort. It deliberately does not
 * implement the file-processing pipeline; downloaded buffers are handed to an
 * optional `onFileDownloaded` seam that TSK0008 implements.
 */

import {
  buildProjectManifest,
  CAS_NAMESPACE_ROOT,
  encodeKeySegment,
  type ManifestArtifact,
  parseProjectManifest,
  type S3ClientConfig,
  S3FetchClient,
  type S3ListOptions,
  type SyncManifest,
} from '@lucasschirm/sal-sync-core';
import { toastManager } from '../components/toast-container';
import { analyticsClient } from '../db/analytics-client';
import { type DbClient, dbClient } from '../db/db-client';
import { generateId } from '../lib/id';
import { describeS3Error } from '../lib/s3-errors';
import type {
  Connection,
  DashboardSession,
  Project,
  SessionFileRecord,
  SessionStub,
} from '../types';
import { decryptField, isUnlocked } from './credential-crypto';
import { requestPasskey } from './passkey-prompt';
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
  WorkerDoneMessage,
  WorkerErrorMessage,
} from './sync-protocol';

const MAX_PARALLEL_PROJECT_WORKERS = 5;
const BROADCAST_CHANNEL_NAME = 'sal-sync';
const HEARTBEAT_INTERVAL_MS = 2000;
const HEARTBEAT_TIMEOUT_MS = 5000;
const LATE_JOINER_LISTEN_MS = 1000;
const PROGRESS_THROTTLE_MS = 250;
const FALLBACK_MAIN_TRANSCRIPT = 'transcript.jsonl';
const SHA256_HEX_LENGTH = 64;

/** State of an enqueued or active run. */
export type SyncRunState = 'queued' | 'running' | 'done' | 'cancelled' | 'failed';

/** Summary exposed to progress consumers and broadcast snapshots. */
export interface RunSummary {
  connectionId: string;
  state: SyncRunState;
  warnings: string[];
  startedAt: number;
  finishedAt?: number;
  /** Total sessions that failed ingestion across all projects in the run. */
  sessionsFailed?: number;
}

/** Input from a UI project-creation modal for a missing manifest. */
export interface ProjectManifestInput {
  name: string;
  description?: string;
}

/** File buffer handed to the pluggable file-processing seam. */
export interface DownloadedFile {
  path: string;
  hash: string;
  etag?: string;
  size: number;
  content: ArrayBuffer;
}

/** Constructor options for `SyncManager`. */
export interface SyncManagerOptions {
  /** Database client; defaults to the app singleton. */
  dbClient?: DbClient;
  /** Factory for `session-sync.worker.ts` instances. */
  createWorker?: () => Worker;
  /** Factory for the `BroadcastChannel` used for multi-tab coordination. */
  createBroadcastChannel?: (name: string) => BroadcastChannel;
  /** Factory for the S3 client used during project discovery. */
  createS3Client?: (config: S3ClientConfig) => S3Client;
  /** Async seam for processing a downloaded file buffer. */
  onFileDownloaded?: (sessionId: string, file: DownloadedFile, projectId: string) => Promise<void>;
  /** Async seam for forcing completion when the sync worker signals a session is complete. */
  onSyncComplete?: (
    sessionId: string,
    manifest: SyncManifest | undefined,
    projectId: string,
  ) => Promise<void>;
  /** Async seam for resolving a missing project manifest. */
  onProjectMissing?: (folder: string) => Promise<ProjectManifestInput | null>;
  /**
   * Async seam for unlocking the credential vault when a sync run needs
   * S3 credentials but the vault is locked. The callback is responsible
   * for prompting the user and unlocking the vault (e.g. via the passkey
   * modal). Resolves to `true` if the vault is now unlocked, `false` if
   * the user cancelled or unlocking failed.
   */
  onPasskeyRequired?: () => Promise<boolean>;
  /** Optional consumer of run summary updates. */
  onRunSummary?: (summary: RunSummary) => void;
  /** Optional consumer fired each time a warning is added to a run. */
  onWarning?: (warning: string) => void;
  /** Event target for `offline` events; defaults to `globalThis`. */
  eventTarget?: EventTarget;
}

/** Minimal S3 client surface used by `SyncManager` during discovery. */
export interface S3Client {
  listProjectFolders(options?: S3ListOptions): Promise<string[]>;
  listSessionFolders(projectId: string, options?: S3ListOptions): Promise<string[]>;
  getObject(key: string): Promise<ArrayBuffer>;
  putObject(key: string, body: ArrayBuffer | Uint8Array): Promise<{ etag?: string }>;
}

interface SessionProgressState {
  filesFound: number;
  filesDownloaded: number;
  filesFailed: number;
  bytesReceived: number;
}

interface SessionSyncState extends SessionProgressState {
  sessionId: string;
  localSessionId: string;
  syncStatus: 'pending' | 'processing' | 'in_sync' | 'failed' | 'transcript_unavailable';
  firstFile: boolean;
  pendingFiles: number;
  completeReceived: boolean;
  manifest?: SyncManifest;
  /** In-flight `onFileDownloaded` (retain) promises; awaited before ingestion. */
  retainPromises: Promise<void>[];
  /** True when the session did not exist locally before this run. */
  isNew: boolean;
  /** True when an existing session had at least one file downloaded this run. */
  wasUpdated: boolean;
}

interface ProjectSyncState {
  projectId: string;
  localProjectId: string;
  worker: Worker | null;
  status: 'queued' | 'running' | 'done' | 'cancelled' | 'failed';
  sessions: Map<string, SessionSyncState>;
  totalSessions: number;
  sessionsDone: number;
  sessionsFailed: number;
  filesFound: number;
  filesDownloaded: number;
  filesFailed: number;
  bytesReceived: number;
  /** True when the project was created during this run (not pre-existing). */
  isNew: boolean;
  /** Optional list of session ids to restrict this project worker to. */
  targetSessionIds?: string[];
}

interface SyncRun {
  id: string;
  connectionId: string;
  state: SyncRunState;
  startedAt: number;
  finishedAt?: number;
  s3Client: S3Client | null;
  s3Config?: S3ClientConfig;
  connection: Connection | null;
  projects: Map<string, ProjectSyncState>;
  projectQueue: string[];
  activeWorkers: Set<Worker>;
  warnings: string[];
  syncOnlyNew: boolean;
  cancelled: boolean;
  /** When set, this run is scoped to a single project and skips full discovery. */
  targetProjectId?: string;
  /** When set, bypass the connection's sync-only-new setting. */
  bypassSyncOnlyNew?: boolean;
  /** When set, overrides the connection's sync-only-new setting with the value
   * chosen by the user in the per-sync confirmation modal. */
  overrideSyncOnlyNew?: boolean;
}

interface BroadcastMessage {
  type: 'run-started' | 'run-progress' | 'run-finished' | 'heartbeat' | 'cancel-requested';
  snapshot?: SyncManagerSnapshot;
}

/** Immutable snapshot of sync state shared with UIs and peer tabs over BroadcastChannel. */
export interface SyncManagerSnapshot {
  initialized: boolean;
  readOnly: boolean;
  activeRun: RunSummary | null;
  projects: ProjectSnapshot[];
  sessions: SessionSnapshot[];
  queuedRuns: string[];
  warnings: string[];
  /**
   * Timestamp of the most recent successfully-completed sync run, from
   * either this session's own runs or persisted connection bookkeeping
   * loaded on `init()`. `null` means "not synced yet" / unknown — per
   * `.agents/rules/missing-is-never-zero.md` this must never be coerced
   * to `0` or a fabricated timestamp.
   */
  lastCompletedAt: number | null;
}

interface ProjectSnapshot {
  projectId: string;
  localProjectId: string;
  status: string;
  totalSessions: number;
  sessionsDone: number;
  sessionsFailed: number;
  filesFound: number;
  filesDownloaded: number;
  filesFailed: number;
  bytesReceived: number;
  isNew: boolean;
}

interface SessionSnapshot {
  projectId: string;
  sessionId: string;
  status: string;
  filesFound: number;
  filesDownloaded: number;
  filesFailed: number;
  bytesReceived: number;
  isNew: boolean;
  wasUpdated: boolean;
}

/**
 * Singleton reactive store that coordinates the sync state machine.
 *
 * Extends `EventTarget` so pages and components can subscribe to `change`
 * events using the same lightweight pattern the rest of the app uses.
 */
export class SyncManager extends EventTarget {
  private readonly db: DbClient;
  private readonly createWorker: () => Worker;
  private readonly createS3Client: (config: S3ClientConfig) => S3Client;
  private readonly createBroadcastChannel: (name: string) => BroadcastChannel;
  private readonly onFileDownloaded: (
    sessionId: string,
    file: DownloadedFile,
    projectId: string,
  ) => Promise<void>;
  private readonly onSyncComplete: (
    sessionId: string,
    manifest: SyncManifest | undefined,
    projectId: string,
  ) => Promise<void>;
  private readonly onProjectMissing?: (folder: string) => Promise<ProjectManifestInput | null>;
  private readonly onPasskeyRequired?: () => Promise<boolean>;
  private readonly onRunSummary?: (summary: RunSummary) => void;
  private readonly onWarning?: (warning: string) => void;
  private readonly eventTarget: EventTarget;

  private broadcastChannel: BroadcastChannel | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private leaderHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private progressBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private progressBroadcastPending = false;
  private lateJoinerResolver: (() => void) | null = null;
  private followerSnapshot: SyncManagerSnapshot | null = null;

  private initialized = false;
  private readOnly = false;
  private activeRun: SyncRun | null = null;
  private runQueue: SyncRun[] = [];
  private lastCompletedAt: number | null = null;

  /**
   * In-memory connections registered by the UI for syncing without persisting
   * credentials to the database. Keyed by connection id.
   */
  private ephemeralConnections = new Map<
    string,
    { connection: Connection; s3Config: S3ClientConfig }
  >();

  constructor(options: SyncManagerOptions = {}) {
    super();
    this.db = options.dbClient ?? dbClient;
    this.createWorker = options.createWorker ?? this.defaultCreateWorker;
    this.createS3Client = options.createS3Client ?? ((config) => new S3FetchClient(config));
    this.createBroadcastChannel =
      options.createBroadcastChannel ?? this.defaultCreateBroadcastChannel;
    this.onFileDownloaded = options.onFileDownloaded ?? this.defaultOnFileDownloaded;
    this.onSyncComplete = options.onSyncComplete ?? this.defaultOnSyncComplete;
    this.onProjectMissing = options.onProjectMissing;
    this.onPasskeyRequired = options.onPasskeyRequired;
    this.onRunSummary = options.onRunSummary;
    this.onWarning = options.onWarning;
    this.eventTarget = options.eventTarget ?? globalThis;
  }

  /** Initialize the store, reconcile stale state, and listen for peer tabs. */
  async init(): Promise<void> {
    if (this.initialized) return;

    await this.db.reconcileSyncStates('Sync interrupted (page closed)');
    await this.loadLastCompletedAt();
    this.openBroadcastChannel();
    this.attachOfflineListener();
    this.initialized = true;
    await this.waitForLeaderHeartbeat();
    this.emitChange();
  }

  /**
   * Loads persisted `last_sync_at` bookkeeping across all known connections
   * and sets `lastCompletedAt` to the most recent one. `null` (never `0`)
   * when there are no connections or none has synced yet.
   */
  private async loadLastCompletedAt(): Promise<void> {
    try {
      const connections = await this.db.getConnections();
      const timestamps = connections
        .map((c) => c.last_sync_at)
        .filter((t): t is number => typeof t === 'number');
      this.lastCompletedAt = timestamps.length > 0 ? Math.max(...timestamps) : null;
    } catch {
      // Non-fatal: bookkeeping stays unknown until a run completes.
      this.lastCompletedAt = null;
    }
  }

  /** Whether this tab must not start runs or write sync state. */
  get isReadOnly(): boolean {
    return this.readOnly;
  }

  /** Snapshot of the current sync state for UIs and broadcasts. */
  getSnapshot(): SyncManagerSnapshot {
    return this.buildSnapshot();
  }

  /**
   * Request a sync run for the given connection.
   *
   * Only one run is active at a time; duplicates for the same connection are
   * ignored.
   */
  requestRun(connectionId: string, options?: { syncOnlyNew?: boolean }): void {
    if (this.readOnly) return;
    if (this.findRunForConnection(connectionId)) return;
    const run = this.createRun(connectionId);
    if (options?.syncOnlyNew !== undefined) {
      run.overrideSyncOnlyNew = options.syncOnlyNew;
    }
    this.runQueue.push(run);
    this.processQueue();
  }

  /**
   * Register an in-memory connection so it can be synced without persisting
   * credentials to the database. The connection and S3 config are held in
   * memory for the lifetime of the page session and used directly by
   * {@link prepareRunCredentials} when a run is started for this connection id.
   */
  registerEphemeralConnection(connection: Connection, s3Config: S3ClientConfig): void {
    this.ephemeralConnections.set(connection.id, { connection, s3Config });
  }

  /**
   * Retry a single failed session within a project.
   *
   * The session is marked `pending` immediately, a one-project run is queued,
   * and the worker is restricted to `targetSessionIds: [sessionId]` with the
   * sync-only-new check bypassed.
   */
  async retrySession(connectionId: string, projectId: string, sessionId: string): Promise<void> {
    if (this.readOnly) return;
    if (!isUnlocked()) throw new Error('Vault is locked');
    const project = await this.db.getProjectByReadableId(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const localSession = await this.db.getSessionBySyncId(project.id, sessionId);
    if (!localSession) throw new Error(`Session not found: ${sessionId}`);

    await this.db.setSessionSyncStatus(localSession.id, 'pending');

    const run = this.createRun(connectionId);
    run.bypassSyncOnlyNew = true;
    run.targetProjectId = projectId;
    this.queueProjectForSync(run, projectId, project.id, [sessionId]);

    this.runQueue.push(run);
    this.emitChange();
    this.processQueue();
  }

  /** Cancel the active run and clear queued runs. */
  cancel(): void {
    if (this.readOnly) {
      this.broadcast({ type: 'cancel-requested' });
      return;
    }
    if (this.activeRun?.state !== 'running') return;
    this.abortActiveRun('Sync cancelled by user');
  }

  /** Clean up resources. */
  dispose(): void {
    this.cancel();
    this.stopHeartbeatTimer();
    this.clearLeaderHeartbeatTimer();
    this.clearProgressBroadcastTimer();
    if (typeof this.eventTarget.removeEventListener === 'function') {
      this.eventTarget.removeEventListener('offline', this.handleOffline);
    }
    this.broadcastChannel?.close();
    this.broadcastChannel = null;
  }

  private defaultCreateWorker(): Worker {
    return new Worker(new URL('../workers/session-sync.worker.ts', import.meta.url), {
      type: 'module',
    });
  }

  private defaultCreateBroadcastChannel(name: string): BroadcastChannel {
    return new BroadcastChannel(name);
  }

  private defaultOnFileDownloaded(): Promise<void> {
    return Promise.resolve();
  }

  private defaultOnSyncComplete(): Promise<void> {
    return Promise.resolve();
  }

  private openBroadcastChannel(): void {
    this.broadcastChannel = this.createBroadcastChannel(BROADCAST_CHANNEL_NAME);
    this.broadcastChannel.onmessage = (event: MessageEvent<BroadcastMessage>) => {
      this.handleBroadcastMessage(event.data);
    };
  }

  private attachOfflineListener(): void {
    if (typeof this.eventTarget.addEventListener === 'function') {
      this.eventTarget.addEventListener('offline', this.handleOffline, { passive: true });
    }
  }

  private handleOffline = (): void => {
    if (this.readOnly) return;
    this.abortActiveRun(this.formatSyncDetails('NETWORK_OFFLINE', 'Network connection lost'));
  };

  private waitForLeaderHeartbeat(): Promise<void> {
    return new Promise((resolve) => {
      this.lateJoinerResolver = resolve;
      setTimeout(() => this.resolveLateJoiner(), LATE_JOINER_LISTEN_MS);
    });
  }

  private resolveLateJoiner(): void {
    if (!this.lateJoinerResolver) return;
    this.lateJoinerResolver();
    this.lateJoinerResolver = null;
  }

  private findRunForConnection(connectionId: string): SyncRun | null {
    if (this.activeRun?.state === 'running' && this.activeRun.connectionId === connectionId) {
      return this.activeRun;
    }
    return this.runQueue.find((run) => run.connectionId === connectionId) ?? null;
  }

  private createRun(connectionId: string): SyncRun {
    return {
      id: generateId(),
      connectionId,
      state: 'queued',
      startedAt: Date.now(),
      s3Client: null,
      connection: null,
      projects: new Map(),
      projectQueue: [],
      activeWorkers: new Set(),
      warnings: [],
      syncOnlyNew: false,
      cancelled: false,
    };
  }

  private processQueue(): void {
    if (this.readOnly) return;
    if (this.activeRun?.state === 'running') return;
    const next = this.runQueue.shift();
    if (!next) return;
    this.activeRun = next;
    next.state = 'running';
    this.startRun(next);
  }

  private async startRun(run: SyncRun): Promise<void> {
    try {
      this.broadcastRunStarted();
      this.startHeartbeatTimer();
      await this.prepareRunCredentials(run);
      await this.discoverProjects(run);
      this.emitChange();
      this.dispatchWorkers(run);
      this.checkRunComplete(run);
    } catch (error) {
      this.failRun(run, describeS3Error(error).message);
    }
  }

  private async prepareRunCredentials(run: SyncRun): Promise<void> {
    const connection = await this.getConnection(run.connectionId);
    if (!connection) throw new Error('Connection not found');
    run.connection = connection;
    run.syncOnlyNew =
      run.overrideSyncOnlyNew !== undefined
        ? run.overrideSyncOnlyNew
        : run.bypassSyncOnlyNew
          ? false
          : connection.sync_only_new;

    const credentials = await this.resolveS3Credentials(run.connectionId);
    if (!credentials) throw new Error('Could not unlock S3 credentials');
    run.s3Config = credentials;
    run.s3Client = this.createS3Client(credentials);
  }

  private async resolveS3Credentials(connectionId: string): Promise<S3ClientConfig | null> {
    const ephemeral = this.ephemeralConnections.get(connectionId);
    if (ephemeral) return ephemeral.s3Config;

    const stored = await this.db.getS3Credentials(connectionId);
    if (!stored) return null;

    if (!isUnlocked()) {
      const unlocked = await this.onPasskeyRequired?.();
      if (!unlocked) return null;
      // The callback is responsible for unlocking the vault (e.g. by
      // opening the passkey modal, which calls `unlock()` internally).
      // Re-check before decrypting credentials; if the callback did not
      // actually unlock, the run cannot proceed.
      if (!isUnlocked()) return null;
    }

    try {
      const secret = await decryptField(stored.secret_access_key_iv, stored.secret_access_key_ct);
      const sessionToken =
        stored.session_token_iv && stored.session_token_ct
          ? await decryptField(stored.session_token_iv, stored.session_token_ct)
          : undefined;
      return {
        accessKeyId: stored.access_key_id,
        secretAccessKey: secret,
        sessionToken,
        region: stored.region,
        bucket: stored.bucket,
        endpoint: stored.endpoint,
      };
    } catch {
      return null;
    }
  }

  private async discoverProjects(run: SyncRun): Promise<void> {
    if (run.targetProjectId) {
      // Single-project retry run: the project is already queued by retrySession.
      return;
    }
    if (!run.s3Client) return;
    const folders = await run.s3Client.listProjectFolders();
    await this.checkGlobalConflict(run);
    for (const folder of folders) {
      if (run.cancelled) break;
      await this.processProjectFolder(run, folder);
    }
  }

  private async checkGlobalConflict(run: SyncRun): Promise<void> {
    if (!run.s3Client) return;
    const children = await run.s3Client.listSessionFolders(CAS_NAMESPACE_ROOT);
    for (const child of children) {
      if (child !== 'cas') {
        this.pushWarning(
          run,
          "project id 'global' is reserved — re-upload under a different SAL_PROJECT_ID",
        );
        break;
      }
    }
  }

  private async processProjectFolder(run: SyncRun, folder: string): Promise<void> {
    if (!run.s3Client) return;
    const manifestKey = `${encodeKeySegment(folder)}/manifest.json`;
    try {
      const buffer = await run.s3Client.getObject(manifestKey);
      const manifest = parseProjectManifest(JSON.parse(this.textFromBuffer(buffer)));
      await this.useProjectManifest(run, manifest);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        await this.handleMissingProjectManifest(run, folder);
        return;
      }
      const detail = describeS3Error(error);
      this.pushWarning(run, `Project "${folder}" manifest error: ${detail.message}`);
    }
  }

  private async handleMissingProjectManifest(run: SyncRun, folder: string): Promise<void> {
    if (this.onProjectMissing && run.s3Client) {
      const input = await this.onProjectMissing(folder);
      if (input) {
        const project = await this.createLocalProject(run, folder, input.name, input.description);
        await this.putProjectManifest(run, folder, input.name, input.description);
        this.queueProjectForSync(run, folder, project.id, undefined, true);
        return;
      }
    }
    // No handler or user declined — proceed anyway using the folder name.
    // The manifest is metadata; the worker discovers sessions from the S3
    // folder structure. Create/find a local project and queue it for sync.
    // The manifest will be created/updated on S3 so it exists next time.
    const existingProject = await this.db.getProjectByReadableId(folder);
    const project = await this.findOrCreateLocalProject(run, folder);
    const isNew = !existingProject;
    await this.putProjectManifest(run, folder, folder, undefined).catch(() => undefined);
    this.queueProjectForSync(run, folder, project.id, undefined, isNew);
  }

  /** Finds an existing local project by readable id, or creates one. */
  private async findOrCreateLocalProject(run: SyncRun, readableId: string): Promise<Project> {
    const existing = await this.db.getProjectByReadableId(readableId);
    if (existing) return existing;
    return this.createLocalProject(run, readableId, readableId, undefined);
  }

  /** Writes a project manifest to S3 for the given folder. */
  private async putProjectManifest(
    run: SyncRun,
    folder: string,
    name: string,
    description?: string,
  ): Promise<void> {
    if (!run.s3Client) return;
    const manifest = buildProjectManifest(
      {
        projectId: folder,
        name,
        description,
        writtenBy: 'session-analyzer-site',
      },
      () => new Date().toISOString(),
    );
    await run.s3Client.putObject(
      `${encodeKeySegment(folder)}/manifest.json`,
      this.bufferFromText(JSON.stringify(manifest)),
    );
  }

  private async useProjectManifest(
    run: SyncRun,
    manifest: { projectId: string; name: string; description?: string },
  ): Promise<void> {
    const existing = await this.db.getProjectByReadableId(manifest.projectId);
    if (existing) {
      this.queueProjectForSync(run, manifest.projectId, existing.id);
      return;
    }
    const project = await this.createLocalProject(
      run,
      manifest.projectId,
      manifest.name,
      manifest.description,
    );
    this.queueProjectForSync(run, manifest.projectId, project.id, undefined, true);
  }

  private async createLocalProject(
    run: SyncRun,
    readableId: string,
    name: string,
    description?: string,
  ): Promise<Project> {
    const project: Project = {
      id: generateId(),
      name,
      description: description ?? '',
      created_at: Date.now(),
      updated_at: Date.now(),
      session_count: 0,
      readable_id: readableId,
      connection_id: run.connectionId,
    };
    await this.db.createProject(project);
    return project;
  }

  private queueProjectForSync(
    run: SyncRun,
    projectId: string,
    localProjectId: string,
    targetSessionIds?: string[],
    isNew = false,
  ): void {
    const state: ProjectSyncState = {
      projectId,
      localProjectId,
      worker: null,
      status: 'queued',
      sessions: new Map(),
      totalSessions: 0,
      sessionsDone: 0,
      sessionsFailed: 0,
      filesFound: 0,
      filesDownloaded: 0,
      filesFailed: 0,
      bytesReceived: 0,
      isNew,
      targetSessionIds,
    };
    run.projects.set(projectId, state);
    run.projectQueue.push(projectId);
  }

  private dispatchWorkers(run: SyncRun): void {
    while (run.projectQueue.length > 0 && run.activeWorkers.size < MAX_PARALLEL_PROJECT_WORKERS) {
      this.dispatchNextWorker(run);
    }
  }

  private dispatchNextWorker(run: SyncRun): void {
    const projectId = run.projectQueue.shift();
    if (!projectId) return;
    const project = run.projects.get(projectId);
    if (!project) return;

    const worker = this.createWorker();
    project.worker = worker;
    project.status = 'running';
    run.activeWorkers.add(worker);

    this.attachWorkerHandlers(run, project, worker);
    this.db.setProjectSyncStatus(project.localProjectId, 'syncing');
    worker.postMessage(this.buildStartMessage(run, projectId));
  }

  private attachWorkerHandlers(run: SyncRun, project: ProjectSyncState, worker: Worker): void {
    let messageQueue: Promise<void> = Promise.resolve();
    worker.onmessage = (event: MessageEvent<SyncMessageFromWorker>) => {
      messageQueue = messageQueue
        .then(() =>
          this.handleWorkerMessage(run, project, worker, event.data).catch((error) =>
            this.handleWorkerFatal(run, project, worker, error),
          ),
        )
        .catch(() => undefined);
    };
    worker.onerror = (event: ErrorEvent) => {
      messageQueue = messageQueue
        .then(() => this.handleWorkerFatal(run, project, worker, new Error(event.message)))
        .catch(() => undefined);
    };
  }

  private buildStartMessage(run: SyncRun, projectId: string): StartMessage {
    const project = run.projects.get(projectId);
    const config = run.s3Config ?? {
      accessKeyId: '',
      secretAccessKey: '',
      region: '',
      bucket: '',
    };
    return {
      type: 'START',
      connectionId: run.connectionId,
      projectId,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      bucket: config.bucket,
      endpoint: config.endpoint,
      region: config.region,
      syncOnlyNew: run.syncOnlyNew,
      targetSessionIds: project?.targetSessionIds,
    };
  }

  private async handleWorkerMessage(
    run: SyncRun,
    project: ProjectSyncState,
    worker: Worker,
    message: SyncMessageFromWorker,
  ): Promise<void> {
    if (run.cancelled) return;
    switch (message.type) {
      case 'CONNECTED':
        this.handleConnected();
        break;
      case 'SESSION_BATCH_FOUND':
        this.handleSessionBatch(project, message);
        break;
      case 'PROJECT_FOLDER_FOUND':
        this.handleProjectFolderFound(project, message);
        break;
      case 'SESSION_FOUND':
        await this.handleSessionFound(run, project, worker, message);
        break;
      case 'SESSION_MANIFEST_READY':
        await this.handleSessionManifestReady(run, project, worker, message);
        break;
      case 'SESSION_SYNC_PROGRESS':
        this.handleSessionSyncProgress(project, message);
        break;
      case 'SESSION_FILE_DOWNLOADED':
        await this.handleSessionFileDownloaded(project, message);
        break;
      case 'SESSION_SYNC_COMPLETE':
        await this.handleSessionSyncComplete(project, message);
        break;
      case 'SESSION_SYNC_FAILED':
        await this.handleSessionSyncFailed(project, message);
        break;
      case 'WORKER_DONE':
        await this.handleWorkerDone(run, project, worker, message);
        break;
      case 'WORKER_ERROR':
        await this.handleWorkerError(run, project, worker, message);
        break;
      default:
        break;
    }
  }

  private handleConnected(): void {
    this.emitChange();
  }

  private handleSessionBatch(
    project: ProjectSyncState,
    message: { sessionIds: string[]; final: boolean },
  ): void {
    for (const sessionId of message.sessionIds) {
      this.getOrCreateSessionState(project, sessionId);
    }
    this.emitChange();
  }

  private handleProjectFolderFound(
    project: ProjectSyncState,
    message: { totalSessions: number },
  ): void {
    project.totalSessions = message.totalSessions;
    this.emitChange();
  }

  private async handleSessionFound(
    run: SyncRun,
    project: ProjectSyncState,
    worker: Worker,
    message: { sessionId: string },
  ): Promise<void> {
    if (!run.syncOnlyNew) return;
    const local = await this.db.getSessionBySyncId(project.localProjectId, message.sessionId);
    const continueMessage: SessionSyncContinueMessage = {
      type: 'SESSION_SYNC_CONTINUE',
      connectionId: run.connectionId,
      projectId: project.projectId,
      sessionId: message.sessionId,
      sync: local === null,
    };
    worker.postMessage(continueMessage);
  }

  private async handleSessionManifestReady(
    _run: SyncRun,
    project: ProjectSyncState,
    worker: Worker,
    message: { sessionId: string; manifest: SyncManifest },
  ): Promise<void> {
    const { manifest, sessionId: remoteSessionId } = message;
    const existing = await this.db.getSessionBySyncId(project.localProjectId, remoteSessionId);
    const stub = this.buildSessionStub(project.localProjectId, remoteSessionId, manifest, existing);
    await this.db.upsertSessionStub(stub);

    const localSession = await this.db.getSessionBySyncId(project.localProjectId, remoteSessionId);
    if (!localSession) return;

    const existingId = existing?.id ?? localSession.id;
    const localRunCount = await this.db.getSyncRunCount(existingId);
    await this.db.updateSessionManifest(localSession.id, manifest);

    const sessionState = this.getOrCreateSessionState(
      project,
      remoteSessionId,
      localSession.id,
      existing === null,
    );
    sessionState.manifest = manifest;

    const mainPath = manifest.mainTranscriptRelativePath ?? FALLBACK_MAIN_TRANSCRIPT;
    const mainArtifact = this.findMainArtifact(manifest, mainPath);
    if (!mainArtifact) {
      await this.handleTranscriptUnavailable(sessionState, localSession, worker, remoteSessionId);
      return;
    }

    const shouldSync = await this.isSyncNeeded(existing, localRunCount, manifest);
    // Even if the sync run count hasn't changed, check whether workspace/global
    // config artifacts are missing from the local session_files table. Sessions
    // synced before the config-artifact download fix won't have these files,
    // so the transformer never sees them and component data stays empty.
    // Force a re-download + re-ingestion when missing config artifacts are detected.
    let forceForConfigArtifacts = false;
    if (!shouldSync && existing) {
      const inScope = this.filterInScopeArtifacts(manifest.artifacts, mainPath);
      const configArtifacts = inScope.filter(
        (a) => a.scope === 'workspace' || a.scope === 'global',
      );
      if (configArtifacts.length > 0) {
        const localFiles = await this.db.getSessionFiles(localSession.id);
        const localByPath = new Map(localFiles.map((f) => [f.path, f]));
        forceForConfigArtifacts = configArtifacts.some((a) => {
          const file = this.artifactToFile(a, mainPath);
          const local = localByPath.get(file.file);
          // Re-download if the file is missing, has a stale hash, or previously
          // failed (status !== 'processed'). A failed row used to keep
          // forceForConfigArtifacts false because only path presence was checked.
          return !local || local.sha256 !== file.hash || local.status !== 'processed';
        });
      }
    }
    if (!shouldSync && !forceForConfigArtifacts) {
      await this.markSessionInSync(
        sessionState,
        project,
        localSession,
        worker,
        remoteSessionId,
        existing !== null,
        mainPath,
        manifest,
      );
      return;
    }

    // For sessions that previously failed or are forced for config artifacts,
    // force a full re-download so the analytics blob store is re-populated.
    // The control DB may mark files as 'processed' from a prior run, but the
    // analytics artifact_blobs table can be empty if that run's retain calls
    // were interrupted (page reload, HMR, worker crash) or if the session was
    // first synced on main where artifact_blobs didn't exist. Skipping
    // re-download leaves ingestion unable to resolve artifacts (especially the
    // root transcript), so the session can never recover.
    const wasFailed = existing?.sync_status === 'failed';
    const forceFullRedownload = wasFailed || forceForConfigArtifacts;
    const filesToDownload = forceFullRedownload
      ? undefined
      : await this.computeFilesToDownload(localSession.id, manifest, mainPath);
    if (filesToDownload !== undefined && filesToDownload.length === 0) {
      await this.markSessionInSync(
        sessionState,
        project,
        localSession,
        worker,
        remoteSessionId,
        true,
        mainPath,
        manifest,
      );
      return;
    }

    sessionState.syncStatus = 'pending';
    await this.db.setSessionSyncStatus(localSession.id, 'pending');
    const localFileEtas = await this.buildLocalFileEtas(localSession.id);
    worker.postMessage(
      this.buildSyncMessage(
        remoteSessionId,
        true,
        existing !== null,
        filesToDownload ?? undefined,
        localFileEtas,
      ),
    );
    this.emitChange();
  }

  private async handleTranscriptUnavailable(
    sessionState: SessionSyncState,
    localSession: DashboardSession,
    worker: Worker,
    remoteSessionId: string,
  ): Promise<void> {
    sessionState.syncStatus = 'transcript_unavailable';
    await this.db.setSessionSyncStatus(
      localSession.id,
      'transcript_unavailable',
      'Main transcript not uploaded',
    );
    worker.postMessage(this.buildSyncMessage(remoteSessionId, false, true, []));
    this.emitChange();
  }

  private async markSessionInSync(
    sessionState: SessionSyncState,
    project: ProjectSyncState,
    localSession: DashboardSession,
    worker: Worker,
    remoteSessionId: string,
    exists: boolean,
    mainPath: string,
    manifest: SyncManifest,
  ): Promise<void> {
    await this.refreshInScopeSessionFiles(
      project.localProjectId,
      localSession.id,
      manifest,
      mainPath,
    );
    sessionState.syncStatus = 'in_sync';
    await this.db.setSessionSyncStatus(localSession.id, 'in_sync');
    worker.postMessage(this.buildSyncMessage(remoteSessionId, false, exists, []));
    this.emitChange();
  }

  private buildSessionStub(
    projectId: string,
    sessionId: string,
    manifest: SyncManifest,
    existing: DashboardSession | null,
  ): SessionStub {
    const source = existing?.source ?? manifest.harness ?? 'claude';
    const title = existing?.title ?? manifest.sessionId;
    const startedAt =
      this.stubTimestamp(existing?.started_at) ?? manifest.startedAt ?? new Date().toISOString();
    const endedAt =
      this.stubTimestamp(existing?.ended_at) ?? manifest.endedAt ?? new Date().toISOString();
    return {
      id: `sync-${projectId}-${sessionId}`,
      project_id: projectId,
      source,
      title,
      started_at: startedAt,
      ended_at: endedAt,
      sync_session_id: sessionId,
      external_id: sessionId,
      sync_status: 'pending',
    };
  }

  private stubTimestamp(value: number | string | undefined): string | undefined {
    if (typeof value === 'number' && value > 0) return new Date(value).toISOString();
    if (typeof value === 'string' && value.length > 0) return value;
    return undefined;
  }

  private formatSyncDetails(code: string, message: string): string {
    return `${code}: ${message}`;
  }

  private getOrCreateSessionState(
    project: ProjectSyncState,
    sessionId: string,
    localSessionId = '',
    isNew = false,
  ): SessionSyncState {
    const existing = project.sessions.get(sessionId);
    if (existing) {
      if (localSessionId && !existing.localSessionId) {
        existing.localSessionId = localSessionId;
      }
      return existing;
    }
    const state: SessionSyncState = {
      sessionId,
      localSessionId,
      syncStatus: 'pending',
      firstFile: true,
      pendingFiles: 0,
      completeReceived: false,
      filesFound: 0,
      filesDownloaded: 0,
      filesFailed: 0,
      bytesReceived: 0,
      retainPromises: [],
      isNew,
      wasUpdated: false,
    };
    project.sessions.set(sessionId, state);
    return state;
  }

  private findMainArtifact(manifest: SyncManifest, mainPath: string): ManifestArtifact | undefined {
    return manifest.artifacts.find(
      (artifact) =>
        artifact.scope === 'session' &&
        (artifact.status === 'uploaded' || artifact.status === 'skipped') &&
        artifact.relativePath === mainPath,
    );
  }

  private async isSyncNeeded(
    existing: { sync_status?: string; id: string } | null,
    localRunCount: number,
    manifest: SyncManifest,
  ): Promise<boolean> {
    if (!existing) return true;
    if (localRunCount < manifest.syncRuns.length) return true;
    return ['failed', 'pending', 'transcript_unavailable'].includes(existing.sync_status ?? '');
  }

  private async computeFilesToDownload(
    sessionId: string,
    manifest: SyncManifest,
    mainPath: string,
  ): Promise<FileToDownload[] | undefined> {
    const inScope = this.filterInScopeArtifacts(manifest.artifacts, mainPath);
    if (!this.hasUsableHashes(inScope)) return undefined;
    const localFiles = await this.db.getSessionFiles(sessionId);
    const toDownload: FileToDownload[] = [];
    for (const artifact of inScope) {
      const file = this.artifactToFile(artifact, mainPath);
      const local = localFiles.find((row) => row.path === file.file);
      if (!local || local.sha256 !== file.hash || local.status !== 'processed') {
        toDownload.push(file);
      }
    }
    return toDownload;
  }

  private filterInScopeArtifacts(
    artifacts: ManifestArtifact[],
    mainPath: string,
  ): ManifestArtifact[] {
    return artifacts.filter(
      (artifact) =>
        // Session-scoped transcripts and subagent files.
        (artifact.scope === 'session' &&
          (artifact.status === 'uploaded' || artifact.status === 'skipped') &&
          (artifact.relativePath === mainPath || this.isSubagentFile(artifact.relativePath))) ||
        // Workspace/global config artifacts (MCP, settings, skills, agents,
        // rules) needed by the transformer to populate component data.
        // Include 'skipped' artifacts (already in CAS from a prior session's
        // sync) so they are downloaded to the local blob store and made
        // available to the transformer during ingestion.
        ((artifact.scope === 'workspace' || artifact.scope === 'global') &&
          (artifact.status === 'uploaded' || artifact.status === 'skipped')),
    );
  }

  private isSubagentFile(relativePath: string): boolean {
    return (
      /^subagents\/[^/]+\.jsonl$/.test(relativePath) ||
      /^subagents\/[^/]+\.meta\.json$/.test(relativePath)
    );
  }

  private hasUsableHashes(artifacts: ManifestArtifact[]): boolean {
    return artifacts.every((artifact) => this.isValidSha256(artifact.sha256));
  }

  private isValidSha256(value: string): boolean {
    return value.length === SHA256_HEX_LENGTH && /^[0-9a-fA-F]+$/.test(value);
  }

  private artifactToFile(artifact: ManifestArtifact, mainPath: string): FileToDownload {
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

  private async refreshInScopeSessionFiles(
    projectId: string,
    sessionId: string,
    manifest: SyncManifest,
    mainPath: string,
  ): Promise<void> {
    const inScope = this.filterInScopeArtifacts(manifest.artifacts, mainPath);
    const existingFiles = await this.db.getSessionFiles(sessionId);
    const existingByPath = new Map(existingFiles.map((f) => [f.path, f]));
    const now = Date.now();
    for (const artifact of inScope) {
      const file = this.artifactToFile(artifact, mainPath);
      const existing = existingByPath.get(file.file);
      // Preserve non-processed statuses (e.g. 'failed') so that
      // computeFilesToDownload can still detect files needing re-download.
      // Only upsert as 'processed' when the file is new or already processed.
      const status = existing && existing.status !== 'processed' ? existing.status : 'processed';
      const record: SessionFileRecord = {
        id: existing?.id ?? generateId(),
        project_id: projectId,
        session_id: sessionId,
        path: file.file,
        scope: artifact.scope,
        sha256: file.hash,
        size: file.size,
        status,
        updated_at: now,
      };
      await this.db.upsertSessionFile(record);
    }
  }

  private buildSyncMessage(
    sessionId: string,
    sync: boolean,
    exists: boolean,
    filesToDownload?: FileToDownload[],
    localFileEtas?: Record<string, string>,
  ): SessionSyncMessage {
    return {
      type: 'SESSION_SYNC',
      sessionId,
      sync,
      exists,
      filesToDownload,
      localFileEtas,
    };
  }

  /** Build a path→etag map for locally stored files, used by the worker to
   * skip downloads when the S3 listing ETag hasn't changed. */
  private async buildLocalFileEtas(
    localSessionId: string,
  ): Promise<Record<string, string> | undefined> {
    const files = await this.db.getSessionFiles(localSessionId);
    const etas: Record<string, string> = {};
    for (const file of files) {
      if (file.etag && file.status === 'processed') {
        etas[file.path] = file.etag;
      }
    }
    return Object.keys(etas).length > 0 ? etas : undefined;
  }

  private handleSessionSyncProgress(
    project: ProjectSyncState,
    message: SessionSyncProgressMessage,
  ): void {
    const session = this.getOrCreateSessionState(project, message.sessionId);
    this.updateSessionProgress(session, message);
    this.aggregateProjectProgress(project);
    this.throttledProgressBroadcast();
  }

  private updateSessionProgress(
    session: SessionSyncState,
    message: SessionSyncProgressMessage,
  ): void {
    session.filesFound = message.files_found;
    session.filesDownloaded = message.files_downloaded;
    session.filesFailed = message.files_failed;
    session.bytesReceived = message.bytes_received;
  }

  private aggregateProjectProgress(project: ProjectSyncState): void {
    let filesFound = 0;
    let filesDownloaded = 0;
    let filesFailed = 0;
    let bytesReceived = 0;
    for (const session of project.sessions.values()) {
      filesFound += session.filesFound;
      filesDownloaded += session.filesDownloaded;
      filesFailed += session.filesFailed;
      bytesReceived += session.bytesReceived;
    }
    project.filesFound = filesFound;
    project.filesDownloaded = filesDownloaded;
    project.filesFailed = filesFailed;
    project.bytesReceived = bytesReceived;
  }

  private throttledProgressBroadcast(): void {
    if (this.progressBroadcastPending) return;
    this.progressBroadcastPending = true;
    this.progressBroadcastTimer = setTimeout(() => {
      this.progressBroadcastPending = false;
      this.broadcastRunProgress();
    }, PROGRESS_THROTTLE_MS);
  }

  private broadcastRunProgress(): void {
    this.broadcast({ type: 'run-progress', snapshot: this.buildSnapshot() });
  }

  private async handleSessionFileDownloaded(
    project: ProjectSyncState,
    message: SessionFileDownloadedMessage,
  ): Promise<void> {
    const session = project.sessions.get(message.sessionId);
    if (!session) return;

    // An existing session receiving at least one file download this run is
    // considered "updated" for the final-results summary.
    if (!session.isNew) {
      session.wasUpdated = true;
    }

    if (session.firstFile) {
      session.firstFile = false;
      session.syncStatus = 'processing';
      await this.db.setSessionSyncStatus(session.localSessionId, 'processing');
    }

    await this.upsertDownloadedFile(project, session, message);
    session.pendingFiles++;

    const retainPromise = this.onFileDownloaded(
      session.localSessionId,
      {
        path: message.file,
        hash: message.hash,
        etag: message.etag,
        size: message.content.byteLength,
        content: message.content,
      },
      project.projectId,
    )
      .then(() => this.onFileProcessed(session, message))
      .catch((error) => {
        console.error(`File download processing failed for ${message.file}:`, error);
        this.onFileProcessFailed(session, message);
      });
    session.retainPromises.push(retainPromise);

    this.emitChange();
  }

  private async upsertDownloadedFile(
    project: ProjectSyncState,
    session: SessionSyncState,
    message: SessionFileDownloadedMessage,
  ): Promise<void> {
    const existing = await this.findSessionFile(session.localSessionId, message.file);
    const record: SessionFileRecord = {
      id: existing?.id ?? generateId(),
      project_id: project.localProjectId,
      session_id: session.localSessionId,
      path: message.file,
      scope: this.fileScope(message.file),
      sha256: message.hash,
      etag: message.etag,
      size: message.content.byteLength,
      status: 'downloaded',
      updated_at: Date.now(),
    };
    await this.db.upsertSessionFile(record);
  }

  private fileScope(file: string): 'session' | 'workspace' | 'global' | 'runtime' {
    const scope = file.split('/')[0];
    if (scope === 'workspace' || scope === 'global' || scope === 'runtime') return scope;
    return 'session';
  }

  private async onFileProcessed(
    session: SessionSyncState,
    message: SessionFileDownloadedMessage,
  ): Promise<void> {
    await this.updateFileStatus(session.localSessionId, message.file, 'processed');
    session.pendingFiles = Math.max(0, session.pendingFiles - 1);
    await this.maybeCompleteSession(session);
    this.emitChange();
  }

  private async onFileProcessFailed(
    session: SessionSyncState,
    message: SessionFileDownloadedMessage,
  ): Promise<void> {
    await this.updateFileStatus(session.localSessionId, message.file, 'failed');
    session.pendingFiles = Math.max(0, session.pendingFiles - 1);
    this.emitChange();
  }

  private async updateFileStatus(
    sessionId: string,
    path: string,
    status: 'downloaded' | 'processed' | 'failed',
  ): Promise<void> {
    const existing = await this.findSessionFile(sessionId, path);
    if (!existing) return;
    await this.db.upsertSessionFile({ ...existing, status, updated_at: Date.now() });
  }

  private async findSessionFile(
    sessionId: string,
    path: string,
  ): Promise<SessionFileRecord | undefined> {
    const files = await this.db.getSessionFiles(sessionId);
    return files.find((row) => row.path === path);
  }

  private async handleSessionSyncComplete(
    project: ProjectSyncState,
    message: SessionSyncCompleteMessage,
  ): Promise<void> {
    const session = project.sessions.get(message.sessionId);
    if (!session) return;
    session.completeReceived = true;

    for (const file of message.files) {
      await this.reconcileCompleteFile(project, session, file);
    }

    // Wait for all in-flight artifact retain calls to settle before feeding
    // the manifest into the analytics ingestion pipeline. Without this, the
    // worker's SESSION_SYNC_COMPLETE can arrive before `retainSyncArtifact`
    // has finished, causing `ingestSyncManifest` to fail with
    // "Artifact not resolvable".
    if (session.retainPromises.length > 0) {
      await Promise.allSettled(session.retainPromises);
      session.retainPromises.length = 0;
    }

    try {
      await this.onSyncComplete(session.localSessionId, session.manifest, project.projectId);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      const details = this.formatSyncDetails('INGEST_FAILED', messageText);
      console.error(`Session sync ingest failed for ${message.sessionId}: ${details}`, error);
      session.syncStatus = 'failed';
      project.sessionsFailed++;
      await this.db.setSessionSyncStatus(session.localSessionId, 'failed', details);
      this.emitChange();
      return;
    }

    project.sessionsDone++;
    await this.maybeCompleteSession(session);
    this.emitChange();
  }

  private async reconcileCompleteFile(
    project: ProjectSyncState,
    session: SessionSyncState,
    file: FileSummary,
  ): Promise<void> {
    const existing = await this.findSessionFile(session.localSessionId, file.file);
    const status = this.fileSummaryStatus(file, existing);
    const record: SessionFileRecord = {
      id: existing?.id ?? generateId(),
      project_id: project.localProjectId,
      session_id: session.localSessionId,
      path: file.file,
      scope: this.fileScope(file.file),
      sha256: file.hash,
      size: file.size,
      status,
      updated_at: Date.now(),
    };
    if (file.status === 'unchanged' && !existing && !this.isValidSha256(file.hash)) {
      return;
    }
    await this.db.upsertSessionFile(record);
  }

  private fileSummaryStatus(
    file: FileSummary,
    existing?: SessionFileRecord,
  ): 'downloaded' | 'processed' | 'failed' {
    if (file.status === 'failed') return 'failed';
    if (file.status === 'unchanged') return 'processed';
    if (existing?.status === 'processed') return 'processed';
    return 'downloaded';
  }

  private async maybeCompleteSession(session: SessionSyncState): Promise<void> {
    if (!session.completeReceived) return;
    if (session.pendingFiles > 0) return;
    if (session.syncStatus === 'transcript_unavailable' || session.syncStatus === 'failed') {
      return;
    }
    session.syncStatus = 'in_sync';
    try {
      await this.db.setSessionSyncStatus(session.localSessionId, 'in_sync');
    } catch {
      // Ignore; the row will be re-evaluated on the next sync.
    }
    this.emitChange();
  }

  private async handleSessionSyncFailed(
    project: ProjectSyncState,
    message: SessionSyncFailedMessage,
  ): Promise<void> {
    const session = project.sessions.get(message.sessionId);
    if (!session) return;
    const details = this.formatSyncDetails(message.error.code, message.error.message);
    console.error(`Session sync failed for ${message.sessionId}: ${details}`);
    session.syncStatus = 'failed';
    session.completeReceived = true;
    project.sessionsFailed++;
    await this.db.setSessionSyncStatus(session.localSessionId, 'failed', details);
    this.emitChange();
  }

  private async handleWorkerDone(
    run: SyncRun,
    project: ProjectSyncState,
    worker: Worker,
    _message: WorkerDoneMessage,
  ): Promise<void> {
    await this.closeWorkerSlot(run, project, worker, 'Failed to process files', false);
  }

  private async handleWorkerError(
    run: SyncRun,
    project: ProjectSyncState,
    worker: Worker,
    message: WorkerErrorMessage,
  ): Promise<void> {
    const details = this.formatSyncDetails(message.error.code, message.error.message);
    console.error(`Worker error for ${project.projectId}: ${details}`);
    this.pushWarning(run, `${project.projectId}: ${details}`);
    await this.closeWorkerSlot(run, project, worker, details, true);
  }

  private handleWorkerFatal(
    run: SyncRun,
    project: ProjectSyncState,
    worker: Worker,
    error: Error,
  ): void {
    const details = this.formatSyncDetails('WORKER_ERROR', error.message);
    console.error(`Worker fatal for ${project.projectId}: ${details}`, error);
    this.pushWarning(run, `${project.projectId}: ${details}`);
    this.closeWorkerSlot(run, project, worker, details, true).catch(() => undefined);
  }

  private async closeWorkerSlot(
    run: SyncRun,
    project: ProjectSyncState,
    worker: Worker,
    staleDetails: string,
    errored: boolean,
  ): Promise<void> {
    project.status = errored ? 'failed' : 'done';
    project.sessionsDone = project.sessions.size;
    project.sessionsFailed = Array.from(project.sessions.values()).filter(
      (s) => s.syncStatus === 'failed',
    ).length;

    await this.db.failStaleSessions(project.localProjectId, staleDetails);
    await this.db.setProjectSyncStatus(project.localProjectId, 'in_sync');

    worker.terminate();
    run.activeWorkers.delete(worker);
    project.worker = null;

    this.dispatchWorkers(run);
    this.checkRunComplete(run);
  }

  private checkRunComplete(run: SyncRun): void {
    if (run.activeWorkers.size > 0 || run.projectQueue.length > 0) return;
    const anyErrored = Array.from(run.projects.values()).some(
      (project) => project.status === 'failed' || project.sessionsFailed > 0,
    );
    this.endRun(run, anyErrored ? 'failed' : 'done');
  }

  private endRun(run: SyncRun, state: SyncRunState): void {
    run.state = state;
    run.finishedAt = Date.now();
    if (state === 'done') {
      this.lastCompletedAt = run.finishedAt;
    }
    this.stopHeartbeatTimer();
    this.broadcast({ type: 'run-finished', snapshot: this.buildSnapshot() });

    if (run.connection) {
      const ephemeral = this.ephemeralConnections.get(run.connectionId);
      if (ephemeral) {
        ephemeral.connection = { ...ephemeral.connection, last_sync_at: Date.now() };
      } else {
        this.db
          .updateConnection(run.connectionId, { last_sync_at: Date.now() })
          .catch(() => undefined);
      }
    }

    this.onRunSummary?.(this.summarizeRun(run));
    this.emitChange();
    this.processQueue();
  }

  /** Pushes a warning onto the run and fires the {@link onWarning} seam. */
  private pushWarning(run: SyncRun, warning: string): void {
    run.warnings.push(warning);
    this.onWarning?.(warning);
  }

  private failRun(run: SyncRun, reason: string): void {
    console.error(`Sync run failed: ${reason}`);
    for (const worker of run.activeWorkers) {
      worker.postMessage({ type: 'CANCEL' } as SyncMessageToWorker);
      worker.terminate();
    }
    run.activeWorkers.clear();
    this.pushWarning(run, reason);
    this.endRun(run, 'failed');
  }

  private abortActiveRun(details: string): void {
    const run = this.activeRun;
    if (!run) return;
    console.error(`Sync run aborted: ${details}`);
    run.cancelled = true;
    this.pushWarning(run, details);

    for (const worker of run.activeWorkers) {
      worker.postMessage({ type: 'CANCEL' } as SyncMessageToWorker);
      worker.terminate();
    }
    run.activeWorkers.clear();
    run.projectQueue.length = 0;

    for (const project of run.projects.values()) {
      project.worker = null;
      project.status = 'cancelled';
      this.db
        .failStaleSessions(project.localProjectId, details)
        .then(() => this.db.setProjectSyncStatus(project.localProjectId, 'in_sync'))
        .catch(() => undefined);
    }

    for (const queued of this.runQueue) {
      queued.state = 'cancelled';
      this.onRunSummary?.(this.summarizeRun(queued));
    }
    this.runQueue.length = 0;

    this.endRun(run, 'cancelled');
  }

  private handleBroadcastMessage(message: BroadcastMessage): void {
    if (message.type === 'cancel-requested') {
      if (!this.readOnly && this.activeRun) {
        this.abortActiveRun('Sync cancelled by user');
      }
      return;
    }

    if (message.type === 'run-finished') {
      this.becomeIdle();
      return;
    }

    if (message.snapshot) {
      this.resolveLateJoiner();
      this.becomeFollower(message.snapshot);
      this.resetLeaderHeartbeatTimer();
    }
  }

  private becomeIdle(): void {
    this.readOnly = false;
    this.activeRun = null;
    this.followerSnapshot = null;
    this.clearLeaderHeartbeatTimer();
    this.emitChange();
  }

  private becomeFollower(snapshot: SyncManagerSnapshot): void {
    this.readOnly = true;
    this.activeRun = null;
    this.followerSnapshot = snapshot;
    this.emitChange();
  }

  private resetLeaderHeartbeatTimer(): void {
    this.clearLeaderHeartbeatTimer();
    this.leaderHeartbeatTimer = setTimeout(() => {
      this.becomeIdle();
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private startHeartbeatTimer(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.broadcast({ type: 'heartbeat', snapshot: this.buildSnapshot() });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeatTimer(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearLeaderHeartbeatTimer(): void {
    if (!this.leaderHeartbeatTimer) return;
    clearTimeout(this.leaderHeartbeatTimer);
    this.leaderHeartbeatTimer = null;
  }

  private clearProgressBroadcastTimer(): void {
    if (!this.progressBroadcastTimer) return;
    clearTimeout(this.progressBroadcastTimer);
    this.progressBroadcastPending = false;
    this.progressBroadcastTimer = null;
  }

  private broadcastRunStarted(): void {
    this.broadcast({ type: 'run-started', snapshot: this.buildSnapshot() });
  }

  private broadcast(message: BroadcastMessage): void {
    this.broadcastChannel?.postMessage(message);
  }

  private buildSnapshot(): SyncManagerSnapshot {
    if (this.followerSnapshot && this.readOnly) {
      return { ...this.followerSnapshot, readOnly: true };
    }
    const run = this.activeRun;
    return {
      initialized: this.initialized,
      readOnly: this.readOnly,
      activeRun: run ? this.summarizeRun(run) : null,
      projects: run ? this.projectSnapshots(run) : [],
      sessions: run ? this.sessionSnapshots(run) : [],
      queuedRuns: this.runQueue.map((r) => r.connectionId),
      warnings: run ? [...run.warnings] : [],
      lastCompletedAt: this.lastCompletedAt,
    };
  }

  private projectSnapshots(run: SyncRun): ProjectSnapshot[] {
    return Array.from(run.projects.values()).map((project) => ({
      projectId: project.projectId,
      localProjectId: project.localProjectId,
      status: project.status,
      totalSessions: project.totalSessions,
      sessionsDone: project.sessionsDone,
      sessionsFailed: project.sessionsFailed,
      filesFound: project.filesFound,
      filesDownloaded: project.filesDownloaded,
      filesFailed: project.filesFailed,
      bytesReceived: project.bytesReceived,
      isNew: project.isNew,
    }));
  }

  private sessionSnapshots(run: SyncRun): SessionSnapshot[] {
    const sessions: SessionSnapshot[] = [];
    for (const project of run.projects.values()) {
      for (const session of project.sessions.values()) {
        sessions.push({
          projectId: project.projectId,
          sessionId: session.sessionId,
          status: session.syncStatus,
          filesFound: session.filesFound,
          filesDownloaded: session.filesDownloaded,
          filesFailed: session.filesFailed,
          bytesReceived: session.bytesReceived,
          isNew: session.isNew,
          wasUpdated: session.wasUpdated,
        });
      }
    }
    return sessions;
  }

  private summarizeRun(run: SyncRun): RunSummary {
    const sessionsFailed = Array.from(run.projects.values()).reduce(
      (sum, p) => sum + p.sessionsFailed,
      0,
    );
    return {
      connectionId: run.connectionId,
      state: run.state,
      warnings: [...run.warnings],
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      sessionsFailed,
    };
  }

  private emitChange(): void {
    this.dispatchEvent(new CustomEvent('change', { detail: this.buildSnapshot() }));
  }

  private textFromBuffer(buffer: ArrayBuffer): string {
    return new TextDecoder().decode(new Uint8Array(buffer));
  }

  private bufferFromText(text: string): ArrayBuffer {
    return new TextEncoder().encode(text).buffer;
  }

  private async getConnection(connectionId: string): Promise<Connection | null> {
    const ephemeral = this.ephemeralConnections.get(connectionId);
    if (ephemeral) return ephemeral.connection;
    const connections = await this.db.getConnections();
    return connections.find((c) => c.id === connectionId) ?? null;
  }

  private isNotFoundError(error: unknown): boolean {
    const e = error as { status?: number; code?: string };
    return e.status === 404 || e.code === 'NoSuchKey' || e.code === 'NotFound';
  }
}

/** App-wide sync singleton. */
export const syncManager = new SyncManager({
  onWarning: (warning) => toastManager.warning('Sync warning', { message: warning }),
  onPasskeyRequired: async () => requestPasskey(),
  onRunSummary: (summary) => {
    if (summary.state === 'failed') {
      const hasWarnings = summary.warnings.length > 0;
      const hasSessionFailures = (summary.sessionsFailed ?? 0) > 0;
      if (hasWarnings) {
        toastManager.error('Sync failed', {
          message: summary.warnings[summary.warnings.length - 1],
          hint: 'Click the progress bar in the header for full details.',
        });
      } else if (hasSessionFailures) {
        toastManager.error('Sync completed with failures', {
          message: `${summary.sessionsFailed} session${summary.sessionsFailed === 1 ? '' : 's'} failed to ingest.`,
          hint: 'Click the progress bar in the header for full details.',
        });
      }
    }
  },
  onFileDownloaded: async (_sessionId, file, _projectId) => {
    // Retain each downloaded file in the analytics blob store so the
    // analytics worker can resolve artifacts during manifest ingestion.
    await analyticsClient.retainSyncArtifact({
      sha256: file.hash,
      size: file.size,
      relativePath: file.path,
      mediaType: 'application/octet-stream',
      content: new Uint8Array(file.content),
    });
  },
  onSyncComplete: async (_sessionId, manifest, projectId) => {
    if (!manifest) return;
    // Feed the completed sync manifest into the analytics ingestion pipeline
    // so metric values and rollups are materialized for portfolio charts.
    const receipt = await analyticsClient.ingestSyncManifest(manifest, {
      sourceId: 'sync',
      projectId,
      sessionId: manifest.sessionId,
    });
    if (receipt.status === 'failed' && receipt.issueIds.length > 0) {
      const detail =
        receipt.issueIds.length > 0
          ? `ingestion issues: ${receipt.issueIds.join(', ')}`
          : 'ingestion failed';
      throw new Error(`INGEST_FAILED: ${detail}`);
    }
  },
});

// Analytics auto-reprocessing events (emitted by the analytics worker on boot
// when the stored processing version is older than the current version) are
// handled by app-root.ts, which renders a full-screen blocking overlay with
// progress. No toast listeners are needed here.
