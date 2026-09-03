import type { ListObjectsResult, StorageAdapter } from '@lucasschirm/sal-sync';
import { describe, expect, it } from 'vitest';
import { parseListArgs, runListCommand } from '../../src/cli/list-command.js';

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

describe('parseListArgs', () => {
  it('parses the no-arg (all-projects) form', () => {
    expect(parseListArgs([])).toEqual({ mode: 'all-projects' });
  });

  it('parses --current', () => {
    expect(parseListArgs(['--current'])).toEqual({ mode: 'current' });
  });

  it('parses a project id', () => {
    expect(parseListArgs(['proj-1'])).toEqual({ mode: 'project', projectId: 'proj-1' });
  });

  it('parses --session=<id>', () => {
    expect(parseListArgs(['proj-1', '--session=sess-1'])).toEqual({
      mode: 'session',
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });
  });

  it('parses --session <id> --path <p>', () => {
    expect(parseListArgs(['proj-1', '--session', 'sess-1', '--path', 'plans/'])).toEqual({
      mode: 'path',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      path: 'plans',
    });
  });

  it('rejects --current combined with a project id', () => {
    const result = parseListArgs(['--current', 'proj-1']);
    expect('error' in result).toBe(true);
  });

  it('rejects --path without --session', () => {
    const result = parseListArgs(['proj-1', '--path=x']);
    expect('error' in result).toBe(true);
  });

  it('rejects an unknown option', () => {
    expect('error' in parseListArgs(['--bogus'])).toBe(true);
  });

  it('rejects a second positional argument', () => {
    expect('error' in parseListArgs(['proj-1', 'proj-2'])).toBe(true);
  });

  it('rejects --session missing a value', () => {
    expect('error' in parseListArgs(['proj-1', '--session'])).toBe(true);
  });
});

