import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SYNC_LIMITS,
  DEFAULT_SYNC_RETRIES,
  DEFAULT_SYNC_TIMEOUTS,
  loadConfig,
  loadStorageConfig,
} from '../../src/index.js';

describe('loadConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const baseEnv: Record<string, string | undefined> = {
    SAL_PROJECT_ID: 'proj-1',
    SAL_STORAGE_TYPE: 's3',
    SAL_STORAGE_BUCKET: 'my-bucket',
    SAL_STORAGE_REGION: 'us-east-1',
    SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    SAL_STORAGE_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };

  it('returns SYNC_CONFIG_MISSING when SAL_PROJECT_ID is missing', () => {
    const result = loadConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.disabled).toBe(true);
    expect(result.error?.code).toBe('SYNC_CONFIG_MISSING');
  });

  it('rejects the reserved project id "global" with a clear reserved-id error', () => {
    const result = loadConfig({ ...baseEnv, SAL_PROJECT_ID: 'global' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.disabled).toBe(true);
    expect(result.error?.code).toBe('SYNC_CONFIG_MISSING');
    expect(result.error?.message).toContain('global');
    expect(result.error?.message).toContain('reserved');
  });

  it('rejects an invalid SAL_PROJECT_ID format', () => {
    const result = loadConfig({ ...baseEnv, SAL_PROJECT_ID: 'my_project' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error?.code).toBe('SYNC_CONFIG_MISSING');
  });

  it('disables synchronization when SAL_SYNC_DISABLED=true', () => {
    const result = loadConfig({ ...baseEnv, SAL_SYNC_DISABLED: 'true' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.disabled).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('honors SAL_CAPTURE_TRANSCRIPTS=false', () => {
    const result = loadConfig({ ...baseEnv, SAL_CAPTURE_TRANSCRIPTS: 'false' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.config.captureTranscripts).toBe(false);
  });

  it('uses default values when optional env vars are unset', () => {
    const result = loadConfig({ ...baseEnv });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.config.projectId).toBe('proj-1');
    expect(result.config.disabled).toBe(false);
    expect(result.config.captureTranscripts).toBe(true);
    expect(result.config.storage).toEqual({
      type: 's3',
      endpoint: undefined,
      bucket: 'my-bucket',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      sessionToken: undefined,
    });
    expect(result.config.timeouts).toEqual(DEFAULT_SYNC_TIMEOUTS);
    expect(result.config.retries).toBe(DEFAULT_SYNC_RETRIES);
    expect(result.config.limits).toEqual(DEFAULT_SYNC_LIMITS);
  });

  it('rejects missing SAL_STORAGE_TYPE', () => {
    const result = loadConfig({ ...baseEnv, SAL_STORAGE_TYPE: undefined });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error?.code).toBe('SYNC_CONFIG_MISSING');
  });

  it('rejects unknown SAL_STORAGE_TYPE', () => {
    const result = loadConfig({ ...baseEnv, SAL_STORAGE_TYPE: 'ftp' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error?.code).toBe('SYNC_CONFIG_MISSING');
  });

  it('rejects invalid sync timeout', () => {
    const result = loadConfig({ ...baseEnv, SAL_SYNC_TIMEOUT: 'abc' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error?.code).toBe('SYNC_CONFIG_MISSING');
  });

  it('rejects negative session end budget', () => {
    const result = loadConfig({ ...baseEnv, SAL_SESSION_END_BUDGET_MS: '-1' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error?.code).toBe('SYNC_CONFIG_MISSING');
  });

  it('rejects invalid hook upload timeout', () => {
    const result = loadConfig({ ...baseEnv, SAL_HOOK_UPLOAD_TIMEOUT: '12.5' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error?.code).toBe('SYNC_CONFIG_MISSING');
  });

  it('rejects invalid retry count', () => {
    const result = loadConfig({ ...baseEnv, SAL_SYNC_RETRIES: '-3' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error?.code).toBe('SYNC_CONFIG_MISSING');
  });

  it('rejects invalid file limits', () => {
    const result = loadConfig({ ...baseEnv, SAL_MAX_FILE_BYTES: 'not-a-number' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error?.code).toBe('SYNC_CONFIG_MISSING');
  });

  it('ignores SAL_STORAGE_URL and does not conflate storage concepts', () => {
    const result = loadConfig({
      ...baseEnv,
      SAL_STORAGE_URL: 'https://bucket.s3.amazonaws.com/prefix',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.config.storage).not.toHaveProperty('url');
    expect(result.config.storage.endpoint).toBeUndefined();
    expect(result.config.storage.bucket).toBe('my-bucket');
  });

  it('parses all storage fields including the session token', () => {
    const result = loadConfig({
      ...baseEnv,
      SAL_STORAGE_ENDPOINT: 'https://s3.example.com',
      SAL_STORAGE_SESSION_TOKEN: 'session-token',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.config.storage.endpoint).toBe('https://s3.example.com');
    expect(result.config.storage.sessionToken).toBe('session-token');
  });

  it('applies custom timeouts, retries, and limits', () => {
    const result = loadConfig({
      ...baseEnv,
      SAL_SYNC_TIMEOUT: '60000',
      SAL_SYNC_RETRIES: '0',
      SAL_SESSION_END_BUDGET_MS: '300000',
      SAL_HOOK_UPLOAD_TIMEOUT: '5000',
      SAL_MAX_FILE_BYTES: '5242880',
      SAL_MAX_TOTAL_BYTES: '52428800',
      SAL_MAX_FILES: '500',
      SAL_MAX_TRANSCRIPT_BYTES: '10485760',
      SAL_MAX_JSON_DEPTH: '64',
      SAL_MAX_JSONL_LINE_BYTES: '65536',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.config.timeouts).toEqual({
      syncTimeoutMs: 60000,
      hookUploadTimeoutMs: 5000,
      sessionEndBudgetMs: 300000,
    });
    expect(result.config.retries).toBe(0);
    expect(result.config.limits).toEqual({
      maxFileBytes: 5242880,
      maxTotalBytes: 52428800,
      maxFiles: 500,
      maxTranscriptBytes: 10485760,
      maxJsonDepth: 64,
      maxJsonlLineBytes: 65536,
    });
  });

  it('does not derive projectId from filesystem or git', () => {
    const result = loadConfig({
      ...baseEnv,
      SAL_PROJECT_ID: 'my-explicit-project',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.config.projectId).toBe('my-explicit-project');
  });

  it('reads process.env when no argument is provided', () => {
    vi.stubEnv('SAL_PROJECT_ID', 'process-proj');
    vi.stubEnv('SAL_STORAGE_TYPE', 's3');

    const result = loadConfig();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.config.projectId).toBe('process-proj');

    vi.unstubAllEnvs();
  });
});

describe('loadStorageConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const storageEnv: Record<string, string | undefined> = {
    SAL_STORAGE_TYPE: 's3',
    SAL_STORAGE_BUCKET: 'my-bucket',
    SAL_STORAGE_REGION: 'us-east-1',
    SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    SAL_STORAGE_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };

  it('succeeds without SAL_PROJECT_ID', () => {
    const result = loadStorageConfig(storageEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.config.storage.type).toBe('s3');
    expect(result.config.storage.bucket).toBe('my-bucket');
    expect(result.config.retries).toBe(DEFAULT_SYNC_RETRIES);
  });

  it('rejects missing SAL_STORAGE_TYPE', () => {
    const result = loadStorageConfig({ ...storageEnv, SAL_STORAGE_TYPE: undefined });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('SYNC_CONFIG_MISSING');
  });

  it('rejects unknown SAL_STORAGE_TYPE', () => {
    const result = loadStorageConfig({ ...storageEnv, SAL_STORAGE_TYPE: 'ftp' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('SYNC_CONFIG_MISSING');
  });

  it('rejects invalid retry count', () => {
    const result = loadStorageConfig({ ...storageEnv, SAL_SYNC_RETRIES: '-3' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('SYNC_CONFIG_MISSING');
  });

  it('ignores SAL_SYNC_DISABLED', () => {
    const result = loadStorageConfig({ ...storageEnv, SAL_SYNC_DISABLED: 'true' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.config.storage.type).toBe('s3');
  });
});
