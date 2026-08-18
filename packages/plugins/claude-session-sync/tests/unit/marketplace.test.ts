import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const repoRoot = resolve(packageRoot, '..', '..', '..');
const marketplacePath = resolve(repoRoot, '.claude-plugin/marketplace.json');

const EXPECTED_PLUGIN_NAME = 'claude-session-sync';
const EXPECTED_PLUGIN_SOURCE = './packages/plugins/claude-session-sync';

const KNOWN_HOOK_EVENTS = new Set([
  'SessionStart',
  'SessionEnd',
  'PreCompact',
  'PostCompact',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
]);

const KEBAB_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const EXECUTABLE_PLACEHOLDER = /^\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/([^/]+)$/;

function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

interface MarketplacePlugin {
  name: string;
  source: unknown;
  description?: string;
}

interface Marketplace {
  name: string;
  owner: { name: string };
  description?: string;
  plugins: MarketplacePlugin[];
}

interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  hooks?: string;
}

interface MatcherGroup {
  matcher?: string;
  hooks: Array<Record<string, unknown>>;
}

interface HooksFile {
  description?: string;
  hooks: Record<string, MatcherGroup[]>;
}

function pluginSourceToPath(source: unknown): string {
  expect(typeof source === 'string' || isPlainObject(source)).toBe(true);
  if (typeof source === 'string') {
    return source;
  }
  assertPlainObject(source, 'plugin source');
  expect(source).toHaveProperty('source');
  return String(source.source);
}

describe('marketplace registry', () => {
  it('exists at the repository root', () => {
    expect(existsSync(marketplacePath)).toBe(true);
  });

  it('conforms to the current marketplace schema', () => {
    const marketplace = readJson<Marketplace>(marketplacePath);
    assertPlainObject(marketplace, 'marketplace');

    expect(typeof marketplace.name).toBe('string');
    expect(marketplace.name).toMatch(KEBAB_PATTERN);

    assertPlainObject(marketplace.owner, 'owner');
    expect(typeof marketplace.owner.name).toBe('string');
    expect(marketplace.owner.name.length).toBeGreaterThan(0);

    if ('description' in marketplace && marketplace.description !== undefined) {
      expect(typeof marketplace.description).toBe('string');
    }

    expect(Array.isArray(marketplace.plugins)).toBe(true);
    expect(marketplace.plugins.length).toBeGreaterThan(0);

    for (const plugin of marketplace.plugins) {
      assertPlainObject(plugin, 'plugin entry');
      expect(typeof plugin.name).toBe('string');
      expect(plugin.name).toMatch(KEBAB_PATTERN);
      expect(typeof pluginSourceToPath(plugin.source)).toBe('string');
      if (plugin.description !== undefined) {
        expect(typeof plugin.description).toBe('string');
      }
    }
  });

  it('has an object owner named lucasschirm', () => {
    const marketplace = readJson<Marketplace>(marketplacePath);
    expect(marketplace.owner).toEqual({ name: 'lucasschirm' });
  });

  it('lists claude-session-sync with a relative local source', () => {
    const marketplace = readJson<Marketplace>(marketplacePath);
    const plugin = marketplace.plugins.find((p) => p.name === EXPECTED_PLUGIN_NAME);
    expect(plugin).toBeDefined();
    if (!plugin) throw new Error('Expected claude-session-sync plugin was not found');
    expect(pluginSourceToPath(plugin.source)).toBe(EXPECTED_PLUGIN_SOURCE);
  });

  it('discovers a valid plugin manifest from the marketplace entry', () => {
    const marketplace = readJson<Marketplace>(marketplacePath);
    const plugin = marketplace.plugins.find((p) => p.name === EXPECTED_PLUGIN_NAME);
    expect(plugin).toBeDefined();
    if (!plugin) throw new Error('Expected claude-session-sync plugin was not found');

    const source = pluginSourceToPath(plugin.source);
    const pluginRoot = resolve(repoRoot, source);
    const manifestPath = resolve(pluginRoot, '.claude-plugin/plugin.json');
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = readJson<PluginManifest>(manifestPath);
    assertPlainObject(manifest, 'plugin manifest');
    expect(manifest.name).toBe(EXPECTED_PLUGIN_NAME);
    expect(typeof manifest.version).toBe('string');
    expect(manifest.version.length).toBeGreaterThan(0);
    expect(typeof manifest.description).toBe('string');
    // hooks/hooks.json is the default location auto-discovered by Claude Code.
    expect(existsSync(resolve(pluginRoot, 'hooks/hooks.json'))).toBe(true);
  });
});