describe('runListCommand', () => {
  function stubAdapter(objects: ListObjectsResult['objects']): StorageAdapter {
    return {
      putObject: async () => {
        throw new Error('not used');
      },
      listObjects: async () => ({ objects }),
    };
  }

  it('reports an argument error to stderr and exits 1', async () => {
    const { stream: stderr, lines } = writable();
    const code = await runListCommand(['--bogus'], { stderr });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('unknown option');
  });

  it('lists all projects grouped from object keys', async () => {
    const { stream: stdout, lines } = writable();
    const adapter = stubAdapter([
      { key: 'proj-1/sess-1/manifest.json', size: 10 },
      { key: 'proj-1/sess-1/transcript.jsonl', size: 20 },
    ]);
    const code = await runListCommand([], { storageAdapter: adapter, stdout });
    expect(code).toBe(0);
    expect(lines.join('')).toContain('proj-1');
  });

  it('reports no projects found', async () => {
    const { stream: stdout, lines } = writable();
    const code = await runListCommand([], { storageAdapter: stubAdapter([]), stdout });
    expect(code).toBe(0);
    expect(lines.join('')).toContain('No projects found');
  });

  it('lists sessions for a specific project', async () => {
    const { stream: stdout, lines } = writable();
    const adapter = stubAdapter([{ key: 'proj-1/sess-1/manifest.json', size: 10 }]);
    const code = await runListCommand(['proj-1'], { storageAdapter: adapter, stdout });
    expect(code).toBe(0);
    expect(lines.join('')).toContain('sess-1');
  });

  it('lists files in a session, honoring --path', async () => {
    const { stream: stdout, lines } = writable();
    const adapter = stubAdapter([
      { key: 'proj-1/sess-1/manifest.json', size: 10 },
      { key: 'proj-1/sess-1/plans/plan-a.md', size: 30 },
    ]);
    const code = await runListCommand(['proj-1', '--session=sess-1', '--path=plans'], {
      storageAdapter: adapter,
      stdout,
    });
    expect(code).toBe(0);
    expect(lines.join('')).toContain('plan-a.md');
  });

  it('errors when --current is used without SAL_PROJECT_ID', async () => {
    const { stream: stderr, lines } = writable();
    const code = await runListCommand(['--current'], { env: {}, stderr });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('SAL_PROJECT_ID');
  });

  const fullEnv = {
    SAL_PROJECT_ID: 'proj-1',
    SAL_STORAGE_TYPE: 's3',
    SAL_STORAGE_BUCKET: 'test-bucket',
    SAL_STORAGE_REGION: 'us-east-1',
    SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    SAL_STORAGE_SECRET_ACCESS_KEY: 'secret',
  };

  it('lists sessions for --current using SAL_PROJECT_ID', async () => {
    const { stream: stdout, lines } = writable();
    const adapter = stubAdapter([{ key: 'proj-1/sess-1/manifest.json', size: 10 }]);
    const code = await runListCommand(['--current'], {
      env: fullEnv,
      storageAdapter: adapter,
      stdout,
    });
    expect(code).toBe(0);
    expect(lines.join('')).toContain('sess-1');
  });

  it('reports a config error for a plain project/session mode without storage config', async () => {
    const { stream: stderr, lines } = writable();
    const code = await runListCommand(['proj-1'], { env: {}, stderr });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('required storage configuration');
  });

  it('reports an error when listObjects throws', async () => {
    const adapter: StorageAdapter = {
      putObject: async () => {
        throw new Error('not used');
      },
      listObjects: async () => {
        throw new Error('network down');
      },
    };
    const { stream: stderr, lines } = writable();
    const code = await runListCommand([], { storageAdapter: adapter, stderr });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('network down');
  });

  it('errors when the storage adapter does not support listObjects', async () => {
    const adapter: StorageAdapter = { putObject: async () => ({ key: 'x', sha256: 'x' }) };
    const { stream: stderr, lines } = writable();
    const code = await runListCommand(['proj-1'], {
      env: fullEnv,
      storageAdapter: adapter,
      stderr,
    });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('does not support listing');
  });

  it('reports no files found for an empty session with no path filter', async () => {
    const { stream: stdout, lines } = writable();
    const adapter = stubAdapter([]);
    const code = await runListCommand(['proj-1', '--session=sess-empty'], {
      storageAdapter: adapter,
      stdout,
    });
    expect(code).toBe(0);
    expect(lines.join('')).toContain('No files found for session');
  });

  it('aggregates nested files under a folder prefix', async () => {
    const { stream: stdout, lines } = writable();
    const adapter = stubAdapter([
      { key: 'proj-1/sess-1/manifest.json', size: 10 },
      { key: 'proj-1/sess-1/subagents/a.jsonl', size: 5 },
      { key: 'proj-1/sess-1/subagents/b.jsonl', size: 7 },
    ]);
    const code = await runListCommand(['proj-1', '--session=sess-1'], {
      storageAdapter: adapter,
      stdout,
    });
    expect(code).toBe(0);
    expect(lines.join('')).toContain('subagents/');
  });

  // No `storageAdapter` override below — these exercise
  // `resolveListStorageAdapter`'s real `buildStorageAdapterFromStorage`
  // construction path (both the `validateCliConfig`/`current` branch and the
  // `validateStorageConfig`/project branch), not just the short-circuit used
  // by every other test in this file. `SAL_STORAGE_ENDPOINT` points at a
  // closed local port so the resulting network call fails fast.
  const unreachableEnv = {
    SAL_PROJECT_ID: 'proj-1',
    SAL_STORAGE_TYPE: 's3',
    SAL_STORAGE_BUCKET: 'test-bucket',
    SAL_STORAGE_REGION: 'us-east-1',
    SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    SAL_STORAGE_SECRET_ACCESS_KEY: 'secret',
    SAL_STORAGE_ENDPOINT: 'http://127.0.0.1:1',
    SAL_SYNC_TIMEOUT: '500',
  };

  it('builds a real storage adapter for --current and surfaces the resulting network error', async () => {
    const { stream: stderr, lines } = writable();
    const code = await runListCommand(['--current'], { env: unreachableEnv, stderr });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('Error listing objects');
  }, 10000);

  it('builds a real storage adapter for a project id and surfaces the resulting network error', async () => {
    const { stream: stderr, lines } = writable();
    const code = await runListCommand(['proj-1'], { env: unreachableEnv, stderr });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('Error listing objects');
  }, 10000);
});
