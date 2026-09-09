import { Buffer } from 'node:buffer';

import type {
  GetObjectInput,
  GetObjectResult,
  HeadObjectInput,
  HeadObjectResult,
  ListObjectEntry,
  PutObjectInput,
  PutObjectResult,
  StorageAdapter,
} from '@lucasschirm/sal-sync';
import { describe, expect, it, vi } from 'vitest';

import { parseMigrateArgs, runMigrateCommand } from '../../src/index.js';

const validEnv = {
  SAL_STORAGE_TYPE: 's3',
  SAL_STORAGE_BUCKET: 'my-bucket',
  SAL_STORAGE_REGION: 'us-east-1',
  SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  SAL_STORAGE_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

function captureStream() {
  const lines: string[] = [];
  const stream = {
    write: (s: string) => {
      lines.push(s);
      return true;
    },
  } as NodeJS.WritableStream;
  return { lines, stream };
}

function makeAdapter(objects: ListObjectEntry[]): {
  adapter: StorageAdapter;
  puts: PutObjectInput[];
  gets: GetObjectInput[];
} {
  const objectMap = new Map<string, GetObjectResult>();
  for (const obj of objects) {
    objectMap.set(obj.key, {
      body: Buffer.from(`content-for-${obj.key}`),
      contentType: 'application/octet-stream',
      etag: 'etag',
    });
  }

  const puts: PutObjectInput[] = [];
  const gets: GetObjectInput[] = [];

  const adapter = {
    putObject: vi
      .fn()
      .mockImplementation(async (input: PutObjectInput): Promise<PutObjectResult> => {
        puts.push(input);
        return { key: 'mock-key', etag: 'etag' };
      }),
    getObject: vi
      .fn()
      .mockImplementation(async (input: GetObjectInput): Promise<GetObjectResult | undefined> => {
        gets.push(input);
        // Build the key the same way buildObjectKey does for session scope
        // (omits the session/ segment), so the relativePath includes it
        const key = `${input.projectId}/${input.sessionId}/${input.relativePath}`;
        return objectMap.get(key);
      }),
    headObject: vi
      .fn()
      .mockImplementation(async (input: HeadObjectInput): Promise<HeadObjectResult | undefined> => {
        const _key = `${input.projectId}/${input.sessionId}/${input.relativePath}`;
        // Only return a head if the NEW-format key exists
        return undefined;
      }),
    listObjects: vi.fn().mockResolvedValue({ objects }),
  } as unknown as StorageAdapter;

  return { adapter, puts, gets };
}

describe('parseMigrateArgs', () => {
  it('parses bare args as a dry run', () => {
    const result = parseMigrateArgs([]);
    expect(result).toEqual({
      projectId: undefined,
      confirmed: false,
      deleteOld: false,
      manifests: false,
    });
  });

  it('parses --project', () => {
    const result = parseMigrateArgs(['--project=my-project']);
    expect(result).toEqual({
      projectId: 'my-project',
      confirmed: false,
      deleteOld: false,
      manifests: false,
    });
  });

  it('parses --yes', () => {
    const result = parseMigrateArgs(['--yes']);
    expect(result).toEqual({
      projectId: undefined,
      confirmed: true,
      deleteOld: false,
      manifests: false,
    });
  });

  it('parses --yes --delete-old', () => {
    const result = parseMigrateArgs(['--yes', '--delete-old']);
    expect(result).toEqual({
      projectId: undefined,
      confirmed: true,
      deleteOld: true,
      manifests: false,
    });
  });

  it('parses --manifests', () => {
    const result = parseMigrateArgs(['--manifests']);
    expect(result).toEqual({
      projectId: undefined,
      confirmed: false,
      deleteOld: false,
      manifests: true,
    });
  });

  it('parses --yes --manifests', () => {
    const result = parseMigrateArgs(['--yes', '--manifests']);
    expect(result).toEqual({
      projectId: undefined,
      confirmed: true,
      deleteOld: false,
      manifests: true,
    });
  });

  it('errors on unknown options', () => {
    const result = parseMigrateArgs(['--unknown']);
    expect('error' in result).toBe(true);
  });

  it('errors on unexpected positional argument', () => {
    const result = parseMigrateArgs(['foo']);
    expect('error' in result).toBe(true);
  });
});

describe('runMigrateCommand', () => {
  it('dry run lists old-format keys', async () => {
    const objects: ListObjectEntry[] = [
      { key: 'proj-1/sess-a/session/transcript.jsonl', size: 100 },
      { key: 'proj-1/sess-a/session/subagents/agent-1.jsonl', size: 50 },
      { key: 'proj-1/sess-b/transcript.jsonl', size: 200 },
      { key: 'proj-1/sess-a/manifest.json', size: 10 },
    ];
    const { adapter } = makeAdapter(objects);
    const { lines, stream } = captureStream();
    const stderr = captureStream().stream;

    const result = await runMigrateCommand([], {
      env: validEnv,
      storageAdapter: adapter,
      stdout: stream,
      stderr,
    });

    expect(result).toBe(0);
    const output = lines.join('');
    expect(output).toContain('2 old-format key(s)');
    expect(output).toContain('proj-1/sess-a/session/transcript.jsonl');
    expect(output).toContain('-> proj-1/sess-a/transcript.jsonl');
    expect(output).toContain('proj-1/sess-a/session/subagents/agent-1.jsonl');
    expect(output).toContain('-> proj-1/sess-a/subagents/agent-1.jsonl');
  });

  it('dry run lists sessions missing manifests', async () => {
    const objects: ListObjectEntry[] = [
      { key: 'proj-1/sess-a/transcript.jsonl', size: 100 },
      { key: 'proj-1/sess-b/transcript.jsonl', size: 200 },
      { key: 'proj-1/sess-b/manifest.json', size: 10 },
    ];
    const { adapter } = makeAdapter(objects);
    const { lines, stream } = captureStream();
    const stderr = captureStream().stream;

    const result = await runMigrateCommand([], {
      env: validEnv,
      storageAdapter: adapter,
      stdout: stream,
      stderr,
    });

    expect(result).toBe(0);
    const output = lines.join('');
    expect(output).toContain('1 session(s) missing manifests');
    expect(output).toContain('proj-1: 1 session(s)');
  });

  it('reports nothing to migrate when no old-format keys and no missing manifests', async () => {
    const objects: ListObjectEntry[] = [
      { key: 'proj-1/sess-a/transcript.jsonl', size: 100 },
      { key: 'proj-1/sess-a/manifest.json', size: 10 },
    ];
    const { adapter } = makeAdapter(objects);
    const { lines, stream } = captureStream();
    const stderr = captureStream().stream;

    const result = await runMigrateCommand([], {
      env: validEnv,
      storageAdapter: adapter,
      stdout: stream,
      stderr,
    });

    expect(result).toBe(0);
    expect(lines.join('')).toContain('Nothing to migrate');
  });

  it('copies old-format keys to new format with --yes', async () => {
    const objects: ListObjectEntry[] = [
      { key: 'proj-1/sess-a/session/transcript.jsonl', size: 100 },
      { key: 'proj-1/sess-a/session/subagents/agent-1.jsonl', size: 50 },
      { key: 'proj-1/sess-a/manifest.json', size: 10 },
    ];
    const { adapter, puts, gets } = makeAdapter(objects);
    const { lines, stream } = captureStream();
    const stderr = captureStream().stream;

    const result = await runMigrateCommand(['--yes'], {
      env: validEnv,
      storageAdapter: adapter,
      stdout: stream,
      stderr,
    });

    expect(result).toBe(0);
    const output = lines.join('');
    expect(output).toContain('2 keys copied');

    // Verify GET requests used the old key format (with session/ in relativePath)
    expect(gets).toHaveLength(2);
    expect(gets[0]?.relativePath).toBe('session/transcript.jsonl');
    expect(gets[1]?.relativePath).toBe('session/subagents/agent-1.jsonl');

    // Verify PUT requests used the new key format (without session/ in relativePath)
    expect(puts).toHaveLength(2);
    expect(puts[0]?.relativePath).toBe('transcript.jsonl');
    expect(puts[1]?.relativePath).toBe('subagents/agent-1.jsonl');
    expect(puts[0]?.scope).toBe('session');
    expect(puts[1]?.scope).toBe('session');
  });

  it('generates missing manifests with --yes', async () => {
    const objects: ListObjectEntry[] = [
      { key: 'proj-1/sess-a/transcript.jsonl', size: 100 },
      { key: 'proj-1/sess-a/subagents/agent-1.jsonl', size: 50 },
    ];
    const { adapter, puts } = makeAdapter(objects);
    const { lines, stream } = captureStream();
    const stderr = captureStream().stream;

    const result = await runMigrateCommand(['--yes'], {
      env: validEnv,
      storageAdapter: adapter,
      stdout: stream,
      stderr,
    });

    expect(result).toBe(0);
    const output = lines.join('');
    expect(output).toContain('1 manifests generated');

    // Verify a manifest PUT was made with scope 'manifest'
    const manifestPuts = puts.filter((p) => p.scope === 'manifest');
    expect(manifestPuts).toHaveLength(1);
    expect(manifestPuts[0]?.relativePath).toBe('manifest.json');
    expect(manifestPuts[0]?.contentType).toBe('application/json');
  });

  it('backfills manifests with the literal "claude-code" harness, never "claude" (#354)', async () => {
    // `packages/db`'s `classifyManifestArtifact` exact-string-matches the
    // literal 'claude-code' (NOT `ClaudeHarnessProfile.harness`, which is
    // 'claude') to run Claude-specific artifact classification. This test
    // pins that literal directly in the persisted manifest body so a future
    // hoist/refactor that "cleans up" this field to derive from
    // `profile.harness` fails loudly here instead of silently degrading
    // every migrated Claude session's artifacts to `unclassified`.
    const objects: ListObjectEntry[] = [{ key: 'proj-1/sess-a/transcript.jsonl', size: 100 }];
    const { adapter, puts } = makeAdapter(objects);
    const { stream } = captureStream();
    const stderr = captureStream().stream;

    const result = await runMigrateCommand(['--yes'], {
      env: validEnv,
      storageAdapter: adapter,
      stdout: stream,
      stderr,
    });

    expect(result).toBe(0);
    const manifestPut = puts.find((p) => p.scope === 'manifest');
    if (!manifestPut) throw new Error('expected a manifest put');
    const body = JSON.parse((manifestPut.body as Buffer).toString('utf8'));
    expect(body.harness).toBe('claude-code');
    expect(body.harness).not.toBe('claude');
  });

  it('generates manifests only with --yes --manifests (no key migration)', async () => {
    const objects: ListObjectEntry[] = [
      { key: 'proj-1/sess-a/session/transcript.jsonl', size: 100 },
    ];
    const { adapter, puts } = makeAdapter(objects);
    const { lines, stream } = captureStream();
    const stderr = captureStream().stream;

    const result = await runMigrateCommand(['--yes', '--manifests'], {
      env: validEnv,
      storageAdapter: adapter,
      stdout: stream,
      stderr,
    });

    expect(result).toBe(0);
    const output = lines.join('');
    expect(output).toContain('1 manifests generated');
    // No session-scope PUTs (key migration skipped)
    const sessionPuts = puts.filter((p) => p.scope === 'session');
    expect(sessionPuts).toHaveLength(0);
    // Manifest PUT was made
    const manifestPuts = puts.filter((p) => p.scope === 'manifest');
    expect(manifestPuts).toHaveLength(1);
  });

  it('skips keys that already exist in the new format', async () => {
    const objects: ListObjectEntry[] = [
      { key: 'proj-1/sess-a/session/transcript.jsonl', size: 100 },
      { key: 'proj-1/sess-a/manifest.json', size: 10 },
    ];
    const { adapter, puts } = makeAdapter(objects);

    // Make headObject return a result for the new key
    (adapter.headObject as ReturnType<typeof vi.fn>).mockResolvedValue({
      contentLength: 100,
    });

    const { lines, stream } = captureStream();
    const stderr = captureStream().stream;

    const result = await runMigrateCommand(['--yes'], {
      env: validEnv,
      storageAdapter: adapter,
      stdout: stream,
      stderr,
    });

    expect(result).toBe(0);
    expect(lines.join('')).toContain('1 keys skipped');
    // No session-scope PUTs (key already exists)
    const sessionPuts = puts.filter((p) => p.scope === 'session');
    expect(sessionPuts).toHaveLength(0);
  });

  it('groups old-format keys by project in dry run', async () => {
    const objects: ListObjectEntry[] = [
      { key: 'proj-a/sess-1/session/transcript.jsonl', size: 100 },
      { key: 'proj-b/sess-2/session/transcript.jsonl', size: 200 },
      { key: 'proj-b/sess-3/session/transcript.jsonl', size: 300 },
    ];
    const { adapter } = makeAdapter(objects);
    const { lines, stream } = captureStream();
    const stderr = captureStream().stream;

    const result = await runMigrateCommand([], {
      env: validEnv,
      storageAdapter: adapter,
      stdout: stream,
      stderr,
    });

    expect(result).toBe(0);
    const output = lines.join('');
    expect(output).toContain('3 old-format key(s) across 2 project(s)');
    expect(output).toContain('proj-a: 1 key(s)');
    expect(output).toContain('proj-b: 2 key(s)');
  });

  it('errors without storage config', async () => {
    const { stream } = captureStream();
    const stderrLines = captureStream();

    const result = await runMigrateCommand([], {
      env: {},
      stdout: stream,
      stderr: stderrLines.stream,
    });

    expect(result).toBe(1);
    expect(stderrLines.lines.join('')).toContain('SAL_STORAGE_TYPE');
  });
});
