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
} from '@lucasschirm/sal-sync';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseDownloadArgs, runDownloadCommand } from '../../src/index.js';

function makeTmpDir(): string {
  return path.join(
    os.tmpdir(),
    `sal-download-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

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
  const sha256 = sha256Hex(body);
  return {
    projectId: 'proj-1',
    sessionId,
    scope,
    relativePath,
    sha256,
    size: body.length,
    status: 'uploaded',
  };
}

function makeManifest(sessionId: string, artifacts: ManifestArtifact[]): SyncManifest {
  return {
    schemaVersion: 2,
    projectId: 'proj-1',
    sessionId,
    harness: 'claude',
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
    const result = parseDownloadArgs(['--session-id=abc-123', '--output=/tmp/out']);
    expect(result).toEqual({ target: 'abc-123', output: '/tmp/out' });
  });

  it('parses --session-id <id> (space-separated)', () => {
    const result = parseDownloadArgs(['--session-id', 'abc-123', '--output', '/tmp/out']);
    expect(result).toEqual({ target: 'abc-123', output: '/tmp/out' });
  });

  it('parses "all" as target', () => {
    const result = parseDownloadArgs(['all', '--output=/tmp/out']);
    expect(result).toEqual({ target: 'all', output: '/tmp/out' });
  });

  it('returns undefined when required arguments are missing', () => {
    expect(parseDownloadArgs(['--session-id=abc-123'])).toBeUndefined();
    expect(parseDownloadArgs(['--output=/tmp/out'])).toBeUndefined();
    expect(parseDownloadArgs([])).toBeUndefined();
  });
});

describe('runDownloadCommand', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    await fsp.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('fails when args are missing', async () => {
    const io = makeStdio();
    const result = await runDownloadCommand([], {
      env: validEnv,
      storageAdapter: makeStorageAdapter([]),
      ...io,
    });
    expect(result).toBe(1);
    expect(io.stderrStr()).toContain('Usage:');
  });

  it('fails when storage config is missing', async () => {
    const io = makeStdio();
    const result = await runDownloadCommand(['--session-id=abc', '--output=/tmp/out'], {
      env: {},
      storageAdapter: makeStorageAdapter([]),
      ...io,
    });
    expect(result).toBe(1);
    expect(io.stderrStr()).toContain('SAL_STORAGE_TYPE');
  });

  it('fails when adapter lacks getObject', async () => {
    const io = makeStdio();
    const adapter = { putObject: vi.fn(), listObjects: vi.fn() } as unknown as StorageAdapter;
    const result = await runDownloadCommand(['--session-id=abc', '--output=/tmp/out'], {
      env: validEnv,
      storageAdapter: adapter,
      ...io,
    });
    expect(result).toBe(1);
    expect(io.stderrStr()).toContain('does not support');
  });

  it('fails when adapter lacks listObjects for "all"', async () => {
    const io = makeStdio();
    const adapter = { putObject: vi.fn(), getObject: vi.fn() } as unknown as StorageAdapter;
    const result = await runDownloadCommand(['all', '--output=/tmp/out'], {
      env: validEnv,
      storageAdapter: adapter,
      ...io,
    });
    expect(result).toBe(1);
    expect(io.stderrStr()).toContain('does not support');
  });

  it('downloads a session from its manifest', async () => {
    const sessionBody = textBody('session line\n');
    const workspaceBody = textBody('workspace guide\n');
    const transcript = makeArtifact('sess-a', 'session', 'transcript.jsonl', sessionBody);
    const workspace = makeArtifact('sess-a', 'workspace', 'agents/agent.md', workspaceBody);
    const manifest = makeManifest('sess-a', [transcript, workspace]);
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
        body: sessionBody,
      }),
      makeStoredEntry({
        projectId: 'proj-1',
        sessionId: 'sess-a',
        scope: 'workspace',
        relativePath: 'agents/agent.md',
        body: workspaceBody,
        contentSha256: workspace.sha256,
      }),
    ];

    const adapter = makeStorageAdapter(entries);
    const io = makeStdio();
    const result = await runDownloadCommand(['--session-id=sess-a', `--output=${tmpDir}`], {
      env: validEnv,
      storageAdapter: adapter,
      ...io,
    });

    expect(result).toBe(0);
    expect(io.stdoutStr()).toContain('[download]');
    expect(io.stdoutStr()).toContain('Downloaded 3 file(s)');

    const manifestPath = path.join(tmpDir, 'proj-1', 'sess-a', 'manifest.json');
    const sessionPath = path.join(tmpDir, 'proj-1', 'sess-a', 'transcript.jsonl');
    const workspacePath = path.join(tmpDir, 'proj-1', 'sess-a', 'workspace', 'agents', 'agent.md');

    await expect(fsp.access(manifestPath)).resolves.toBeUndefined();
    await expect(fsp.access(sessionPath)).resolves.toBeUndefined();
    await expect(fsp.access(workspacePath)).resolves.toBeUndefined();

    const storedManifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as SyncManifest;
    expect(storedManifest.sessionId).toBe('sess-a');
    expect(storedManifest.artifacts).toHaveLength(2);

    const sessionGet = adapter.getObject.mock.calls.find((c) => c[0].scope === 'session');
    expect(sessionGet?.[0]).not.toHaveProperty('contentSha256');

    const workspaceGet = adapter.getObject.mock.calls.find((c) => c[0].scope === 'workspace');
    expect(workspaceGet?.[0].contentSha256).toBe(workspace.sha256);
  });

  it('refuses to write outside the output directory for a manifest with a traversal relativePath', async () => {
    // A CAS-scoped (workspace/global) artifact's relativePath is never
    // validated by buildObjectKey (the remote key is derived purely from
    // contentSha256), so a malicious/corrupted manifest can smuggle `../`
    // segments through to the local file path — buildLocalPath must catch it.
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
    const result = await runDownloadCommand(['--session-id=sess-a', `--output=${tmpDir}`], {
      env: validEnv,
      storageAdapter: adapter,
      ...io,
    });

    expect(result).toBe(1);
    expect(io.stdoutStr()).toContain('escapes output directory');
    await expect(fsp.access(path.join(path.dirname(tmpDir), 'evil.txt'))).rejects.toThrow();
  });

  it('fails with exit 1 when the requested manifest is missing', async () => {
    const io = makeStdio();
    const result = await runDownloadCommand(['--session-id=sess-missing', `--output=${tmpDir}`], {
      env: validEnv,
      storageAdapter: makeStorageAdapter([]),
      ...io,
    });
    expect(result).toBe(1);
    expect(io.stderrStr()).toContain('manifest not found');
  });

  it('rejects a manifest with an unsupported schema version', async () => {
    const badManifest = { ...makeManifest('sess-bad', []), schemaVersion: 1 } as Record<
      string,
      unknown
    >;
    const entries = [
      makeStoredEntry({
        projectId: 'proj-1',
        sessionId: 'sess-bad',
        scope: 'manifest',
        relativePath: 'manifest.json',
        body: textBody(JSON.stringify(badManifest)),
      }),
    ];

    const io = makeStdio();
    const result = await runDownloadCommand(['--session-id=sess-bad', `--output=${tmpDir}`], {
      env: validEnv,
      storageAdapter: makeStorageAdapter(entries),
      ...io,
    });

    expect(result).toBe(1);
    expect(io.stdoutStr()).toContain('manifest parse failed');
    expect(io.stdoutStr()).toContain('schemaVersion');
  });

  it('discovers sessions and downloads all via manifest listing', async () => {
    const bodyA = textBody('body-a');
    const bodyB = textBody('body-b');
    const manifestA = makeManifest('sess-a', [makeArtifact('sess-a', 'session', 'a.jsonl', bodyA)]);
    const manifestB = makeManifest('sess-b', [makeArtifact('sess-b', 'session', 'b.jsonl', bodyB)]);

    const entries = [
      makeStoredEntry({
        projectId: 'proj-1',
        sessionId: 'sess-a',
        scope: 'manifest',
        relativePath: 'manifest.json',
        body: textBody(JSON.stringify(manifestA)),
      }),
      makeStoredEntry({
        projectId: 'proj-1',
        sessionId: 'sess-a',
        scope: 'session',
        relativePath: 'a.jsonl',
        body: bodyA,
      }),
      makeStoredEntry({
        projectId: 'proj-1',
        sessionId: 'sess-b',
        scope: 'manifest',
        relativePath: 'manifest.json',
        body: textBody(JSON.stringify(manifestB)),
      }),
      makeStoredEntry({
        projectId: 'proj-1',
        sessionId: 'sess-b',
        scope: 'session',
        relativePath: 'b.jsonl',
        body: bodyB,
      }),
    ];

    const adapter = makeStorageAdapter(entries);
    const io = makeStdio();
    const result = await runDownloadCommand(['all', `--output=${tmpDir}`], {
      env: validEnv,
      storageAdapter: adapter,
      ...io,
    });

    expect(result).toBe(0);
    expect(io.stdoutStr()).toContain('proj-1/sess-a/a.jsonl');
    expect(io.stdoutStr()).toContain('proj-1/sess-b/b.jsonl');
    expect(adapter.listObjects).toHaveBeenCalledWith({ projectId: 'proj-1' });
  });

  it('deduplicates CAS workspace artifacts across sessions in one all run', async () => {
    const sharedBody = textBody('shared workspace guide');
    const shared = makeArtifact('sess-a', 'workspace', 'agents/shared.md', sharedBody);
    const manifestA = makeManifest('sess-a', [shared]);
    const manifestB = makeManifest('sess-b', [
      { ...shared, sessionId: 'sess-b' } as ManifestArtifact,
    ]);

    const entries = [
      makeStoredEntry({
        projectId: 'proj-1',
        sessionId: 'sess-a',
        scope: 'manifest',
        relativePath: 'manifest.json',
        body: textBody(JSON.stringify(manifestA)),
      }),
      makeStoredEntry({
        projectId: 'proj-1',
        sessionId: 'sess-a',
        scope: 'workspace',
        relativePath: 'agents/shared.md',
        body: sharedBody,
        contentSha256: shared.sha256,
      }),
      makeStoredEntry({
        projectId: 'proj-1',
        sessionId: 'sess-b',
        scope: 'manifest',
        relativePath: 'manifest.json',
        body: textBody(JSON.stringify(manifestB)),
      }),
    ];

    const adapter = makeStorageAdapter(entries);
    const io = makeStdio();
    const result = await runDownloadCommand(['all', `--output=${tmpDir}`], {
      env: validEnv,
      storageAdapter: adapter,
      ...io,
    });

    expect(result).toBe(0);
    const workspaceGets = adapter.getObject.mock.calls.filter((c) => c[0].scope === 'workspace');
    expect(workspaceGets).toHaveLength(1);
    expect(workspaceGets[0]?.[0].contentSha256).toBe(shared.sha256);

    const pathA = path.join(tmpDir, 'proj-1', 'sess-a', 'workspace', 'agents', 'shared.md');
    const pathB = path.join(tmpDir, 'proj-1', 'sess-b', 'workspace', 'agents', 'shared.md');
    const fileA = await fsp.readFile(pathA, 'utf8');
    const fileB = await fsp.readFile(pathB, 'utf8');
    const sharedText = new TextDecoder().decode(sharedBody);
    expect(fileA).toBe(sharedText);
    expect(fileB).toBe(sharedText);
  });

  it('reports failures when an artifact is missing in storage', async () => {
    const transcript = makeArtifact('sess-a', 'session', 'transcript.jsonl', textBody('ok'));
    const manifest = makeManifest('sess-a', [transcript]);

    const entries = [
      makeStoredEntry({
        projectId: 'proj-1',
        sessionId: 'sess-a',
        scope: 'manifest',
        relativePath: 'manifest.json',
        body: textBody(JSON.stringify(manifest)),
      }),
    ];

    const adapter = makeStorageAdapter(entries);
    const io = makeStdio();
    const result = await runDownloadCommand(['--session-id=sess-a', `--output=${tmpDir}`], {
      env: validEnv,
      storageAdapter: adapter,
      ...io,
    });

    expect(result).toBe(1);
    expect(io.stdoutStr()).toContain('[fail]');
    expect(io.stdoutStr()).toContain('object not found');
  });

  it('returns 0 when no sessions are found for the project', async () => {
    const io = makeStdio();
    const result = await runDownloadCommand(['all', `--output=${tmpDir}`], {
      env: validEnv,
      storageAdapter: makeStorageAdapter([]),
      ...io,
    });
    expect(result).toBe(0);
    expect(io.stdoutStr()).toContain('No sessions found');
  });
});
