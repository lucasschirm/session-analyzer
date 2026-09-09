import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type CliHarnessAdapter,
  detectShellGlobExpansion,
  isGlobPattern,
  matchesSqlLike,
  readWorkdirConfig,
  resolveWorkdirPath,
  runWorkdirCommand,
  workdirConfigPath,
  workdirMatches,
  writeWorkdirConfig,
} from '../../../../src/cli/index.js';

const FIXTURE_ADAPTER: CliHarnessAdapter = {
  profile: {
    harness: 'fixture',
    harnessVersion: '0.0.0',
    configDir: () => '/fixture',
    captureAllowlist: { version: 1, session: [], workspace: [], global: [] },
    sessionLayout: {
      mainTranscriptStorageName: 'transcript.jsonl',
      mainTranscriptFilePattern: '{sessionId}.jsonl',
      subagentTranscriptsPattern: 'subagents/*.jsonl',
      subagentMetaPattern: 'subagents/*.meta.json',
    },
    securityBlocklist: [],
  },
  binName: 'fixture-sync',
  packageName: '@fixture/harness-sync',
  logFolderEnvVar: 'FIXTURE_LOG_PATH_FOLDER',
  resolveConfigPaths: () => ({ local: '/local', project: '/project', userGlobal: '/user' }),
  localConfigDisplayPath: '.fixture/settings.local.json',
  migrateManifestHarness: 'fixture',
  helpText: 'fixture-sync help text\n',
};

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

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'workdir-test-'));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('resolveWorkdirPath', () => {
  it('resolves . to the supplied cwd', () => {
    expect(resolveWorkdirPath('.', '/home/user/project')).toBe('/home/user/project');
  });

  it('resolves ./ to the supplied cwd', () => {
    expect(resolveWorkdirPath('./', '/home/user/project')).toBe('/home/user/project');
  });

  it('resolves ~ to the home directory', () => {
    const home = os.homedir();
    expect(resolveWorkdirPath('~', '/cwd')).toBe(home);
  });

  it('resolves ~/sub/path to home/sub/path', () => {
    const home = os.homedir();
    expect(resolveWorkdirPath('~/sub/path', '/cwd')).toBe(path.join(home, 'sub', 'path'));
  });

  it('resolves relative paths against cwd', () => {
    expect(resolveWorkdirPath('sub/dir', '/home/user')).toBe('/home/user/sub/dir');
  });

  it('keeps absolute paths as-is', () => {
    expect(resolveWorkdirPath('/abs/path', '/cwd')).toBe('/abs/path');
  });

  it('strips trailing slashes (except root)', () => {
    expect(resolveWorkdirPath('/abs/path/', '/cwd')).toBe('/abs/path');
  });

  it('preserves glob metacharacters in absolute paths', () => {
    expect(resolveWorkdirPath('/path/to/worktrees/*', '/cwd')).toBe('/path/to/worktrees/*');
  });

  it('resolves relative globs against cwd', () => {
    expect(resolveWorkdirPath('worktrees/*', '/home/user')).toBe('/home/user/worktrees/*');
  });
});

describe('isGlobPattern', () => {
  it('detects * as a glob', () => {
    expect(isGlobPattern('/path/*')).toBe(true);
  });

  it('detects ? as a glob', () => {
    expect(isGlobPattern('/path/file?')).toBe(true);
  });

  it('detects [ as a glob', () => {
    expect(isGlobPattern('/path/[abc]')).toBe(true);
  });

  it('returns false for plain paths', () => {
    expect(isGlobPattern('/plain/path')).toBe(false);
  });
});

