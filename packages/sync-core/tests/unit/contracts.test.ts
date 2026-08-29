import { describe, expect, it } from 'vitest';

import {
  CAPTURE_ALLOWLIST,
  CAPTURE_ALLOWLIST_VERSION,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_JSON_DEPTH,
  DEFAULT_MAX_JSONL_LINE_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_MAX_TRANSCRIPT_BYTES,
  DEFAULT_PLUGIN_VERSION,
  DEFAULT_PRIVACY_POLICY,
  DEFAULT_SYNC_LIMITS,
  DEFAULT_SYNC_TIMEOUTS,
  ENV_SAL_STORAGE_URL,
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION_LATEST,
  type SessionData,
  STORAGE_CONFIG_FIELDS,
  type StorageConfig,
  SUPPORTED_MANIFEST_SCHEMA_VERSIONS,
  SYNC_ERROR_CATALOG,
  SYNC_SCHEMA_VERSION,
  SYNC_VERSION,
  type SyncConfig,
  type SyncErrorCode,
  type SyncManifest,
  type SyncRun,
  TELEMETRY_INCLUDES_RAW_EXCEPTIONS,
  UNKNOWN_HARNESS_VERSION,
} from '../../src/index.js';

function typeCheck<T>(_value: T) {
  return true;
}

describe('versions', () => {
  it('exposes schema and package version constants', () => {
    expect(SYNC_SCHEMA_VERSION).toBe(1);
    expect(MANIFEST_SCHEMA_VERSION).toBe(2);
    expect(MANIFEST_SCHEMA_VERSION_LATEST).toBe(3);
    expect(SUPPORTED_MANIFEST_SCHEMA_VERSIONS).toEqual([2, 3]);
    expect(CAPTURE_ALLOWLIST_VERSION).toBe(2);
    expect(SYNC_VERSION).toBe('0.1.0');
    expect(UNKNOWN_HARNESS_VERSION).toBe('unknown');
    expect(DEFAULT_PLUGIN_VERSION).toBe('unknown');
  });
});

describe('session data model', () => {
  it('can be constructed with the required fields', () => {
    const session: SessionData = {
      sessionId: 'sess-1',
      projectId: 'proj-1',
      harness: 'claude',
      harnessVersion: UNKNOWN_HARNESS_VERSION,
      model: 'claude-3-5-sonnet',
      startedAt: '2026-08-17T00:00:00Z',
      endedAt: '2026-08-17T01:00:00Z',
      durationMs: 3_600_000,
      endReason: 'completed',
    };
    expect(session.sessionId).toBe('sess-1');
    expect(typeCheck<SessionData>(session)).toBe(true);
  });
});

describe('manifest schema', () => {
  it('can be constructed with the required fields', () => {
    const manifest: SyncManifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      projectId: 'proj-1',
      sessionId: 'sess-1',
      harness: 'claude',
      harnessVersion: UNKNOWN_HARNESS_VERSION,
      syncVersion: SYNC_VERSION,
      pluginVersion: DEFAULT_PLUGIN_VERSION,
      transcriptsCaptured: true,
      artifacts: [
        {
          projectId: 'proj-1',
          sessionId: 'sess-1',
          scope: 'workspace',
          relativePath: '.claude/settings.json',
          sha256: 'sha256',
          size: 1234,
          status: 'uploaded',
        },
      ],
      syncRuns: [],
    };
    expect(manifest.artifacts[0].sha256).toBe('sha256');
    expect(typeCheck<SyncManifest>(manifest)).toBe(true);
  });
});

describe('per-trigger sync run model', () => {
  it('can be constructed with result and telemetry fields', () => {
    const run: SyncRun = {
      trigger: 'session-end',
      filesDiscovered: 10,
      filesChanged: 2,
      filesUploaded: 2,
      filesFailed: 0,
      filesSkipped: 8,
      bytesDiscovered: 1000,
      bytesChanged: 200,
      bytesUploaded: 200,
      discoveryDurationMs: 10,
      sanitizationDurationMs: 20,
      hashDurationMs: 30,
      uploadDurationMs: 40,
      totalDurationMs: 100,
    };
    expect(run.trigger).toBe('session-end');
    expect(typeCheck<SyncRun>(run)).toBe(true);
  });
});

