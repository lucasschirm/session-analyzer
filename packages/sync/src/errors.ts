export type SyncErrorCode =
  | 'SYNC_CONFIG_MISSING'
  | 'SYNC_AUTH_FAILED'
  | 'SYNC_NETWORK_TIMEOUT'
  | 'SYNC_STORAGE_ERROR'
  | 'SYNC_DISCOVERY_ERROR'
  | 'SYNC_SANITIZATION_ERROR'
  | 'SYNC_STATE_ERROR'
  | 'SYNC_FILE_TOO_LARGE'
  | 'SYNC_TOTAL_SIZE_EXCEEDED'
  | 'SYNC_FILE_COUNT_EXCEEDED'
  | 'SYNC_JSON_PARSE_FAILED'
  | 'SYNC_STATE_CORRUPT'
  | 'SYNC_WATCHER_ERROR'
  | 'SYNC_INTERNAL_ERROR';

export type SyncErrorCategory = 'retryable' | 'non-retryable' | 'context-dependent';

export interface SyncErrorMeta {
  code: SyncErrorCode;
  category: SyncErrorCategory;
  description: string;
}

export const SYNC_ERROR_CATALOG: Record<SyncErrorCode, SyncErrorMeta> = {
  SYNC_CONFIG_MISSING: {
    code: 'SYNC_CONFIG_MISSING',
    category: 'non-retryable',
    description: 'Required configuration (e.g. SAL_PROJECT_ID) is missing.',
  },
  SYNC_AUTH_FAILED: {
    code: 'SYNC_AUTH_FAILED',
    category: 'non-retryable',
    description: 'Storage authentication failed.',
  },
  SYNC_NETWORK_TIMEOUT: {
    code: 'SYNC_NETWORK_TIMEOUT',
    category: 'retryable',
    description: 'A network request timed out.',
  },
  SYNC_STORAGE_ERROR: {
    code: 'SYNC_STORAGE_ERROR',
    category: 'context-dependent',
    description: 'A storage service error occurred; retryability depends on the response.',
  },
  SYNC_DISCOVERY_ERROR: {
    code: 'SYNC_DISCOVERY_ERROR',
    category: 'non-retryable',
    description: 'An artifact could not be discovered or was outside the allowed boundary.',
  },
  SYNC_SANITIZATION_ERROR: {
    code: 'SYNC_SANITIZATION_ERROR',
    category: 'non-retryable',
    description: 'Sanitization failed for an artifact.',
  },
  SYNC_STATE_ERROR: {
    code: 'SYNC_STATE_ERROR',
    category: 'retryable',
    description: 'A transient state read or write error occurred.',
  },
  SYNC_FILE_TOO_LARGE: {
    code: 'SYNC_FILE_TOO_LARGE',
    category: 'non-retryable',
    description: 'A single artifact exceeded the byte limit.',
  },
  SYNC_TOTAL_SIZE_EXCEEDED: {
    code: 'SYNC_TOTAL_SIZE_EXCEEDED',
    category: 'non-retryable',
    description: 'The total capture size exceeded the configured budget.',
  },
  SYNC_FILE_COUNT_EXCEEDED: {
    code: 'SYNC_FILE_COUNT_EXCEEDED',
    category: 'non-retryable',
    description: 'The number of artifacts exceeded the configured limit.',
  },
  SYNC_JSON_PARSE_FAILED: {
    code: 'SYNC_JSON_PARSE_FAILED',
    category: 'context-dependent',
    description: 'A JSON or JSONL line could not be parsed; may be transient.',
  },
  SYNC_STATE_CORRUPT: {
    code: 'SYNC_STATE_CORRUPT',
    category: 'non-retryable',
    description: 'Local state was corrupt and must be recovered.',
  },
  SYNC_WATCHER_ERROR: {
    code: 'SYNC_WATCHER_ERROR',
    category: 'retryable',
    description: 'The transcript watcher encountered a transient error.',
  },
  SYNC_INTERNAL_ERROR: {
    code: 'SYNC_INTERNAL_ERROR',
    category: 'non-retryable',
    description: 'An unexpected internal error escaped the sync pipeline.',
  },
};

export const TELEMETRY_INCLUDES_RAW_EXCEPTIONS = false;
