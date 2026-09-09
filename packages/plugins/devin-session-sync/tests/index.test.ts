import { describe, expect, it } from 'vitest';
import * as pkg from '../src/index.js';

describe('package barrel exports', () => {
  it('re-exports the plugin, CLI, and extractor public surface', () => {
    expect(pkg.DEVIN_HARNESS).toBe('devin');
    expect(pkg.DevinHarnessProfile).toBeDefined();
    expect(typeof pkg.parseDevinHookInput).toBe('function');
    expect(typeof pkg.resolveCliEnv).toBe('function');
    expect(typeof pkg.runSyncCommand).toBe('function');
    expect(typeof pkg.runListCommand).toBe('function');
    expect(typeof pkg.runDownloadCommand).toBe('function');
    expect(typeof pkg.runRemoveCommand).toBe('function');
    expect(typeof pkg.runMigrateCommand).toBe('function');
    expect(typeof pkg.listDevinSessions).toBe('function');
    expect(typeof pkg.cliMain).toBe('function');
    expect(typeof pkg.runHook).toBe('function');
    expect(typeof pkg.runDevinHookSync).toBe('function');
    expect(typeof pkg.runSessionEnd).toBe('function');
    expect(typeof pkg.runSessionStart).toBe('function');
    expect(typeof pkg.runDevinSessionSync).toBe('function');
    expect(typeof pkg.runDevinWatcher).toBe('function');
    expect(typeof pkg.computeSessionWatermarkSignature).toBe('function');
    expect(typeof pkg.buildDevinJsonl).toBe('function');
    expect(typeof pkg.resolveDevinPaths).toBe('function');
    expect(typeof pkg.openDevinDatabase).toBe('function');
    expect(typeof pkg.resolveDevinSchema).toBe('function');
    expect(pkg.EMPTY_WATERMARKS).toBeDefined();
    expect(typeof pkg.readDevinSnapshot).toBe('function');
  });
});
