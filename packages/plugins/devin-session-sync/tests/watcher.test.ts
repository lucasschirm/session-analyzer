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

import { createDevinHarnessProfile } from '../src/devin-profile.js';
import type { DevinExtractedTables } from '../src/extractor/types.js';
import { captureDevinModels } from '../src/models/capture.js';
import { computeSessionWatermarkSignature, runDevinWatcher } from '../src/watcher.js';
import { buildFixtureDb, type FixtureDbHandle } from './extractor/fixtures/build-fixture-db.js';
import { devinModelsListFixture } from './models/fixture.js';

class RecordingStorageAdapter implements StorageAdapter {
  readonly calls: PutObjectInput[] = [];

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const key = buildObjectKey(input);
    const sha256 = input.contentSha256 ?? sha256Hex(Buffer.from(input.body).toString('utf8'));
    this.calls.push(input);
    return { key, sha256, etag: `"${sha256}"` };
  }
}

const EMPTY_TABLES: DevinExtractedTables = {
  sessions: [],
  messageNodes: [],
  promptHistory: [],
  toolCallStates: [],
};

describe('computeSessionWatermarkSignature', () => {
  it('changes when a session gains a new message row', () => {
    const before: DevinExtractedTables = { ...EMPTY_TABLES, sessions: [session('sess-1', 100)] };
    const after: DevinExtractedTables = {
      ...before,
      messageNodes: [
        {
          row_id: 1,
          session_id: 'sess-1',
          node_id: 1,
          parent_node_id: null,
          chat_message: 'hi',
          created_at: 100,
          metadata: null,
        },
      ],
    };
    expect(computeSessionWatermarkSignature(before, 'sess-1')).not.toBe(
      computeSessionWatermarkSignature(after, 'sess-1'),
    );
  });

  it('is stable across two reads of unchanged data', () => {
    const tables: DevinExtractedTables = { ...EMPTY_TABLES, sessions: [session('sess-1', 100)] };
    expect(computeSessionWatermarkSignature(tables, 'sess-1')).toBe(
      computeSessionWatermarkSignature(tables, 'sess-1'),
    );
  });

  function session(id: string, lastActivityAt: number) {
    return {
      id,
      working_directory: '/tmp',
      backend_type: null,
      model: null,
      agent_mode: null,
      created_at: null,
      last_activity_at: lastActivityAt,
      title: null,
      main_chain_id: null,
      cogs_json: null,
      workspace_dirs: null,
      hidden: null,
      metadata: null,
    };
  }
});

describe('runDevinWatcher', () => {
  let fixture: FixtureDbHandle;
  let dataDir: string;
  let homeDir: string;

  const harnessProfile = createDevinHarnessProfile('v1');

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-watcher-data-'));
    homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-watcher-home-'));
    await captureDevinModels({
      dataDir,
      devinCliVersion: harnessProfile.harnessVersion,
      runModelsList: async () => devinModelsListFixture,
    });
    fixture = buildFixtureDb({
      sessions: [
        {
          id: 'sess-cloud',
          working_directory: '/tmp/cloud-project',
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
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  function watcherEnv(): Record<string, string> {
    return {
      SAL_PROJECT_ID: 'proj-watcher',
      SAL_STORAGE_TYPE: 's3',
      SAL_STORAGE_BUCKET: 'test-bucket',
      SAL_STORAGE_REGION: 'us-east-1',
      SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      SAL_STORAGE_SECRET_ACCESS_KEY: 'secret',
    };
  }

  it('syncs a changed session on the first poll and reports terminal progress lines', async () => {
    const storage = new RecordingStorageAdapter();
    const stdoutLines: string[] = [];
    const stdout = {
      write: (chunk: string) => {
        stdoutLines.push(chunk);
        return true;
      },
    } as NodeJS.WritableStream;

    const exitCode = await runDevinWatcher({
      env: watcherEnv(),
      dataDir,
      homeDir,
      sessionsDbPath: fixture.path,
      storageAdapter: storage,
      profile: harnessProfile,
      maxPolls: 1,
      pollIntervalMs: 1,
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stdoutLines.some((l) => l.includes('starting'))).toBe(true);
    expect(stdoutLines.some((l) => l.includes('poll #1: 1 session(s) checked, 1 changed'))).toBe(
      true,
    );
    expect(stdoutLines.some((l) => l.includes('stopped'))).toBe(true);
    expect(storage.calls.some((c) => c.scope === 'manifest')).toBe(true);
    expect(storage.calls.some((c) => c.relativePath === 'native/models.json')).toBe(true);
    expect(storage.calls.some((c) => c.relativePath === 'native/models-list.raw.json')).toBe(true);
  });

  it('does not re-sync an unchanged session on a second poll', async () => {
    const storage = new RecordingStorageAdapter();
    const stdout = { write: () => true } as NodeJS.WritableStream;

    await runDevinWatcher({
      env: watcherEnv(),
      dataDir,
      homeDir,
      sessionsDbPath: fixture.path,
      storageAdapter: storage,
      profile: harnessProfile,
      maxPolls: 2,
      pollIntervalMs: 1,
      stdout,
    });

    // Only the first poll should have uploaded anything for sess-cloud —
    // the second poll's signature is unchanged (same fixture db content).
    const manifestUploads = storage.calls.filter((c) => c.scope === 'manifest');
    expect(manifestUploads).toHaveLength(1);
  });

  it('reports a configuration error and exits 1 without looping', async () => {
    const stderrLines: string[] = [];
    const stderr = {
      write: (chunk: string) => {
        stderrLines.push(chunk);
        return true;
      },
    } as NodeJS.WritableStream;

    const exitCode = await runDevinWatcher({
      env: {},
      dataDir,
      maxPolls: 1,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderrLines.join('')).toContain('devin-watcher');
  });
});
