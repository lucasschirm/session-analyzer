/**
 * Shared-package-level tests for the harness-parameterized `resolveCliEnv`
 * (`src/cli/env.ts`), hoisted from `claude-session-sync`/`devin-session-sync`
 * for #354.
 *
 * This suite exists specifically to close the gap the hoist itself could
 * introduce: `resolveCliEnv`'s security blocklist has regressed twice before
 * in `claude-session-sync` (commits `9d71ce6` then `461cc73` — see that
 * plugin's `src/cli/AGENTS.md`), and a hoist that accidentally hardcodes one
 * harness's config path shape, or forgets to apply the blocklist to BOTH the
 * project and user-global tiers, would silently reintroduce that class of
 * regression for every plugin built on this shared function — not just one.
 *
 * The two fixture adapters below intentionally mirror the two real harnesses'
 * distinguishing shapes without importing them (this package cannot depend
 * on `claude-session-sync`/`devin-session-sync` — they depend on it):
 *   - `CLAUDE_LIKE_ADAPTER` mirrors Claude's 2-segment user-global path
 *     shape (`~/.claude/settings.json`) and its real
 *     `ClaudeHarnessProfile.securityBlocklist`.
 *   - `DEVIN_LIKE_ADAPTER` mirrors Devin's 3-segment user-global path shape
 *     (`~/.config/devin/config.json`) and its real
 *     `DevinHarnessProfile.securityBlocklist` — the differing path *shape*
 *     (not just naming) is exactly what a naive string-template hoist would
 *     get wrong (see `CliHarnessAdapter.resolveConfigPaths`'s doc comment).
 */
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveCliEnv } from '../../../src/cli/env.js';
import type { CliConfigPaths, CliHarnessAdapter } from '../../../src/cli/harness-adapter.js';

// Both real harnesses currently declare this exact blocklist (see
// `ClaudeHarnessProfile`/`DevinHarnessProfile`'s `securityBlocklist`) — kept
// as a literal here (not imported) since this package cannot depend on
// either plugin.
const REAL_SECURITY_BLOCKLIST: readonly string[] = [
  'SAL_STORAGE_ENDPOINT',
  'SAL_STORAGE_ACCESS_KEY_ID',
  'SAL_STORAGE_SECRET_ACCESS_KEY',
];

function makeProfile(securityBlocklist: readonly string[]): CliHarnessAdapter['profile'] {
  return {
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
    securityBlocklist,
  };
}

const CLAUDE_LIKE_ADAPTER: CliHarnessAdapter = {
  profile: makeProfile(REAL_SECURITY_BLOCKLIST),
  binName: 'fixture-claude-sync',
  packageName: '@fixture/claude-like',
  logFolderEnvVar: 'FIXTURE_CLAUDE_LOG_PATH_FOLDER',
  resolveConfigPaths: (cwd, homedir): CliConfigPaths => ({
    local: path.join(cwd, '.fixture-claude', 'settings.local.json'),
    project: path.join(cwd, '.fixture-claude', 'settings.json'),
    userGlobal: path.join(homedir, '.fixture-claude', 'settings.json'),
  }),
  localConfigDisplayPath: '.fixture-claude/settings.local.json',
  migrateManifestHarness: 'fixture-claude',
  helpText: '',
};

const DEVIN_LIKE_ADAPTER: CliHarnessAdapter = {
  profile: makeProfile(REAL_SECURITY_BLOCKLIST),
  binName: 'fixture-devin-sync',
  packageName: '@fixture/devin-like',
  logFolderEnvVar: 'FIXTURE_DEVIN_LOG_PATH_FOLDER',
  resolveConfigPaths: (cwd, homedir): CliConfigPaths => ({
    local: path.join(cwd, '.fixture-devin', 'config.local.json'),
    project: path.join(cwd, '.fixture-devin', 'config.json'),
    // Deliberately 3 segments under home (like Devin's real
    // `~/.config/devin/config.json`), one more than the claude-like fixture
    // above — this is the path-shape asymmetry a string-template hoist
    // cannot express.
    userGlobal: path.join(homedir, '.config', 'fixture-devin', 'config.json'),
  }),
  localConfigDisplayPath: '.fixture-devin/config.local.json',
  migrateManifestHarness: 'fixture-devin',
  helpText: '',
};

