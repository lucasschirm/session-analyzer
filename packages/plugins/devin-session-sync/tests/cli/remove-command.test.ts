import type {
  DeleteObjectsInput,
  DeleteObjectsResult,
  ListObjectsInput,
  ListObjectsResult,
  PutObjectResult,
  StorageAdapter,
} from '@lucasschirm/sal-sync';
import { describe, expect, it } from 'vitest';
import { parseRemoveArgs, runRemoveCommand } from '../../src/cli/remove-command.js';

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

describe('parseRemoveArgs', () => {
  it('parses a bare project id (dry run)', () => {
    expect(parseRemoveArgs(['proj-1'])).toEqual({
      projectId: 'proj-1',
      sessionId: undefined,
      confirmed: false,
    });
  });

  it('parses --session and --yes', () => {
    expect(parseRemoveArgs(['proj-1', '--session=sess-1', '--yes'])).toEqual({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      confirmed: true,
    });
  });

  it('rejects the reserved "global" project id', () => {
    expect('error' in parseRemoveArgs(['global'])).toBe(true);
  });

  it('rejects a missing project id', () => {
    expect('error' in parseRemoveArgs([])).toBe(true);
  });
});

describe('runRemoveCommand', () => {
  function fakeConfigEnv(): Record<string, string> {
    return {
      SAL_STORAGE_TYPE: 's3',
      SAL_STORAGE_BUCKET: 'test-bucket',
      SAL_STORAGE_REGION: 'us-east-1',
      SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      SAL_STORAGE_SECRET_ACCESS_KEY: 'secret',
    };
  }

  function buildAdapter(): StorageAdapter & { deleted: DeleteObjectsInput[] } {
    const deleted: DeleteObjectsInput[] = [];
    return {
      deleted,
      putObject: async (): Promise<PutObjectResult> => {
        throw new Error('not used');
      },
      listObjects: async (_input: ListObjectsInput): Promise<ListObjectsResult> => ({
        objects: [{ key: 'proj-1/sess-1/transcript.jsonl', size: 10 }],
      }),
      deleteObjects: async (input: DeleteObjectsInput): Promise<DeleteObjectsResult> => {
        deleted.push(input);
        return { deletedKeys: ['proj-1/sess-1/transcript.jsonl'], errors: [] };
      },
    };
  }

  it('performs a dry run without deleting when --yes is absent', async () => {
    const adapter = buildAdapter();
    const { stream: stdout, lines } = writable();
    const code = await runRemoveCommand(['proj-1'], {
      env: fakeConfigEnv(),
      storageAdapter: adapter,
      stdout,
    });
    expect(code).toBe(0);
    expect(adapter.deleted).toHaveLength(0);
    expect(lines.join('')).toContain('Dry run');
  });

  it('deletes objects when --yes is passed', async () => {
    const adapter = buildAdapter();
    const { stream: stdout } = writable();
    const code = await runRemoveCommand(['proj-1', '--yes'], {
      env: fakeConfigEnv(),
      storageAdapter: adapter,
      stdout,
    });
    expect(code).toBe(0);
    expect(adapter.deleted).toHaveLength(1);
  });

  it('reports nothing to remove for an empty project', async () => {
    const adapter: StorageAdapter = {
      putObject: async () => {
        throw new Error('not used');
      },
      listObjects: async () => ({ objects: [] }),
    };
    const { stream: stdout, lines } = writable();
    const code = await runRemoveCommand(['proj-1'], {
      env: fakeConfigEnv(),
      storageAdapter: adapter,
      stdout,
    });
    expect(code).toBe(0);
    expect(lines.join('')).toContain('Nothing to remove');
  });

  it('reports an argument error to stderr and exits 1', async () => {
    const { stream: stderr, lines } = writable();
    const code = await runRemoveCommand([], { stderr });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('remove requires a project id');
  });

  it('reports a configuration error when no storage env is set', async () => {
    const { stream: stderr, lines } = writable();
    const code = await runRemoveCommand(['proj-1'], { env: {}, stderr });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('required storage configuration');
  });

  it('errors when the adapter does not support listObjects', async () => {
    const adapter: StorageAdapter = { putObject: async () => ({ key: 'x', sha256: 'x' }) };
    const { stream: stderr, lines } = writable();
    const code = await runRemoveCommand(['proj-1'], {
      env: fakeConfigEnv(),
      storageAdapter: adapter,
      stderr,
    });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('does not support listing objects');
  });

  it('errors when --yes is passed but the adapter does not support deleteObjects', async () => {
    const adapter: StorageAdapter = {
      putObject: async () => ({ key: 'x', sha256: 'x' }),
      listObjects: async () => ({ objects: [{ key: 'proj-1/sess-1/transcript.jsonl', size: 10 }] }),
    };
    const { stream: stderr, lines } = writable();
    const code = await runRemoveCommand(['proj-1', '--yes'], {
      env: fakeConfigEnv(),
      storageAdapter: adapter,
      stderr,
    });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('does not support deleting objects');
  });

  it('reports per-key delete errors and exits 1', async () => {
    const adapter: StorageAdapter = {
      putObject: async () => ({ key: 'x', sha256: 'x' }),
      listObjects: async () => ({ objects: [{ key: 'proj-1/sess-1/transcript.jsonl', size: 10 }] }),
      deleteObjects: async () => ({
        deletedKeys: [],
        errors: [{ key: 'proj-1/sess-1/transcript.jsonl', message: 'access denied' }],
      }),
    };
    const { stream: stdout, lines: stdoutLines } = writable();
    const { stream: stderr, lines: stderrLines } = writable();
    const code = await runRemoveCommand(['proj-1', '--yes'], {
      env: fakeConfigEnv(),
      storageAdapter: adapter,
      stdout,
      stderr,
    });
    expect(code).toBe(1);
    expect(stdoutLines.join('')).toContain('access denied');
    expect(stderrLines.join('')).toContain('failed to delete');
  });

  it('caps the dry-run preview list at 20 keys with an "and N more" line', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      key: `proj-1/sess-1/file-${i}.txt`,
      size: 1,
    }));
    const adapter: StorageAdapter = {
      putObject: async () => ({ key: 'x', sha256: 'x' }),
      listObjects: async () => ({ objects: many }),
    };
    const { stream: stdout, lines } = writable();
    const code = await runRemoveCommand(['proj-1'], {
      env: fakeConfigEnv(),
      storageAdapter: adapter,
      stdout,
    });
    expect(code).toBe(0);
    expect(lines.join('')).toContain('and 5 more');
  });

  it('builds a real storage adapter when none is provided (network error propagates)', async () => {
    const { stream: stdout } = writable();
    await expect(
      runRemoveCommand(['proj-1'], {
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
