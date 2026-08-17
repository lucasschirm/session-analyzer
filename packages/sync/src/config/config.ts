import process from 'node:process';
import type { SyncErrorCode } from '../errors.js';
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_JSON_DEPTH,
  DEFAULT_MAX_JSONL_LINE_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_MAX_TRANSCRIPT_BYTES,
  type SyncLimits,
} from '../limits.js';
import {
  DEFAULT_HOOK_UPLOAD_TIMEOUT_MS,
  DEFAULT_SESSION_END_BUDGET_MS,
  DEFAULT_SYNC_RETRIES,
  DEFAULT_SYNC_TIMEOUT_MS,
  ENV_SAL_CAPTURE_TRANSCRIPTS,
  ENV_SAL_HOOK_UPLOAD_TIMEOUT,
  ENV_SAL_MAX_FILE_BYTES,
  ENV_SAL_MAX_FILES,
  ENV_SAL_MAX_JSON_DEPTH,
  ENV_SAL_MAX_JSONL_LINE_BYTES,
  ENV_SAL_MAX_TOTAL_BYTES,
  ENV_SAL_MAX_TRANSCRIPT_BYTES,
  ENV_SAL_PROJECT_ID,
  ENV_SAL_SESSION_END_BUDGET_MS,
  ENV_SAL_STORAGE_BUCKET,
  ENV_SAL_STORAGE_ENDPOINT,
  ENV_SAL_STORAGE_ID,
  ENV_SAL_STORAGE_REGION,
  ENV_SAL_STORAGE_SECRET,
  ENV_SAL_STORAGE_SESSION_TOKEN,
  ENV_SAL_STORAGE_TYPE,
  ENV_SAL_SYNC_DISABLED,
  ENV_SAL_SYNC_RETRIES,
  ENV_SAL_SYNC_TIMEOUT,
  type StorageConfig,
  type StorageType,
  type SyncConfig,
  type SyncTimeouts,
} from './contract.js';

export type ConfigEnv = Record<string, string | undefined>;

export interface SyncConfigError {
  code: SyncErrorCode;
  message: string;
}

export type LoadConfigResult =
  | { ok: true; config: SyncConfig }
  | { ok: false; disabled: true; error?: SyncConfigError };

const KNOWN_STORAGE_TYPES: readonly string[] = ['s3'];

function envValue(env: ConfigEnv, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.toLowerCase();
  return normalized === 'true' || normalized === '1';
}

function isFalse(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.toLowerCase();
  return normalized === 'false' || normalized === '0';
}

type NumberParseResult = { value: number } | { error: SyncConfigError };

function parseNonNegativeInteger(
  raw: string | undefined,
  envVar: string,
  defaultValue: number,
): NumberParseResult {
  if (raw === undefined) return { value: defaultValue };
  if (!/^\d+$/.test(raw)) {
    return {
      error: {
        code: 'SYNC_CONFIG_MISSING',
        message: `${envVar} must be a non-negative integer.`,
      },
    };
  }
  const parsed = Number(raw);
  if (parsed < 0) {
    return {
      error: {
        code: 'SYNC_CONFIG_MISSING',
        message: `${envVar} must be a non-negative integer.`,
      },
    };
  }
  return { value: parsed };
}

type StorageParseResult = { config: StorageConfig } | { error: SyncConfigError };

function parseStorageConfig(env: ConfigEnv): StorageParseResult {
  const rawType = envValue(env, ENV_SAL_STORAGE_TYPE);
  if (rawType === undefined) {
    return {
      error: {
        code: 'SYNC_CONFIG_MISSING',
        message: `${ENV_SAL_STORAGE_TYPE} is required.`,
      },
    };
  }

  const normalizedType = rawType.toLowerCase();
  if (!KNOWN_STORAGE_TYPES.includes(normalizedType)) {
    return {
      error: {
        code: 'SYNC_CONFIG_MISSING',
        message: `${ENV_SAL_STORAGE_TYPE} must be one of: ${KNOWN_STORAGE_TYPES.join(', ')}.`,
      },
    };
  }

  const config: StorageConfig = {
    type: normalizedType as StorageType,
    endpoint: envValue(env, ENV_SAL_STORAGE_ENDPOINT),
    bucket: envValue(env, ENV_SAL_STORAGE_BUCKET),
    region: envValue(env, ENV_SAL_STORAGE_REGION),
    accessKeyId: envValue(env, ENV_SAL_STORAGE_ID),
    secretAccessKey: envValue(env, ENV_SAL_STORAGE_SECRET),
    sessionToken: envValue(env, ENV_SAL_STORAGE_SESSION_TOKEN),
  };

  return { config };
}

type TimeoutsParseResult = { timeouts: SyncTimeouts } | { error: SyncConfigError };

