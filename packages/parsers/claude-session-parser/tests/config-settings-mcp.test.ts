import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseSettings } from '../src/config/settings.js';
import { parseMcp } from '../src/config/mcp-config.js';
import { parsePluginMarketplace } from '../src/config/marketplace.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

describe('parseSettings', () => {
  it('round-trips a full realistic settings file losslessly through raw', () => {
    const content = readFixture('t6-settings-full.json');
    const settings = parseSettings(content, 'user', '/Users/dev/.claude/settings.json');

    expect(settings.kind).toBe('settings');
    expect(settings.scope).toBe('user');
    expect(settings.sourcePath).toBe('/Users/dev/.claude/settings.json');
    expect(settings.parseErrors).toEqual([]);

    // raw is a lossless passthrough of the whole parsed object.
    expect(settings.raw).toEqual(JSON.parse(content));
    // Including fields with no typed equivalent on ClaudeCodeSettings.
    expect(settings.raw.skipDangerousModePermissionPrompt).toBe(true);
    expect(settings.raw.agentPushNotifEnabled).toBe(true);

    expect(settings.model).toBe('opus');
    expect(settings.effortLevel).toBe('high');
    expect(settings.tui).toBe('fullscreen');
    expect(settings.permissions).toEqual({
      defaultMode: 'auto',
      allow: ['Bash(git *)', 'Read'],
      deny: ['Bash(rm -rf *)'],
      ask: ['Write'],
    });
    expect(settings.enabledPlugins).toEqual({
      'example-docs@official-demo-marketplace': true,
      'superpowers@official-demo-marketplace': true,
      'example-basics@example-marketplace': true,
    });
    expect(settings.extraKnownMarketplaces?.['example-marketplace']).toEqual({
      source: { source: 'github', repo: 'dev/claude-marketplace' },
    });
    expect(settings.extraKnownMarketplaces?.['local-demo']).toEqual({
      source: { source: 'directory', path: '/Users/dev/PEP/src' },
    });
    expect(settings.sandbox).toEqual({
      enabled: true,
      network: { allowedDomains: ['example.com', 'api.example.com'] },
    });
    expect(settings.statusLine).toEqual({ type: 'command', command: './statusline.sh' });
  });

  it('parses a hooks block with multiple events and matchers', () => {
    const content = readFixture('t6-settings-full.json');
    const settings = parseSettings(content, 'project');

    expect(settings.hooks?.SessionStart).toEqual([
      {
        hooks: [
          {
            type: 'command',
            command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/sync-agents-symlinks.sh',
            timeout: 15,
            statusMessage: 'Syncing symlinks',
          },
        ],
      },
    ]);
    expect(settings.hooks?.PreToolUse).toHaveLength(2);
    expect(settings.hooks?.PreToolUse[0]).toEqual({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: './hooks/pre-bash.sh', timeout: 10 }],
    });
    expect(settings.hooks?.PreToolUse[1].matcher).toBe('Edit|Write');
    expect(settings.hooks?.Stop).toEqual([
      { hooks: [{ type: 'command', command: './bin/lgtm', timeout: 360 }] },
    ]);
  });

  it('never redacts secret-shaped values in env', () => {
    const content = readFixture('t6-settings-local-secret.json');
    const settings = parseSettings(content, 'local');

    expect(settings.env).toEqual({
      HELPER_API_KEY: 'sk-fake-anonymized-0000000000000000',
      SOME_TOKEN: 'ghp_fakeFakeFakeFakeFakeFakeFakeFakeFa',
    });
    expect(settings.permissions?.allow).toEqual(['Bash(ssh devhost *)']);
    expect(settings.parseErrors).toEqual([]);
  });

  it('returns one ParseError for invalid JSON and never throws', () => {
    const content = readFixture('t6-settings-invalid.json');
    expect(() => parseSettings(content, 'project')).not.toThrow();

    const settings = parseSettings(content, 'project');
    expect(settings.raw).toEqual({});
    expect(settings.parseErrors).toHaveLength(1);
    expect(settings.parseErrors[0].code).toBe('invalid_json');
    expect(settings.model).toBeUndefined();
  });

  it('handles an empty string without throwing', () => {
    expect(() => parseSettings('', 'user')).not.toThrow();
    const settings = parseSettings('', 'user');
    expect(settings.raw).toEqual({});
    expect(settings.parseErrors).toHaveLength(1);
  });

  it('records a ParseError (not a crash) for a JSON array root', () => {
    const content = readFixture('t6-settings-array-root.json');
    const settings = parseSettings(content, 'user');

    expect(settings.raw).toEqual({});
    expect(settings.parseErrors).toHaveLength(1);
    expect(settings.parseErrors[0].code).toBe('unexpected_root_shape');
  });

  it('skips wrong-typed fields rather than trusting them', () => {
    const content = readFixture('t6-settings-wrong-types.json');
    const settings = parseSettings(content, 'project');

    // model: 42 (number) -> left unset
    expect(settings.model).toBeUndefined();
    // effortLevel is correctly typed -> kept
    expect(settings.effortLevel).toBe('high');
    // env: an array -> left unset
    expect(settings.env).toBeUndefined();
    // permissions.allow: filters non-string entries rather than dropping the field
    expect(settings.permissions?.allow).toEqual(['Read', 'Write']);
    // enabledPlugins: a string, not an object -> left unset
    expect(settings.enabledPlugins).toBeUndefined();
    // hooks: a string, not an object -> left unset
    expect(settings.hooks).toBeUndefined();
    // raw is still a full lossless passthrough regardless of typed-field validation
    expect(settings.raw.model).toBe(42);
    expect(settings.raw.hooks).toBe('also-not-an-object');
  });

  it('drops malformed-shape sub-fields (permissions, hook actions, matcher groups, non-array hook events, extraKnownMarketplaces entries) while keeping valid siblings', () => {
    const content = readFixture('c3-settings-malformed-shapes.json');
    const settings = parseSettings(content, 'project');

    // permissions: a string, not an object -> the whole field is left unset.
    expect(settings.permissions).toBeUndefined();

    // hooks.PostToolUse: value isn't an array -> the event key is dropped
    // entirely rather than appearing with an empty array.
    expect(settings.hooks).toBeDefined();
    expect('PostToolUse' in (settings.hooks ?? {})).toBe(false);

    // hooks.PreToolUse: a matcher-group entry that's a bare string, and one
    // that's an object but has no `hooks` array, are both dropped -> only
    // the one well-formed matcher group survives.
    expect(settings.hooks?.PreToolUse).toHaveLength(1);
    const group = settings.hooks?.PreToolUse[0];
    expect(group?.matcher).toBeUndefined();

    // Within that group's `hooks` array: a non-object action and an action
    // missing `type` are both skipped; a `command` action and an `agent`
    // action carrying both `prompt` and `statusMessage` both survive.
    expect(group?.hooks).toEqual([
      { type: 'agent', prompt: 'Summarize the diff', statusMessage: 'Thinking...' },
      { type: 'command', command: './hooks/valid.sh' },
    ]);

    // extraKnownMarketplaces: a non-object entry and an entry whose
    // `source.source` is missing are both dropped; the well-formed entry
    // (carrying `repo` AND `path` alongside `source`) survives intact.
    expect(Object.keys(settings.extraKnownMarketplaces ?? {})).toEqual(['full-entry']);
    expect(settings.extraKnownMarketplaces?.['full-entry']).toEqual({
      source: { source: 'github', repo: 'example-org/full-repo', path: 'sub/dir' },
    });
  });
});

