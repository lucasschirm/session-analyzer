/**
 * Typed message protocol between the main-thread analytics client and the
 * analytics Web Worker.
 *
 * Only DTOs cross this boundary. SQL types (`SqliteExecutor`, `SqliteRow`,
 * `SqliteValue`, etc.) live inside the worker and are never serialized.
 */

import type { AnalyticsDataSource, ResolvedArtifact } from '@lucasschirm/sal-db';

/**
 * Serializable backend report describing the WASM/OPFS adapter state.
 */
export interface AnalyticsBackendReport {
  readonly backendName: string;
  readonly durability: 'persistent' | 'ephemeral';
  readonly journalMode: string;
  readonly storage: 'opfs' | 'memory';
  readonly fallbackReason?: 'locked' | 'unsupported';
  readonly supports?: {
    readonly integersAsBigint: boolean;
    readonly blob: boolean;
    readonly preparedStatements: boolean;
    readonly foreignKeys: boolean;
    readonly wal: boolean;
    readonly nestedTransactions: boolean;
    readonly concurrentTransactions: boolean;
    readonly cancellation: boolean;
    readonly busyTimeout: boolean;
    readonly durable: boolean;
    readonly sharedMemory?: boolean;
    readonly sql: {
      readonly features: readonly string[];
      readonly maxBoundParameters: number | 'unlimited';
      readonly maxSqlLength: number | 'unlimited';
      readonly maxColumnNameLength: number;
    };
  };
}

/**
 * A single artifact supplied by the manual-import UI.
 *
 * Only the relative path, media type, and content cross the worker boundary.
 * The worker computes hashes and sizes as needed.
 */
export interface ManualArtifactPayload {
  readonly relativePath: string;
  readonly mediaType: string;
  readonly content: string;
  readonly sha256?: string;
  readonly size?: number;
  readonly status?: string;
}

/**
 * Serializable request body for a manual ingestion bundle.
 */
export interface ManualIngestionBundleRequest {
  readonly artifacts: readonly ManualArtifactPayload[];
  readonly source?: {
    readonly sourceId: string;
    readonly environmentId?: string;
    readonly projectId?: string;
    readonly sessionId?: string;
  };
  readonly harness?: string;
  readonly harnessVersion?: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly workspaceId?: string;
  readonly repositoryId?: string;
  readonly importBatchId?: string;
}

interface BaseRequest {
  readonly id: number;
}

export interface InitRequest extends BaseRequest {
  readonly type: 'init';
}

export interface GetBackendRequest extends BaseRequest {
  readonly type: 'getBackend';
}

export interface QueryRequest extends BaseRequest {
  readonly type: 'query';
  readonly view: keyof AnalyticsDataSource;
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface RetainSyncArtifactRequest extends BaseRequest {
  readonly type: 'retainSyncArtifact';
  readonly artifact: ResolvedArtifact;
}

export interface DetectManualHarnessRequest extends BaseRequest {
  readonly type: 'detectManualHarness';
  readonly artifacts: readonly ManualArtifactPayload[];
}

export interface IngestManualBundleRequest extends BaseRequest {
  readonly type: 'ingestManualBundle';
  readonly bundle: ManualIngestionBundleRequest;
}

export interface ResolveManualConflictRequest extends BaseRequest {
  readonly type: 'resolveManualConflict';
  readonly bundle: ManualIngestionBundleRequest;
  readonly resolution: 'replace' | 'keep';
}

export interface IngestSyncManifestRequest extends BaseRequest {
  readonly type: 'ingestSyncManifest';
  readonly manifest: unknown;
  readonly source: {
    readonly sourceId: string;
    readonly environmentId?: string;
    readonly projectId?: string;
    readonly sessionId?: string;
  };
}

export interface CloseRequest extends BaseRequest {
  readonly type: 'close';
}

export interface ResolveProjectIdRequest extends BaseRequest {
  readonly type: 'resolveProjectId';
  readonly projectId: string;
}

export interface DeleteProjectRequest extends BaseRequest {
  readonly type: 'deleteProject';
  readonly projectId: string;
}

export type AnalyticsRequest =
  | InitRequest
  | GetBackendRequest
  | QueryRequest
  | RetainSyncArtifactRequest
  | DetectManualHarnessRequest
  | IngestManualBundleRequest
  | ResolveManualConflictRequest
  | IngestSyncManifestRequest
  | ResolveProjectIdRequest
  | DeleteProjectRequest
  | CloseRequest;

export type AnalyticsRequestPayload =
  | Omit<InitRequest, 'id'>
  | Omit<GetBackendRequest, 'id'>
  | Omit<QueryRequest, 'id'>
  | Omit<RetainSyncArtifactRequest, 'id'>
  | Omit<DetectManualHarnessRequest, 'id'>
  | Omit<IngestManualBundleRequest, 'id'>
  | Omit<ResolveManualConflictRequest, 'id'>
  | Omit<IngestSyncManifestRequest, 'id'>
  | Omit<ResolveProjectIdRequest, 'id'>
  | Omit<DeleteProjectRequest, 'id'>
  | Omit<CloseRequest, 'id'>;

interface BaseResponse {
  readonly id: number;
}

export interface AnalyticsSuccessResponse extends BaseResponse {
  readonly ok: true;
  readonly result?: unknown;
  readonly backend?: AnalyticsBackendReport;
  readonly storage?: 'opfs' | 'memory';
  readonly fallbackReason?: 'locked' | 'unsupported';
}

export interface AnalyticsErrorResponse extends BaseResponse {
  readonly ok: false;
  readonly error: string;
}

export type AnalyticsResponse = AnalyticsSuccessResponse | AnalyticsErrorResponse;

/**
 * Broadcast sent by the analytics worker when a write operation changes the
 * underlying data. It carries no request id so it is not mistaken for a
 * correlated query response. UI consumers can listen for this on the client.
 */
export interface AnalyticsDataChangedBroadcast {
  readonly type: 'dataChanged';
  readonly ok: true;
}

/**
 * Broadcast sent by the analytics worker when an automatic reprocessing pass
 * starts. Emitted on boot when the stored analytics processing version is
 * older than the current version and a rebuild is required.
 */
export interface AnalyticsReprocessStartedBroadcast {
  readonly type: 'reprocessStarted';
  readonly ok: true;
  readonly reason: string;
}

/**
 * Broadcast sent by the analytics worker during reprocessing to report
 * per-step progress. `completed` and `total` are counts for the current step.
 */
export interface AnalyticsReprocessProgressBroadcast {
  readonly type: 'reprocessProgress';
  readonly ok: true;
  readonly step: string;
  readonly completed: number;
  readonly total: number;
}

/**
 * Broadcast sent by the analytics worker when an automatic reprocessing pass
 * finishes (successfully or not). `error` is present when the rebuild failed.
 */
export interface AnalyticsReprocessCompletedBroadcast {
  readonly type: 'reprocessCompleted';
  readonly ok: boolean;
  readonly error?: string;
}

export type AnalyticsReprocessBroadcast =
  | AnalyticsReprocessStartedBroadcast
  | AnalyticsReprocessProgressBroadcast
  | AnalyticsReprocessCompletedBroadcast;
