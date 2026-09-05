import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCliMain } from '../../../src/cli/create-cli.js';
import type { CliHarnessAdapter } from '../../../src/cli/harness-adapter.js';

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

function makeCommands() {
  return {
    runSyncCommand: vi.fn().mockResolvedValue(0),
    runListCommand: vi.fn().mockResolvedValue(0),
    runDownloadCommand: vi.fn().mockResolvedValue(0),
    runRemoveCommand: vi.fn().mockResolvedValue(0),
    runMigrateCommand: vi.fn().mockResolvedValue(0),
  };
}

describe('createCliMain', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('prints the adapter help text and exits 0 for no args, -h, and --help', async () => {
    const main = createCliMain(FIXTURE_ADAPTER, makeCommands(), () => '1.2.3');
    for (const argv of [[], ['-h'], ['--help']]) {
      const code = await main(argv);
      expect(code).toBe(0);
    }
    expect(stdoutSpy.mock.calls.some((c) => c[0] === FIXTURE_ADAPTER.helpText)).toBe(true);
  });

  it('prints the resolved version and exits 0 for -v/--version', async () => {
    const main = createCliMain(FIXTURE_ADAPTER, makeCommands(), () => '9.9.9');
    const code = await main(['--version']);
    expect(code).toBe(0);
    expect(stdoutSpy.mock.calls.some((c) => c[0] === '9.9.9\n')).toBe(true);
  });

  it('dispatches sync with the parsed --force flag', async () => {
    const commands = makeCommands();
    const main = createCliMain(FIXTURE_ADAPTER, commands, () => '1.0.0');
    await main(['sync', '--force']);
    expect(commands.runSyncCommand).toHaveBeenCalledWith({ force: true });
  });

  it('dispatches list/download/remove/migrate to the matching command runner', async () => {
    const commands = makeCommands();
    const main = createCliMain(FIXTURE_ADAPTER, commands, () => '1.0.0');
    await main(['list', 'proj-1']);
    await main(['download', '--session-id=x']);
    await main(['remove', 'proj-1']);
    await main(['migrate', '--yes']);
    expect(commands.runListCommand).toHaveBeenCalledWith(['proj-1']);
    expect(commands.runDownloadCommand).toHaveBeenCalledWith(['--session-id=x']);
    expect(commands.runRemoveCommand).toHaveBeenCalledWith(['proj-1']);
    expect(commands.runMigrateCommand).toHaveBeenCalledWith(['--yes']);
  });

  it('prints "Unknown command" plus help text and exits 1 for an unrecognized command', async () => {
    const main = createCliMain(FIXTURE_ADAPTER, makeCommands(), () => '1.0.0');
    const code = await main(['bogus']);
    expect(code).toBe(1);
    const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(stderrOutput).toContain('Unknown command: bogus');
    expect(stderrOutput).toContain(FIXTURE_ADAPTER.helpText);
  });
});
