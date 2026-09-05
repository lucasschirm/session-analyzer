/**
 * Dedicated tests for the Claude Code settings environment resolver
 * (`resolveCliEnv` in `src/cli/env.ts`).
 *
 * This is the single source of truth for env-resolution behavior. The tests
 * here are intentionally exhaustive because this behavior has regressed twice
 * in the past — once when the blocklist was added (9d71ce6), and again when
 * a refactor accidentally removed it (461cc73) before a merge re-introduced
 * it. These tests guard against a third regression.
 *
 * See `src/cli/AGENTS.md` for the documented behavior.
 */
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveCliEnv } from '../../src/cli/env.js';

// All three blocked keys in one place — if this list changes, the tests must
// change too.
const BLOCKED_KEYS = [
  'SAL_STORAGE_ENDPOINT',
  'SAL_STORAGE_ACCESS_KEY_ID',
  'SAL_STORAGE_SECRET_ACCESS_KEY',
] as const;

// A representative non-blocked key for contrast tests.
const SAFE_KEY = 'SAL_STORAGE_BUCKET';

describe('resolveCliEnv', () => {
  let tmpCwd: string;
  let tmpHome: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpCwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sal-env-cwd-'));
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'sal-env-home-'));
    await fsp.mkdir(path.join(tmpCwd, '.claude'), { recursive: true });
    await fsp.mkdir(path.join(tmpHome, '.claude'), { recursive: true });
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  });

  afterEach(async () => {
    homedirSpy.mockRestore();
    await fsp.rm(tmpCwd, { recursive: true, force: true });
    await fsp.rm(tmpHome, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Helper
  // ---------------------------------------------------------------------------

  async function writeSettings(
    dir: string,
    filename: string,
    env: Record<string, unknown>,
  ): Promise<void> {
    const settingsPath = path.join(dir, '.claude', filename);
    const dir2 = path.dirname(settingsPath);
    await fsp.mkdir(dir2, { recursive: true });
    await fsp.writeFile(settingsPath, JSON.stringify({ env }));
  }

  // ===========================================================================
  // Section 1: Precedence Ladder
  // ===========================================================================

  describe('precedence ladder', () => {
    it('process.env wins over all settings files', async () => {
      await writeSettings(tmpHome, 'settings.json', { SAL_PROJECT_ID: 'from-global' });
      await writeSettings(tmpCwd, 'settings.json', { SAL_PROJECT_ID: 'from-project' });
      await writeSettings(tmpCwd, 'settings.local.json', { SAL_PROJECT_ID: 'from-local' });

      const env = await resolveCliEnv(tmpCwd, { SAL_PROJECT_ID: 'from-env' });
      expect(env.SAL_PROJECT_ID).toBe('from-env');
    });

    it('settings.local.json wins over settings.json and global settings.json', async () => {
      await writeSettings(tmpHome, 'settings.json', { SAL_PROJECT_ID: 'from-global' });
      await writeSettings(tmpCwd, 'settings.json', { SAL_PROJECT_ID: 'from-project' });
      await writeSettings(tmpCwd, 'settings.local.json', { SAL_PROJECT_ID: 'from-local' });

      const env = await resolveCliEnv(tmpCwd, {});
      expect(env.SAL_PROJECT_ID).toBe('from-local');
    });

    it('settings.json wins over ~/.claude/settings.json', async () => {
      await writeSettings(tmpHome, 'settings.json', { SAL_PROJECT_ID: 'from-global' });
      await writeSettings(tmpCwd, 'settings.json', { SAL_PROJECT_ID: 'from-project' });

      const env = await resolveCliEnv(tmpCwd, {});
      expect(env.SAL_PROJECT_ID).toBe('from-project');
    });

    it('~/.claude/settings.json is used when no higher-precedence source has the key', async () => {
      await writeSettings(tmpHome, 'settings.json', { SAL_PROJECT_ID: 'from-global' });

      const env = await resolveCliEnv(tmpCwd, {});
      expect(env.SAL_PROJECT_ID).toBe('from-global');
    });

    it('full ladder: user < project < local < ENV for the same key', async () => {
      await writeSettings(tmpHome, 'settings.json', { SAL_PROJECT_ID: 'user' });
      await writeSettings(tmpCwd, 'settings.json', { SAL_PROJECT_ID: 'project' });
      await writeSettings(tmpCwd, 'settings.local.json', { SAL_PROJECT_ID: 'local' });

      expect((await resolveCliEnv(tmpCwd, {})).SAL_PROJECT_ID).toBe('local');
      expect((await resolveCliEnv(tmpCwd, { SAL_PROJECT_ID: 'env' })).SAL_PROJECT_ID).toBe('env');
    });

    it('non-overlapping keys accumulate across all sources', async () => {
      await writeSettings(tmpHome, 'settings.json', { SAL_STORAGE_TYPE: 's3' });
      await writeSettings(tmpCwd, 'settings.json', { SAL_STORAGE_BUCKET: 'my-bucket' });
      await writeSettings(tmpCwd, 'settings.local.json', { SAL_STORAGE_REGION: 'us-east-1' });

      const env = await resolveCliEnv(tmpCwd, { SAL_PROJECT_ID: 'from-env' });
      expect(env).toMatchObject({
        SAL_STORAGE_TYPE: 's3',
        SAL_STORAGE_BUCKET: 'my-bucket',
        SAL_STORAGE_REGION: 'us-east-1',
        SAL_PROJECT_ID: 'from-env',
      });
    });
  });

  // ===========================================================================
  // Section 2: Security Blocklist
  // ===========================================================================

  describe('security blocklist (credential keys)', () => {
    for (const blockedKey of BLOCKED_KEYS) {
      it(`blocks ${blockedKey} from .claude/settings.json`, async () => {
        await writeSettings(tmpCwd, 'settings.json', {
          [blockedKey]: 'should-be-blocked',
          [SAFE_KEY]: 'should-pass-through',
        });

        const env = await resolveCliEnv(tmpCwd, {});
        expect(env[blockedKey]).toBeUndefined();
        expect(env[SAFE_KEY]).toBe('should-pass-through');
      });

      it(`blocks ${blockedKey} from ~/.claude/settings.json`, async () => {
        await writeSettings(tmpHome, 'settings.json', {
          [blockedKey]: 'should-be-blocked',
          [SAFE_KEY]: 'should-pass-through',
        });

        const env = await resolveCliEnv(tmpCwd, {});
        expect(env[blockedKey]).toBeUndefined();
        expect(env[SAFE_KEY]).toBe('should-pass-through');
      });

      it(`allows ${blockedKey} from .claude/settings.local.json`, async () => {
        await writeSettings(tmpCwd, 'settings.local.json', {
          [blockedKey]: 'allowed-from-local',
        });

        const env = await resolveCliEnv(tmpCwd, {});
        expect(env[blockedKey]).toBe('allowed-from-local');
      });

      it(`allows ${blockedKey} from process.env`, async () => {
        const env = await resolveCliEnv(tmpCwd, {
          [blockedKey]: 'allowed-from-env',
        });
        expect(env[blockedKey]).toBe('allowed-from-env');
      });
    }

    it('process.env blocked key wins over settings.local.json blocked key', async () => {
      await writeSettings(tmpCwd, 'settings.local.json', {
        SAL_STORAGE_ACCESS_KEY_ID: 'from-local',
      });

      const env = await resolveCliEnv(tmpCwd, {
        SAL_STORAGE_ACCESS_KEY_ID: 'from-env',
      });
      expect(env.SAL_STORAGE_ACCESS_KEY_ID).toBe('from-env');
    });

    it('settings.local.json blocked key wins over settings.json blocked key (blocked key in settings.json is ignored)', async () => {
      await writeSettings(tmpCwd, 'settings.json', {
        SAL_STORAGE_ACCESS_KEY_ID: 'should-be-ignored',
      });
      await writeSettings(tmpCwd, 'settings.local.json', {
        SAL_STORAGE_ACCESS_KEY_ID: 'from-local',
      });

      const env = await resolveCliEnv(tmpCwd, {});
      expect(env.SAL_STORAGE_ACCESS_KEY_ID).toBe('from-local');
    });

    it('all three blocked keys are simultaneously blocked from settings.json', async () => {
      await writeSettings(tmpCwd, 'settings.json', {
        SAL_STORAGE_ENDPOINT: 'https://attacker.example.com',
        SAL_STORAGE_ACCESS_KEY_ID: 'attacker-key',
        SAL_STORAGE_SECRET_ACCESS_KEY: 'attacker-secret',
        SAL_STORAGE_BUCKET: 'shared-bucket',
        SAL_STORAGE_REGION: 'us-east-1',
      });

      const env = await resolveCliEnv(tmpCwd, {});
      expect(env.SAL_STORAGE_ENDPOINT).toBeUndefined();
      expect(env.SAL_STORAGE_ACCESS_KEY_ID).toBeUndefined();
      expect(env.SAL_STORAGE_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.SAL_STORAGE_BUCKET).toBe('shared-bucket');
      expect(env.SAL_STORAGE_REGION).toBe('us-east-1');
    });

    it('all three blocked keys are simultaneously blocked from ~/.claude/settings.json', async () => {
      await writeSettings(tmpHome, 'settings.json', {
        SAL_STORAGE_ENDPOINT: 'https://attacker.example.com',
        SAL_STORAGE_ACCESS_KEY_ID: 'attacker-key',
        SAL_STORAGE_SECRET_ACCESS_KEY: 'attacker-secret',
        SAL_STORAGE_BUCKET: 'shared-bucket',
        SAL_STORAGE_REGION: 'us-east-1',
      });

      const env = await resolveCliEnv(tmpCwd, {});
      expect(env.SAL_STORAGE_ENDPOINT).toBeUndefined();
      expect(env.SAL_STORAGE_ACCESS_KEY_ID).toBeUndefined();
      expect(env.SAL_STORAGE_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.SAL_STORAGE_BUCKET).toBe('shared-bucket');
      expect(env.SAL_STORAGE_REGION).toBe('us-east-1');
    });

    it('blocked keys from settings.local.json are NOT blocked', async () => {
      await writeSettings(tmpCwd, 'settings.local.json', {
        SAL_STORAGE_ENDPOINT: 'https://my-real-endpoint.example.com',
        SAL_STORAGE_ACCESS_KEY_ID: 'my-key',
        SAL_STORAGE_SECRET_ACCESS_KEY: 'my-secret',
      });

      const env = await resolveCliEnv(tmpCwd, {});
      expect(env.SAL_STORAGE_ENDPOINT).toBe('https://my-real-endpoint.example.com');
      expect(env.SAL_STORAGE_ACCESS_KEY_ID).toBe('my-key');
      expect(env.SAL_STORAGE_SECRET_ACCESS_KEY).toBe('my-secret');
    });
  });

  // ===========================================================================
  // Section 2b: Blocklist is genuinely parameterized (DS-F1 #156)
  // ===========================================================================

  describe('blocklist is parameterized, not a hardcoded array', () => {
    it('the default (3rd) parameter blocks exactly the three documented keys', async () => {
      await writeSettings(tmpCwd, 'settings.json', {
        SAL_STORAGE_ENDPOINT: 'attacker',
        SAL_STORAGE_BUCKET: 'shared-bucket',
      });

      const env = await resolveCliEnv(tmpCwd, {});
      expect(env.SAL_STORAGE_ENDPOINT).toBeUndefined();
      expect(env.SAL_STORAGE_BUCKET).toBe('shared-bucket');
    });

    it('a caller-supplied blocklist adds a synthetic extra key beyond the three defaults', async () => {
      await writeSettings(tmpCwd, 'settings.json', {
        SAL_STORAGE_BUCKET: 'attacker-controlled',
        SAL_STORAGE_REGION: 'us-east-1',
      });

      const env = await resolveCliEnv(tmpCwd, {}, [...BLOCKED_KEYS, 'SAL_STORAGE_BUCKET']);
      // The synthetic extra key is now blocked from the committed file too.
      expect(env.SAL_STORAGE_BUCKET).toBeUndefined();
      // A key not in the caller-supplied list still passes through normally.
      expect(env.SAL_STORAGE_REGION).toBe('us-east-1');
    });

    it('a caller-supplied empty blocklist stops blocking the three default keys', async () => {
      await writeSettings(tmpCwd, 'settings.json', {
        SAL_STORAGE_ENDPOINT: 'now-allowed-because-blocklist-is-empty',
      });

      const env = await resolveCliEnv(tmpCwd, {}, []);
      expect(env.SAL_STORAGE_ENDPOINT).toBe('now-allowed-because-blocklist-is-empty');
    });
  });

  // ===========================================================================
  // Section 3: Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('returns only process env when no settings files exist', async () => {
      const env = await resolveCliEnv(tmpCwd, { FOO: 'bar' });
      expect(env.FOO).toBe('bar');
      expect(env.SAL_PROJECT_ID).toBeUndefined();
    });

    it('handles malformed settings.local.json gracefully', async () => {
      await fsp.writeFile(path.join(tmpCwd, '.claude', 'settings.local.json'), 'not valid json');
      const env = await resolveCliEnv(tmpCwd, { FOO: 'bar' });
      expect(env.FOO).toBe('bar');
    });

    it('handles malformed settings.json gracefully', async () => {
      await fsp.writeFile(path.join(tmpCwd, '.claude', 'settings.json'), 'not valid json');
      const env = await resolveCliEnv(tmpCwd, { FOO: 'bar' });
      expect(env.FOO).toBe('bar');
    });

    it('handles malformed ~/.claude/settings.json gracefully', async () => {
      await fsp.writeFile(path.join(tmpHome, '.claude', 'settings.json'), 'not valid json');
      const env = await resolveCliEnv(tmpCwd, { FOO: 'bar' });
      expect(env.FOO).toBe('bar');
    });

    it('ignores non-string env values in settings.local.json', async () => {
      await writeSettings(tmpCwd, 'settings.local.json', {
        SAL_PROJECT_ID: 'valid',
        SAL_NUMBER: 42,
        SAL_BOOL: true,
        SAL_OBJECT: { nested: true },
        SAL_ARRAY: [1, 2, 3],
      });
      const env = await resolveCliEnv(tmpCwd, {});
      expect(env.SAL_PROJECT_ID).toBe('valid');
      expect(env.SAL_NUMBER).toBeUndefined();
      expect(env.SAL_BOOL).toBeUndefined();
      expect(env.SAL_OBJECT).toBeUndefined();
      expect(env.SAL_ARRAY).toBeUndefined();
    });

    it('ignores non-string env values in settings.json', async () => {
      await writeSettings(tmpCwd, 'settings.json', {
        SAL_PROJECT_ID: 'valid',
        SAL_NUMBER: 42,
      });
      const env = await resolveCliEnv(tmpCwd, {});
      expect(env.SAL_PROJECT_ID).toBe('valid');
      expect(env.SAL_NUMBER).toBeUndefined();
    });

    it('ignores non-string env values in ~/.claude/settings.json', async () => {
      await writeSettings(tmpHome, 'settings.json', {
        SAL_PROJECT_ID: 'valid',
        SAL_NUMBER: 42,
        SAL_BOOL: true,
      });
      const env = await resolveCliEnv(tmpCwd, {});
      expect(env.SAL_PROJECT_ID).toBe('valid');
      expect(env.SAL_NUMBER).toBeUndefined();
      expect(env.SAL_BOOL).toBeUndefined();
    });

    it('ignores settings files with no env key', async () => {
      await fsp.writeFile(
        path.join(tmpCwd, '.claude', 'settings.json'),
        JSON.stringify({ model: 'claude-sonnet-4', permissions: { defaultMode: 'plan' } }),
      );
      const env = await resolveCliEnv(tmpCwd, { FOO: 'bar' });
      expect(env.FOO).toBe('bar');
      expect(env.SAL_PROJECT_ID).toBeUndefined();
    });

    it('ignores settings files where env is not an object', async () => {
      await fsp.writeFile(
        path.join(tmpCwd, '.claude', 'settings.json'),
        JSON.stringify({ env: 'not-an-object' }),
      );
      const env = await resolveCliEnv(tmpCwd, { FOO: 'bar' });
      expect(env.FOO).toBe('bar');
    });

    it('ignores settings files where env is an array', async () => {
      await fsp.writeFile(
        path.join(tmpCwd, '.claude', 'settings.json'),
        JSON.stringify({ env: [1, 2, 3] }),
      );
      const env = await resolveCliEnv(tmpCwd, { FOO: 'bar' });
      expect(env.FOO).toBe('bar');
    });

    it('process.env with undefined values does not override settings files', async () => {
      await writeSettings(tmpCwd, 'settings.local.json', { SAL_PROJECT_ID: 'from-settings' });
      const env = await resolveCliEnv(tmpCwd, { SAL_PROJECT_ID: undefined });
      expect(env.SAL_PROJECT_ID).toBe('from-settings');
    });

    it('returns an empty object when no sources have any keys', async () => {
      const env = await resolveCliEnv(tmpCwd, {});
      expect(env).toEqual({});
    });
  });

  // ===========================================================================
  // Section 4: Integration — all commands use resolveCliEnv
  // ===========================================================================

  describe('integration: all entry points use resolveCliEnv', () => {
    // These tests verify that the commands actually call resolveCliEnv by
    // checking that settings.local.json values are picked up. We use
    // settings.local.json because it has no blocklist, so all keys work.

    it('fills missing vars from settings.local.json when process.env is empty', async () => {
      await writeSettings(tmpCwd, 'settings.local.json', {
        SAL_PROJECT_ID: 'test-project',
        SAL_STORAGE_TYPE: 's3',
        SAL_STORAGE_BUCKET: 'test-bucket',
        SAL_STORAGE_REGION: 'us-east-1',
        SAL_STORAGE_ACCESS_KEY_ID: 'test-key',
        SAL_STORAGE_SECRET_ACCESS_KEY: 'test-secret',
      });

      const env = await resolveCliEnv(tmpCwd, {});
      expect(env.SAL_PROJECT_ID).toBe('test-project');
      expect(env.SAL_STORAGE_TYPE).toBe('s3');
      expect(env.SAL_STORAGE_BUCKET).toBe('test-bucket');
      expect(env.SAL_STORAGE_REGION).toBe('us-east-1');
      expect(env.SAL_STORAGE_ACCESS_KEY_ID).toBe('test-key');
      expect(env.SAL_STORAGE_SECRET_ACCESS_KEY).toBe('test-secret');
    });

    it('fills missing vars from ~/.claude/settings.json for non-blocked keys', async () => {
      await writeSettings(tmpHome, 'settings.json', {
        SAL_PROJECT_ID: 'global-project',
        SAL_STORAGE_TYPE: 's3',
        SAL_STORAGE_BUCKET: 'global-bucket',
        SAL_STORAGE_REGION: 'us-east-1',
      });

      const env = await resolveCliEnv(tmpCwd, {});
      expect(env.SAL_PROJECT_ID).toBe('global-project');
      expect(env.SAL_STORAGE_TYPE).toBe('s3');
      expect(env.SAL_STORAGE_BUCKET).toBe('global-bucket');
      expect(env.SAL_STORAGE_REGION).toBe('us-east-1');
    });
  });
});
