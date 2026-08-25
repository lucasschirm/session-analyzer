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

export interface CloseRequest extends BaseRequest {
  readonly type: 'close';
}

export type AnalyticsRequest =
  | InitRequest
  | GetBackendRequest
  | QueryRequest
  | RetainSyncArtifactRequest
  | CloseRequest;

export type AnalyticsRequestPayload =
  | Omit<InitRequest, 'id'>
  | Omit<GetBackendRequest, 'id'>
  | Omit<QueryRequest, 'id'>
  | Omit<RetainSyncArtifactRequest, 'id'>
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
