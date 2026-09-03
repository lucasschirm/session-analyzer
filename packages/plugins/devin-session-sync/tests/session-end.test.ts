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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevinHarnessProfile } from '../src/devin-profile.js';
import { runSessionEnd } from '../src/session-end.js';
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

// `SessionEnd` fires only for local CLI sessions (Part A3); this test suite
// covers `runSessionEnd`'s own `reportOutcome` helper, in particular its
// handling of `DevinSessionSyncOutcome.warnings` (#266) — not exercised by
// `runDevinSessionSync`/`runSyncCommand` unit tests, since `reportOutcome`
// writes directly to `process.stderr`.
describe('runSessionEnd', () => {
  let dataDir: string;
  let homeDir: string;
  let fixture: FixtureDbHandle;

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-session-end-'));
    homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-session-end-home-'));
    fixture = buildFixtureDb({
      sessions: [
        {
          id: 'sess-1',
          working_directory: '/tmp/ws',
          backend_type: null,
          model: null,
          agent_mode: null,
          created_at: null,
          last_activity_at: null,
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
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  function envFor(): Record<string, string> {
    return {
      SAL_PROJECT_ID: 'proj-session-end',
      SAL_STORAGE_TYPE: 's3',
      SAL_STORAGE_BUCKET: 'test-bucket',
      SAL_STORAGE_REGION: 'us-east-1',
      SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      SAL_STORAGE_SECRET_ACCESS_KEY: 'secret',
      SAL_DATA_DIR: dataDir,
    };
  }

  it('reports a models-capture warning on stderr without reporting errors when the session otherwise succeeds (#266)', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const exitCode = await runSessionEnd(
        {
          session_id: 'sess-1',
          cwd: '/tmp/ws',
          hook_event_name: 'SessionEnd',
          reason: 'completed',
        },
        {
          env: envFor(),
          storageAdapter: new RecordingStorageAdapter(),
          sessionsDbPath: fixture.path,
          homeDir,
          harnessProfile: DevinHarnessProfile,
          models: {
            runModelsList: async () => {
              throw new Error('devin cli unavailable');
            },
          },
        },
      );

      expect(exitCode).toBe(0);
      const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('devin-session-sync: warnings: devin cli unavailable.');
      expect(output).not.toContain('devin-session-sync: errors:');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('reports errors on stderr, distinct from warnings, when a real artifact upload fails', async () => {
    const failingStorage: StorageAdapter = {
      putObject: async (input) => {
        if (input.scope === 'manifest') {
          throw new Error('manifest upload failed');
        }
        return { key: 'x', sha256: sha256Hex(Buffer.from(input.body).toString('utf8')) };
      },
    };
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const exitCode = await runSessionEnd(
        {
          session_id: 'sess-1',
          cwd: '/tmp/ws',
          hook_event_name: 'SessionEnd',
          reason: 'completed',
        },
        {
          env: envFor(),
          storageAdapter: failingStorage,
          sessionsDbPath: fixture.path,
          homeDir,
          harnessProfile: DevinHarnessProfile,
          models: {
            runModelsList: async () => '{"families":[]}',
          },
        },
      );

      // Hooks are best-effort/fail-open (Part A3): the sync outcome is
      // reported, but the hook process itself always exits 0.
      expect(exitCode).toBe(0);
      const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('devin-session-sync: errors:');
      expect(output).not.toContain('devin-session-sync: warnings:');
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