describe('environment configuration', () => {
  it('StorageConfig does not conflate endpoint, bucket, and URL', () => {
    const config: StorageConfig = {
      type: 's3',
      endpoint: 'https://s3.example.com',
      bucket: 'my-bucket',
      region: 'us-east-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    };
    expect(STORAGE_CONFIG_FIELDS).not.toContain('url');
    expect(typeCheck<StorageConfig>(config)).toBe(true);
  });

  it('SyncConfig can be constructed with all documented env concepts', () => {
    const config: SyncConfig = {
      projectId: 'proj-1',
      disabled: false,
      captureTranscripts: true,
      storage: {
        type: 's3',
        endpoint: 'https://s3.example.com',
        bucket: 'my-bucket',
      },
      limits: DEFAULT_SYNC_LIMITS,
      timeouts: DEFAULT_SYNC_TIMEOUTS,
      retries: 3,
    };
    expect(config.captureTranscripts).toBe(true);
    expect(typeCheck<SyncConfig>(config)).toBe(true);
  });

  it('documents the unsupported storage URL env var', () => {
    expect(ENV_SAL_STORAGE_URL).toBe('SAL_STORAGE_URL');
  });
});

describe('capture allowlist', () => {
  it('is versioned and matches the documented paths', () => {
    expect(CAPTURE_ALLOWLIST.version).toBe(CAPTURE_ALLOWLIST_VERSION);

    const sessionPatterns = CAPTURE_ALLOWLIST.session.map((entry) => entry.pattern);
    expect(sessionPatterns).toEqual([]);

    const workspacePatterns = CAPTURE_ALLOWLIST.workspace.map((entry) => entry.pattern);
    expect(workspacePatterns).toEqual([
      'CLAUDE.md',
      '.mcp.json',
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.claude/agents/**',
      '.claude/skills/**',
      '.claude/rules/**',
    ]);

    const globalPatterns = CAPTURE_ALLOWLIST.global.map((entry) => entry.pattern);
    expect(globalPatterns).toEqual([
      '~/.claude/settings.json',
      '~/.claude/CLAUDE.md',
      '~/.claude/agents/**',
      '~/.claude.json',
    ]);
  });
});

describe('privacy and retention policy', () => {
  it('documents raw-by-default transcripts and opt-out paths', () => {
    expect(DEFAULT_PRIVACY_POLICY.transcriptDefault).toBe('raw');
    expect(DEFAULT_PRIVACY_POLICY.transcriptOptOut).toBe('SAL_CAPTURE_TRANSCRIPTS=false');
    expect(DEFAULT_PRIVACY_POLICY.fullDisable).toBe('SAL_SYNC_DISABLED=true');
    expect(DEFAULT_PRIVACY_POLICY.mcpConfigCaptured).toBe(true);
    expect(DEFAULT_PRIVACY_POLICY.globalConfigCaptured).toBe(true);
  });
});

describe('stable error codes', () => {
  const expectedCodes: SyncErrorCode[] = [
    'SYNC_CONFIG_MISSING',
    'SYNC_AUTH_FAILED',
    'SYNC_NETWORK_TIMEOUT',
    'SYNC_STORAGE_ERROR',
    'SYNC_DISCOVERY_ERROR',
    'SYNC_SANITIZATION_ERROR',
    'SYNC_STATE_ERROR',
    'SYNC_FILE_TOO_LARGE',
    'SYNC_TOTAL_SIZE_EXCEEDED',
    'SYNC_FILE_COUNT_EXCEEDED',
    'SYNC_JSON_PARSE_FAILED',
    'SYNC_STATE_CORRUPT',
    'SYNC_WATCHER_ERROR',
    'SYNC_WATCHER_DEAD',
    'SYNC_INTERNAL_ERROR',
    'MANIFEST_UNSUPPORTED_SCHEMA',
  ];

  it('contains all documented error codes', () => {
    expect(Object.keys(SYNC_ERROR_CATALOG).sort()).toEqual(expectedCodes.sort());
  });

  it('classifies retryable and non-retryable codes', () => {
    expect(SYNC_ERROR_CATALOG.SYNC_NETWORK_TIMEOUT.category).toBe('retryable');
    expect(SYNC_ERROR_CATALOG.SYNC_STATE_ERROR.category).toBe('retryable');
    expect(SYNC_ERROR_CATALOG.SYNC_WATCHER_ERROR.category).toBe('retryable');
    expect(SYNC_ERROR_CATALOG.SYNC_CONFIG_MISSING.category).toBe('non-retryable');
    expect(SYNC_ERROR_CATALOG.SYNC_AUTH_FAILED.category).toBe('non-retryable');
    expect(SYNC_ERROR_CATALOG.SYNC_FILE_TOO_LARGE.category).toBe('non-retryable');
    expect(SYNC_ERROR_CATALOG.MANIFEST_UNSUPPORTED_SCHEMA.category).toBe('non-retryable');
  });

  it('never stores raw exception strings in telemetry', () => {
    expect(TELEMETRY_INCLUDES_RAW_EXCEPTIONS).toBe(false);
  });
});

describe('file limits', () => {
  it('has sane default values', () => {
    expect(DEFAULT_SYNC_LIMITS.maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(DEFAULT_SYNC_LIMITS.maxTotalBytes).toBe(DEFAULT_MAX_TOTAL_BYTES);
    expect(DEFAULT_SYNC_LIMITS.maxFiles).toBe(DEFAULT_MAX_FILES);
    expect(DEFAULT_SYNC_LIMITS.maxTranscriptBytes).toBe(DEFAULT_MAX_TRANSCRIPT_BYTES);
    expect(DEFAULT_SYNC_LIMITS.maxJsonDepth).toBe(DEFAULT_MAX_JSON_DEPTH);
    expect(DEFAULT_SYNC_LIMITS.maxJsonlLineBytes).toBe(DEFAULT_MAX_JSONL_LINE_BYTES);

    expect(DEFAULT_MAX_FILE_BYTES).toBeGreaterThan(0);
    expect(DEFAULT_MAX_TOTAL_BYTES).toBeGreaterThan(DEFAULT_MAX_FILE_BYTES);
    expect(DEFAULT_MAX_FILES).toBeGreaterThan(0);
    expect(DEFAULT_MAX_TRANSCRIPT_BYTES).toBeGreaterThan(0);
    expect(DEFAULT_MAX_JSON_DEPTH).toBeGreaterThan(0);
    expect(DEFAULT_MAX_JSONL_LINE_BYTES).toBeGreaterThan(0);
  });
});
