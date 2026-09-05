import type { ListObjectsResult, StorageAdapter } from '@lucasschirm/sal-sync-core';
import { describe, expect, it } from 'vitest';

import { parseListArgs, runListCommand } from '../../../../src/cli/commands/list-command.js';
import type { CliHarnessAdapter } from '../../../../src/cli/harness-adapter.js';

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
  helpText: '',
};

const validEnv = {
  SAL_PROJECT_ID: 'proj-1',
  SAL_STORAGE_TYPE: 's3',
  SAL_STORAGE_BUCKET: 'my-bucket',
  SAL_STORAGE_REGION: 'us-east-1',
  SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  SAL_STORAGE_SECRET_ACCESS_KEY: 'secret',
};

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

function makeAdapter(result: ListObjectsResult): StorageAdapter {
  return {
    putObject: async () => ({ key: 'x', sha256: 'x' }),
    listObjects: async () => result,
  };
}

describe('parseListArgs', () => {
  it('parses bare list as all-projects', () => {
    expect(parseListArgs([])).toEqual({ mode: 'all-projects' });
  });

  it('rejects --path without --session', () => {
    expect('error' in parseListArgs(['proj-1', '--path=x'])).toBe(true);
  });
});

describe('runListCommand', () => {
  it('lists all projects', async () => {
    const io = makeStdio();
    const result = await runListCommand(FIXTURE_ADAPTER, [], {
      env: validEnv,
      storageAdapter: makeAdapter({
        objects: [
          { key: 'proj-1/sess-a/manifest.json', size: 10 },
          { key: 'proj-2/sess-b/manifest.json', size: 20 },
        ],
      }),
      ...io,
    });
    expect(result).toBe(0);
    expect(io.stdoutStr()).toContain('proj-1');
    expect(io.stdoutStr()).toContain('proj-2');
    expect(io.stdoutStr()).toContain('2 project(s), 2 files');
  });

  it('lists sessions for a project', async () => {
    const io = makeStdio();
    const result = await runListCommand(FIXTURE_ADAPTER, ['proj-1'], {
      env: validEnv,
      storageAdapter: makeAdapter({
        objects: [
          { key: 'proj-1/sess-a/manifest.json', size: 10 },
          { key: 'proj-1/sess-b/manifest.json', size: 20 },
        ],
      }),
      ...io,
    });
    expect(result).toBe(0);
    expect(io.stdoutStr()).toContain('sess-a');
    expect(io.stdoutStr()).toContain('sess-b');
    expect(io.stdoutStr()).toContain('2 session(s), 2 files');
  });

  it('requires SAL_PROJECT_ID for --current', async () => {
    const io = makeStdio();
    const result = await runListCommand(FIXTURE_ADAPTER, ['--current'], {
      env: { ...validEnv, SAL_PROJECT_ID: '' },
      storageAdapter: makeAdapter({ objects: [] }),
      ...io,
    });
    expect(result).toBe(1);
    expect(io.stderrStr()).toContain('SAL_PROJECT_ID');
  });

  it('fails when storage config is missing', async () => {
    const io = makeStdio();
    const result = await runListCommand(FIXTURE_ADAPTER, ['proj-1'], { env: {}, ...io });
    expect(result).toBe(1);
    expect(io.stderrStr()).toContain('SAL_STORAGE_TYPE');
  });

  it('filters session files by --path non-recursively', async () => {
    const io = makeStdio();
    const result = await runListCommand(
      FIXTURE_ADAPTER,
      ['proj-1', '--session=sess-a', '--path=subagents'],
      {
        env: validEnv,
        storageAdapter: makeAdapter({
          objects: [
            { key: 'proj-1/sess-a/manifest.json', size: 1 },
            { key: 'proj-1/sess-a/subagents/agent-x.jsonl', size: 2 },
          ],
        }),
        ...io,
      },
    );
    expect(result).toBe(0);
    expect(io.stdoutStr()).toContain('agent-x.jsonl');
    expect(io.stdoutStr()).not.toContain('manifest.json');
  });
});
