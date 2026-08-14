import { describe, expect, it } from 'vitest';

import { buildConfigSnapshot } from '../src/config/snapshot.js';
import type {
  AgentDefinition,
  ClaudeCodeSettings,
  McpConfig,
  PluginMarketplace,
  RuleDefinition,
  SkillDefinition,
} from '../src/types/config.js';

/**
 * C2 (retry) — closing `src/config/snapshot.ts` branch-coverage gaps.
 * Only `settings`/`mcp-config`/`agent-definition` kinds were ever bucketed
 * before this file existed (see `tests/builder.test.ts`'s pre-existing
 * `buildConfigSnapshot` describe block, which this file complements rather
 * than duplicates). Everything here is built from inline objects conforming
 * to the `src/types/config.ts` shapes — no fixture files, per the plan.
 *
 * Every name/path below (orbit-tracker, nimbus-market, csv-wrangler, ...) is
 * invented; nothing here is copied from a real `~/.claude` corpus.
 */

function baseSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    kind: 'skill-definition',
    scope: 'project',
    name: 'csv-wrangler',
    frontmatter: {},
    body: '',
    parseErrors: [],
    ...overrides,
  };
}

function baseRule(overrides: Partial<RuleDefinition> = {}): RuleDefinition {
  return {
    kind: 'rule-definition',
    sourcePath: '/home/testuser/projects/orbit-tracker/.claude/rules/style.md',
    scope: 'project',
    ruleKind: 'rule',
    frontmatter: {},
    globs: [],
    body: '',
    parseErrors: [],
    ...overrides,
  };
}

function baseMarketplace(overrides: Partial<PluginMarketplace> = {}): PluginMarketplace {
  return {
    kind: 'plugin-marketplace',
    name: 'nimbus-market',
    plugins: [],
    ...overrides,
  };
}

function baseSettings(overrides: Partial<ClaudeCodeSettings> = {}): ClaudeCodeSettings {
  return {
    kind: 'settings',
    scope: 'project',
    raw: {},
    parseErrors: [],
    ...overrides,
  };
}

function baseAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    kind: 'agent-definition',
    scope: 'project',
    name: 'docs-drafter',
    frontmatter: {},
    body: '',
    parseErrors: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// skill-definition / rule-definition / plugin-marketplace bucketing
// ---------------------------------------------------------------------------

describe('buildConfigSnapshot: skill/rule/marketplace bucketing', () => {
  it('buckets a skill-definition into bucket.skills and skillsByName by name', () => {
    const skill = baseSkill({ sourcePath: '/home/testuser/projects/orbit-tracker/.claude/skills/csv-wrangler/SKILL.md' });
    const snapshot = buildConfigSnapshot([skill]);

    expect(snapshot.inventories).toHaveLength(1);
    expect(snapshot.inventories[0].skills).toEqual([skill]);
    expect(snapshot.skillsByName['csv-wrangler']).toBe(skill);
  });

  it('keeps a skill with an empty name in bucket.skills but does not pollute skillsByName', () => {
    const skill = baseSkill({ name: '' });
    const snapshot = buildConfigSnapshot([skill]);

    expect(snapshot.inventories[0].skills).toEqual([skill]);
    expect(snapshot.skillsByName).toEqual({});
    expect(Object.prototype.hasOwnProperty.call(snapshot.skillsByName, '')).toBe(false);
  });

  it('buckets a rule-definition into bucket.rules', () => {
    const rule = baseRule();
    const snapshot = buildConfigSnapshot([rule]);

    expect(snapshot.inventories[0].rules).toEqual([rule]);
  });

  it('buckets a plugin-marketplace onto its own inventory (marketplace field)', () => {
    const marketplace = baseMarketplace({
      sourcePath: '/home/testuser/.claude/plugins/nimbus-market/.claude-plugin/marketplace.json',
    });
    const snapshot = buildConfigSnapshot([marketplace]);

    expect(snapshot.inventories[0].marketplace).toBe(marketplace);
  });
});

// ---------------------------------------------------------------------------
// inferMarketplaceScope
// ---------------------------------------------------------------------------