describe('matchesSqlLike', () => {
  it('matches exact strings', () => {
    expect(matchesSqlLike('/home/user/project', '/home/user/project')).toBe(true);
    expect(matchesSqlLike('/home/user/project', '/home/user/other')).toBe(false);
  });

  it('matches wildcard * across directory separators', () => {
    expect(matchesSqlLike('/worktrees/tsk0005', '/worktrees/*')).toBe(true);
    expect(matchesSqlLike('/worktrees/tsk0005/sub/dir', '/worktrees/*')).toBe(true);
    expect(matchesSqlLike('/other/tsk0005', '/worktrees/*')).toBe(false);
  });

  it('matches wildcard * with zero characters', () => {
    expect(matchesSqlLike('/worktrees/', '/worktrees/*')).toBe(true);
  });

  it('matches single-character wildcard ?', () => {
    expect(matchesSqlLike('/path/a', '/path/?')).toBe(true);
    expect(matchesSqlLike('/path/ab', '/path/?')).toBe(false);
  });

  it('escapes regex metacharacters in literal parts', () => {
    expect(matchesSqlLike('/foo.bar/baz', '/foo.bar/*')).toBe(true);
    expect(matchesSqlLike('/fooXbar/baz', '/foo.bar/*')).toBe(false);
    expect(matchesSqlLike('/foo+bar/baz', '/foo+bar/*')).toBe(true);
    expect(matchesSqlLike('/foo[bar]/baz', '/foo[bar]/*')).toBe(true);
  });

  it('matches paths containing dashes (e.g. tsk0049-e2e)', () => {
    expect(matchesSqlLike('/worktrees/tsk0049-e2e', '/worktrees/*')).toBe(true);
    expect(matchesSqlLike('/worktrees/tsk0049-e2e/nested', '/worktrees/*')).toBe(true);
    expect(matchesSqlLike('/worktrees/tsk0049-e2e', '/worktrees/*-e2e')).toBe(true);
    expect(matchesSqlLike('/worktrees/tsk0049-e2e', '/worktrees/tsk*-e2e')).toBe(true);
    expect(matchesSqlLike('/worktrees/tsk0049', '/worktrees/*-e2e')).toBe(false);
  });
});

describe('detectShellGlobExpansion', () => {
  it('returns undefined when args has length <= 1', async () => {
    expect(await detectShellGlobExpansion([])).toBeUndefined();
    expect(await detectShellGlobExpansion(['/path/to/one'])).toBeUndefined();
  });

  it('returns undefined when args have different parent directories', async () => {
    expect(await detectShellGlobExpansion(['/dir1/a', '/dir2/b'])).toBeUndefined();
  });

  it('returns parent/* when args match the directory entries', async () => {
    const parentDir = path.join(tmpDir, 'worktrees');
    await fsp.mkdir(parentDir, { recursive: true });
    await fsp.mkdir(path.join(parentDir, 'tsk0001'));
    await fsp.mkdir(path.join(parentDir, 'tsk0002'));
    await fsp.mkdir(path.join(parentDir, 'tsk0003'));

    const args = [
      path.join(parentDir, 'tsk0001'),
      path.join(parentDir, 'tsk0002'),
      path.join(parentDir, 'tsk0003'),
    ];
    const detected = await detectShellGlobExpansion(args);
    expect(detected).toBe(path.join(parentDir, '*'));
  });

  it('returns undefined when args do not match all entries in directory', async () => {
    const parentDir = path.join(tmpDir, 'worktrees');
    await fsp.mkdir(parentDir, { recursive: true });
    await fsp.mkdir(path.join(parentDir, 'tsk0001'));
    await fsp.mkdir(path.join(parentDir, 'tsk0002'));
    await fsp.mkdir(path.join(parentDir, 'tsk0003'));

    const args = [path.join(parentDir, 'tsk0001'), path.join(parentDir, 'tsk0002')];
    const detected = await detectShellGlobExpansion(args);
    expect(detected).toBeUndefined();
  });

  it('returns undefined when parent directory does not exist', async () => {
    const args = ['/nonexistent/dir/a', '/nonexistent/dir/b'];
    expect(await detectShellGlobExpansion(args)).toBeUndefined();
  });
});

describe('workdirMatches', () => {
  it('matches exact paths after normalization', () => {
    expect(workdirMatches('/home/user/project', ['/home/user/project'])).toBe(true);
  });

  it('matches despite trailing slash differences', () => {
    expect(workdirMatches('/home/user/project/', ['/home/user/project'])).toBe(true);
  });

  it('does not match unrelated paths', () => {
    expect(workdirMatches('/home/user/other', ['/home/user/project'])).toBe(false);
  });

  it('matches glob patterns with *', () => {
    expect(workdirMatches('/home/user/worktrees/feature-a', ['/home/user/worktrees/*'])).toBe(true);
  });

  it('matches nested subdirectories for wildcard patterns like SQL LIKE', () => {
    expect(
      workdirMatches('/home/user/worktrees/feature-a/sub/folder', ['/home/user/worktrees/*']),
    ).toBe(true);
  });

  it('matches paths containing dashes (e.g. tsk0049-e2e) with wildcards', () => {
    expect(workdirMatches('/home/user/worktrees/tsk0049-e2e', ['/home/user/worktrees/*'])).toBe(
      true,
    );
    expect(
      workdirMatches('/home/user/worktrees/tsk0049-e2e/nested/folder', ['/home/user/worktrees/*']),
    ).toBe(true);
  });

  it('does not match glob patterns to non-matching paths', () => {
    expect(workdirMatches('/home/user/other', ['/home/user/worktrees/*'])).toBe(false);
  });

  it('matches against multiple patterns', () => {
    const patterns = ['/home/user/project-a', '/home/user/worktrees/*'];
    expect(workdirMatches('/home/user/project-a', patterns)).toBe(true);
    expect(workdirMatches('/home/user/worktrees/feat', patterns)).toBe(true);
    expect(workdirMatches('/home/user/project-b', patterns)).toBe(false);
  });
});

