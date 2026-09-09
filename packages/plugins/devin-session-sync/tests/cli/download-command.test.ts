import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildObjectKey,
  type GetObjectInput,
  type GetObjectResult,
  type ListObjectsInput,
  type ListObjectsResult,
  MANIFEST_SCHEMA_VERSION,
  type PutObjectResult,
  type StorageAdapter,
  sha256Hex,
} from '@lucasschirm/sal-sync';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDownloadArgs, runDownloadCommand } from '../../src/cli/download-command.js';

function writable(): { stream: NodeJS.WritableStream; lines: string[] } {
  const lines: string[] = [];
  return {
    stream: {
      write: (chunk: string) => {
        lines.push(chunk);
        return true;
      },
    } as NodeJS.WritableStream,
    lines,
  };
}

describe('parseDownloadArgs', () => {
  it('parses --session-id=<id> --output=<dir>', () => {
    expect(parseDownloadArgs(['--session-id=sess-1', '--output=/tmp/out'])).toEqual({
      target: 'sess-1',
      output: '/tmp/out',
    });
  });

  it('parses "all" with a separated --output value', () => {
    expect(parseDownloadArgs(['all', '--output', '/tmp/out'])).toEqual({
      target: 'all',
      output: '/tmp/out',
    });
  });

  it('returns undefined when --output is missing', () => {
    expect(parseDownloadArgs(['--session-id=sess-1'])).toBeUndefined();
  });

  it('returns undefined for empty argv', () => {
    expect(parseDownloadArgs([])).toBeUndefined();
  });
});