describe('buildConfigSnapshot: inferMarketplaceScope', () => {
  it('infers scope "plugin" from a sourcePath containing /plugins/, overriding the fallback scope argument', () => {
    const marketplace = baseMarketplace({
      sourcePath: '/home/testuser/.claude/plugins/nimbus-market/.claude-plugin/marketplace.json',
    });
    const snapshot = buildConfigSnapshot([marketplace], 'project');

    expect(snapshot.inventories[0].scope).toBe('plugin');
  });

  it('falls back to the caller-supplied scope argument when sourcePath has no /plugins/ segment', () => {
    const marketplace = baseMarketplace({
      sourcePath: '/home/testuser/.claude/marketplaces/nimbus-market/.claude-plugin/marketplace.json',
    });
    const snapshot = buildConfigSnapshot([marketplace], 'project');

    expect(snapshot.inventories[0].scope).toBe('project');
  });

  it('falls back to "unknown" when there is neither a /plugins/ sourcePath nor a scope argument', () => {
    const marketplace = baseMarketplace({ sourcePath: undefined });
    const snapshot = buildConfigSnapshot([marketplace]);

    expect(snapshot.inventories[0].scope).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// deriveRootPath
// ---------------------------------------------------------------------------

describe('buildConfigSnapshot: deriveRootPath', () => {
  it('derives a rootPath ending in .claude-plugin for a marketplace manifest under a .claude-plugin dir', () => {
    // No plain ".claude/" segment anywhere in this path — otherwise the
    // ".claude" branch (checked first) would win instead.
    const marketplace = baseMarketplace({
      sourcePath: '/home/testuser/projects/orbit-tracker/.claude-plugin/marketplace.json',
    });
    const snapshot = buildConfigSnapshot([marketplace]);

    expect(snapshot.inventories[0].rootPath).toBe('/home/testuser/projects/orbit-tracker/.claude-plugin');
  });

  it('derives an undefined rootPath (bucketed by scope alone) when sourcePath has neither .claude nor .claude-plugin', () => {
    const agent = baseAgent({ sourcePath: '/tmp/orbit-tracker-scratch/agent.md', scope: 'local' });
    const snapshot = buildConfigSnapshot([agent]);

    expect(snapshot.inventories[0].rootPath).toBeUndefined();
    expect(snapshot.inventories[0].scope).toBe('local');
  });
});

// ---------------------------------------------------------------------------
// Unrecognized kind
// ---------------------------------------------------------------------------

describe('buildConfigSnapshot: unrecognized kind', () => {
  it('labels an unrecognized kind with its string sourcePath', () => {
    const snapshot = buildConfigSnapshot([{ kind: 'wat', sourcePath: '/x/y' } as never]);

    expect(snapshot.inventories[0].unrecognized).toEqual(['/x/y']);
    expect(snapshot.inventories[0].parseErrors[0]?.code).toBe('unrecognized_config_kind');
  });

  it('labels an unrecognized kind with an index placeholder when sourcePath is not a string', () => {
    const snapshot = buildConfigSnapshot([{ kind: 'wat' } as never]);

    expect(snapshot.inventories[0].unrecognized).toEqual(['<unrecognized item at index 0>']);
    expect(snapshot.inventories[0].parseErrors[0]?.code).toBe('unrecognized_config_kind');
  });
});

// ---------------------------------------------------------------------------
// Bucketing catch path
// ---------------------------------------------------------------------------

describe('buildConfigSnapshot: bucketing catch path', () => {
  it('catches a throw from a recognized-kind item and records bucketing_error (Error message)', () => {
    const evil = {
      kind: 'settings',
      get sourcePath(): never {
        throw new Error('boom');
      },
    };
    expect(() => buildConfigSnapshot([evil as never])).not.toThrow();

    const snapshot = buildConfigSnapshot([evil as never]);
    expect(snapshot.inventories[0].parseErrors[0]?.code).toBe('bucketing_error');
    expect(snapshot.inventories[0].parseErrors[0]?.message).toContain('boom');
  });

  it('catches a non-Error throw from a recognized-kind item and stringifies it', () => {
    // sourcePath is the very first field the 'agent-definition' bucketing
    // case touches (via deriveRootPath), so the throw happens before any
    // bucket is created/mutated — keeping this to a single resulting
    // inventory, unlike a throw that happens after partial bucketing work.
    const evil = {
      kind: 'agent-definition',
      get sourcePath(): never {
        throw 'agent-sourcePath-explosion';
      },
    };
    const snapshot = buildConfigSnapshot([evil as never]);

    expect(snapshot.inventories[0].parseErrors[0]?.code).toBe('bucketing_error');
    expect(snapshot.inventories[0].parseErrors[0]?.message).toContain('agent-sourcePath-explosion');
  });
});

// ---------------------------------------------------------------------------
// Bucket scope upgrade
// ---------------------------------------------------------------------------

describe('buildConfigSnapshot: bucket scope upgrade', () => {
  it('upgrades a bucket\'s reported scope from "local" to a higher-precedence scope sharing the same root', () => {
    const localSettings = baseSettings({
      scope: 'local',
      sourcePath: '/home/testuser/projects/orbit-tracker/.claude/settings.local.json',
    });
    const projectAgent = baseAgent({
      scope: 'project',
      sourcePath: '/home/testuser/projects/orbit-tracker/.claude/agents/docs-drafter.md',
    });

    const snapshot = buildConfigSnapshot([localSettings, projectAgent]);

    expect(snapshot.inventories).toHaveLength(1);
    expect(snapshot.inventories[0].scope).toBe('project');
    expect(snapshot.inventories[0].localSettings).toBe(localSettings);
    expect(snapshot.inventories[0].agents).toEqual([projectAgent]);
  });
});

// ---------------------------------------------------------------------------
// mergeEffectiveSettings field matrix
// ---------------------------------------------------------------------------

describe('buildConfigSnapshot: mergeEffectiveSettings field matrix', () => {
  it('shallow-replaces effortLevel/tui/statusLine/sandbox with the higher-precedence scope\'s value', () => {
    const userSettings = baseSettings({
      scope: 'user',
      sourcePath: '/home/testuser/.claude/settings.json',
      effortLevel: 'high',
      tui: 'classic',
      statusLine: { type: 'text', text: 'ready' },
      sandbox: { enabled: true, network: { allowedDomains: ['example.invalid'] } },
    });
    const projectSettings = baseSettings({
      scope: 'project',
      sourcePath: '/home/testuser/projects/orbit-tracker/.claude/settings.json',
      effortLevel: 'medium',
      tui: 'compact',
      // Explicit key present with value `null` — exercises the `'statusLine'
      // in s` check (as opposed to an `!== undefined` check), which must
      // overwrite the user scope's statusLine even with a "falsy" value.
      statusLine: null,
      // Sandbox is a full shallow replace, not a per-key merge: the user
      // scope's `network` sub-object must NOT survive.
      sandbox: { enabled: false },
    });
    const localSettings = baseSettings({
      scope: 'local',
      sourcePath: '/home/testuser/projects/orbit-tracker/.claude/settings.local.json',
      // No statusLine key at all here — the `'statusLine' in s` branch is
      // false for this scope, so project's `null` must survive untouched.
    });

    const snapshot = buildConfigSnapshot([userSettings, projectSettings, localSettings]);

    expect(snapshot.effectiveSettings.effortLevel).toBe('medium');
    expect(snapshot.effectiveSettings.tui).toBe('compact');
    expect(snapshot.effectiveSettings.statusLine).toBeNull();
    expect(snapshot.effectiveSettings.sandbox).toEqual({ enabled: false });
  });

  it('merges env/enabledPlugins/extraKnownMarketplaces/hooks per-key, later scope wins per key, earlier-only keys survive', () => {
    const userSettings = baseSettings({
      scope: 'user',
      env: { SHARED: 'from-user', USER_ONLY: 'u1' },
      enabledPlugins: { 'pluglet-a': true },
      extraKnownMarketplaces: { 'nimbus-market': { source: { source: 'git', repo: 'demo-org/nimbus-market' } } },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'scripts/greet.sh' }] }] },
    });
    const projectSettings = baseSettings({
      scope: 'project',
      env: { SHARED: 'from-project', PROJECT_ONLY: 'p1' },
      enabledPlugins: { 'pluglet-b': true },
      extraKnownMarketplaces: { 'quill-market': { source: { source: 'npm' } } },
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'scripts/lint.sh' }] }] },
    });

    const snapshot = buildConfigSnapshot([userSettings, projectSettings]);

    expect(snapshot.effectiveSettings.env).toEqual({ SHARED: 'from-project', USER_ONLY: 'u1', PROJECT_ONLY: 'p1' });
    expect(snapshot.effectiveSettings.enabledPlugins).toEqual({ 'pluglet-a': true, 'pluglet-b': true });
    expect(Object.keys(snapshot.effectiveSettings.extraKnownMarketplaces ?? {})).toEqual(
      expect.arrayContaining(['nimbus-market', 'quill-market']),
    );
    expect(Object.keys(snapshot.effectiveSettings.hooks ?? {})).toEqual(expect.arrayContaining(['SessionStart', 'PreToolUse']));
  });

  it('concatenates and de-dupes permissions.ask across scopes; defaultMode is last-wins', () => {
    const userSettingsA = baseSettings({
      scope: 'user',
      permissions: { ask: ['Bash(git push*)'] },
    });
    // Same scope as A — exercises tie-breaking by original array order
    // within a single precedence tier (B comes after A in `parsed`, so it
    // is applied after A even though both are scope "user").
    const userSettingsB = baseSettings({
      scope: 'user',
      permissions: { ask: ['Bash(git push*)', 'Bash(npm publish*)'], defaultMode: 'plan' },
    });
    const projectSettings = baseSettings({
      scope: 'project',
      sourcePath: '/home/testuser/projects/orbit-tracker/.claude/settings.json',
      permissions: { defaultMode: 'acceptEdits' },
    });

    const snapshot = buildConfigSnapshot([userSettingsA, userSettingsB, projectSettings]);

    // Deduped, first-occurrence order preserved.
    expect(snapshot.effectiveSettings.permissions?.ask).toEqual(['Bash(git push*)', 'Bash(npm publish*)']);
    // project (highest precedence present) wins the single-value field.
    expect(snapshot.effectiveSettings.permissions?.defaultMode).toBe('acceptEdits');
    // The merged sourcePath/scope reflect the highest-precedence contributor.
    expect(snapshot.effectiveSettings.sourcePath).toBe('/home/testuser/projects/orbit-tracker/.claude/settings.json');
    expect(snapshot.effectiveSettings.scope).toBe('project');
  });

  it('sorts a plugin-scoped settings below managed in SETTINGS_PRECEDENCE, regardless of input array order', () => {
    const pluginSettings = baseSettings({ scope: 'plugin', model: 'plugin-model' });
    const managedSettings = baseSettings({ scope: 'managed', model: 'managed-model' });

    // Deliberately handed in reverse precedence order (managed first).
    const snapshot = buildConfigSnapshot([managedSettings, pluginSettings]);

    // managed outranks plugin, so it must win the shallow-replace field
    // regardless of array position.
    expect(snapshot.effectiveSettings.model).toBe('managed-model');
  });
});

// ---------------------------------------------------------------------------
// Duplicate MCP server names
// ---------------------------------------------------------------------------

describe('buildConfigSnapshot: duplicate MCP server names across two configs', () => {
  it('last config wins in mcpServersByName', () => {
    const firstMcp: McpConfig = {
      kind: 'mcp-config',
      scope: 'user',
      servers: [{ name: 'zephyr:tools', toolNamespace: 'zephyr_tools', transport: 'stdio', command: 'node', raw: {} }],
      parseErrors: [],
    };
    const secondMcp: McpConfig = {
      kind: 'mcp-config',
      scope: 'project',
      servers: [
        { name: 'zephyr:tools', toolNamespace: 'zephyr_tools', transport: 'http', url: 'https://zephyr.invalid/mcp', raw: {} },
      ],
      parseErrors: [],
    };

    const snapshot = buildConfigSnapshot([firstMcp, secondMcp]);

    expect(snapshot.mcpServersByName['zephyr:tools'].transport).toBe('http');
    expect(snapshot.mcpServersByName['zephyr:tools'].url).toBe('https://zephyr.invalid/mcp');
  });
});
