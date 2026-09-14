import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';

describe('devin-sync CLI dispatch', () => {
  // The dispatch tests below expect config validation to fail once SAL_* is
  // stripped from process.env — but `resolveCliEnv` also reads the user-global
  // `~/.config/devin/config.json` (a trusted tier for Devin). Point
  // `os.homedir()` at a scratch dir so a real machine config cannot leak in.
  let tmpHome: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-cli-home-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  });

  afterEach(async () => {
    homedirSpy.mockRestore();
    await fsp.rm(tmpHome, { recursive: true, force: true });
  });

  it('prints help for no arguments', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await main([]);
    expect(code).toBe(0);
    expect(write).toHaveBeenCalled();
    const output = write.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('devin-sync');
    expect(output).toContain('sync');
    expect(output).toContain('list');
    expect(output).toContain('download');
    expect(output).toContain('remove');
    expect(output).toContain('migrate');
    write.mockRestore();
  });

  it('prints help for -h/--help', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await main(['-h'])).toBe(0);
    expect(await main(['--help'])).toBe(0);
    write.mockRestore();
  });

  it('prints a version for -v/--version', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await main(['-v']);
    expect(code).toBe(0);
    expect(write).toHaveBeenCalledWith(expect.stringMatching(/\S/));
    write.mockRestore();
  });

  it('reports an unknown command on stderr and exits 1', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await main(['bogus-command']);
    expect(code).toBe(1);
    expect(write.mock.calls.some((c) => String(c[0]).includes('Unknown command'))).toBe(true);
    write.mockRestore();
  });

  it('dispatches `list` to runListCommand (config-error path exits 1)', async () => {
    const originalEnv = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('SAL_')) delete process.env[key];
    }
    const code = await main(['list']);
    expect(code).toBe(1);
    process.env = originalEnv;
  });

  async function withoutSalEnv(argv: string[]): Promise<number> {
    const originalEnv = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('SAL_')) delete process.env[key];
    }
    try {
      return await main(argv);
    } finally {
      process.env = originalEnv;
    }
  }

  it('dispatches `sync --force` to runSyncCommand', async () => {
    expect(await withoutSalEnv(['sync', '--force'])).toBe(1);
  });

  it('dispatches `download` to runDownloadCommand', async () => {
    expect(await withoutSalEnv(['download'])).toBe(1);
  });

  it('dispatches `remove` to runRemoveCommand', async () => {
    expect(await withoutSalEnv(['remove'])).toBe(1);
  });

  it('dispatches `migrate` to runMigrateCommand', async () => {
    expect(await withoutSalEnv(['migrate'])).toBe(1);
  });
});
