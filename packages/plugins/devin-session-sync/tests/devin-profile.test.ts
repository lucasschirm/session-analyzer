import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discover } from '@lucasschirm/sal-sync';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDevinHarnessProfile,
  DEVIN_HARD_BLOCKLIST_PATTERNS,
  DevinHarnessProfile,
  resolveDevinCliVersion,
  resolveDevinConfigDir,
} from '../src/devin-profile.js';

describe('DevinHarnessProfile', () => {
  it('carries the devin harness identity and 3-entry security blocklist', () => {
    expect(DevinHarnessProfile.harness).toBe('devin');
    expect(DevinHarnessProfile.securityBlocklist).toEqual([
      'SAL_STORAGE_ENDPOINT',
      'SAL_STORAGE_ACCESS_KEY_ID',
      'SAL_STORAGE_SECRET_ACCESS_KEY',
    ]);
  });

  it('session layout resolves an on-disk <sessionId>.jsonl filename', () => {
    expect(DevinHarnessProfile.sessionLayout.mainTranscriptFilePattern).toBe('{sessionId}.jsonl');
    expect(DevinHarnessProfile.sessionLayout.mainTranscriptStorageName).toBe('transcript.jsonl');
  });
});

describe('resolveDevinConfigDir', () => {
  it('resolves to ~/.local/share/devin/cli by default', () => {
    const dir = resolveDevinConfigDir({});
    expect(dir).toBe(path.join(os.homedir(), '.local', 'share', 'devin', 'cli'));
  });

  it('honors XDG_DATA_HOME when set', () => {
    const dir = resolveDevinConfigDir({ XDG_DATA_HOME: '/custom/data' });
    expect(dir).toBe(path.join('/custom/data', 'devin', 'cli'));
  });
});

describe('resolveDevinCliVersion', () => {
  it('returns the live devin --version output, trimmed', () => {
    const version = resolveDevinCliVersion(() => '3000.6.7\n');
    expect(version).toBe('3000.6.7');
  });

  it('falls back to UNKNOWN_HARNESS_VERSION (never a blank string) when devin is unavailable', () => {
    const version = resolveDevinCliVersion(() => {
      throw new Error('spawn devin ENOENT');
    });
    expect(version).toBe('unknown');
  });

  it('falls back to UNKNOWN_HARNESS_VERSION for empty output', () => {
    const version = resolveDevinCliVersion(() => '   ');
    expect(version).toBe('unknown');
  });
});

describe('createDevinHarnessProfile', () => {
  it('accepts an explicit version without shelling out (test injection)', () => {
    const profile = createDevinHarnessProfile('devin-cli-test-version');
    expect(profile.harnessVersion).toBe('devin-cli-test-version');
  });
});