describe('workdirConfigPath / readWorkdirConfig / writeWorkdirConfig', () => {
  it('resolves the config path under <dataDir>/projects/<projectId>/config.json', () => {
    expect(workdirConfigPath('/data', 'proj-1')).toBe(
      path.join('/data', 'projects', 'proj-1', 'config.json'),
    );
  });

  it('returns an empty config when the file does not exist', async () => {
    const config = await readWorkdirConfig(tmpDir, 'proj-missing');
    expect(config).toEqual({ workdirs: [] });
  });

  it('returns an empty config when the file is malformed JSON', async () => {
    const configPath = workdirConfigPath(tmpDir, 'proj-bad');
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, 'not json', 'utf8');
    const config = await readWorkdirConfig(tmpDir, 'proj-bad');
    expect(config).toEqual({ workdirs: [] });
  });

  it('returns an empty config when workdirs is not an array', async () => {
    const configPath = workdirConfigPath(tmpDir, 'proj-noarray');
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, JSON.stringify({ workdirs: 'not-array' }), 'utf8');
    const config = await readWorkdirConfig(tmpDir, 'proj-noarray');
    expect(config).toEqual({ workdirs: [] });
  });

  it('filters non-string entries from workdirs', async () => {
    const configPath = workdirConfigPath(tmpDir, 'proj-mixed');
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(
      configPath,
      JSON.stringify({ workdirs: ['/valid', 123, null, '/also-valid'] }),
      'utf8',
    );
    const config = await readWorkdirConfig(tmpDir, 'proj-mixed');
    expect(config.workdirs).toEqual(['/valid', '/also-valid']);
  });

  it('writes and reads back a config', async () => {
    await writeWorkdirConfig(tmpDir, 'proj-1', { workdirs: ['/path/a', '/path/b'] });
    const config = await readWorkdirConfig(tmpDir, 'proj-1');
    expect(config.workdirs).toEqual(['/path/a', '/path/b']);
  });

  it('creates parent directories as needed', async () => {
    const deepDir = path.join(tmpDir, 'deep', 'nested');
    await writeWorkdirConfig(deepDir, 'proj-1', { workdirs: ['/path/a'] });
    const config = await readWorkdirConfig(deepDir, 'proj-1');
    expect(config.workdirs).toEqual(['/path/a']);
  });
});

