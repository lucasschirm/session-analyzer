export interface SyncLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  maxTranscriptBytes: number;
  maxJsonDepth: number;
  maxJsonlLineBytes: number;
}

export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 1000;
export const DEFAULT_MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_JSON_DEPTH = 128;
export const DEFAULT_MAX_JSONL_LINE_BYTES = 1024 * 1024;

export const DEFAULT_SYNC_LIMITS: SyncLimits = {
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
  maxFiles: DEFAULT_MAX_FILES,
  maxTranscriptBytes: DEFAULT_MAX_TRANSCRIPT_BYTES,
  maxJsonDepth: DEFAULT_MAX_JSON_DEPTH,
  maxJsonlLineBytes: DEFAULT_MAX_JSONL_LINE_BYTES,
};
