import type {
  ListObjectEntry,
  PutObjectInput,
  PutObjectResult,
  StorageAdapter,
} from '@lucasschirm/sal-sync-core';
import { describe, expect, it, vi } from 'vitest';

import {
  parseMigrateArgs,
  runMigrateCommand,
} from '../../../../src/cli/commands/migrate-command.js';
import type { CliHarnessAdapter } from '../../../../src/cli/harness-adapter.js';

function makeFixtureAdapter(overrides: Partial<CliHarnessAdapter>): CliHarnessAdapter {
  return {
    profile: {
      // Deliberately DIFFERENT from migrateManifestHarness below, in both
      // fixtures — this is the exact shape of the real Claude asymmetry
      // ('claude' profile.harness vs 'claude-code' migrateManifestHarness).
      // If `runMigrateCommand`/`buildManifestForSession` ever derived
      // `harness` from `profile.harness` instead of
      // `adapter.migrateManifestHarness`, these tests would fail.
      harness: 'profile-harness-should-never-appear',
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
    migrateManifestHarness: 'fixture-migrate-harness',
    helpText: '',
    ...overrides,
  };
}

const CLAUDE_LIKE_ADAPTER = makeFixtureAdapter({ migrateManifestHarness: 'claude-code' });
const DEVIN_LIKE_ADAPTER = makeFixtureAdapter({ migrateManifestHarness: 'devin' });

const validEnv = {
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
  };
}

function makeAdapterWithMissingManifest(objects: ListObjectEntry[]): {
  adapter: StorageAdapter;
  puts: PutObjectInput[];
} {
  const bodies = new Map<string, Uint8Array>();
  for (const obj of objects) {
    bodies.set(obj.key, new TextEncoder().encode(`content-for-${obj.key}`));
  }
  const puts: PutObjectInput[] = [];
  const adapter: StorageAdapter = {
    putObject: vi.fn(async (input: PutObjectInput): Promise<PutObjectResult> => {
      puts.push(input);
      return { key: 'mock-key', sha256: 'x' };
    }),
    getObject: vi.fn(async (input) => {
      const key = `${input.projectId}/${input.sessionId}/${input.relativePath}`;
      const body = bodies.get(key);
      return body ? { body } : undefined;
    }),
    headObject: vi.fn(async () => undefined),
    listObjects: vi.fn().mockResolvedValue({ objects }),
  };
  return { adapter, puts };
}

describe('parseMigrateArgs', () => {
  it('parses --yes --manifests', () => {
    expect(parseMigrateArgs(['--yes', '--manifests'])).toEqual({
      projectId: undefined,
      confirmed: true,
      deleteOld: false,
      manifests: true,
    });
  });
});

describe.each([
  { label: 'claude-like adapter', adapter: CLAUDE_LIKE_ADAPTER, expectedHarness: 'claude-code' },
  { label: 'devin-like adapter', adapter: DEVIN_LIKE_ADAPTER, expectedHarness: 'devin' },
])(
  'runMigrateCommand backfills manifest.harness from adapter.migrateManifestHarness: $label',
  ({ adapter, expectedHarness }) => {
    it(`writes harness="${expectedHarness}", never the profile.harness literal`, async () => {
      const objects: ListObjectEntry[] = [{ key: 'proj-1/sess-a/transcript.jsonl', size: 100 }];
      const { adapter: storageAdapter, puts } = makeAdapterWithMissingManifest(objects);
      const io = makeStdio();

      const result = await runMigrateCommand(adapter, ['--yes'], {
        env: validEnv,
        storageAdapter,
        ...io,
      });

      expect(result).toBe(0);
      const manifestPut = puts.find((p) => p.scope === 'manifest');
      if (!manifestPut) throw new Error('expected a manifest put');
      const body = JSON.parse(new TextDecoder().decode(manifestPut.body as Uint8Array));
      expect(body.harness).toBe(expectedHarness);
      expect(body.harness).not.toBe('profile-harness-should-never-appear');
    });
  },
);

describe('runMigrateCommand', () => {
  it('reports nothing to migrate for a clean bucket', async () => {
    const adapter: StorageAdapter = {
      putObject: vi.fn(),
      listObjects: vi.fn().mockResolvedValue({ objects: [] }),
    };
    const io = makeStdio();
    const result = await runMigrateCommand(CLAUDE_LIKE_ADAPTER, [], {
      env: validEnv,
      storageAdapter: adapter,
      ...io,
    });
    expect(result).toBe(0);
    expect(io.stdoutStr()).toContain('Nothing to migrate');
  });
});
