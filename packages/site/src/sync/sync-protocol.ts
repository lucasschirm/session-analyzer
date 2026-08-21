/**
 * Typed message protocol between the main thread and the session sync Web
 * Worker. All worker→main payloads use `ArrayBuffer` for file bytes and list
 * the buffer in `postMessage`'s transfer list.
 */

import type { ArtifactScope, SyncManifest } from '@lucasschirm/sal-sync-core';

/** In-memory S3 credential material sent with `START`. */
export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * A single file the main thread wants the worker to download. The worker never
 * constructs object keys by string concatenation; it derives each one from
 * `scope`, `relativePath`, and `hash` via `buildObjectKey`.
 */
export interface FileToDownload {
  /** Logical path used in progress and `session_files` rows: `<scope>/<relativePath>`. */
  file: string;
  scope: ArtifactScope;
  relativePath: string;
  hash: string;
  size: number;
  isMainTranscript: boolean;
}

/** Per-file terminal status reported in `SESSION_SYNC_COMPLETE`. */
export interface FileSummary {
  file: string;
  hash: string;
  size: number;
  status: 'downloaded' | 'unchanged' | 'failed';
}

/** Error payload carried by worker→main failure messages. */
export interface SyncErrorPayload {
  code: string;
  message: string;
}

/** Main→Worker: begin syncing a project. */
export interface StartMessage {
  type: 'START';
  connectionId?: string;
  projectId: string;
  credentials: S3Credentials;
  bucket: string;
  endpoint?: string;
  region: string;
  syncOnlyNew: boolean;
  targetSessionIds?: string[];
}

/** Main→Worker: answer to `SESSION_FOUND` in sync-only-new mode. */
export interface SessionSyncContinueMessage {
  type: 'SESSION_SYNC_CONTINUE';
  connectionId?: string;
  projectId?: string;
  sessionId: string;
  sync: boolean;
}

/** Main→Worker: decision after `SESSION_MANIFEST_READY`. */
export interface SessionSyncMessage {
  type: 'SESSION_SYNC';
  connectionId?: string;
  projectId?: string;
  sessionId: string;
  sync: boolean;
  exists: boolean;
  filesToDownload?: FileToDownload[];
}

/** Main→Worker: abort the sync and release resources. */
export interface CancelMessage {
  type: 'CANCEL';
  connectionId?: string;
  projectId?: string;
}

/** Union of all messages the main thread can send to the sync worker. */
export type SyncMessageToWorker =
  | StartMessage
  | SessionSyncContinueMessage
  | SessionSyncMessage
  | CancelMessage;

/** Worker→Main: S3 client is built and the first listing page succeeded. */
export interface ConnectedMessage {
  type: 'CONNECTED';
  connectionId?: string;
  projectId: string;
}

/** Worker→Main: one page of session folder prefixes. */
export interface SessionBatchFoundMessage {
  type: 'SESSION_BATCH_FOUND';
  connectionId?: string;
  projectId: string;
  sessionIds: string[];
  final: boolean;
}

/** Worker→Main: session folder listing is complete. */
export interface ProjectFolderFoundMessage {
  type: 'PROJECT_FOLDER_FOUND';
  connectionId?: string;
  projectId: string;
  totalSessions: number;
}

/** Worker→Main: a session folder was discovered. */
export interface SessionFoundMessage {
  type: 'SESSION_FOUND';
  connectionId?: string;
  projectId: string;
  sessionId: string;
}

/** Worker→Main: manifest downloaded and validated. */
export interface SessionManifestReadyMessage {
  type: 'SESSION_MANIFEST_READY';
  connectionId?: string;
  projectId: string;
  sessionId: string;
  manifest: SyncManifest;
}

/** Worker→Main: per-file download progress for a session. */
export interface SessionSyncProgressMessage {
  type: 'SESSION_SYNC_PROGRESS';
  connectionId?: string;
  projectId: string;
  sessionId: string;
  files_found: number;
  files_downloaded: number;
  files_failed: number;
  bytes_received: number;
}

/**
 * Worker→Main: a requested file finished downloading and hash-verified. The
 * `content` ArrayBuffer is listed in the `postMessage` transfer list so it is
 * detached from worker memory immediately.
 */
export interface SessionFileDownloadedMessage {
  type: 'SESSION_FILE_DOWNLOADED';
  connectionId?: string;
  projectId: string;
  sessionId: string;
  file: string;
  hash: string;
  content: ArrayBuffer;
}

/** Worker→Main: terminal per-session summary. */
export interface SessionSyncCompleteMessage {
  type: 'SESSION_SYNC_COMPLETE';
  connectionId?: string;
  projectId: string;
  sessionId: string;
  files: FileSummary[];
}

/** Worker→Main: a single session could not be synced. */
export interface SessionSyncFailedMessage {
  type: 'SESSION_SYNC_FAILED';
  connectionId?: string;
  projectId: string;
  sessionId: string;
  error: SyncErrorPayload;
}

/** Worker→Main: every discovered session has been settled. */
export interface WorkerDoneMessage {
  type: 'WORKER_DONE';
  connectionId?: string;
  projectId: string;
  synced: number;
  failed: number;
  skipped: number;
}

/** Worker→Main: unrecoverable worker-level failure. */
export interface WorkerErrorMessage {
  type: 'WORKER_ERROR';
  connectionId?: string;
  projectId: string;
  error: SyncErrorPayload;
}

/** Union of all messages the sync worker can post to the main thread. */
export type SyncMessageFromWorker =
  | ConnectedMessage
  | SessionBatchFoundMessage
  | ProjectFolderFoundMessage
  | SessionFoundMessage
  | SessionManifestReadyMessage
  | SessionSyncProgressMessage
  | SessionFileDownloadedMessage
  | SessionSyncCompleteMessage
  | SessionSyncFailedMessage
  | WorkerDoneMessage
  | WorkerErrorMessage;
