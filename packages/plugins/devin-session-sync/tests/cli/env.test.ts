/**
 * Dedicated tests for `resolveCliEnv` (`src/cli/env.ts`), mirroring
 * `claude-session-sync`'s exhaustive `env.test.ts` — this is the same
 * regression-prone security blocklist pattern (see that package's
 * `src/cli/AGENTS.md`), reimplemented here for the Devin config-file
 * precedence ladder.
 */
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveCliEnv } from '../../src/cli/env.js';

const BLOCKED_KEYS = [
  'SAL_STORAGE_ENDPOINT',
  'SAL_STORAGE_ACCESS_KEY_ID',
  'SAL_STORAGE_SECRET_ACCESS_KEY',
] as const;

const SAFE_KEY = 'SAL_STORAGE_BUCKET';

describe('resolveCliEnv', () => {
  let tmpCwd: string;
  let tmpHome: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpCwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-env-cwd-'));
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-env-home-'));
    await fsp.mkdir(path.join(tmpCwd, '.devin'), { recursive: true });
    await fsp.mkdir(path.join(tmpHome, '.config', 'devin'), { recursive: true });
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  });

  afterEach(async () => {
    homedirSpy.mockRestore();
    await fsp.rm(tmpCwd, { recursive: true, force: true });
    await fsp.rm(tmpHome, { recursive: true, force: true });
  });

  async function writeProjectConfig(filename: string, env: Record<string, unknown>): Promise<void> {
    await fsp.writeFile(path.join(tmpCwd, '.devin', filename), JSON.stringify({ env }));
  }

  async function writeUserConfig(env: Record<string, unknown>): Promise<void> {
    await fsp.writeFile(
      path.join(tmpHome, '.config', 'devin', 'config.json'),
      JSON.stringify({ env }),
    );
  }

  describe('precedence ladder', () => {
    it('process.env wins over all config files', async () => {
      await writeUserConfig({ SAL_PROJECT_ID: 'from-global' });
      await writeProjectConfig('config.json', { SAL_PROJECT_ID: 'from-project' });
      await writeProjectConfig('config.local.json', { SAL_PROJECT_ID: 'from-local' });

      const env = await resolveCliEnv(tmpCwd, { SAL_PROJECT_ID: 'from-env' });
      expect(env.SAL_PROJECT_ID).toBe('from-env');
    });

    it('.devin/config.local.json wins over .devin/config.json and the global config', async () => {
      await writeUserConfig({ SAL_PROJECT_ID: 'from-global' });
      await writeProjectConfig('config.json', { SAL_PROJECT_ID: 'from-project' });
      await writeProjectConfig('config.local.json', { SAL_PROJECT_ID: 'from-local' });

      const env = await resolveCliEnv(tmpCwd, {});
      expect(env.SAL_PROJECT_ID).toBe('from-local');
    });

    it('.devin/config.json wins over the global config', async () => {
      await writeUserConfig({ SAL_PROJECT_ID: 'from-global' });
      await writeProjectConfig('config.json', { SAL_PROJECT_ID: 'from-project' });

      const env = await resolveCliEnv(tmpCwd, {});
      expect(env.SAL_PROJECT_ID).toBe('from-project');
    });

    it('falls back to the global config when no project config exists', async () => {
      await writeUserConfig({ SAL_PROJECT_ID: 'from-global' });

      const env = await resolveCliEnv(tmpCwd, {});
      expect(env.SAL_PROJECT_ID).toBe('from-global');
    });

    it('accumulates non-overlapping keys across every source', async () => {
      await writeUserConfig({ SAL_STORAGE_REGION: 'us-east-1' });
      await writeProjectConfig('config.json', { SAL_PROJECT_ID: 'proj' });
      await writeProjectConfig('config.local.json', { SAL_STORAGE_BUCKET: 'my-bucket' });

      const env = await resolveCliEnv(tmpCwd, { SAL_SYNC_TIMEOUT: '5000' });
      expect(env).toMatchObject({
        SAL_STORAGE_REGION: 'us-east-1',
        SAL_PROJECT_ID: 'proj',
        SAL_STORAGE_BUCKET: 'my-bucket',
        SAL_SYNC_TIMEOUT: '5000',
      });
    });
  });

  describe('security blocklist', () => {
    for (const key of BLOCKED_KEYS) {
      it(`never reads ${key} from .devin/config.json even when present`, async () => {
        await writeProjectConfig('config.json', { [key]: 'malicious-value' });
        const env = await resolveCliEnv(tmpCwd, {});
        expect(env[key]).toBeUndefined();
      });

      it(`never reads ${key} from the global config even when present`, async () => {
        await writeUserConfig({ [key]: 'malicious-value' });
        const env = await resolveCliEnv(tmpCwd, {});
        expect(env[key]).toBeUndefined();
      });

      it(`honors ${key} from .devin/config.local.json (gitignored)`, async () => {
        await writeProjectConfig('config.local.json', { [key]: 'local-value' });
        const env = await resolveCliEnv(tmpCwd, {});
        expect(env[key]).toBe('local-value');
      });

      it(`honors ${key} from process.env`, async () => {
        const env = await resolveCliEnv(tmpCwd, { [key]: 'env-value' });
        expect(env[key]).toBe('env-value');
      });
    }

    it(`does not block ${SAFE_KEY} from a committed config file`, async () => {
      await writeProjectConfig('config.json', { [SAFE_KEY]: 'my-bucket' });
      const env = await resolveCliEnv(tmpCwd, {});
      expect(env[SAFE_KEY]).toBe('my-bucket');
    });

    it('applies a custom blocklist when explicitly provided', async () => {
      await writeProjectConfig('config.json', { [SAFE_KEY]: 'blocked-by-custom-list' });
      const env = await resolveCliEnv(tmpCwd, {}, [SAFE_KEY]);
      expect(env[SAFE_KEY]).toBeUndefined();
    });
  });

  describe('malformed / missing files', () => {
    it('silently ignores a missing config file', async () => {
      const env = await resolveCliEnv(tmpCwd, { SAL_PROJECT_ID: 'x' });
      expect(env.SAL_PROJECT_ID).toBe('x');
    });

    it('silently ignores malformed JSON', async () => {
      await fsp.writeFile(path.join(tmpCwd, '.devin', 'config.json'), 'not json');
      const env = await resolveCliEnv(tmpCwd, { SAL_PROJECT_ID: 'x' });
      expect(env.SAL_PROJECT_ID).toBe('x');
    });

    it('silently skips non-string env values', async () => {
      await writeProjectConfig('config.json', { SAL_SYNC_RETRIES: 5, SAL_PROJECT_ID: 'proj' });
      const env = await resolveCliEnv(tmpCwd, {});
      expect(env.SAL_SYNC_RETRIES).toBeUndefined();
      expect(env.SAL_PROJECT_ID).toBe('proj');
    });

    it('silently ignores a config file with no "env" key at all', async () => {
      await fsp.writeFile(
        path.join(tmpCwd, '.devin', 'config.json'),
        JSON.stringify({ other: true }),
      );
      const env = await resolveCliEnv(tmpCwd, { SAL_PROJECT_ID: 'x' });
      expect(env.SAL_PROJECT_ID).toBe('x');
    });

    it('silently ignores a config file whose "env" value is an array', async () => {
      await fsp.writeFile(
        path.join(tmpCwd, '.devin', 'config.json'),
        JSON.stringify({ env: ['a', 'b'] }),
      );
      const env = await resolveCliEnv(tmpCwd, { SAL_PROJECT_ID: 'x' });
      expect(env.SAL_PROJECT_ID).toBe('x');
    });

    it('silently ignores a config file whose top level is an array', async () => {
      await fsp.writeFile(path.join(tmpCwd, '.devin', 'config.json'), JSON.stringify([1, 2, 3]));
      const env = await resolveCliEnv(tmpCwd, { SAL_PROJECT_ID: 'x' });
      expect(env.SAL_PROJECT_ID).toBe('x');
    });
  });
});