describe('parseMcp', () => {
  it('parses the wrapped {mcpServers: {...}} shape with stdio transport, including a hyphenated and colon-namespaced server', () => {
    const content = readFixture('t6-mcp-stdio.json');
    const config = parseMcp(content, 'project', '/Users/dev/PEP/src/.mcp.json');

    expect(config.kind).toBe('mcp-config');
    expect(config.scope).toBe('project');
    expect(config.parseErrors).toEqual([]);
    expect(config.servers).toHaveLength(5);

    const byName = Object.fromEntries(config.servers.map((s) => [s.name, s]));

    expect(byName['vuetify:mcp']).toMatchObject({
      name: 'vuetify:mcp',
      toolNamespace: 'vuetify_mcp',
      transport: 'stdio',
      command: 'pnpm',
      args: ['vuetify:mcp'],
    });

    // Colon -> underscore, hyphen preserved.
    expect(byName['claude-in-chrome']).toMatchObject({
      name: 'claude-in-chrome',
      toolNamespace: 'claude-in-chrome',
      transport: 'stdio',
    });

    // The exact real-corpus example from the spec: "acme:mcp" -> "acme_mcp".
    expect(byName['acme:mcp']).toMatchObject({
      name: 'acme:mcp',
      toolNamespace: 'acme_mcp',
      transport: 'stdio',
      command: 'node',
      args: ['tools/pep-mcp/dist/index.js'],
      env: { PEP_ENV: 'dev' },
    });
    expect(byName['acme:mcp'].raw).toEqual({
      command: 'node',
      args: ['tools/pep-mcp/dist/index.js'],
      env: { PEP_ENV: 'dev' },
    });
  });

  it('infers http/sse transport from url + explicit type, defaulting to http with no discriminant', () => {
    const content = readFixture('t6-mcp-http.json');
    const config = parseMcp(content, 'project');
    const byName = Object.fromEntries(config.servers.map((s) => [s.name, s]));

    expect(byName.helper).toMatchObject({
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer ${HELPER_API_KEY}' },
    });
    expect(byName['legacy-sse'].transport).toBe('sse');
    expect(byName['no-discriminant'].transport).toBe('http');
  });

  it('tolerates a file that is the server map directly (no mcpServers wrapper), regression check', () => {
    const content = readFixture('t6-mcp-bare.json');
    const config = parseMcp(content, 'project');

    expect(config.parseErrors).toEqual([]);
    expect(config.servers.map((s) => s.name).sort()).toEqual(['playwright', 'step-thinking']);
    const playwright = config.servers.find((s) => s.name === 'playwright');
    expect(playwright?.transport).toBe('stdio');
    expect(playwright?.command).toBe('npx');
  });

  it('rejects a malformed "mcpServers" value instead of silently reinterpreting it as a bare map', () => {
    const config = parseMcp(JSON.stringify({ mcpServers: 'oops' }), 'project');

    expect(config.servers).toEqual([]);
    expect(config.parseErrors).toHaveLength(1);
    expect(config.parseErrors[0].code).toBe('invalid_mcp_servers_shape');
    // Must NOT produce a bogus server literally named "mcpServers".
    expect(config.servers.some((s) => s.name === 'mcpServers')).toBe(false);
  });

  it('rejects a non-MCP object (e.g. a settings.json) rather than walking every key as a server', () => {
    const content = readFixture('t6-mcp-not-a-server-map.json');
    const config = parseMcp(content, 'project');

    expect(config.servers).toEqual([]);
    expect(config.parseErrors).toHaveLength(1);
    expect(config.parseErrors[0].code).toBe('not_mcp_config');
  });

  it('defaults scope to unknown when omitted', () => {
    const config = parseMcp('{"mcpServers": {}}');
    expect(config.scope).toBe('unknown');
  });

  it('never throws on invalid JSON and records one ParseError', () => {
    const content = readFixture('t6-mcp-invalid.json');
    expect(() => parseMcp(content, 'project')).not.toThrow();
    const config = parseMcp(content, 'project');
    expect(config.servers).toEqual([]);
    expect(config.parseErrors).toHaveLength(1);
    expect(config.parseErrors[0].code).toBe('invalid_json');
  });

  it('skips a malformed individual server entry without aborting the rest', () => {
    const content = JSON.stringify({ mcpServers: { broken: [1, 2, 3], ok: { command: 'node' } } });
    const config = parseMcp(content, 'project');

    expect(config.servers).toHaveLength(1);
    expect(config.servers[0].name).toBe('ok');
    expect(config.parseErrors).toHaveLength(1);
    expect(config.parseErrors[0].code).toBe('invalid_server_config');
  });

  it('handles empty string input without throwing', () => {
    expect(() => parseMcp('', 'project')).not.toThrow();
    const config = parseMcp('', 'project');
    expect(config.parseErrors).toHaveLength(1);
  });

  it('infers transport "unknown" for a server with neither command nor url', () => {
    const content = JSON.stringify({ mcpServers: { orphaned: { env: { FOO: 'bar' } } } });
    const config = parseMcp(content, 'project');

    expect(config.parseErrors).toEqual([]);
    expect(config.servers).toHaveLength(1);
    expect(config.servers[0]).toMatchObject({ name: 'orphaned', transport: 'unknown' });
    expect(config.servers[0].command).toBeUndefined();
    expect(config.servers[0].url).toBeUndefined();
  });

  it('records unexpected_root_shape for a JSON array root', () => {
    const config = parseMcp(JSON.stringify([1, 2, 3]), 'project');

    expect(config.servers).toEqual([]);
    expect(config.parseErrors).toHaveLength(1);
    expect(config.parseErrors[0].code).toBe('unexpected_root_shape');
  });

  it('reads the sse discriminant from an explicit "transport" key (not just "type")', () => {
    const content = JSON.stringify({
      mcpServers: {
        'zephyr:tools': { url: 'https://zephyr.example.invalid/sse', transport: 'sse' },
      },
    });
    const config = parseMcp(content, 'project');

    expect(config.servers).toHaveLength(1);
    expect(config.servers[0]).toMatchObject({ name: 'zephyr:tools', transport: 'sse', url: 'https://zephyr.example.invalid/sse' });
  });
});