describe('plugin discovery', () => {
  const marketplace = readJson<Marketplace>(marketplacePath);
  const plugin = marketplace.plugins.find((p) => p.name === EXPECTED_PLUGIN_NAME);
  const source = plugin ? pluginSourceToPath(plugin.source) : '';
  const pluginRoot = resolve(repoRoot, source);

  it('resolves the declared source to the plugin package on disk', () => {
    expect(plugin).toBeDefined();
    expect(existsSync(resolve(pluginRoot, '.claude-plugin/plugin.json'))).toBe(true);
    expect(existsSync(resolve(pluginRoot, 'package.json'))).toBe(true);
    expect(existsSync(resolve(pluginRoot, 'hooks/hooks.json'))).toBe(true);
  });
});

describe('hooks.json validation', () => {
  const marketplace = readJson<Marketplace>(marketplacePath);
  const plugin = marketplace.plugins.find((p) => p.name === EXPECTED_PLUGIN_NAME);
  const source = plugin ? pluginSourceToPath(plugin.source) : '';
  const pluginRoot = resolve(repoRoot, source);
  const manifest = readJson<PluginManifest>(resolve(pluginRoot, '.claude-plugin/plugin.json'));
  const hooksPath = resolve(pluginRoot, manifest.hooks ?? 'hooks/hooks.json');

  it('is reachable from the plugin manifest', () => {
    expect(existsSync(hooksPath)).toBe(true);
  });

  it('conforms to the hook matcher group schema', () => {
    const hooksFile = readJson<HooksFile>(hooksPath);
    assertPlainObject(hooksFile, 'hooks file');

    if (hooksFile.description !== undefined) {
      expect(typeof hooksFile.description).toBe('string');
    }

    assertPlainObject(hooksFile.hooks, 'hooks');

    for (const [event, groups] of Object.entries(hooksFile.hooks)) {
      expect(KNOWN_HOOK_EVENTS.has(event)).toBe(true);
      expect(Array.isArray(groups)).toBe(true);
      expect(groups.length).toBeGreaterThan(0);

      for (const group of groups) {
        assertPlainObject(group, 'matcher group');
        if (group.matcher !== undefined) {
          expect(typeof group.matcher).toBe('string');
        }
        expect(Array.isArray(group.hooks)).toBe(true);
        expect(group.hooks.length).toBeGreaterThan(0);

        for (const hook of group.hooks) {
          assertPlainObject(hook, 'hook');
          expect(typeof hook.type).toBe('string');

          if (hook.type === 'command') {
            expect(typeof hook.command).toBe('string');
            expect(hook.command.length).toBeGreaterThan(0);
            if ('args' in hook && hook.args !== undefined) {
              expect(Array.isArray(hook.args)).toBe(true);
              for (const arg of hook.args) {
                expect(typeof arg).toBe('string');
              }
            }
            if ('async' in hook && hook.async !== undefined) {
              expect(typeof hook.async).toBe('boolean');
            }
            if ('timeout' in hook && hook.timeout !== undefined) {
              expect(typeof hook.timeout).toBe('number');
              expect(hook.timeout).toBeGreaterThan(0);
            }
          }
        }
      }
    }
  });

  it('resolves command hooks to bundled executables', () => {
    const hooksFile = readJson<HooksFile>(hooksPath);
    assertPlainObject(hooksFile.hooks, 'hooks');

    const referenced = new Set<string>();

    for (const groups of Object.values(hooksFile.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          if (hook.type !== 'command') continue;
          if (!('args' in hook) || !Array.isArray(hook.args) || hook.args.length === 0) {
            continue;
          }

          const command = String(hook.command ?? '');
          const firstArg = String(hook.args[0]);

          expect(command).toBe('node');

          const match = EXECUTABLE_PLACEHOLDER.exec(firstArg);
          expect(match).not.toBeNull();

          if (match) {
            const name = match[1];
            referenced.add(name);

            const sourceFile = resolve(pluginRoot, `src/${name}.ts`);
            const builtFile = resolve(pluginRoot, `bin/${name}`);
            const sourceExists = existsSync(sourceFile);
            const builtExists = existsSync(builtFile);

            expect(
              sourceExists || builtExists,
              `command target ${firstArg} does not resolve to src/${name}.ts or bin/${name}`,
            ).toBe(true);
          }
        }
      }
    }

    expect(referenced.size).toBeGreaterThan(0);
    const names = [...referenced];
    expect(names).toContain('session-start');
    expect(names).toContain('session-end');
    expect(names).toContain('hook');
  });
});