function parseTimeouts(env: ConfigEnv): TimeoutsParseResult {
  const syncTimeout = parseNonNegativeInteger(
    envValue(env, ENV_SAL_SYNC_TIMEOUT),
    ENV_SAL_SYNC_TIMEOUT,
    DEFAULT_SYNC_TIMEOUT_MS,
  );
  if ('error' in syncTimeout) return syncTimeout;

  const hookUploadTimeout = parseNonNegativeInteger(
    envValue(env, ENV_SAL_HOOK_UPLOAD_TIMEOUT),
    ENV_SAL_HOOK_UPLOAD_TIMEOUT,
    DEFAULT_HOOK_UPLOAD_TIMEOUT_MS,
  );
  if ('error' in hookUploadTimeout) return hookUploadTimeout;

  const sessionEndBudget = parseNonNegativeInteger(
    envValue(env, ENV_SAL_SESSION_END_BUDGET_MS),
    ENV_SAL_SESSION_END_BUDGET_MS,
    DEFAULT_SESSION_END_BUDGET_MS,
  );
  if ('error' in sessionEndBudget) return sessionEndBudget;

  return {
    timeouts: {
      syncTimeoutMs: syncTimeout.value,
      hookUploadTimeoutMs: hookUploadTimeout.value,
      sessionEndBudgetMs: sessionEndBudget.value,
    },
  };
}

type RetriesParseResult = { retries: number } | { error: SyncConfigError };

function parseRetries(env: ConfigEnv): RetriesParseResult {
  const retries = parseNonNegativeInteger(
    envValue(env, ENV_SAL_SYNC_RETRIES),
    ENV_SAL_SYNC_RETRIES,
    DEFAULT_SYNC_RETRIES,
  );
  if ('error' in retries) return retries;
  return { retries: retries.value };
}

type LimitsParseResult = { limits: SyncLimits } | { error: SyncConfigError };

function parseLimits(env: ConfigEnv): LimitsParseResult {
  const maxFileBytes = parseNonNegativeInteger(
    envValue(env, ENV_SAL_MAX_FILE_BYTES),
    ENV_SAL_MAX_FILE_BYTES,
    DEFAULT_MAX_FILE_BYTES,
  );
  if ('error' in maxFileBytes) return maxFileBytes;

  const maxTotalBytes = parseNonNegativeInteger(
    envValue(env, ENV_SAL_MAX_TOTAL_BYTES),
    ENV_SAL_MAX_TOTAL_BYTES,
    DEFAULT_MAX_TOTAL_BYTES,
  );
  if ('error' in maxTotalBytes) return maxTotalBytes;

  const maxFiles = parseNonNegativeInteger(
    envValue(env, ENV_SAL_MAX_FILES),
    ENV_SAL_MAX_FILES,
    DEFAULT_MAX_FILES,
  );
  if ('error' in maxFiles) return maxFiles;

  const maxTranscriptBytes = parseNonNegativeInteger(
    envValue(env, ENV_SAL_MAX_TRANSCRIPT_BYTES),
    ENV_SAL_MAX_TRANSCRIPT_BYTES,
    DEFAULT_MAX_TRANSCRIPT_BYTES,
  );
  if ('error' in maxTranscriptBytes) return maxTranscriptBytes;

  const maxJsonDepth = parseNonNegativeInteger(
    envValue(env, ENV_SAL_MAX_JSON_DEPTH),
    ENV_SAL_MAX_JSON_DEPTH,
    DEFAULT_MAX_JSON_DEPTH,
  );
  if ('error' in maxJsonDepth) return maxJsonDepth;

  const maxJsonlLineBytes = parseNonNegativeInteger(
    envValue(env, ENV_SAL_MAX_JSONL_LINE_BYTES),
    ENV_SAL_MAX_JSONL_LINE_BYTES,
    DEFAULT_MAX_JSONL_LINE_BYTES,
  );
  if ('error' in maxJsonlLineBytes) return maxJsonlLineBytes;

  return {
    limits: {
      maxFileBytes: maxFileBytes.value,
      maxTotalBytes: maxTotalBytes.value,
      maxFiles: maxFiles.value,
      maxTranscriptBytes: maxTranscriptBytes.value,
      maxJsonDepth: maxJsonDepth.value,
      maxJsonlLineBytes: maxJsonlLineBytes.value,
    },
  };
}

export function loadConfig(env: ConfigEnv = process.env): LoadConfigResult {
  if (isTruthy(envValue(env, ENV_SAL_SYNC_DISABLED))) {
    return { ok: false, disabled: true };
  }

  const projectId = envValue(env, ENV_SAL_PROJECT_ID);
  if (projectId === undefined) {
    return {
      ok: false,
      disabled: true,
      error: {
        code: 'SYNC_CONFIG_MISSING',
        message: `${ENV_SAL_PROJECT_ID} is required.`,
      },
    };
  }

  const storageResult = parseStorageConfig(env);
  if ('error' in storageResult) {
    return { ok: false, disabled: true, error: storageResult.error };
  }

  const timeoutsResult = parseTimeouts(env);
  if ('error' in timeoutsResult) {
    return { ok: false, disabled: true, error: timeoutsResult.error };
  }

  const retriesResult = parseRetries(env);
  if ('error' in retriesResult) {
    return { ok: false, disabled: true, error: retriesResult.error };
  }

  const limitsResult = parseLimits(env);
  if ('error' in limitsResult) {
    return { ok: false, disabled: true, error: limitsResult.error };
  }

  const config: SyncConfig = {
    projectId,
    disabled: false,
    captureTranscripts: !isFalse(envValue(env, ENV_SAL_CAPTURE_TRANSCRIPTS)),
    storage: storageResult.config,
    limits: limitsResult.limits,
    timeouts: timeoutsResult.timeouts,
    retries: retriesResult.retries,
  };

  return { ok: true, config };
}
