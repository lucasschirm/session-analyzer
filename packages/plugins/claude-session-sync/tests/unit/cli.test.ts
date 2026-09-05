import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HarnessProfile, ListObjectEntry, StorageAdapter } from '@lucasschirm/sal-sync';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ClaudeHarnessProfile,
  decodeProjectFolder,
  encodeProjectFolder,
  listLocalSessions,
  parseDownloadArgs,
  parseListArgs,
  resolveClaudeProjectDir,
  resolveCliEnv,
  runListCommand,
  runSyncCommand,
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
  let tmpHome: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpCwd = makeTmpDir();
    tmpHome = makeTmpDir();
    await fsp.mkdir(path.join(tmpCwd, '.claude'), { recursive: true });
    await fsp.mkdir(path.join(tmpHome, '.claude'), { recursive: true });
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  });

  afterEach(async () => {
    homedirSpy.mockRestore();
    await fsp.rm(tmpCwd, { recursive: true, force: true });
    await fsp.rm(tmpHome, { recursive: true, force: true });
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

  it('returns only process env when no settings files exist', async () => {
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

  // --- Full 3-file precedence ladder tests ---

  it('fills in missing vars from settings.json when settings.local.json is absent', async () => {
    await fsp.writeFile(
      path.join(tmpCwd, '.claude', 'settings.json'),
      JSON.stringify({
        env: {
          SAL_STORAGE_TYPE: 's3',
          SAL_STORAGE_REGION: 'us-east-1',
        },
      }),
    );

    const env = await resolveCliEnv(tmpCwd, {});
    expect(env.SAL_STORAGE_TYPE).toBe('s3');
    expect(env.SAL_STORAGE_REGION).toBe('us-east-1');
  });

  it('reads env from ~/.claude/settings.json (user scope)', async () => {
    await fsp.writeFile(
      path.join(tmpHome, '.claude', 'settings.json'),
      JSON.stringify({ env: { SAL_PROJECT_ID: 'from-user' } }),
    );

    const env = await resolveCliEnv(tmpCwd, {});
    expect(env.SAL_PROJECT_ID).toBe('from-user');
  });

  it('reads env from .claude/settings.json (project scope)', async () => {
    await fsp.writeFile(
      path.join(tmpCwd, '.claude', 'settings.json'),
      JSON.stringify({ env: { SAL_PROJECT_ID: 'from-project' } }),
    );

    const env = await resolveCliEnv(tmpCwd, {});
    expect(env.SAL_PROJECT_ID).toBe('from-project');
  });

  it('project settings.json overrides user settings.json for the same key', async () => {
    await fsp.writeFile(
      path.join(tmpHome, '.claude', 'settings.json'),
      JSON.stringify({ env: { SAL_PROJECT_ID: 'from-user', SAL_STORAGE_TYPE: 's3' } }),
    );
    await fsp.writeFile(
      path.join(tmpCwd, '.claude', 'settings.json'),
      JSON.stringify({ env: { SAL_PROJECT_ID: 'from-project' } }),
    );

    const env = await resolveCliEnv(tmpCwd, {});
    expect(env.SAL_PROJECT_ID).toBe('from-project');
    expect(env.SAL_STORAGE_TYPE).toBe('s3');
  });

  it('settings.local.json takes precedence over settings.json for the same key', async () => {
    await fsp.writeFile(
      path.join(tmpCwd, '.claude', 'settings.json'),
      JSON.stringify({ env: { SAL_PROJECT_ID: 'from-project', SAL_STORAGE_TYPE: 's3' } }),
    );
    await fsp.writeFile(
      path.join(tmpCwd, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { SAL_PROJECT_ID: 'from-local' } }),
    );

    const env = await resolveCliEnv(tmpCwd, {});
    expect(env.SAL_PROJECT_ID).toBe('from-local');
    expect(env.SAL_STORAGE_TYPE).toBe('s3');
  });

  it('process.env overrides all settings files for the same key', async () => {
    await fsp.writeFile(
      path.join(tmpHome, '.claude', 'settings.json'),
      JSON.stringify({ env: { SAL_PROJECT_ID: 'from-user' } }),
    );
    await fsp.writeFile(
      path.join(tmpCwd, '.claude', 'settings.json'),
      JSON.stringify({ env: { SAL_PROJECT_ID: 'from-project' } }),
    );
    await fsp.writeFile(
      path.join(tmpCwd, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { SAL_PROJECT_ID: 'from-local' } }),
    );

    const env = await resolveCliEnv(tmpCwd, { SAL_PROJECT_ID: 'from-env' });
    expect(env.SAL_PROJECT_ID).toBe('from-env');
  });

  it('merges keys from all three settings files (non-overlapping keys accumulate)', async () => {
    await fsp.writeFile(
      path.join(tmpHome, '.claude', 'settings.json'),
      JSON.stringify({ env: { SAL_STORAGE_TYPE: 's3' } }),
    );
    await fsp.writeFile(
      path.join(tmpCwd, '.claude', 'settings.json'),
      JSON.stringify({ env: { SAL_STORAGE_BUCKET: 'my-bucket' } }),
    );
    await fsp.writeFile(
      path.join(tmpCwd, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { SAL_STORAGE_REGION: 'us-east-1' } }),
    );

    const env = await resolveCliEnv(tmpCwd, {});
    expect(env.SAL_STORAGE_TYPE).toBe('s3');
    expect(env.SAL_STORAGE_BUCKET).toBe('my-bucket');
    expect(env.SAL_STORAGE_REGION).toBe('us-east-1');
  });

  it('merges vars across process env, settings.local.json, and settings.json', async () => {
    await fsp.writeFile(
      path.join(tmpCwd, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { SAL_STORAGE_ACCESS_KEY_ID: 'from-local' } }),
    );
    await fsp.writeFile(
      path.join(tmpCwd, '.claude', 'settings.json'),
      JSON.stringify({
        env: {
          SAL_STORAGE_TYPE: 's3',
          SAL_STORAGE_ACCESS_KEY_ID: 'ignored-because-local-wins',
        },
      }),
    );

    const env = await resolveCliEnv(tmpCwd, { SAL_PROJECT_ID: 'from-process' });
    expect(env.SAL_PROJECT_ID).toBe('from-process');
    expect(env.SAL_STORAGE_ACCESS_KEY_ID).toBe('from-local');
    expect(env.SAL_STORAGE_TYPE).toBe('s3');
  });

  it('ignores settings files with no env key', async () => {
    await fsp.writeFile(
      path.join(tmpCwd, '.claude', 'settings.json'),
      JSON.stringify({ model: 'claude-sonnet-4', permissions: { defaultMode: 'plan' } }),
    );

    const env = await resolveCliEnv(tmpCwd, { FOO: 'bar' });
    expect(env.FOO).toBe('bar');
    expect(env.SAL_PROJECT_ID).toBeUndefined();
  });

  it('handles malformed settings.json gracefully', async () => {
    await fsp.writeFile(path.join(tmpCwd, '.claude', 'settings.json'), 'not valid json');

    const env = await resolveCliEnv(tmpCwd, { FOO: 'bar' });
    expect(env.FOO).toBe('bar');
  });

  it('handles malformed ~/.claude/settings.json gracefully', async () => {
    await fsp.writeFile(path.join(tmpHome, '.claude', 'settings.json'), 'not valid json');

    const env = await resolveCliEnv(tmpCwd, { FOO: 'bar' });
    expect(env.FOO).toBe('bar');
  });

  it('full ladder: user < project < local < ENV for the same key', async () => {
    await fsp.writeFile(
      path.join(tmpHome, '.claude', 'settings.json'),
      JSON.stringify({ env: { SAL_PROJECT_ID: 'user' } }),
    );
    await fsp.writeFile(
      path.join(tmpCwd, '.claude', 'settings.json'),
      JSON.stringify({ env: { SAL_PROJECT_ID: 'project' } }),
    );
    await fsp.writeFile(
      path.join(tmpCwd, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { SAL_PROJECT_ID: 'local' } }),
    );

    // Without ENV, local wins
    const env1 = await resolveCliEnv(tmpCwd, {});
    expect(env1.SAL_PROJECT_ID).toBe('local');

    // With ENV, ENV wins
    const env2 = await resolveCliEnv(tmpCwd, { SAL_PROJECT_ID: 'env' });
    expect(env2.SAL_PROJECT_ID).toBe('env');
  });

  it('ignores env values that are not strings in user settings.json', async () => {
    await fsp.writeFile(
      path.join(tmpHome, '.claude', 'settings.json'),
      JSON.stringify({
        env: {
          SAL_PROJECT_ID: 'valid',
          SAL_NUMBER: 42,
          SAL_BOOL: true,
        },
      }),
    );

    const env = await resolveCliEnv(tmpCwd, {});
    expect(env.SAL_PROJECT_ID).toBe('valid');
    expect(env.SAL_NUMBER).toBeUndefined();
    expect(env.SAL_BOOL).toBeUndefined();
  });

  // --- Security: blocklist for committed settings files ---

  it('never reads credentials or the storage endpoint from settings.json', async () => {
    await fsp.writeFile(
      path.join(tmpCwd, '.claude', 'settings.json'),
      JSON.stringify({
        env: {
          SAL_STORAGE_ENDPOINT: 'https://attacker.example.com',
          SAL_STORAGE_ACCESS_KEY_ID: 'attacker-key',
          SAL_STORAGE_SECRET_ACCESS_KEY: 'attacker-secret',
          SAL_STORAGE_BUCKET: 'shared-bucket',
        },
      }),
    );

    const env = await resolveCliEnv(tmpCwd, {});
    expect(env.SAL_STORAGE_ENDPOINT).toBeUndefined();
    expect(env.SAL_STORAGE_ACCESS_KEY_ID).toBeUndefined();
    expect(env.SAL_STORAGE_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.SAL_STORAGE_BUCKET).toBe('shared-bucket');
  });

  it('never reads credentials or the storage endpoint from ~/.claude/settings.json', async () => {
    await fsp.writeFile(
      path.join(tmpHome, '.claude', 'settings.json'),
      JSON.stringify({
        env: {
          SAL_STORAGE_ENDPOINT: 'https://attacker.example.com',
          SAL_STORAGE_ACCESS_KEY_ID: 'attacker-key',
          SAL_STORAGE_SECRET_ACCESS_KEY: 'attacker-secret',
          SAL_STORAGE_BUCKET: 'shared-bucket',
        },
      }),
    );

    const env = await resolveCliEnv(tmpCwd, {});
    expect(env.SAL_STORAGE_ENDPOINT).toBeUndefined();
    expect(env.SAL_STORAGE_ACCESS_KEY_ID).toBeUndefined();
    expect(env.SAL_STORAGE_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.SAL_STORAGE_BUCKET).toBe('shared-bucket');
  });

  it('still allows credentials and endpoint from settings.local.json', async () => {
    await fsp.writeFile(
      path.join(tmpCwd, '.claude', 'settings.local.json'),
      JSON.stringify({
        env: {
          SAL_STORAGE_ENDPOINT: 'https://my-real-endpoint.example.com',
          SAL_STORAGE_ACCESS_KEY_ID: 'my-key',
          SAL_STORAGE_SECRET_ACCESS_KEY: 'my-secret',
        },
      }),
    );

    const env = await resolveCliEnv(tmpCwd, {});
    expect(env.SAL_STORAGE_ENDPOINT).toBe('https://my-real-endpoint.example.com');
    expect(env.SAL_STORAGE_ACCESS_KEY_ID).toBe('my-key');
    expect(env.SAL_STORAGE_SECRET_ACCESS_KEY).toBe('my-secret');
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
        key: 'proj-2/sess-b/transcript.jsonl',
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

  it('lists all projects including the global CAS namespace', async () => {
    const casHash = 'a'.repeat(64);
    const objects = [
      { key: 'proj-1/sess-a/manifest.json', size: 100, lastModified: new Date('2026-01-02') },
      { key: `global/cas/${casHash}`, size: 300, lastModified: new Date('2026-01-03') },
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
    expect(output).toContain('global');
    expect(output).toContain('2 project(s), 2 files');
  });

  it('lists sessions for a project', async () => {
    const objects = [
      { key: 'proj-1/sess-a/manifest.json', size: 100, lastModified: new Date('2026-01-02') },
      { key: 'proj-1/sess-a/transcript.jsonl', size: 200 },
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

  it('lists direct children of a session (non-recursive)', async () => {
    const objects = [
      { key: 'proj-1/sess-a/manifest.json', size: 100, lastModified: new Date('2026-01-02') },
      {
        key: 'proj-1/sess-a/transcript.jsonl',
        size: 200,
        lastModified: new Date('2026-01-02'),
      },
      { key: 'proj-1/sess-a/subagents/agent-x.jsonl', size: 80 },
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
    // Direct files: manifest.json and transcript.jsonl (session-scoped keys
    // omit the `session/` segment, so transcript.jsonl is a direct child)
    expect(output).toContain('manifest.json');
    expect(output).toContain('transcript.jsonl');
    // Folders aggregated, not their contents
    expect(output).toContain('subagents/');
    expect(output).toContain('workspace/');
    expect(output).not.toContain('subagents/agent-x.jsonl');
    expect(output).not.toContain('workspace/package.json');
    // Summary: 2 direct files, 2 folders, 4 total files
    expect(output).toContain('2 file(s), 2 folder(s), 4 total file(s)');
  });

  it('filters files by --path (non-recursive under the path)', async () => {
    const objects = [
      { key: 'proj-1/sess-a/manifest.json', size: 100 },
      { key: 'proj-1/sess-a/transcript.jsonl', size: 200 },
      { key: 'proj-1/sess-a/subagents/agent-x.jsonl', size: 80 },
      { key: 'proj-1/sess-a/subagents/agent-x.meta.json', size: 20 },
      { key: 'proj-1/sess-a/workspace/package.json', size: 50 },
    ] as ListObjectEntry[];
    const stdout: string[] = [];
    const result = await runListCommand(['proj-1', '--session', 'sess-a', '--path', 'subagents/'], {
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
    // Direct children under subagents/
    expect(output).toContain('agent-x.jsonl');
    expect(output).toContain('agent-x.meta.json');
    // Outside the filter
    expect(output).not.toContain('manifest.json');
    expect(output).not.toContain('transcript.jsonl');
    expect(output).not.toContain('workspace/');
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

describe('runSyncCommand', () => {
  const validEnv = {
    SAL_PROJECT_ID: 'proj-1',
    SAL_STORAGE_TYPE: 's3',
    SAL_STORAGE_BUCKET: 'my-bucket',
    SAL_STORAGE_REGION: 'us-east-1',
    SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    SAL_STORAGE_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };

  function makeAdapter(
    objects: ListObjectEntry[] = [],
    putFn?: (input: { body: Uint8Array; relativePath: string }) => Promise<{ key: string }>,
  ): StorageAdapter {
    return {
      putObject: vi.fn(
        putFn ??
          (async (input: { body: Uint8Array; relativePath: string }) => ({
            key: `proj-1/sess-x/${input.relativePath}`,
          })),
      ),
      listObjects: vi.fn().mockResolvedValue({ objects }),
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

  it('fails when storage config is missing', async () => {
    const io = makeStdio();
    const result = await runSyncCommand({ env: {}, ...io });
    expect(result).toBe(1);
    expect(io.stderrStr()).toContain('SAL_STORAGE_TYPE');
  });

  it('fails when no Claude project folder is found', async () => {
    const io = makeStdio();
    const result = await runSyncCommand({
      cwd: '/nonexistent/path/that/does/not/exist',
      env: validEnv,
      storageAdapter: makeAdapter(),
      ...io,
    });
    expect(result).toBe(1);
    expect(io.stderrStr()).toContain('could not find');
  });

  it('returns 0 when no local sessions are found', async () => {
    const tmpDir = makeTmpDir();
    const claudeDir = path.join(tmpDir, '.claude', 'projects', encodeProjectFolder(tmpDir));
    await fsp.mkdir(claudeDir, { recursive: true });

    const oldHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const io = makeStdio();
      const result = await runSyncCommand({
        cwd: tmpDir,
        env: { ...validEnv, SAL_DATA_DIR: path.join(tmpDir, 'sal-data') },
        storageAdapter: makeAdapter(),
        ...io,
      });
      expect(result).toBe(0);
      expect(io.stdoutStr()).toContain('No local sessions found');
    } finally {
      process.env.HOME = oldHome;
    }
  });

  it('skips sessions that are complete in storage (manifest + transcript)', async () => {
    const tmpDir = makeTmpDir();
    const claudeDir = path.join(tmpDir, '.claude', 'projects', encodeProjectFolder(tmpDir));
    await fsp.mkdir(claudeDir, { recursive: true });
    await fsp.writeFile(path.join(claudeDir, 'sess-a.jsonl'), '{"type":"message"}\n');

    const adapter = makeAdapter([
      { key: 'proj-1/sess-a/manifest.json', size: 100 },
      { key: 'proj-1/sess-a/transcript.jsonl', size: 50 },
    ]);

    const oldHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const io = makeStdio();
      const result = await runSyncCommand({
        cwd: tmpDir,
        env: { ...validEnv, SAL_DATA_DIR: path.join(tmpDir, 'sal-data') },
        storageAdapter: adapter,
        ...io,
      });
      expect(result).toBe(0);
      expect(io.stdoutStr()).toContain('[skip] session sess-a');
      expect(io.stdoutStr()).toContain('1 already synced');
    } finally {
      process.env.HOME = oldHome;
    }
  });

  it('re-syncs sessions that have a manifest but no transcript (incomplete)', async () => {
    const tmpDir = makeTmpDir();
    const claudeDir = path.join(tmpDir, '.claude', 'projects', encodeProjectFolder(tmpDir));
    await fsp.mkdir(claudeDir, { recursive: true });
    await fsp.writeFile(path.join(claudeDir, 'sess-a.jsonl'), '{"type":"message"}\n');

    // Manifest-only: the old code would skip this, but the completeness check
    // should detect the missing transcript and re-sync.
    const adapter = makeAdapter([{ key: 'proj-1/sess-a/manifest.json', size: 100 }]);

    const oldHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const io = makeStdio();
      const result = await runSyncCommand({
        cwd: tmpDir,
        env: { ...validEnv, SAL_DATA_DIR: path.join(tmpDir, 'sal-data') },
        storageAdapter: adapter,
        ...io,
      });
      expect(result).toBe(0);
      expect(io.stdoutStr()).not.toContain('[skip] session sess-a');
      expect(io.stdoutStr()).toContain('[ok]   session sess-a');
    } finally {
      process.env.HOME = oldHome;
    }
  });

  it('fails when storage adapter does not support listObjects', async () => {
    const tmpDir = makeTmpDir();
    const claudeDir = path.join(tmpDir, '.claude', 'projects', encodeProjectFolder(tmpDir));
    await fsp.mkdir(claudeDir, { recursive: true });
    await fsp.writeFile(path.join(claudeDir, 'sess-a.jsonl'), '{"type":"message"}\n');

    const adapter = {
      putObject: vi.fn(),
    } as unknown as StorageAdapter;

    const oldHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const io = makeStdio();
      const result = await runSyncCommand({
        cwd: tmpDir,
        env: { ...validEnv, SAL_DATA_DIR: path.join(tmpDir, 'sal-data') },
        storageAdapter: adapter,
        ...io,
      });
      expect(result).toBe(1);
      expect(io.stderrStr()).toContain('does not support listing');
    } finally {
      process.env.HOME = oldHome;
    }
  });

  it('prints force message when --force clears state and re-syncs', async () => {
    const tmpDir = makeTmpDir();
    const claudeDir = path.join(tmpDir, '.claude', 'projects', encodeProjectFolder(tmpDir));
    await fsp.mkdir(claudeDir, { recursive: true });
    await fsp.writeFile(path.join(claudeDir, 'sess-a.jsonl'), '{"type":"message"}\n');

    // Even with a complete session in storage, --force bypasses the
    // completeness check and re-syncs.
    const adapter = makeAdapter([
      { key: 'proj-1/sess-a/manifest.json', size: 100 },
      { key: 'proj-1/sess-a/transcript.jsonl', size: 50 },
    ]);

    const oldHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const io = makeStdio();
      const result = await runSyncCommand({
        cwd: tmpDir,
        env: { ...validEnv, SAL_DATA_DIR: path.join(tmpDir, 'sal-data') },
        storageAdapter: adapter,
        force: true,
        ...io,
      });
      expect(result).toBe(0);
      // With force, the session should NOT be skipped.
      expect(io.stdoutStr()).not.toContain('[skip] session sess-a');
      expect(io.stdoutStr()).toContain('[ok]   session sess-a');
    } finally {
      process.env.HOME = oldHome;
    }
  });

  it('uploads a new session with full scope sync', async () => {
    const tmpDir = makeTmpDir();
    const claudeDir = path.join(tmpDir, '.claude', 'projects', encodeProjectFolder(tmpDir));
    await fsp.mkdir(claudeDir, { recursive: true });
    await fsp.writeFile(
      path.join(claudeDir, 'sess-new.jsonl'),
      '{"type":"message_start","message":{"id":"1","model":"claude","content":[]}}\n',
    );

    const putCalls: string[] = [];
    const adapter: StorageAdapter = {
      putObject: vi.fn(async (input: { body: Uint8Array; relativePath: string }) => {
        putCalls.push(input.relativePath);
        return { key: `proj-1/sess-new/${input.relativePath}` };
      }),
      listObjects: vi.fn().mockResolvedValue({ objects: [] }),
    } as unknown as StorageAdapter;

    const oldHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const io = makeStdio();
      const result = await runSyncCommand({
        cwd: tmpDir,
        env: { ...validEnv, SAL_DATA_DIR: path.join(tmpDir, 'sal-data') },
        storageAdapter: adapter,
        ...io,
      });
      expect(result).toBe(0);
      expect(io.stdoutStr()).toContain('[ok]   session sess-new');
      expect(putCalls.length).toBeGreaterThan(0);
    } finally {
      process.env.HOME = oldHome;
    }
  });

  it('handles sync errors gracefully and returns 1', async () => {
    const tmpDir = makeTmpDir();
    const claudeDir = path.join(tmpDir, '.claude', 'projects', encodeProjectFolder(tmpDir));
    await fsp.mkdir(claudeDir, { recursive: true });
    await fsp.writeFile(path.join(claudeDir, 'sess-err.jsonl'), '{"type":"message_start"}\n');

    const adapter: StorageAdapter = {
      putObject: vi.fn().mockRejectedValue(new Error('network failure')),
      listObjects: vi.fn().mockResolvedValue({ objects: [] }),
    } as unknown as StorageAdapter;

    const oldHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const io = makeStdio();
      const result = await runSyncCommand({
        cwd: tmpDir,
        env: { ...validEnv, SAL_DATA_DIR: path.join(tmpDir, 'sal-data') },
        storageAdapter: adapter,
        ...io,
      });
      expect(result).toBe(1);
      expect(io.stdoutStr()).toContain('[fail] session sess-err');
    } finally {
      process.env.HOME = oldHome;
    }
  });

  it('uploads multiple sessions, first full then session-only', async () => {
    const tmpDir = makeTmpDir();
    const claudeDir = path.join(tmpDir, '.claude', 'projects', encodeProjectFolder(tmpDir));
    await fsp.mkdir(claudeDir, { recursive: true });
    await fsp.writeFile(
      path.join(claudeDir, 'sess-a.jsonl'),
      '{"type":"message_start","message":{"id":"1","model":"claude","content":[]}}\n',
    );
    await fsp.writeFile(
      path.join(claudeDir, 'sess-b.jsonl'),
      '{"type":"message_start","message":{"id":"2","model":"claude","content":[]}}\n',
    );

    const putCalls: string[] = [];
    const adapter: StorageAdapter = {
      putObject: vi.fn(async (input: { body: Uint8Array; relativePath: string }) => {
        putCalls.push(input.relativePath);
        return { key: `proj-1/${input.relativePath}` };
      }),
      listObjects: vi.fn().mockResolvedValue({ objects: [] }),
    } as unknown as StorageAdapter;

    const oldHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const io = makeStdio();
      const result = await runSyncCommand({
        cwd: tmpDir,
        env: { ...validEnv, SAL_DATA_DIR: path.join(tmpDir, 'sal-data') },
        storageAdapter: adapter,
        ...io,
      });
      expect(result).toBe(0);
      expect(io.stdoutStr()).toContain('[ok]   session sess-a');
      expect(io.stdoutStr()).toContain('[ok]   session sess-b');
    } finally {
      process.env.HOME = oldHome;
    }
  });

  it('rejects "global" as a project id (reserved CAS namespace)', async () => {
    const io = makeStdio();
    const result = await runSyncCommand({
      env: { ...validEnv, SAL_PROJECT_ID: 'global' },
      storageAdapter: makeAdapter([]),
      ...io,
    });
    expect(result).toBe(1);
    expect(io.stderrStr()).toContain('reserved');
  });

  // DS-B5 (#143) regression: sync-command.ts:356-357 used to hardcode
  // `harness: 'claude', harness_version: '0.1.0'` regardless of which
  // HarnessProfile was in play. Assert the uploaded manifest's harness
  // fields come from the injected profile end-to-end, using a profile whose
  // values differ from Claude's so a regression to the old hardcode would
  // be caught (not masked by both happening to be 'claude').
  it('DS-B5: manifest harness/harnessVersion come from the injected HarnessProfile', async () => {
    const tmpDir = makeTmpDir();
    const claudeDir = path.join(tmpDir, '.claude', 'projects', encodeProjectFolder(tmpDir));
    await fsp.mkdir(claudeDir, { recursive: true });
    await fsp.writeFile(
      path.join(claudeDir, 'sess-profile.jsonl'),
      '{"type":"message_start","message":{"id":"1","model":"claude","content":[]}}\n',
    );

    let manifestBody: string | undefined;
    const adapter: StorageAdapter = {
      putObject: vi.fn(async (input: { body: Uint8Array; relativePath: string; scope: string }) => {
        if (input.scope === 'manifest' && input.relativePath === 'manifest.json') {
          manifestBody = Buffer.from(input.body).toString('utf8');
        }
        return { key: `proj-1/sess-profile/${input.relativePath}` };
      }),
      listObjects: vi.fn().mockResolvedValue({ objects: [] }),
    } as unknown as StorageAdapter;

    const syntheticProfile: HarnessProfile = {
      ...ClaudeHarnessProfile,
      harness: 'synthetic-harness',
      harnessVersion: '42.0.0',
    };

    const oldHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const io = makeStdio();
      const result = await runSyncCommand({
        cwd: tmpDir,
        env: { ...validEnv, SAL_DATA_DIR: path.join(tmpDir, 'sal-data') },
        storageAdapter: adapter,
        harnessProfile: syntheticProfile,
        ...io,
      });

      expect(result).toBe(0);
      expect(manifestBody).toBeDefined();
      const manifest = JSON.parse(manifestBody as string) as {
        harness: string;
        harnessVersion: string;
      };
      expect(manifest.harness).toBe('synthetic-harness');
      expect(manifest.harnessVersion).toBe('42.0.0');
      expect(manifest.harness).not.toBe('claude');
      expect(manifest.harnessVersion).not.toBe('0.1.0');
    } finally {
      process.env.HOME = oldHome;
    }
  });

  it('defaults to ClaudeHarnessProfile when no harnessProfile option is given', async () => {
    const tmpDir = makeTmpDir();
    const claudeDir = path.join(tmpDir, '.claude', 'projects', encodeProjectFolder(tmpDir));
    await fsp.mkdir(claudeDir, { recursive: true });
    await fsp.writeFile(
      path.join(claudeDir, 'sess-default.jsonl'),
      '{"type":"message_start","message":{"id":"1","model":"claude","content":[]}}\n',
    );

    let manifestBody: string | undefined;
    const adapter: StorageAdapter = {
      putObject: vi.fn(async (input: { body: Uint8Array; relativePath: string; scope: string }) => {
        if (input.scope === 'manifest' && input.relativePath === 'manifest.json') {
          manifestBody = Buffer.from(input.body).toString('utf8');
        }
        return { key: `proj-1/sess-default/${input.relativePath}` };
      }),
      listObjects: vi.fn().mockResolvedValue({ objects: [] }),
    } as unknown as StorageAdapter;

    const oldHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const io = makeStdio();
      const result = await runSyncCommand({
        cwd: tmpDir,
        env: { ...validEnv, SAL_DATA_DIR: path.join(tmpDir, 'sal-data') },
        storageAdapter: adapter,
        ...io,
      });

      expect(result).toBe(0);
      const manifest = JSON.parse(manifestBody as string) as {
        harness: string;
        harnessVersion: string;
      };
      expect(manifest.harness).toBe(ClaudeHarnessProfile.harness);
      expect(manifest.harnessVersion).toBe(ClaudeHarnessProfile.harnessVersion);
    } finally {
      process.env.HOME = oldHome;
    }
  });
});
