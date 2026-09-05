import { CAS_NAMESPACE_ROOT, type StorageAdapter } from '@lucasschirm/sal-sync-core';
import { describe, expect, it, vi } from 'vitest';

import { parseRemoveArgs, runRemoveCommand } from '../../../../src/cli/commands/remove-command.js';
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

describe('parseRemoveArgs', () => {
  it('rejects the reserved CAS namespace root', () => {
    const result = parseRemoveArgs([CAS_NAMESPACE_ROOT]);
    expect('error' in result).toBe(true);
  });
});

describe('runRemoveCommand', () => {
  it('performs a dry run listing objects without deleting when --yes is absent', async () => {
    const adapter: StorageAdapter = {
      putObject: vi.fn(),
      listObjects: vi.fn().mockResolvedValue({ objects: [{ key: 'proj-1/sess-a/x.json' }] }),
      deleteObjects: vi.fn(),
    };
    const io = makeStdio();
    const result = await runRemoveCommand(FIXTURE_ADAPTER, ['proj-1'], {
      storageAdapter: adapter,
      ...io,
    });
    expect(result).toBe(0);
    expect(io.stdoutStr()).toContain('Dry run');
    expect(adapter.deleteObjects).not.toHaveBeenCalled();
  });

  it('deletes objects when --yes is passed', async () => {
    const adapter: StorageAdapter = {
      putObject: vi.fn(),
      listObjects: vi.fn().mockResolvedValue({ objects: [{ key: 'proj-1/sess-a/x.json' }] }),
      deleteObjects: vi
        .fn()
        .mockResolvedValue({ deletedKeys: ['proj-1/sess-a/x.json'], errors: [] }),
    };
    const io = makeStdio();
    const result = await runRemoveCommand(FIXTURE_ADAPTER, ['proj-1', '--yes'], {
      storageAdapter: adapter,
      ...io,
    });
    expect(result).toBe(0);
    expect(io.stdoutStr()).toContain('Deleted 1 object(s)');
  });

  it('surfaces a config error using the adapter when no storage adapter is injected', async () => {
    const io = makeStdio();
    const result = await runRemoveCommand(FIXTURE_ADAPTER, ['proj-1'], { env: {}, ...io });
    expect(result).toBe(1);
    expect(io.stderrStr()).toContain('required storage configuration is missing');
  });
});
