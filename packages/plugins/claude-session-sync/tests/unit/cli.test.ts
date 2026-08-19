import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ListObjectEntry, StorageAdapter } from '@lucasschirm/sal-sync';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  decodeProjectFolder,
  encodeProjectFolder,
  listLocalSessions,
  parseDownloadArgs,
  parseListArgs,
  resolveClaudeProjectDir,
  resolveCliEnv,
  runListCommand,
  validateCliConfig,
  validateStorageConfig,
} from '../../src/index.js';

function makeTmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `sal-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  return dir;
}

describe('encodeProjectFolder', () => {
  it('replaces path separators with dashes', () => {
    expect(encodeProjectFolder('/Users/foo/bar')).toBe('-Users-foo-bar');
  });

  it('strips trailing slashes before encoding', () => {
    expect(encodeProjectFolder('/Users/foo/bar/')).toBe('-Users-foo-bar');
  });

  it('handles root path', () => {
    // path.normalize('/') returns '/', then trailing slash is stripped to ''
    expect(encodeProjectFolder('/')).toBe('');
  });
});

describe('decodeProjectFolder', () => {
  it('replaces dashes with slashes', () => {
    expect(decodeProjectFolder('-Users-foo-bar')).toBe('/Users/foo/bar');
  });

  it('round-trips with encodeProjectFolder for paths without dashes', () => {
    const cwd = '/Users/lucascaixeta/Documents/projects/myapp';
    expect(decodeProjectFolder(encodeProjectFolder(cwd))).toBe(cwd);
  });

  it('is lossy for paths containing dashes (known limitation)', () => {
    // The encoding replaces / with -, so dashes in directory names are
    // ambiguous. This matches Claude Code's own encoding behavior.
    const cwd = '/Users/foo/my-project';
    const encoded = encodeProjectFolder(cwd);
    expect(encoded).toBe('-Users-foo-my-project');
    // Decoding produces a different path — this is expected.
    expect(decodeProjectFolder(encoded)).toBe('/Users/foo/my/project');
  });
});

describe('resolveClaudeProjectDir', () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeEach(async () => {
    tmpHome = makeTmpDir();
    await fsp.mkdir(tmpHome, { recursive: true });
    tmpProject = path.join(tmpHome, 'my-project');
    await fsp.mkdir(tmpProject, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(tmpHome, { recursive: true, force: true });
  });

  it('finds the encoded project folder', async () => {
    const claudeDir = path.join(tmpHome, '.claude');
    const projectsDir = path.join(claudeDir, 'projects');
    const encoded = encodeProjectFolder(tmpProject);
    await fsp.mkdir(path.join(projectsDir, encoded), { recursive: true });

    const result = await resolveClaudeProjectDir(tmpProject, claudeDir);
    expect(result).toBe(path.join(projectsDir, encoded));
  });

  it('returns undefined when no matching folder exists', async () => {
    const claudeDir = path.join(tmpHome, '.claude');
    await fsp.mkdir(path.join(claudeDir, 'projects'), { recursive: true });

    const result = await resolveClaudeProjectDir(tmpProject, claudeDir);
    expect(result).toBeUndefined();
  });

  it('returns undefined when projects dir does not exist', async () => {
    const claudeDir = path.join(tmpHome, '.claude');
    const result = await resolveClaudeProjectDir(tmpProject, claudeDir);
    expect(result).toBeUndefined();
  });
});

describe('listLocalSessions', () => {
  let tmpProjectDir: string;

  beforeEach(async () => {
    tmpProjectDir = makeTmpDir();
    await fsp.mkdir(tmpProjectDir, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(tmpProjectDir, { recursive: true, force: true });
  });

  it('lists .jsonl files sorted by session id', async () => {
    await fsp.writeFile(path.join(tmpProjectDir, 'b-session.jsonl'), '[]');
    await fsp.writeFile(path.join(tmpProjectDir, 'a-session.jsonl'), '[]');
    await fsp.writeFile(path.join(tmpProjectDir, 'not-a-session.txt'), '[]');
    await fsp.mkdir(path.join(tmpProjectDir, 'subfolder.jsonl'));

    const sessions = await listLocalSessions(tmpProjectDir);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.sessionId).toBe('a-session');
    expect(sessions[1]?.sessionId).toBe('b-session');
  });

  it('returns empty array for missing directory', async () => {
    const sessions = await listLocalSessions(path.join(tmpProjectDir, 'missing'));
    expect(sessions).toEqual([]);
  });
});

describe('resolveCliEnv', () => {
  let tmpCwd: string;

  beforeEach(async () => {
    tmpCwd = makeTmpDir();
    await fsp.mkdir(path.join(tmpCwd, '.claude'), { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(tmpCwd, { recursive: true, force: true });
  });

  it('process env takes precedence over settings.local.json', async () => {
    await fsp.writeFile(
      path.join(tmpCwd, '.claude', 'settings.local.json'),
      JSON.stringify({
        env: {
          SAL_PROJECT_ID: 'from-settings',
          SAL_STORAGE_TYPE: 's3',
        },
      }),
    );

    const env = await resolveCliEnv(tmpCwd, {
      SAL_PROJECT_ID: 'from-process',
      OTHER_VAR: 'kept',
    });

    expect(env.SAL_PROJECT_ID).toBe('from-process');
    expect(env.SAL_STORAGE_TYPE).toBe('s3');
    expect(env.OTHER_VAR).toBe('kept');
  });

  it('fills in missing vars from settings.local.json', async () => {
    await fsp.writeFile(
      path.join(tmpCwd, '.claude', 'settings.local.json'),
      JSON.stringify({
        env: {
          SAL_PROJECT_ID: 'from-settings',
          SAL_STORAGE_TYPE: 's3',
        },
      }),
    );

    const env = await resolveCliEnv(tmpCwd, {
      SAL_STORAGE_TYPE: 'from-process',
    });

    expect(env.SAL_PROJECT_ID).toBe('from-settings');
    expect(env.SAL_STORAGE_TYPE).toBe('from-process');
  });

  it('returns only process env when settings file is missing', async () => {
    const env = await resolveCliEnv(tmpCwd, { FOO: 'bar' });
    expect(env.FOO).toBe('bar');
    expect(env.SAL_PROJECT_ID).toBeUndefined();
  });

  it('handles malformed settings file gracefully', async () => {
    await fsp.writeFile(path.join(tmpCwd, '.claude', 'settings.local.json'), 'not valid json');

    const env = await resolveCliEnv(tmpCwd, { FOO: 'bar' });
    expect(env.FOO).toBe('bar');
  });

  it('ignores non-string env values', async () => {
    await fsp.writeFile(
      path.join(tmpCwd, '.claude', 'settings.local.json'),
      JSON.stringify({
        env: {
          SAL_PROJECT_ID: 'valid',
          SAL_NUMBER: 42,
          SAL_OBJECT: { nested: true },
        },
      }),
    );

    const env = await resolveCliEnv(tmpCwd, {});
    expect(env.SAL_PROJECT_ID).toBe('valid');
    expect(env.SAL_NUMBER).toBeUndefined();
    expect(env.SAL_OBJECT).toBeUndefined();
  });
});

describe('validateCliConfig', () => {
  const validEnv = {
    SAL_PROJECT_ID: 'test-project',
    SAL_STORAGE_TYPE: 's3',
    SAL_STORAGE_BUCKET: 'my-bucket',
    SAL_STORAGE_REGION: 'us-east-1',
    SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    SAL_STORAGE_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };

  it('returns ok with config when all required vars are set', () => {
    const result = validateCliConfig(validEnv, '/tmp/test-project');
    expect(result.ok).toBe(true);
    expect(result.config?.projectId).toBe('test-project');
    expect(result.config?.storage.bucket).toBe('my-bucket');
  });

  it('returns error with example messages for missing vars', () => {
    const result = validateCliConfig({}, '/tmp/test-project');
    expect(result.ok).toBe(false);
    expect(result.missing).toBeDefined();
    expect(result.missing?.length).toBe(6);
    expect(result.errorMessage).toContain('SAL_PROJECT_ID');
    expect(result.errorMessage).toContain('export SAL_PROJECT_ID=test-project');
    expect(result.errorMessage).toContain('npx @lucasschirm/claude-session-sync sync');
    expect(result.errorMessage).toContain('.claude/settings.local.json');
  });

  it('suggests project id from cwd basename', () => {
    const result = validateCliConfig({}, '/Users/foo/my-cool-app');
    expect(result.errorMessage).toContain('export SAL_PROJECT_ID=my-cool-app');
  });

  it('only reports missing vars, not set ones', () => {
    const partial = {
      SAL_PROJECT_ID: 'test',
      SAL_STORAGE_TYPE: 's3',
    };
    const result = validateCliConfig(partial, '/tmp/test');
    expect(result.ok).toBe(false);
    const missingNames = result.missing?.map((m) => m.name);
    expect(missingNames).not.toContain('SAL_PROJECT_ID');
    expect(missingNames).not.toContain('SAL_STORAGE_TYPE');
    expect(missingNames).toContain('SAL_STORAGE_BUCKET');
  });

  it('handles invalid storage type with all required vars set', () => {
    const env = {
      ...validEnv,
      SAL_STORAGE_TYPE: 'invalid',
    };
    const result = validateCliConfig(env, '/tmp/test');
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain('SAL_STORAGE_TYPE');
  });
});

describe('parseDownloadArgs', () => {
  it('parses --session-id=value --output=value', () => {
    const result = parseDownloadArgs(['--session-id=abc-123', '--output=/tmp/out']);
    expect(result).toEqual({ target: 'abc-123', output: '/tmp/out' });
  });

  it('parses --session-id value --output value (space-separated)', () => {
    const result = parseDownloadArgs(['--session-id', 'abc-123', '--output', '/tmp/out']);
    expect(result).toEqual({ target: 'abc-123', output: '/tmp/out' });
  });

  it('parses "all" as target', () => {
    const result = parseDownloadArgs(['all', '--output=/tmp/out']);
    expect(result).toEqual({ target: 'all', output: '/tmp/out' });
  });

  it('returns undefined when --output is missing', () => {
    const result = parseDownloadArgs(['--session-id=abc-123']);
    expect(result).toBeUndefined();
  });

  it('returns undefined when target is missing', () => {
    const result = parseDownloadArgs(['--output=/tmp/out']);
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty args', () => {
    const result = parseDownloadArgs([]);
    expect(result).toBeUndefined();
  });
});

describe('CLI main entry', () => {
  it('prints help for -h and exits 0', async () => {
    const { cliMain } = await import('../../src/index.js');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const code = await cliMain(['-h']);
      expect(code).toBe(0);
      const output = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('claude-sync');
      expect(output).toContain('sync');
      expect(output).toContain('download');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('prints help for --help and exits 0', async () => {
    const { cliMain } = await import('../../src/index.js');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const code = await cliMain(['--help']);
      expect(code).toBe(0);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('prints help for no args and exits 0', async () => {
    const { cliMain } = await import('../../src/index.js');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const code = await cliMain([]);
      expect(code).toBe(0);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('prints version for -v and exits 0', async () => {
    const { cliMain } = await import('../../src/index.js');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const code = await cliMain(['-v']);
      expect(code).toBe(0);
      const output = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('exits 1 for unknown command', async () => {
    const { cliMain } = await import('../../src/index.js');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await cliMain(['unknown-command']);
      expect(code).toBe(1);
      const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderrOutput).toContain('Unknown command');
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});

describe('validateStorageConfig', () => {
  const validStorageEnv = {
    SAL_STORAGE_TYPE: 's3',
    SAL_STORAGE_BUCKET: 'my-bucket',
    SAL_STORAGE_REGION: 'us-east-1',
    SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    SAL_STORAGE_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };

  it('succeeds without SAL_PROJECT_ID', () => {
    const result = validateStorageConfig(validStorageEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.storage.type).toBe('s3');
    expect(result.storage.bucket).toBe('my-bucket');
    expect(result.retries).toBe(3);
  });

  it('fails when storage type is missing', () => {
    const result = validateStorageConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.errorMessage).toContain('SAL_STORAGE_TYPE');
    expect(result.errorMessage).not.toContain('SAL_PROJECT_ID');
  });
});

describe('parseListArgs', () => {
  it('parses bare list as all-projects', () => {
    expect(parseListArgs([])).toEqual({ mode: 'all-projects' });
  });

  it('parses --current', () => {
    expect(parseListArgs(['--current'])).toEqual({ mode: 'current' });
  });

  it('parses a positional project id', () => {
    expect(parseListArgs(['proj-1'])).toEqual({ mode: 'project', projectId: 'proj-1' });
  });

  it('parses project with --session', () => {
    expect(parseListArgs(['proj-1', '--session=sess-a'])).toEqual({
      mode: 'session',
      projectId: 'proj-1',
      sessionId: 'sess-a',
    });
  });

  it('parses project with --session and --path', () => {
    expect(parseListArgs(['proj-1', '--session', 'sess-a', '--path', 'session/configs'])).toEqual({
      mode: 'path',
      projectId: 'proj-1',
      sessionId: 'sess-a',
      path: 'session/configs',
    });
  });

  it('rejects --current with a project id', () => {
    const result = parseListArgs(['--current', 'proj-1']);
    expect('error' in result).toBe(true);
  });

  it('rejects --path without --session', () => {
    const result = parseListArgs(['proj-1', '--path=session']);
    expect('error' in result).toBe(true);
  });

  it('rejects unknown options', () => {
    const result = parseListArgs(['--unknown']);
    expect('error' in result).toBe(true);
  });
});

describe('runListCommand', () => {
  const validEnv = {
    SAL_PROJECT_ID: 'proj-1',
    SAL_STORAGE_TYPE: 's3',
    SAL_STORAGE_BUCKET: 'my-bucket',
    SAL_STORAGE_REGION: 'us-east-1',
    SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    SAL_STORAGE_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };

  function makeAdapter(objects: ListObjectEntry[]): StorageAdapter {
    return {
      putObject: vi.fn(),
      listObjects: vi.fn().mockResolvedValue({ objects }),
    } as unknown as StorageAdapter;
  }

  it('lists all projects', async () => {
    const objects = [
      { key: 'proj-1/sess-a/manifest.json', size: 100, lastModified: new Date('2026-01-02') },
      {
        key: 'proj-2/sess-b/session/transcript.jsonl',
        size: 200,
        lastModified: new Date('2026-01-01'),
      },
    ] as ListObjectEntry[];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runListCommand([], {
      env: validEnv,
      storageAdapter: makeAdapter(objects),
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
    });
    expect(result).toBe(0);
    const output = stdout.join('');
    expect(output).toContain('proj-1');
    expect(output).toContain('proj-2');
    expect(output).toContain('2 project(s), 2 files');
  });

  it('lists sessions for a project', async () => {
    const objects = [
      { key: 'proj-1/sess-a/manifest.json', size: 100, lastModified: new Date('2026-01-02') },
      { key: 'proj-1/sess-a/session/transcript.jsonl', size: 200 },
      { key: 'proj-1/sess-b/manifest.json', size: 50, lastModified: new Date('2026-01-01') },
    ] as ListObjectEntry[];
    const stdout: string[] = [];
    const result = await runListCommand(['proj-1'], {
      env: validEnv,
      storageAdapter: makeAdapter(objects),
      stdout: {
        write: (s: string) => {
          stdout.push(s);
          return true;
        },
      } as NodeJS.WritableStream,
    });
    expect(result).toBe(0);
    const output = stdout.join('');
    expect(output).toContain('sess-a');
    expect(output).toContain('sess-b');
    expect(output).toContain('2 session(s), 3 files');
  });

  it('lists files in a session', async () => {
    const objects = [
      { key: 'proj-1/sess-a/manifest.json', size: 100, lastModified: new Date('2026-01-02') },
      {
        key: 'proj-1/sess-a/session/transcript.jsonl',
        size: 200,
        lastModified: new Date('2026-01-02'),
      },
      { key: 'proj-1/sess-a/workspace/package.json', size: 50 },
    ] as ListObjectEntry[];
    const stdout: string[] = [];
    const result = await runListCommand(['proj-1', '--session=sess-a'], {
      env: validEnv,
      storageAdapter: makeAdapter(objects),
      stdout: {
        write: (s: string) => {
          stdout.push(s);
          return true;
        },
      } as NodeJS.WritableStream,
    });
    expect(result).toBe(0);
    const output = stdout.join('');
    expect(output).toContain('manifest.json');
    expect(output).toContain('session/transcript.jsonl');
    expect(output).toContain('workspace/package.json');
    expect(output).toContain('3 file(s)');
  });

  it('filters files by --path', async () => {
    const objects = [
      { key: 'proj-1/sess-a/manifest.json', size: 100 },
      { key: 'proj-1/sess-a/session/transcript.jsonl', size: 200 },
      { key: 'proj-1/sess-a/workspace/package.json', size: 50 },
    ] as ListObjectEntry[];
    const stdout: string[] = [];
    const result = await runListCommand(['proj-1', '--session', 'sess-a', '--path', 'session/'], {
      env: validEnv,
      storageAdapter: makeAdapter(objects),
      stdout: {
        write: (s: string) => {
          stdout.push(s);
          return true;
        },
      } as NodeJS.WritableStream,
    });
    expect(result).toBe(0);
    const output = stdout.join('');
    expect(output).toContain('session/transcript.jsonl');
    expect(output).not.toContain('manifest.json');
    expect(output).not.toContain('workspace/package.json');
  });

  it('requires SAL_PROJECT_ID for --current', async () => {
    const stderr: string[] = [];
    const result = await runListCommand(['--current'], {
      env: {},
      stdout: { write: () => true } as unknown as NodeJS.WritableStream,
      stderr: {
        write: (s: string) => {
          stderr.push(s);
          return true;
        },
      } as NodeJS.WritableStream,
    });
    expect(result).toBe(1);
    expect(stderr.join('')).toContain('SAL_PROJECT_ID');
  });

  it('fails when storage config is missing', async () => {
    const stderr: string[] = [];
    const result = await runListCommand([], {
      env: {},
      stdout: { write: () => true } as unknown as NodeJS.WritableStream,
      stderr: {
        write: (s: string) => {
          stderr.push(s);
          return true;
        },
      } as NodeJS.WritableStream,
    });
    expect(result).toBe(1);
    expect(stderr.join('')).toContain('SAL_STORAGE_TYPE');
  });
});