describe.each([
  { label: 'claude-like adapter (2-segment user-global path)', adapter: CLAUDE_LIKE_ADAPTER },
  { label: 'devin-like adapter (3-segment user-global path)', adapter: DEVIN_LIKE_ADAPTER },
])('resolveCliEnv blocklist parity: $label', ({ adapter }) => {
  let tmpCwd: string;
  let tmpHome: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpCwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sal-shared-env-cwd-'));
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'sal-shared-env-home-'));
    // resolveCliEnv resolves the user-global tier via `os.homedir()`
    // internally (it is not an injectable parameter — matching both plugins'
    // pre-hoist `resolveCliEnv(cwd, processEnv, blocklist)` signature), so
    // tests must mock the real `os.homedir()` to point at a scratch dir.
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  });

  afterEach(async () => {
    homedirSpy.mockRestore();
    await fsp.rm(tmpCwd, { recursive: true, force: true });
    await fsp.rm(tmpHome, { recursive: true, force: true });
  });

  async function writeConfig(
    tier: 'project' | 'userGlobal',
    env: Record<string, unknown>,
  ): Promise<void> {
    const paths = adapter.resolveConfigPaths(tmpCwd, tmpHome);
    const target = tier === 'project' ? paths.project : paths.userGlobal;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, JSON.stringify({ env }));
  }

  for (const blockedKey of REAL_SECURITY_BLOCKLIST) {
    it(`blocks ${blockedKey} from the project config tier`, async () => {
      await writeConfig('project', { [blockedKey]: 'attacker-value', SAL_STORAGE_BUCKET: 'ok' });

      const env = await resolveCliEnv(adapter, tmpCwd, {});
      expect(env[blockedKey]).toBeUndefined();
      expect(env.SAL_STORAGE_BUCKET).toBe('ok');
    });

    it(`blocks ${blockedKey} from the user-global config tier`, async () => {
      await writeConfig('userGlobal', {
        [blockedKey]: 'attacker-value',
        SAL_STORAGE_BUCKET: 'ok',
      });

      const env = await resolveCliEnv(adapter, tmpCwd, {});
      expect(env[blockedKey]).toBeUndefined();
      expect(env.SAL_STORAGE_BUCKET).toBe('ok');
    });

    it(`allows ${blockedKey} from process.env regardless of config tiers`, async () => {
      await writeConfig('project', { [blockedKey]: 'attacker-value' });
      await writeConfig('userGlobal', { [blockedKey]: 'attacker-value' });

      const env = await resolveCliEnv(adapter, tmpCwd, { [blockedKey]: 'from-env' });
      expect(env[blockedKey]).toBe('from-env');
    });
  }

  it('defaults the blocklist to adapter.profile.securityBlocklist (never a hardcoded array)', async () => {
    await writeConfig('project', { SAL_STORAGE_ENDPOINT: 'attacker', SAL_STORAGE_BUCKET: 'ok' });

    const env = await resolveCliEnv(adapter, tmpCwd, {});
    expect(env.SAL_STORAGE_ENDPOINT).toBeUndefined();
    expect(env.SAL_STORAGE_BUCKET).toBe('ok');
  });

  it('honors the actual resolveConfigPaths shape, not a fixed segment count', async () => {
    const paths = adapter.resolveConfigPaths(tmpCwd, tmpHome);
    // Sanity check the fixture actually wrote where resolveCliEnv reads —
    // otherwise the blocklist assertions above would pass vacuously.
    expect(paths.userGlobal.startsWith(tmpHome)).toBe(true);
    await writeConfig('userGlobal', { SAL_PROJECT_ID: 'from-global' });
    const env = await resolveCliEnv(adapter, tmpCwd, {});
    expect(env.SAL_PROJECT_ID).toBe('from-global');
  });
});
