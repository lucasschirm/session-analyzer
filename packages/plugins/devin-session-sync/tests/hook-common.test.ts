import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildObjectKey,
  type PutObjectInput,
  type PutObjectResult,
  type StorageAdapter,
  sha256Hex,
} from '@lucasschirm/sal-sync';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDevinHookSync } from '../src/hook-common.js';
import { buildFixtureDb, type FixtureDbHandle } from './extractor/fixtures/build-fixture-db.js';

class RecordingStorageAdapter implements StorageAdapter {
  readonly calls: PutObjectInput[] = [];

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const key = buildObjectKey(input);
    const sha256 = input.contentSha256 ?? sha256Hex(Buffer.from(input.body).toString('utf8'));
    this.calls.push(input);
    return { key, sha256, etag: `"${sha256}"` };
  }
}

describe('runDevinHookSync', () => {
  let dataDir: string;
  let fixture: FixtureDbHandle;

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-hook-common-'));
    fixture = buildFixtureDb({
      sessions: [
        {
          id: 'sess-1',
          working_directory: '/tmp/ws',
          backend_type: null,
          model: null,
          agent_mode: null,
          created_at: null,
          last_activity_at: 100,
          title: null,
          main_chain_id: null,
          cogs_json: null,
          workspace_dirs: null,
          hidden: null,
          metadata: null,
        },
      ],
    });
  });

  afterEach(async () => {
    fixture.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('reports a config error on stderr and does not throw when configuration is missing', async () => {
    const stderrLines: string[] = [];
    const stderr = {
      write: (chunk: string) => {
        stderrLines.push(chunk);
        return true;
      },
    } as NodeJS.WritableStream;
    const result = await runDevinHookSync('hook', {
      sessionId: 'sess-1',
      cwd: '/tmp/ws',
      trigger: 'stop',
      env: {},
      stderr,
    });
    expect(result.ok).toBe(false);
    expect(stderrLines.join('')).toContain('required configuration is missing');
  });

  it('runs the sync pipeline and returns the outcome when configured', async () => {
    const storage = new RecordingStorageAdapter();
    const result = await runDevinHookSync('hook', {
      sessionId: 'sess-1',
      cwd: '/tmp/ws',
      trigger: 'stop',
      storageAdapter: storage,
      sessionsDbPath: fixture.path,
      env: {
        SAL_PROJECT_ID: 'proj-1',
        SAL_STORAGE_TYPE: 's3',
        SAL_STORAGE_BUCKET: 'test-bucket',
        SAL_STORAGE_REGION: 'us-east-1',
        SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
        SAL_STORAGE_SECRET_ACCESS_KEY: 'secret',
        SAL_DATA_DIR: dataDir,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome.failed).toBe(0);
    }
    expect(storage.calls.some((c) => c.scope === 'manifest')).toBe(true);
  });

  it('falls back to resolveCliEnv when no env is explicitly provided', async () => {
    const originalEnv = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('SAL_')) delete process.env[key];
    }
    try {
      const stderrLines: string[] = [];
      const stderr = {
        write: (chunk: string) => {
          stderrLines.push(chunk);
          return true;
        },
      } as NodeJS.WritableStream;
      const result = await runDevinHookSync('hook', {
        sessionId: 'sess-1',
        cwd: dataDir,
        trigger: 'stop',
        stderr,
      });
      expect(result.ok).toBe(false);
    } finally {
      process.env = originalEnv;
    }
  });

  it('reports a caught error on stderr and returns ok:false when sessions.db cannot be opened', async () => {
    const stderrLines: string[] = [];
    const stderr = {
      write: (chunk: string) => {
        stderrLines.push(chunk);
        return true;
      },
    } as NodeJS.WritableStream;
    const result = await runDevinHookSync('hook', {
      sessionId: 'sess-1',
      cwd: '/tmp/ws',
      trigger: 'stop',
      sessionsDbPath: path.join(dataDir, 'no-such-sessions.db'),
      env: {
        SAL_PROJECT_ID: 'proj-1',
        SAL_STORAGE_TYPE: 's3',
        SAL_STORAGE_BUCKET: 'test-bucket',
        SAL_STORAGE_REGION: 'us-east-1',
        SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
        SAL_STORAGE_SECRET_ACCESS_KEY: 'secret',
        SAL_DATA_DIR: dataDir,
      },
      stderr,
    });
    expect(result.ok).toBe(false);
    expect(stderrLines.join('')).toContain('hook error');
  });

  it('builds a real storage adapter when none is provided', async () => {
    const result = await runDevinHookSync('hook', {
      sessionId: 'sess-1',
      cwd: '/tmp/ws',
      trigger: 'stop',
      sessionsDbPath: fixture.path,
      env: {
        SAL_PROJECT_ID: 'proj-1',
        SAL_STORAGE_TYPE: 's3',
        SAL_STORAGE_BUCKET: 'test-bucket',
        SAL_STORAGE_REGION: 'us-east-1',
        SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
        SAL_STORAGE_SECRET_ACCESS_KEY: 'secret',
        SAL_STORAGE_ENDPOINT: 'http://127.0.0.1:1',
        SAL_SYNC_TIMEOUT: '500',
        SAL_HOOK_UPLOAD_TIMEOUT: '500',
        SAL_DATA_DIR: dataDir,
      },
    });
    // No storageAdapter override: exercises the real buildStorageAdapter(config)
    // fallback. Upload failures are caught internally by processDelta and
    // recorded as outcome.failed, not re-thrown, so this still resolves ok:true.
    expect(result.ok).toBe(true);
  }, 15000);
});
