import type {
  DeleteObjectsInput,
  DeleteObjectsResult,
  ListObjectEntry,
  ListObjectsInput,
  StorageAdapter,
} from '@lucasschirm/sal-sync';
import { describe, expect, it, vi } from 'vitest';

import { parseRemoveArgs, runRemoveCommand } from '../../src/index.js';

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

function makeAdapter(options: { objects: ListObjectEntry[]; deleteResult?: DeleteObjectsResult }): {
  adapter: StorageAdapter;
  listObjects: ReturnType<typeof vi.fn>;
  deleteObjects: ReturnType<typeof vi.fn>;
} {
  const listObjects = vi.fn().mockResolvedValue({ objects: options.objects });
  const deleteObjects = vi
    .fn()
    .mockResolvedValue(options.deleteResult ?? { deletedKeys: [], errors: [] });
  const adapter = {
    putObject: vi.fn(),
    listObjects,
    deleteObjects,
  } as unknown as StorageAdapter;
  return { adapter, listObjects, deleteObjects };
}

describe('parseRemoveArgs', () => {
  it('parses a bare project id as a dry run', () => {
    const result = parseRemoveArgs(['proj-1']);
    expect(result).toEqual({ projectId: 'proj-1', sessionId: undefined, confirmed: false });
  });

  it('parses --session and --yes', () => {
    const result = parseRemoveArgs(['proj-1', '--session=sess-a', '--yes']);
    expect(result).toEqual({ projectId: 'proj-1', sessionId: 'sess-a', confirmed: true });
  });

  it('parses --session with a separate value and -y', () => {
    const result = parseRemoveArgs(['proj-1', '--session', 'sess-a', '-y']);
    expect(result).toEqual({ projectId: 'proj-1', sessionId: 'sess-a', confirmed: true });
  });

  it('errors when no project id is given', () => {
    const result = parseRemoveArgs(['--yes']);
    expect('error' in result).toBe(true);
  });

  it('errors on more than one project id', () => {
    const result = parseRemoveArgs(['proj-1', 'proj-2']);
    expect('error' in result).toBe(true);
  });

  it('errors on --session with no value', () => {
    const result = parseRemoveArgs(['proj-1', '--session']);
    expect('error' in result).toBe(true);
  });

  it('errors on an unknown option', () => {
    const result = parseRemoveArgs(['proj-1', '--bogus']);
    expect('error' in result).toBe(true);
  });
});

