import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildObjectKey,
  type ListObjectEntry,
  type ManifestArtifact,
  parseObjectKey,
  type StorageAdapter,
  type SyncManifest,
} from '@lucasschirm/sal-sync-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseDownloadArgs,
  runDownloadCommand,
} from '../../../../src/cli/commands/download-command.js';
import type { CliHarnessAdapter } from '../../../../src/cli/harness-adapter.js';

const FIXTURE_ADAPTER: CliHarnessAdapter = {
  profile: {
    harness: 'fixture',
    harnessVersion: '0.0.0',
    configDir: () => '/fixture',
    captureAllowlist: { version: 1, session: [], workspace: [], global: [] },
    sessionLayout: {
      mainTranscriptStorageName: 'transcript.jsonl',
      mainTranscriptFilePattern: '{sessionId}.jsonl',
      subagentTranscriptsPattern: 'subagents/*.jsonl',
      subagentMetaPattern: 'subagents/*.meta.json',
    },
    securityBlocklist: [],
  },
  binName: 'fixture-sync',
  packageName: '@fixture/harness-sync',
  logFolderEnvVar: 'FIXTURE_LOG_PATH_FOLDER',
  resolveConfigPaths: () => ({ local: '/local', project: '/project', userGlobal: '/user' }),
  localConfigDisplayPath: '.fixture/settings.local.json',
  migrateManifestHarness: 'fixture',
  helpText: '',
};

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function textBody(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function makeArtifact(
  sessionId: string,
  scope: ManifestArtifact['scope'],
  relativePath: string,
  body: Uint8Array,
): ManifestArtifact {
  return {
    projectId: 'proj-1',
    sessionId,
    scope,
    relativePath,
    sha256: sha256Hex(body),
    size: body.length,
    status: 'uploaded',
  };
}

function makeManifest(sessionId: string, artifacts: ManifestArtifact[]): SyncManifest {
  return {
    schemaVersion: 2,
    projectId: 'proj-1',
    sessionId,
    harness: 'fixture',
    harnessVersion: '1.0',
    syncVersion: '1.0',
    pluginVersion: '1.0',
    transcriptsCaptured: true,
    artifacts,
    syncRuns: [],
  };
}

interface StoredEntry {
  key: string;
  body: Uint8Array;
}

function makeStoredEntry(input: {
  projectId: string;
  sessionId: string;
  scope: 'manifest' | ManifestArtifact['scope'];
  relativePath: string;
  body: Uint8Array;
  contentSha256?: string;
}): StoredEntry {
  return { key: buildObjectKey(input), body: input.body };
}

function makeStorageAdapter(entries: StoredEntry[]): StorageAdapter {
  const objects = new Map<string, Uint8Array>(entries.map((e) => [e.key, e.body]));
  const manifestEntries: ListObjectEntry[] = entries
    .filter((e) => parseObjectKey(e.key)?.scope === 'manifest')
    .map((e) => ({ key: e.key, size: e.body.length }));

  return {
    putObject: vi.fn(),
    listObjects: vi.fn().mockResolvedValue({ objects: manifestEntries }),
    getObject: vi.fn(async (input) => {
      const key = buildObjectKey(input);
      const body = objects.get(key);
      return body ? { body } : undefined;
    }),
  } as unknown as StorageAdapter;
}

function makeStdio() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: {
      write: (s: string) => {
        stdout.push(s);
        return true;
      },
    } as NodeJS.WritableStream,
    stderr: {
      write: (s: string) => {
        stderr.push(s);
        return true;
      },
    } as NodeJS.WritableStream,
    stdoutStr: () => stdout.join(''),
    stderrStr: () => stderr.join(''),
  };
}

