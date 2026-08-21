import type { SyncLimits } from '../limits.js';

export const ENV_SAL_PROJECT_ID = 'SAL_PROJECT_ID';
export const ENV_SAL_SYNC_DISABLED = 'SAL_SYNC_DISABLED';
export const ENV_SAL_CAPTURE_TRANSCRIPTS = 'SAL_CAPTURE_TRANSCRIPTS';

export const ENV_SAL_STORAGE_TYPE = 'SAL_STORAGE_TYPE';
export const ENV_SAL_STORAGE_BUCKET = 'SAL_STORAGE_BUCKET';
export const ENV_SAL_STORAGE_ENDPOINT = 'SAL_STORAGE_ENDPOINT';
export const ENV_SAL_STORAGE_REGION = 'SAL_STORAGE_REGION';
export const ENV_SAL_STORAGE_ACCESS_KEY_ID = 'SAL_STORAGE_ACCESS_KEY_ID';
export const ENV_SAL_STORAGE_SECRET_ACCESS_KEY = 'SAL_STORAGE_SECRET_ACCESS_KEY';
export const ENV_SAL_STORAGE_SESSION_TOKEN = 'SAL_STORAGE_SESSION_TOKEN';

export const ENV_SAL_STORAGE_URL = 'SAL_STORAGE_URL';

export const SYNC_STORAGE_URL_CONFLATION_PROHIBITED = true;

export const ENV_SAL_SYNC_TIMEOUT = 'SAL_SYNC_TIMEOUT';
export const ENV_SAL_SYNC_RETRIES = 'SAL_SYNC_RETRIES';
export const ENV_SAL_SESSION_END_BUDGET_MS = 'SAL_SESSION_END_BUDGET_MS';
export const ENV_SAL_HOOK_UPLOAD_TIMEOUT = 'SAL_HOOK_UPLOAD_TIMEOUT';

export const ENV_SAL_MAX_FILE_BYTES = 'SAL_MAX_FILE_BYTES';
export const ENV_SAL_MAX_TOTAL_BYTES = 'SAL_MAX_TOTAL_BYTES';
export const ENV_SAL_MAX_FILES = 'SAL_MAX_FILES';
export const ENV_SAL_MAX_TRANSCRIPT_BYTES = 'SAL_MAX_TRANSCRIPT_BYTES';
export const ENV_SAL_MAX_JSON_DEPTH = 'SAL_MAX_JSON_DEPTH';
export const ENV_SAL_MAX_JSONL_LINE_BYTES = 'SAL_MAX_JSONL_LINE_BYTES';

export type SyncEnvVar =
  | typeof ENV_SAL_PROJECT_ID
  | typeof ENV_SAL_SYNC_DISABLED
  | typeof ENV_SAL_CAPTURE_TRANSCRIPTS
  | typeof ENV_SAL_STORAGE_TYPE
  | typeof ENV_SAL_STORAGE_BUCKET
  | typeof ENV_SAL_STORAGE_ENDPOINT
  | typeof ENV_SAL_STORAGE_REGION
  | typeof ENV_SAL_STORAGE_ACCESS_KEY_ID
  | typeof ENV_SAL_STORAGE_SECRET_ACCESS_KEY
  | typeof ENV_SAL_STORAGE_SESSION_TOKEN
  | typeof ENV_SAL_SYNC_TIMEOUT
  | typeof ENV_SAL_SYNC_RETRIES
  | typeof ENV_SAL_SESSION_END_BUDGET_MS
  | typeof ENV_SAL_HOOK_UPLOAD_TIMEOUT
  | typeof ENV_SAL_MAX_FILE_BYTES
  | typeof ENV_SAL_MAX_TOTAL_BYTES
  | typeof ENV_SAL_MAX_FILES
  | typeof ENV_SAL_MAX_TRANSCRIPT_BYTES
  | typeof ENV_SAL_MAX_JSON_DEPTH
  | typeof ENV_SAL_MAX_JSONL_LINE_BYTES;

export type StorageType = 's3' | (string & {});

export const STORAGE_CONFIG_FIELDS: readonly (keyof StorageConfig)[] = [
  'type',
  'endpoint',
  'bucket',
  'region',
  'accessKeyId',
  'secretAccessKey',
  'sessionToken',
];

export interface StorageConfig {
  type: StorageType;
  endpoint?: string;
  bucket?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

export const DEFAULT_SYNC_TIMEOUT_MS = 30_000;
export const DEFAULT_SYNC_RETRIES = 3;
export const DEFAULT_SESSION_END_BUDGET_MS = 120_000;
export const DEFAULT_HOOK_UPLOAD_TIMEOUT_MS = 10_000;

export interface SyncTimeouts {
  syncTimeoutMs: number;
  hookUploadTimeoutMs: number;
  sessionEndBudgetMs: number;
}

export const DEFAULT_SYNC_TIMEOUTS: SyncTimeouts = {
  syncTimeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
  hookUploadTimeoutMs: DEFAULT_HOOK_UPLOAD_TIMEOUT_MS,
  sessionEndBudgetMs: DEFAULT_SESSION_END_BUDGET_MS,
};

export interface SyncConfig {
  projectId: string;
  disabled: boolean;
  captureTranscripts: boolean;
  storage: StorageConfig;
  limits: SyncLimits;
  timeouts: SyncTimeouts;
  retries: number;
}
