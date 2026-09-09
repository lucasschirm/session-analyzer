import { describe, expect, it } from 'vitest';

import { validateCliConfig, validateStorageConfig } from '../../../src/cli/config.js';
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
  helpText: '',
};

const FULL_ENV = {
  SAL_PROJECT_ID: 'proj-1',
  SAL_STORAGE_TYPE: 's3',
  SAL_STORAGE_BUCKET: 'my-bucket',
  SAL_STORAGE_REGION: 'us-east-1',
  SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  SAL_STORAGE_SECRET_ACCESS_KEY: 'secret',
};

describe('validateCliConfig', () => {
  it('succeeds with a fully populated environment', () => {
    const result = validateCliConfig(FIXTURE_ADAPTER, FULL_ENV, '/tmp/proj');
    expect(result.ok).toBe(true);
    expect(result.config?.projectId).toBe('proj-1');
  });

  it('reports every missing required variable, using the adapter package name and local config path', () => {
    const result = validateCliConfig(FIXTURE_ADAPTER, {}, '/tmp/my-project');
    expect(result.ok).toBe(false);
    expect(result.missing?.map((m) => m.name)).toContain('SAL_PROJECT_ID');
    expect(result.errorMessage).toContain('my-project');
    expect(result.errorMessage).toContain(
      'Error: required configuration is missing or incomplete.',
    );
    // packageName and localConfigDisplayPath must come from the adapter, not
    // a hardcoded literal — this is what makes the function reusable across
    // harnesses.
    expect(result.errorMessage).toContain('npx @fixture/harness-sync sync');
    expect(result.errorMessage).toContain('.fixture/settings.local.json');
  });

  it('always shows "sync" as the example command, never the actually-invoked command', () => {
    // `validateCliConfig` is called from non-`sync` commands too (e.g.
    // `download`), but its error text has always hardcoded the `sync`
    // example — devin-session-sync's pre-hoist `command` parameter was a
    // half-finished generalization, always invoked with the literal
    // `'sync'`. Deliberately NOT wired to the real command as part of this
    // hoist (#354) — this test pins that deferral.
    const result = validateCliConfig(FIXTURE_ADAPTER, {}, '/tmp/proj');
    expect(result.errorMessage).toContain('npx @fixture/harness-sync sync');
    expect(result.errorMessage).not.toContain('npx @fixture/harness-sync download');
  });

  it('surfaces a value-validation error from loadConfig', () => {
    const result = validateCliConfig(
      FIXTURE_ADAPTER,
      { ...FULL_ENV, SAL_PROJECT_ID: 'Not Valid!' },
      '/tmp',
    );
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toBeDefined();
  });
});

describe('validateStorageConfig', () => {
  it('succeeds without requiring SAL_PROJECT_ID', () => {
    const { SAL_PROJECT_ID: _unused, ...storageOnly } = FULL_ENV;
    const result = validateStorageConfig(FIXTURE_ADAPTER, storageOnly);
    expect(result.ok).toBe(true);
  });

  it('reports missing storage variables using the adapter package name', () => {
    const result = validateStorageConfig(FIXTURE_ADAPTER, {});
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain('npx @fixture/harness-sync list');
    expect(result.errorMessage).toContain('.fixture/settings.local.json');
  });

  it('surfaces a value-validation error from loadStorageConfig', () => {
    const { SAL_PROJECT_ID: _unused, ...storageOnly } = FULL_ENV;
    const result = validateStorageConfig(FIXTURE_ADAPTER, {
      ...storageOnly,
      SAL_STORAGE_TYPE: 'not-a-real-type',
    });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toBeDefined();
  });
});