describe('parsePluginMarketplace', () => {
  it('parses an official-style marketplace with both string and object source forms', () => {
    const content = readFixture('t6-marketplace-official-style.json');
    const marketplace = parsePluginMarketplace(content, '/Users/dev/.claude/plugins/marketplaces/official/.claude-plugin/marketplace.json');

    expect(marketplace.kind).toBe('plugin-marketplace');
    expect(marketplace.name).toBe('official-demo-marketplace');
    expect(marketplace.description).toBe('Directory of popular Claude Code extensions');
    expect(marketplace.owner).toEqual({ name: 'Anthropic' });

    // String source form kept as-is.
    const agentSdk = marketplace.plugins.find((p) => p.name === 'agent-sdk-dev');
    expect(agentSdk?.source).toBe('./plugins/agent-sdk-dev');

    // Object source form normalized to its `url`.
    const adlc = marketplace.plugins.find((p) => p.name === 'agentforce-adlc');
    expect(adlc?.source).toBe('https://github.com/example/agentforce-adlc.git');

    const crunch = marketplace.plugins.find((p) => p.name === '42crunch-api-security-testing');
    expect(crunch?.source).toBe('https://github.com/example/claude-plugins.git');

    // A plugin entry with no `name` is dropped rather than crashing the parse.
    expect(marketplace.plugins.some((p) => p.source === './plugins/missing-name')).toBe(false);
    expect(marketplace.plugins).toHaveLength(3);
  });

  it('falls back to metadata.description when there is no top-level description', () => {
    const content = readFixture('t6-marketplace-metadata-description.json');
    const marketplace = parsePluginMarketplace(content);

    expect(marketplace.name).toBe('example-marketplace');
    expect(marketplace.description).toBe('A claude plugins marketplace with custom plugins');
    expect(marketplace.owner).toEqual({ name: 'Dev Person' });
    expect(marketplace.plugins).toEqual([
      { name: 'example-basics', source: './plugins/example-basics', description: 'A collection of agents and skills for every project.' },
    ]);
  });

  it('never throws on invalid JSON, returning a minimal valid object with no parseErrors field', () => {
    const content = readFixture('t6-marketplace-invalid.json');
    expect(() => parsePluginMarketplace(content, '/Users/dev/proj/.claude-plugin/marketplace.json')).not.toThrow();

    const marketplace = parsePluginMarketplace(content, '/Users/dev/proj/.claude-plugin/marketplace.json');
    expect(marketplace.kind).toBe('plugin-marketplace');
    expect(marketplace.plugins).toEqual([]);
    // Falls back to the marketplace's containing directory name.
    expect(marketplace.name).toBe('proj');
    expect('parseErrors' in marketplace).toBe(false);
  });

  it('handles empty string input without throwing, falling back to "unknown" with no sourcePath', () => {
    expect(() => parsePluginMarketplace('')).not.toThrow();
    const marketplace = parsePluginMarketplace('');
    expect(marketplace.name).toBe('unknown');
    expect(marketplace.plugins).toEqual([]);
  });

  it('normalizes every object-form `source` shape, and falls back to "" for a non-string/non-object source', () => {
    const content = readFixture('c3-marketplace-source-forms.json');
    const marketplace = parsePluginMarketplace(content);
    const byName = Object.fromEntries(marketplace.plugins.map((p) => [p.name, p.source]));

    // { source: 'git-subdir', url, path } -> url is preferred over path/source.
    expect(byName['url-preferred']).toBe('https://example.invalid/nimbus/url-preferred.git');
    // Object with only `path` -> path.
    expect(byName['path-only']).toBe('plugins/path-only');
    // Object with only the `source` sub-field -> that sub-field.
    expect(byName['source-field-only']).toBe('git-subdir');
    // Empty object -> JSON.stringify fallback.
    expect(byName['empty-object-source']).toBe('{}');
    // Non-string, non-object (a number) -> ''.
    expect(byName['numeric-source']).toBe('');
  });

  it('skips a non-object plugin entry and an entry missing `name`, keeping valid siblings', () => {
    const content = readFixture('c3-marketplace-plugins-skip.json');
    const marketplace = parsePluginMarketplace(content);

    expect(marketplace.plugins.map((p) => p.name)).toEqual(['valid-one', 'valid-two']);
  });

  describe('fallbackName', () => {
    it('falls back to "unknown" when there is no sourcePath and no top-level name', () => {
      const marketplace = parsePluginMarketplace(JSON.stringify({}));
      expect(marketplace.name).toBe('unknown');
    });

    it('falls back to the last path segment when sourcePath has no .claude-plugin directory', () => {
      const marketplace = parsePluginMarketplace(JSON.stringify({}), '/home/testuser/projects/orbit-tracker/marketplace.json');
      expect(marketplace.name).toBe('marketplace.json');
    });

    it('falls back to the last path segment when .claude-plugin is the FIRST path segment (pluginDirIdx === 0 edge case)', () => {
      const marketplace = parsePluginMarketplace(JSON.stringify({}), '.claude-plugin/marketplace.json');
      // pluginDirIdx (0) is not > 0, so the "containing directory" branch
      // must NOT fire here -- it must fall through to the last-segment
      // fallback, same as the no-.claude-plugin case above.
      expect(marketplace.name).toBe('marketplace.json');
    });
  });

  it('prefers a top-level `description` over `metadata.description` when both are present', () => {
    const content = JSON.stringify({
      name: 'nimbus-market',
      description: 'Top-level description wins',
      metadata: { description: 'This nested description should be ignored' },
    });
    const marketplace = parsePluginMarketplace(content);
    expect(marketplace.description).toBe('Top-level description wins');
  });

  it('falls back to `metadata.description` when there is no top-level `description`', () => {
    const content = JSON.stringify({
      name: 'nimbus-market',
      metadata: { description: 'Only the nested description is present' },
    });
    const marketplace = parsePluginMarketplace(content);
    expect(marketplace.description).toBe('Only the nested description is present');
  });

  it('mirrors owner.name, but leaves `owner` unset (not `{}`) when the owner object has no name', () => {
    const withName = parsePluginMarketplace(JSON.stringify({ name: 'nimbus-market', owner: { name: 'Synthetic Owner' } }));
    expect(withName.owner).toEqual({ name: 'Synthetic Owner' });

    const withoutName = parsePluginMarketplace(JSON.stringify({ name: 'nimbus-market', owner: {} }));
    expect('owner' in withoutName).toBe(false);
    expect(withoutName.owner).toBeUndefined();
  });
});
