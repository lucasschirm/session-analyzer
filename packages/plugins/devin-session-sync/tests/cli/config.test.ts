import { describe, expect, it } from 'vitest';
import { validateCliConfig, validateStorageConfig } from '../../src/cli/config.js';

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
    const result = validateCliConfig(FULL_ENV, '/tmp/proj');
    expect(result.ok).toBe(true);
    expect(result.config?.projectId).toBe('proj-1');
  });

  it('reports every missing required variable with an actionable message', () => {
    const result = validateCliConfig({}, '/tmp/my-project');
    expect(result.ok).toBe(false);
    expect(result.missing?.map((m) => m.name)).toContain('SAL_PROJECT_ID');
    expect(result.errorMessage).toContain('my-project');
    expect(result.errorMessage).toContain('@lucasschirm/devin-session-sync sync');
  });

  it('surfaces a value-validation error from loadConfig', () => {
    const result = validateCliConfig({ ...FULL_ENV, SAL_PROJECT_ID: 'Not Valid!' }, '/tmp');
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toBeDefined();
  });
});

describe('validateStorageConfig', () => {
  it('succeeds without requiring SAL_PROJECT_ID', () => {
    const { SAL_PROJECT_ID: _unused, ...storageOnly } = FULL_ENV;
    const result = validateStorageConfig(storageOnly);
    expect(result.ok).toBe(true);
  });

  it('reports missing storage variables', () => {
    const result = validateStorageConfig({});
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain('@lucasschirm/devin-session-sync list');
  });

  it('surfaces a value-validation error from loadStorageConfig', () => {
    const { SAL_PROJECT_ID: _unused, ...storageOnly } = FULL_ENV;
    const result = validateStorageConfig({ ...storageOnly, SAL_STORAGE_TYPE: 'not-a-real-type' });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toBeDefined();
  });
});