describe('runRemoveCommand', () => {
  it('performs a dry run without --yes and never calls deleteObjects', async () => {
    const objects: ListObjectEntry[] = [
      { key: 'proj-1/sess-a/manifest.json', size: 100 },
      { key: 'proj-1/sess-a/session/transcript.jsonl', size: 200 },
    ];
    const { adapter, deleteObjects } = makeAdapter({ objects });
    const stdout = captureStream();

    const result = await runRemoveCommand(['proj-1'], {
      env: validEnv,
      storageAdapter: adapter,
      stdout: stdout.stream,
    });

    expect(result).toBe(0);
    expect(deleteObjects).not.toHaveBeenCalled();
    const output = stdout.lines.join('');
    expect(output).toContain('Dry run: 2 object(s)');
    expect(output).toContain('proj-1/sess-a/manifest.json');
    expect(output).toContain('--yes to actually delete');
  });

  it('reports nothing to remove when the project has no objects', async () => {
    const { adapter } = makeAdapter({ objects: [] });
    const stdout = captureStream();

    const result = await runRemoveCommand(['proj-empty'], {
      env: validEnv,
      storageAdapter: adapter,
      stdout: stdout.stream,
    });

    expect(result).toBe(0);
    expect(stdout.lines.join('')).toContain('Nothing to remove');
  });

  it('deletes objects when --yes is passed, scoped to the project', async () => {
    const objects: ListObjectEntry[] = [{ key: 'proj-1/sess-a/manifest.json', size: 100 }];
    const { adapter, listObjects, deleteObjects } = makeAdapter({
      objects,
      deleteResult: { deletedKeys: ['proj-1/sess-a/manifest.json'], errors: [] },
    });
    const stdout = captureStream();

    const result = await runRemoveCommand(['proj-1', '--yes'], {
      env: validEnv,
      storageAdapter: adapter,
      stdout: stdout.stream,
    });

    expect(result).toBe(0);
    expect(listObjects).not.toHaveBeenCalled();
    expect(deleteObjects).toHaveBeenCalledWith({
      projectId: 'proj-1',
      sessionId: undefined,
    } satisfies DeleteObjectsInput);
    expect(stdout.lines.join('')).toContain('Deleted 1 object(s)');
  });

  it('scopes deletion to a single session when --session is given', async () => {
    const { adapter, deleteObjects } = makeAdapter({
      objects: [],
      deleteResult: { deletedKeys: ['proj-1/sess-a/manifest.json'], errors: [] },
    });

    await runRemoveCommand(['proj-1', '--session=sess-a', '--yes'], {
      env: validEnv,
      storageAdapter: adapter,
      stdout: captureStream().stream,
    });

    expect(deleteObjects).toHaveBeenCalledWith({
      projectId: 'proj-1',
      sessionId: 'sess-a',
    } satisfies DeleteObjectsInput);
  });

  it('reports partial failures and exits 1', async () => {
    const { adapter } = makeAdapter({
      objects: [],
      deleteResult: {
        deletedKeys: ['proj-1/sess-a/manifest.json'],
        errors: [{ key: 'proj-1/sess-a/session/transcript.jsonl', message: 'AccessDenied' }],
      },
    });
    const stdout = captureStream();
    const stderr = captureStream();

    const result = await runRemoveCommand(['proj-1', '--yes'], {
      env: validEnv,
      storageAdapter: adapter,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(result).toBe(1);
    expect(stdout.lines.join('')).toContain('[fail] proj-1/sess-a/session/transcript.jsonl');
    expect(stderr.lines.join('')).toContain('1 object(s) failed to delete');
  });

  it('errors when the storage adapter does not support deleteObjects', async () => {
    const objects: ListObjectEntry[] = [];
    const listObjects = vi.fn().mockResolvedValue({ objects });
    const adapter = { putObject: vi.fn(), listObjects } as unknown as StorageAdapter;
    const stderr = captureStream();

    const result = await runRemoveCommand(['proj-1', '--yes'], {
      env: validEnv,
      storageAdapter: adapter,
      stderr: stderr.stream,
      stdout: captureStream().stream,
    });

    expect(result).toBe(1);
    expect(stderr.lines.join('')).toContain('does not support deleting objects');
  });

  it('errors when the storage adapter does not support listing objects', async () => {
    const adapter = { putObject: vi.fn() } as unknown as StorageAdapter;
    const stderr = captureStream();

    const result = await runRemoveCommand(['proj-1'], {
      env: validEnv,
      storageAdapter: adapter,
      stderr: stderr.stream,
      stdout: captureStream().stream,
    });

    expect(result).toBe(1);
    expect(stderr.lines.join('')).toContain('does not support listing objects');
  });

  it('propagates a configuration error when no storage adapter or env is valid', async () => {
    const stderr = captureStream();
    const result = await runRemoveCommand(['proj-1'], {
      env: {},
      stderr: stderr.stream,
      stdout: captureStream().stream,
    });

    expect(result).toBe(1);
    expect(stderr.lines.join('').length).toBeGreaterThan(0);
  });

  it('returns 1 and writes usage on invalid arguments', async () => {
    const stderr = captureStream();
    const result = await runRemoveCommand([], {
      env: validEnv,
      stderr: stderr.stream,
      stdout: captureStream().stream,
    });

    expect(result).toBe(1);
    expect(stderr.lines.join('')).toContain('requires a project id');
  });

  it('never invokes listObjects with a prefix that could match global/cas/ objects', async () => {
    const objects: ListObjectEntry[] = [{ key: 'proj-1/sess-a/manifest.json', size: 100 }];
    const { adapter, listObjects } = makeAdapter({ objects });

    await runRemoveCommand(['proj-1'], {
      env: validEnv,
      storageAdapter: adapter,
      stdout: captureStream().stream,
    });

    const call = listObjects.mock.calls[0]?.[0] as ListObjectsInput;
    expect(call.projectId).toBe('proj-1');
    expect(call.sessionId).toBeUndefined();
  });
});