describe('capture allowlist matching (via discover())', () => {
  let workspaceDir: string;
  let homeDir: string;

  beforeEach(async () => {
    workspaceDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-allowlist-ws-'));
    homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-allowlist-home-'));
  });

  afterEach(async () => {
    await fsp.rm(workspaceDir, { recursive: true, force: true });
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  async function writeFile(root: string, relative: string, content = '{}'): Promise<void> {
    const full = path.join(root, relative);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content, 'utf8');
  }

  it('matches every documented workspace pattern and rejects a non-matching path', async () => {
    await writeFile(workspaceDir, '.devin/hooks.v1.json');
    await writeFile(workspaceDir, '.devin/hooks/pre-tool.json');
    await writeFile(workspaceDir, '.devin/config.json');
    await writeFile(workspaceDir, '.windsurf/settings.json');
    await writeFile(workspaceDir, 'AGENTS.md', '# agents');
    await writeFile(workspaceDir, 'not-captured.txt', 'nope');

    const result = await discover(
      { projectId: 'proj', sessionId: 'sess', workspaceRoot: workspaceDir, homeDir },
      DevinHarnessProfile,
    );

    const relativePaths = result.artifacts.map((a) => a.relativePath);
    expect(relativePaths).toContain('.devin/hooks.v1.json');
    expect(relativePaths).toContain('.devin/hooks/pre-tool.json');
    expect(relativePaths).toContain('.devin/config.json');
    expect(relativePaths).toContain('.windsurf/settings.json');
    expect(relativePaths).toContain('AGENTS.md');
    expect(relativePaths).not.toContain('not-captured.txt');
  });

  it('matches the documented global patterns (~/.config/devin/config.json, {configDir}/plugins/discovered.json)', async () => {
    // {configDir} resolves to the XDG *data* root (see devin-profile.ts's doc
    // comment) — plugins/discovered.json lives there, alongside sessions.db.
    // `profile.configDir(env)` always reads the live `os.homedir()` (matching
    // `ClaudeHarnessProfile`'s identical behavior), so an explicit
    // `configDir` override is required to point discovery at a temp dir.
    const dataRoot = path.join(homeDir, '.local', 'share', 'devin', 'cli');
    await writeFile(homeDir, '.config/devin/config.json');
    await writeFile(dataRoot, 'plugins/discovered.json');

    const result = await discover(
      {
        projectId: 'proj',
        sessionId: 'sess',
        workspaceRoot: workspaceDir,
        homeDir,
        configDir: dataRoot,
      },
      DevinHarnessProfile,
    );

    const relativePaths = result.artifacts.map((a) => a.relativePath);
    expect(relativePaths).toContain('.config/devin/config.json');
    expect(relativePaths).toContain('plugins/discovered.json');
  });

  it('matches every DS-B18 (#270) workspace-scope rule/skill/subagent pattern', async () => {
    await writeFile(workspaceDir, 'AGENTS.local.md', '# local agents');
    await writeFile(workspaceDir, 'AGENT.md', '# agent');
    await writeFile(workspaceDir, '.devin/rules/style.md', '# style rule');
    await writeFile(workspaceDir, '.devin/global_rules.md', '# global rules');
    // Devin's documented skill/subagent convention nests one directory
    // level deeper (`<name>/SKILL.md`, `<name>/AGENT.md`) — exercise that
    // multi-level shape under a `**` pattern, not just a flat file.
    await writeFile(workspaceDir, '.devin/skills/my-skill/SKILL.md', '# skill');
    await writeFile(workspaceDir, '.devin/agents/my-agent/AGENT.md', '# agent');
    await writeFile(workspaceDir, '.agents/skills/shared-skill/SKILL.md', '# shared skill');
    await writeFile(workspaceDir, '.agents/agents/shared-agent/AGENT.md', '# shared agent');

    const result = await discover(
      { projectId: 'proj', sessionId: 'sess', workspaceRoot: workspaceDir, homeDir },
      DevinHarnessProfile,
    );

    const relativePaths = result.artifacts.map((a) => a.relativePath);
    expect(relativePaths).toContain('AGENTS.local.md');
    expect(relativePaths).toContain('AGENT.md');
    expect(relativePaths).toContain('.devin/rules/style.md');
    expect(relativePaths).toContain('.devin/global_rules.md');
    expect(relativePaths).toContain('.devin/skills/my-skill/SKILL.md');
    expect(relativePaths).toContain('.devin/agents/my-agent/AGENT.md');
    expect(relativePaths).toContain('.agents/skills/shared-skill/SKILL.md');
    expect(relativePaths).toContain('.agents/agents/shared-agent/AGENT.md');
    expect(result.errors).toHaveLength(0);
  });

  it('matches every DS-B18 (#270) global-scope rule/skill/subagent pattern', async () => {
    await writeFile(homeDir, '.config/devin/AGENTS.md', '# global agents');
    await writeFile(homeDir, '.config/devin/AGENT.md', '# global agent');
    await writeFile(homeDir, '.config/devin/AGENTS.local.md', '# global local agents');
    // Global skill/subagent directories nest one level deeper too
    // (`<name>/SKILL.md`, `<name>/AGENT.md`), same as workspace scope.
    await writeFile(homeDir, '.config/devin/skills/global-skill/SKILL.md', '# global skill');
    await writeFile(homeDir, '.config/devin/agents/global-agent/AGENT.md', '# global subagent');
    await writeFile(homeDir, '.devin/rules/team-style.md', '# team rule');
    await writeFile(homeDir, '.devin/global_rules.md', '# devin global rules');
    await writeFile(homeDir, '.agents/skills/dotagents-skill/SKILL.md', '# dot-agents skill');

    const result = await discover(
      { projectId: 'proj', sessionId: 'sess', workspaceRoot: workspaceDir, homeDir },
      DevinHarnessProfile,
    );

    const relativePaths = result.artifacts.map((a) => a.relativePath);
    expect(relativePaths).toContain('.config/devin/AGENTS.md');
    expect(relativePaths).toContain('.config/devin/AGENT.md');
    expect(relativePaths).toContain('.config/devin/AGENTS.local.md');
    expect(relativePaths).toContain('.config/devin/skills/global-skill/SKILL.md');
    expect(relativePaths).toContain('.config/devin/agents/global-agent/AGENT.md');
    expect(relativePaths).toContain('.devin/rules/team-style.md');
    expect(relativePaths).toContain('.devin/global_rules.md');
    expect(relativePaths).toContain('.agents/skills/dotagents-skill/SKILL.md');
    expect(result.errors).toHaveLength(0);
  });

  it('never overlaps DEVIN_HARD_BLOCKLIST_PATTERNS with any allowlist pattern', () => {
    const allPatterns = [
      ...DevinHarnessProfile.captureAllowlist.workspace.map((e) => e.pattern),
      ...DevinHarnessProfile.captureAllowlist.global.map((e) => e.pattern),
    ];
    for (const blocked of DEVIN_HARD_BLOCKLIST_PATTERNS) {
      expect(allPatterns).not.toContain(blocked);
      // Guard against a broadened `**` glob sweeping a blocklisted directory
      // in: no allowlist pattern's directory prefix may equal a blocklisted
      // directory prefix (e.g. `mcp/**` would collide with `mcp/oauth/**`).
      const blockedDir = blocked.replace(/\/\*\*$/, '');
      for (const allowed of allPatterns) {
        const allowedDir = allowed.replace(/\/\*\*$/, '').replace(/^~\//, '');
        expect(allowedDir).not.toBe(blockedDir);
      }
    }
  });
});

describe('DEVIN_HARD_BLOCKLIST_PATTERNS', () => {
  it('lists the three Part A2 never-sync patterns', () => {
    expect(DEVIN_HARD_BLOCKLIST_PATTERNS).toEqual(['credentials.toml', 'mcp/oauth/**', 'logs/**']);
  });
});