describe('runDownloadCommand', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-download-'));
  });

  afterEach(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });

  function fakeConfigEnv(): Record<string, string> {
    return {
      SAL_PROJECT_ID: 'proj-1',
      SAL_STORAGE_TYPE: 's3',
      SAL_STORAGE_BUCKET: 'test-bucket',
      SAL_STORAGE_REGION: 'us-east-1',
      SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      SAL_STORAGE_SECRET_ACCESS_KEY: 'secret',
    };
  }

  function buildAdapterWithSession(): StorageAdapter {
    const manifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      projectId: 'proj-1',
      sessionId: 'sess-1',
      harness: 'devin',
      harnessVersion: 'test',
      syncVersion: '0.1.0',
      pluginVersion: 'unknown',
      transcriptsCaptured: true,
      artifacts: [
        {
          projectId: 'proj-1',
          sessionId: 'sess-1',
          scope: 'session' as const,
          relativePath: 'transcript.jsonl',
          sha256: sha256Hex('{"type":"session"}\n'),
          size: 20,
          status: 'uploaded' as const,
        },
      ],
      syncRuns: [],
    };
    const manifestBody = Buffer.from(JSON.stringify(manifest), 'utf8');

    return {
      putObject: async (): Promise<PutObjectResult> => {
        throw new Error('not used');
      },
      getObject: async (input: GetObjectInput): Promise<GetObjectResult | undefined> => {
        if (input.scope === 'manifest') return { body: manifestBody };
        if (input.scope === 'session' && input.relativePath === 'transcript.jsonl') {
          return { body: Buffer.from('{"type":"session"}\n', 'utf8') };
        }
        return undefined;
      },
      listObjects: async (_input: ListObjectsInput): Promise<ListObjectsResult> => ({
        objects: [
          {
            key: buildObjectKey({
              projectId: 'proj-1',
              sessionId: 'sess-1',
              scope: 'manifest',
              relativePath: 'manifest.json',
            }),
          },
        ],
      }),
    };
  }

  function buildAdapterWithTraversalArtifact(): StorageAdapter {
    // A CAS-scoped (workspace/global) artifact's relativePath is never
    // validated by buildObjectKey (the remote key is derived purely from
    // contentSha256), so a malicious/corrupted manifest can smuggle `../`
    // segments through to the local file path — `buildLocalPath` in the
    // shared `@lucasschirm/sal-sync` download command must catch it. This
    // regression test was missing from this suite before #354 (claude
    // -session-sync's suite already had the equivalent assertion) — it now
    // exercises the shared implementation this plugin's `runDownloadCommand`
    // delegates to.
    const evilBody = Buffer.from('evil payload\n', 'utf8');
    const evilSha256 = sha256Hex('evil payload\n');
    const manifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      projectId: 'proj-1',
      sessionId: 'sess-evil',
      harness: 'devin',
      harnessVersion: 'test',
      syncVersion: '0.1.0',
      pluginVersion: 'unknown',
      transcriptsCaptured: true,
      artifacts: [
        {
          projectId: 'proj-1',
          sessionId: 'sess-evil',
          scope: 'workspace' as const,
          relativePath: '../../../../evil.txt',
          sha256: evilSha256,
          size: evilBody.length,
          status: 'uploaded' as const,
        },
      ],
      syncRuns: [],
    };
    const manifestBody = Buffer.from(JSON.stringify(manifest), 'utf8');

    return {
      putObject: async (): Promise<PutObjectResult> => {
        throw new Error('not used');
      },
      getObject: async (input: GetObjectInput): Promise<GetObjectResult | undefined> => {
        if (input.scope === 'manifest') return { body: manifestBody };
        if (input.scope === 'workspace' && input.contentSha256 === evilSha256) {
          return { body: evilBody };
        }
        return undefined;
      },
    };
  }

  it('refuses to write outside the output directory for a manifest with a traversal relativePath', async () => {
    const { stream: stdout, lines } = writable();
    const code = await runDownloadCommand(['--session-id=sess-evil', `--output=${outputDir}`], {
      env: fakeConfigEnv(),
      storageAdapter: buildAdapterWithTraversalArtifact(),
      stdout,
    });

    expect(code).toBe(1);
    expect(lines.join('')).toContain('escapes output directory');
    await expect(fsp.access(path.join(path.dirname(outputDir), 'evil.txt'))).rejects.toThrow();
  });

  it('downloads a specific session', async () => {
    const { stream: stdout } = writable();
    const code = await runDownloadCommand(['--session-id=sess-1', `--output=${outputDir}`], {
      env: fakeConfigEnv(),
      storageAdapter: buildAdapterWithSession(),
      stdout,
    });
    expect(code).toBe(0);
    const downloaded = await fsp.readFile(
      path.join(outputDir, 'proj-1', 'sess-1', 'transcript.jsonl'),
      'utf8',
    );
    expect(downloaded).toContain('session');
  });

  it('downloads all sessions for a project', async () => {
    const { stream: stdout } = writable();
    const code = await runDownloadCommand(['all', `--output=${outputDir}`], {
      env: fakeConfigEnv(),
      storageAdapter: buildAdapterWithSession(),
      stdout,
    });
    expect(code).toBe(0);
    const downloaded = await fsp.readFile(
      path.join(outputDir, 'proj-1', 'sess-1', 'manifest.json'),
      'utf8',
    );
    expect(JSON.parse(downloaded).sessionId).toBe('sess-1');
  });

  it('prints usage and exits 1 for invalid args', async () => {
    const { stream: stderr, lines } = writable();
    const code = await runDownloadCommand([], { stderr });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('Usage');
  });

  it('exits 1 when configuration is missing', async () => {
    const { stream: stderr, lines } = writable();
    const code = await runDownloadCommand(['all', `--output=${outputDir}`], { env: {}, stderr });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('required');
  });

  it('errors when the adapter lacks getObject support', async () => {
    const { stream: stderr, lines } = writable();
    const adapter: StorageAdapter = { putObject: async () => ({ key: 'x', sha256: 'x' }) };
    const code = await runDownloadCommand(['--session-id=sess-1', `--output=${outputDir}`], {
      env: fakeConfigEnv(),
      storageAdapter: adapter,
      stderr,
    });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('does not support getting objects');
  });

  it('errors when downloading "all" and the adapter lacks listObjects support', async () => {
    const { stream: stderr, lines } = writable();
    const adapter: StorageAdapter = {
      putObject: async () => ({ key: 'x', sha256: 'x' }),
      getObject: async () => undefined,
    };
    const code = await runDownloadCommand(['all', `--output=${outputDir}`], {
      env: fakeConfigEnv(),
      storageAdapter: adapter,
      stderr,
    });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('does not support listing objects');
  });

  it('reports a missing manifest for a single session and exits 1', async () => {
    const { stream: stderr, lines } = writable();
    const adapter: StorageAdapter = {
      putObject: async () => ({ key: 'x', sha256: 'x' }),
      getObject: async () => undefined,
    };
    const code = await runDownloadCommand(['--session-id=sess-missing', `--output=${outputDir}`], {
      env: fakeConfigEnv(),
      storageAdapter: adapter,
      stderr,
    });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('manifest not found');
  });

  it('reports 0 downloaded / 0 failed without printing a summary', async () => {
    const { stream: stdout, lines } = writable();
    const adapter: StorageAdapter = {
      putObject: async () => ({ key: 'x', sha256: 'x' }),
      getObject: async () => undefined,
      listObjects: async () => ({ objects: [] }),
    };
    const code = await runDownloadCommand(['all', `--output=${outputDir}`], {
      env: fakeConfigEnv(),
      storageAdapter: adapter,
      stdout,
    });
    expect(code).toBe(0);
    expect(lines.join('')).toContain('No sessions found');
  });

  it('builds a real storage adapter (network error propagates rather than resolving)', async () => {
    const { stream: stdout } = writable();
    await expect(
      runDownloadCommand(['all', `--output=${outputDir}`], {
        env: {
          ...fakeConfigEnv(),
          SAL_STORAGE_ENDPOINT: 'http://127.0.0.1:1',
          SAL_SYNC_TIMEOUT: '500',
        },
        stdout,
      }),
    ).rejects.toBeDefined();
  }, 10000);
});
