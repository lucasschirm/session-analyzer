import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  decodeProjectFolder,
  encodeProjectFolder,
  listLocalSessions,
  parseDownloadArgs,
  resolveClaudeProjectDir,
  resolveCliEnv,
  validateCliConfig,
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