describe('runWorkdirCommand', () => {
  const baseEnv = {
    SAL_PROJECT_ID: 'proj-test',
    SAL_STORAGE_TYPE: 's3',
    SAL_STORAGE_BUCKET: 'b',
    SAL_STORAGE_REGION: 'us-east-1',
    SAL_STORAGE_ACCESS_KEY_ID: 'k',
    SAL_STORAGE_SECRET_ACCESS_KEY: 's',
    SAL_DATA_DIR: '', // set per-test
  };

  beforeEach(() => {
    baseEnv.SAL_DATA_DIR = tmpDir;
  });

  it('prints help and exits 0 for --help', async () => {
    const { stream, lines } = writable();
    const code = await runWorkdirCommand(FIXTURE_ADAPTER, ['--help'], {
      env: baseEnv,
      stdout: stream,
    });
    expect(code).toBe(0);
    expect(lines.join('')).toContain('Usage: fixture-sync workdir');
  });

  it('exits 1 for an unknown subcommand', async () => {
    const { stream, lines } = writable();
    const code = await runWorkdirCommand(FIXTURE_ADAPTER, ['bogus'], {
      env: baseEnv,
      stderr: stream,
    });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('Unknown workdir subcommand: bogus');
  });

  it('exits 1 when SAL_PROJECT_ID is missing for add', async () => {
    const { stream, lines } = writable();
    const code = await runWorkdirCommand(FIXTURE_ADAPTER, ['add', '/path'], {
      env: { ...baseEnv, SAL_PROJECT_ID: undefined },
      stderr: stream,
    });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('SAL_PROJECT_ID is required');
  });

  it('adds a path argument to the config', async () => {
    const { stream, lines } = writable();
    const code = await runWorkdirCommand(FIXTURE_ADAPTER, ['add', '/abs/path'], {
      env: baseEnv,
      stdout: stream,
    });
    expect(code).toBe(0);
    expect(lines.join('')).toContain('Added: /abs/path');
    const config = await readWorkdirConfig(tmpDir, 'proj-test');
    expect(config.workdirs).toEqual(['/abs/path']);
  });

  it('resolves . to the cwd', async () => {
    const { stream } = writable();
    await runWorkdirCommand(FIXTURE_ADAPTER, ['add', '.'], {
      env: baseEnv,
      cwd: '/home/user/proj',
      stdout: stream,
    });
    const config = await readWorkdirConfig(tmpDir, 'proj-test');
    expect(config.workdirs).toEqual(['/home/user/proj']);
  });

  it('resolves ~ to the home directory', async () => {
    const { stream } = writable();
    await runWorkdirCommand(FIXTURE_ADAPTER, ['add', '~/work'], {
      env: baseEnv,
      cwd: '/cwd',
      stdout: stream,
    });
    const config = await readWorkdirConfig(tmpDir, 'proj-test');
    expect(config.workdirs).toEqual([path.join(os.homedir(), 'work')]);
  });

  it('does not add duplicates', async () => {
    await writeWorkdirConfig(tmpDir, 'proj-test', { workdirs: ['/path/a'] });
    const { stream, lines } = writable();
    await runWorkdirCommand(FIXTURE_ADAPTER, ['add', '/path/a'], {
      env: baseEnv,
      stdout: stream,
    });
    expect(lines.join('')).toContain('Already configured: /path/a');
    const config = await readWorkdirConfig(tmpDir, 'proj-test');
    expect(config.workdirs).toEqual(['/path/a']);
  });

  it('preserves existing entries when adding a new one', async () => {
    await writeWorkdirConfig(tmpDir, 'proj-test', { workdirs: ['/path/a'] });
    const { stream } = writable();
    await runWorkdirCommand(FIXTURE_ADAPTER, ['add', '/path/b'], {
      env: baseEnv,
      stdout: stream,
    });
    const config = await readWorkdirConfig(tmpDir, 'proj-test');
    expect(config.workdirs).toEqual(['/path/a', '/path/b']);
  });

  it('adds glob patterns as-is', async () => {
    const { stream } = writable();
    await runWorkdirCommand(FIXTURE_ADAPTER, ['add', '/worktrees/*'], {
      env: baseEnv,
      stdout: stream,
    });
    const config = await readWorkdirConfig(tmpDir, 'proj-test');
    expect(config.workdirs).toEqual(['/worktrees/*']);
  });

  it('removes a path from the config', async () => {
    await writeWorkdirConfig(tmpDir, 'proj-test', { workdirs: ['/path/a', '/path/b'] });
    const { stream, lines } = writable();
    const code = await runWorkdirCommand(FIXTURE_ADAPTER, ['remove', '/path/a'], {
      env: baseEnv,
      stdout: stream,
    });
    expect(code).toBe(0);
    expect(lines.join('')).toContain('Removed 1 working directory pattern(s)');
    const config = await readWorkdirConfig(tmpDir, 'proj-test');
    expect(config.workdirs).toEqual(['/path/b']);
  });

  it('reports when remove finds no match', async () => {
    await writeWorkdirConfig(tmpDir, 'proj-test', { workdirs: ['/path/a'] });
    const { stream, lines } = writable();
    const code = await runWorkdirCommand(FIXTURE_ADAPTER, ['remove', '/path/x'], {
      env: baseEnv,
      stdout: stream,
    });
    expect(code).toBe(0);
    expect(lines.join('')).toContain('No matching working directories found');
  });

  it('list shows configured workdirs when no listAvailableWorkdirs is defined', async () => {
    await writeWorkdirConfig(tmpDir, 'proj-test', { workdirs: ['/path/a', '/worktrees/*'] });
    const { stream, lines } = writable();
    const code = await runWorkdirCommand(FIXTURE_ADAPTER, ['list'], {
      env: baseEnv,
      stdout: stream,
    });
    expect(code).toBe(0);
    const out = lines.join('');
    expect(out).toContain('/path/a');
    expect(out).toContain('/worktrees/*');
  });

  it('list shows available workdirs from the adapter when defined', async () => {
    const adapter: CliHarnessAdapter = {
      ...FIXTURE_ADAPTER,
      listAvailableWorkdirs: async () => ['/sessions/a', '/sessions/b'],
    };
    await writeWorkdirConfig(tmpDir, 'proj-test', { workdirs: ['/sessions/a'] });
    const { stream, lines } = writable();
    const code = await runWorkdirCommand(adapter, ['list'], {
      env: baseEnv,
      stdout: stream,
    });
    expect(code).toBe(0);
    const out = lines.join('');
    expect(out).toContain('/sessions/a [configured]');
    expect(out).toContain('/sessions/b');
  });

  it('list handles errors from listAvailableWorkdirs gracefully', async () => {
    const adapter: CliHarnessAdapter = {
      ...FIXTURE_ADAPTER,
      listAvailableWorkdirs: async () => {
        throw new Error('db locked');
      },
    };
    const { stream, lines } = writable();
    const code = await runWorkdirCommand(adapter, ['list'], {
      env: baseEnv,
      stdout: stream,
    });
    expect(code).toBe(0);
    expect(lines.join('')).toContain('could not read session store: db locked');
  });

  it('add without a path exits 1 when adapter has no listAvailableWorkdirs', async () => {
    const { stream, lines } = writable();
    const code = await runWorkdirCommand(FIXTURE_ADAPTER, ['add'], {
      env: baseEnv,
      stderr: stream,
    });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('interactive workdir selection requires a session store');
  });

  it('add without a path reports no workdirs when session store is empty', async () => {
    const adapter: CliHarnessAdapter = {
      ...FIXTURE_ADAPTER,
      listAvailableWorkdirs: async () => [],
    };
    const { stream, lines } = writable();
    const code = await runWorkdirCommand(adapter, ['add'], {
      env: baseEnv,
      stdout: stream,
    });
    expect(code).toBe(0);
    expect(lines.join('')).toContain('No working directories found in the session store');
  });

  it('add collapses shell-expanded sibling arguments into a single wildcard pattern', async () => {
    const parentDir = path.join(tmpDir, 'worktrees');
    await fsp.mkdir(parentDir, { recursive: true });
    await fsp.mkdir(path.join(parentDir, 'tsk0001'));
    await fsp.mkdir(path.join(parentDir, 'tsk0002'));

    const { stream, lines } = writable();
    const code = await runWorkdirCommand(
      FIXTURE_ADAPTER,
      ['add', path.join(parentDir, 'tsk0001'), path.join(parentDir, 'tsk0002')],
      {
        env: baseEnv,
        stdout: stream,
      },
    );
    expect(code).toBe(0);
    const expectedPattern = path.join(parentDir, '*');
    expect(lines.join('')).toContain(
      `Detected shell glob expansion; storing wildcard pattern: '${expectedPattern}'`,
    );
    expect(lines.join('')).toContain(`Added: ${expectedPattern}`);
    const config = await readWorkdirConfig(tmpDir, 'proj-test');
    expect(config.workdirs).toEqual([expectedPattern]);
  });

  it('remove collapses shell-expanded sibling arguments into a single wildcard pattern', async () => {
    const parentDir = path.join(tmpDir, 'worktrees');
    await fsp.mkdir(parentDir, { recursive: true });
    await fsp.mkdir(path.join(parentDir, 'tsk0001'));
    await fsp.mkdir(path.join(parentDir, 'tsk0002'));
    const expectedPattern = path.join(parentDir, '*');
    await writeWorkdirConfig(tmpDir, 'proj-test', { workdirs: [expectedPattern] });

    const { stream, lines } = writable();
    const code = await runWorkdirCommand(
      FIXTURE_ADAPTER,
      ['remove', path.join(parentDir, 'tsk0001'), path.join(parentDir, 'tsk0002')],
      {
        env: baseEnv,
        stdout: stream,
      },
    );
    expect(code).toBe(0);
    expect(lines.join('')).toContain('Removed 1 working directory pattern(s)');
    const config = await readWorkdirConfig(tmpDir, 'proj-test');
    expect(config.workdirs).toEqual([]);
  });

  it('list marks available workdirs matching a wildcard as [configured] and suppresses pattern from missing', async () => {
    const adapter: CliHarnessAdapter = {
      ...FIXTURE_ADAPTER,
      listAvailableWorkdirs: async () => ['/worktrees/tsk0001/sub', '/unrelated/path'],
    };
    await writeWorkdirConfig(tmpDir, 'proj-test', { workdirs: ['/worktrees/*'] });
    const { stream, lines } = writable();
    const code = await runWorkdirCommand(adapter, ['list'], {
      env: baseEnv,
      stdout: stream,
    });
    expect(code).toBe(0);
    const out = lines.join('');
    expect(out).toContain('/worktrees/tsk0001/sub [configured]');
    expect(out).toContain('/unrelated/path');
    expect(out).not.toContain('Configured patterns not in session store:');
  });
});