const validEnv = {
  SAL_PROJECT_ID: 'proj-1',
  SAL_STORAGE_TYPE: 's3',
  SAL_STORAGE_BUCKET: 'my-bucket',
  SAL_STORAGE_REGION: 'us-east-1',
  SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  SAL_STORAGE_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

describe('parseDownloadArgs', () => {
  it('parses --session-id=value --output=value', () => {
    expect(parseDownloadArgs(['--session-id=sess-1', '--output=/tmp/out'])).toEqual({
      target: 'sess-1',
      output: '/tmp/out',
    });
  });

  it('returns undefined when required arguments are missing', () => {
    expect(parseDownloadArgs(['--session-id=sess-1'])).toBeUndefined();
  });
});

describe('runDownloadCommand', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sal-shared-download-test-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('prints adapter-specific usage and exits 1 for invalid args', async () => {
    const io = makeStdio();
    const result = await runDownloadCommand(FIXTURE_ADAPTER, [], { ...io });
    expect(result).toBe(1);
    expect(io.stderrStr()).toContain('Usage: fixture-sync download');
  });

  it('downloads a session from its manifest', async () => {
    const body = textBody('{"type":"session"}\n');
    const artifact = makeArtifact('sess-a', 'session', 'transcript.jsonl', body);
    const manifest = makeManifest('sess-a', [artifact]);
    const manifestBody = textBody(JSON.stringify(manifest));

    const entries = [
      makeStoredEntry({
        projectId: 'proj-1',
        sessionId: 'sess-a',
        scope: 'manifest',
        relativePath: 'manifest.json',
        body: manifestBody,
      }),
      makeStoredEntry({
        projectId: 'proj-1',
        sessionId: 'sess-a',
        scope: 'session',
        relativePath: 'transcript.jsonl',
        body,
      }),
    ];

    const adapter = makeStorageAdapter(entries);
    const io = makeStdio();
    const result = await runDownloadCommand(
      FIXTURE_ADAPTER,
      ['--session-id=sess-a', `--output=${tmpDir}`],
      { env: validEnv, storageAdapter: adapter, ...io },
    );

    expect(result).toBe(0);
    const downloaded = await fsp.readFile(
      path.join(tmpDir, 'proj-1', 'sess-a', 'transcript.jsonl'),
      'utf8',
    );
    expect(downloaded).toContain('session');
  });

  it('refuses to write outside the output directory for a manifest with a traversal relativePath', async () => {
    // A CAS-scoped (workspace/global) artifact's relativePath is never
    // validated by buildObjectKey (the remote key is derived purely from
    // contentSha256), so a malicious/corrupted manifest can smuggle `../`
    // segments through to the local file path — buildLocalPath must catch
    // it. This is the regression test that was missing from
    // devin-session-sync's pre-hoist suite (#354) — now proven once, here,
    // for every harness that builds on this shared implementation.
    const evilBody = textBody('evil payload\n');
    const evil = makeArtifact('sess-a', 'workspace', '../../../../evil.txt', evilBody);
    const manifest = makeManifest('sess-a', [evil]);
    const manifestBody = textBody(JSON.stringify(manifest));

    const entries = [
      makeStoredEntry({
        projectId: 'proj-1',
        sessionId: 'sess-a',
        scope: 'manifest',
        relativePath: 'manifest.json',
        body: manifestBody,
      }),
      makeStoredEntry({
        projectId: 'proj-1',
        sessionId: 'sess-a',
        scope: 'workspace',
        relativePath: '../../../../evil.txt',
        body: evilBody,
        contentSha256: evil.sha256,
      }),
    ];

    const adapter = makeStorageAdapter(entries);
    const io = makeStdio();
    const result = await runDownloadCommand(
      FIXTURE_ADAPTER,
      ['--session-id=sess-a', `--output=${tmpDir}`],
      { env: validEnv, storageAdapter: adapter, ...io },
    );

    expect(result).toBe(1);
    expect(io.stdoutStr()).toContain('escapes output directory');
    await expect(fsp.access(path.join(path.dirname(tmpDir), 'evil.txt'))).rejects.toThrow();
  });

  it('fails with exit 1 when the requested manifest is missing', async () => {
    const adapter = makeStorageAdapter([]);
    const io = makeStdio();
    const result = await runDownloadCommand(
      FIXTURE_ADAPTER,
      ['--session-id=sess-missing', `--output=${tmpDir}`],
      { env: validEnv, storageAdapter: adapter, ...io },
    );
    expect(result).toBe(1);
    expect(io.stderrStr()).toContain('manifest not found');
  });

  it('returns 0 when no sessions are found for "all"', async () => {
    const adapter = makeStorageAdapter([]);
    const io = makeStdio();
    const result = await runDownloadCommand(FIXTURE_ADAPTER, ['all', `--output=${tmpDir}`], {
      env: validEnv,
      storageAdapter: adapter,
      ...io,
    });
    expect(result).toBe(0);
    expect(io.stdoutStr()).toContain('No sessions found');
  });
});
