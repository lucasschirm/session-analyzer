import type {
  GetObjectInput,
  GetObjectResult,
  ListObjectsInput,
  ListObjectsResult,
  PutObjectInput,
  PutObjectResult,
  StorageAdapter,
} from '@lucasschirm/sal-sync';
import { describe, expect, it } from 'vitest';
import { parseMigrateArgs, runMigrateCommand } from '../../src/cli/migrate-command.js';

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

describe('parseMigrateArgs', () => {
  it('parses a dry run with no options', () => {
    expect(parseMigrateArgs([])).toEqual({
      confirmed: false,
      deleteOld: false,
      manifests: false,
      projectId: undefined,
    });
  });

  it('parses --yes --manifests --delete-old --project=<id>', () => {
    expect(parseMigrateArgs(['--yes', '--manifests', '--delete-old', '--project=proj-1'])).toEqual({
      confirmed: true,
      deleteOld: true,
      manifests: true,
      projectId: 'proj-1',
    });
  });

  it('rejects an unknown option', () => {
    expect('error' in parseMigrateArgs(['--bogus'])).toBe(true);
  });

  it('rejects an unexpected positional argument', () => {
    expect('error' in parseMigrateArgs(['proj-1'])).toBe(true);
  });
});

describe('runMigrateCommand', () => {
  function fakeConfigEnv(): Record<string, string> {
    return {
      SAL_STORAGE_TYPE: 's3',
      SAL_STORAGE_BUCKET: 'test-bucket',
      SAL_STORAGE_REGION: 'us-east-1',
      SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      SAL_STORAGE_SECRET_ACCESS_KEY: 'secret',
    };
  }

  function buildAdapter(): StorageAdapter & { puts: PutObjectInput[] } {
    const objects = new Map<string, Uint8Array>();
    objects.set(
      'proj-1/sess-1/session/transcript.jsonl',
      Buffer.from('{"type":"session"}\n', 'utf8'),
    );
    const puts: PutObjectInput[] = [];
    return {
      puts,
      putObject: async (input: PutObjectInput): Promise<PutObjectResult> => {
        puts.push(input);
        objects.set(`${input.projectId}/${input.sessionId}/${input.relativePath}`, input.body);
        return { key: `${input.projectId}/${input.sessionId}/${input.relativePath}`, sha256: 'x' };
      },
      getObject: async (input: GetObjectInput): Promise<GetObjectResult | undefined> => {
        const key = `${input.projectId}/${input.sessionId}/${input.relativePath}`;
        const body = objects.get(key);
        return body ? { body } : undefined;
      },
      headObject: async () => undefined,
      listObjects: async (_input: ListObjectsInput): Promise<ListObjectsResult> => ({
        objects: [{ key: 'proj-1/sess-1/session/transcript.jsonl', size: 20 }],
      }),
    };
  }

  it('performs a dry run listing old-format keys and missing manifests', async () => {
    const { stream: stdout, lines } = writable();
    const code = await runMigrateCommand([], {
      env: fakeConfigEnv(),
      storageAdapter: buildAdapter(),
      stdout,
    });
    expect(code).toBe(0);
    expect(lines.join('')).toContain('old-format key');
  });

  it('copies old keys and generates a missing manifest with --yes', async () => {
    const adapter = buildAdapter();
    const { stream: stdout, lines } = writable();
    const code = await runMigrateCommand(['--yes'], {
      env: fakeConfigEnv(),
      storageAdapter: adapter,
      stdout,
    });
    expect(code).toBe(0);
    expect(adapter.puts.some((p) => p.relativePath === 'transcript.jsonl')).toBe(true);
    expect(adapter.puts.some((p) => p.scope === 'manifest')).toBe(true);
    expect(lines.join('')).toContain('Migration complete');
  });

  it('reports nothing to migrate for a clean bucket', async () => {
    const adapter: StorageAdapter = {
      putObject: async () => {
        throw new Error('not used');
      },
      listObjects: async () => ({ objects: [] }),
    };
    const { stream: stdout, lines } = writable();
    const code = await runMigrateCommand([], {
      env: fakeConfigEnv(),
      storageAdapter: adapter,
      stdout,
    });
    expect(code).toBe(0);
    expect(lines.join('')).toContain('Nothing to migrate');
  });

  it('reports an argument error to stderr and exits 1', async () => {
    const { stream: stderr, lines } = writable();
    const code = await runMigrateCommand(['--bogus'], { stderr });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('unknown option');
  });

  it('reports a configuration error when no storage env is set', async () => {
    const { stream: stderr, lines } = writable();
    const code = await runMigrateCommand([], { env: {}, stderr });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('required storage configuration');
  });

  it('errors when the adapter does not support listObjects', async () => {
    const adapter: StorageAdapter = { putObject: async () => ({ key: 'x', sha256: 'x' }) };
    const { stream: stderr, lines } = writable();
    const code = await runMigrateCommand([], {
      env: fakeConfigEnv(),
      storageAdapter: adapter,
      stderr,
    });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('does not support listing objects');
  });

  it('warns about --delete-old without actually deleting', async () => {
    const adapter = buildAdapter();
    const { stream: stdout, lines } = writable();
    const code = await runMigrateCommand(['--yes', '--delete-old'], {
      env: fakeConfigEnv(),
      storageAdapter: adapter,
      stdout,
    });
    expect(code).toBe(0);
    expect(lines.join('')).toContain('old keys were not deleted');
  });

  it('with --manifests, generates manifests only and skips key copying', async () => {
    const adapter = buildAdapter();
    const { stream: stdout, lines } = writable();
    const code = await runMigrateCommand(['--yes', '--manifests'], {
      env: fakeConfigEnv(),
      storageAdapter: adapter,
      stdout,
    });
    expect(code).toBe(0);
    expect(adapter.puts.some((p) => p.relativePath === 'transcript.jsonl')).toBe(false);
    expect(lines.join('')).toContain('manifests generated');
  });

  it('errors when the adapter lacks getObject/putObject for --yes', async () => {
    const adapter: StorageAdapter = {
      putObject: async () => {
        throw new Error('not used');
      },
      listObjects: async () => ({
        objects: [{ key: 'proj-1/sess-1/session/transcript.jsonl', size: 20 }],
      }),
    };
    const { stream: stderr, lines } = writable();
    const code = await runMigrateCommand(['--yes'], {
      env: fakeConfigEnv(),
      storageAdapter: adapter,
      stderr,
    });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('does not support getObject/putObject');
  });

  it('scopes the dry run to --project=<id>', async () => {
    const adapter = buildAdapter();
    const { stream: stdout, lines } = writable();
    const code = await runMigrateCommand(['--project=proj-1'], {
      env: fakeConfigEnv(),
      storageAdapter: adapter,
      stdout,
    });
    expect(code).toBe(0);
    expect(lines.join('')).toContain('old-format key');
  });

  it('builds a real storage adapter when none is provided (network error propagates)', async () => {
    const { stream: stdout } = writable();
    await expect(
      runMigrateCommand([], {
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
