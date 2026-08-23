import type { SyncErrorCode } from './errors.js';

export type SyncTrigger =
  | 'session-start'
  | 'file-changed'
  | 'pre-compact'
  | 'post-compact'
  | 'stop'
  | 'stop-failure'
  | 'subagent-stop'
  | 'session-end'
  | 'manual';

export interface SyncRunResult {
  trigger: SyncTrigger;
  filesDiscovered: number;
  filesChanged: number;
  filesUploaded: number;
  filesFailed: number;
  filesSkipped: number;
  bytesDiscovered: number;
  bytesChanged: number;
  bytesUploaded: number;
  errors?: SyncErrorCode[];
  errorDetails?: Array<{ code: SyncErrorCode; message: string }>;
}

export interface SyncPerformanceTelemetry {
  trigger: SyncTrigger;
  discoveryDurationMs: number;
  sanitizationDurationMs: number;
  hashDurationMs: number;
  uploadDurationMs: number;
  totalDurationMs: number;
}

export interface SyncRun extends SyncRunResult, SyncPerformanceTelemetry {}
