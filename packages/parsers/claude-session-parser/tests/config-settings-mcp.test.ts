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
      'context7@claude-plugins-official': true,
      'superpowers@claude-plugins-official': true,
      'lsc-claude-basics@lsc-marketplace': true,
    });
    expect(settings.extraKnownMarketplaces?.['lsc-marketplace']).toEqual({
      source: { source: 'github', repo: 'dev/claude-marketplace' },
    });
    expect(settings.extraKnownMarketplaces?.['pep-local']).toEqual({
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
      DEVIN_API_KEY: 'sk-fake-anonymized-0000000000000000',
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

    // The exact real-corpus example from the spec: "pep:mcp" -> "pep_mcp".
    expect(byName['pep:mcp']).toMatchObject({
      name: 'pep:mcp',
      toolNamespace: 'pep_mcp',
      transport: 'stdio',
      command: 'node',
      args: ['tools/pep-mcp/dist/index.js'],
      env: { PEP_ENV: 'dev' },
    });
    expect(byName['pep:mcp'].raw).toEqual({
      command: 'node',
      args: ['tools/pep-mcp/dist/index.js'],
      env: { PEP_ENV: 'dev' },
    });
  });

  it('infers http/sse transport from url + explicit type, defaulting to http with no discriminant', () => {
    const content = readFixture('t6-mcp-http.json');
    const config = parseMcp(content, 'project');
    const byName = Object.fromEntries(config.servers.map((s) => [s.name, s]));

    expect(byName.devin).toMatchObject({
      transport: 'http',
      url: 'https://mcp.devin.ai/mcp',
      headers: { Authorization: 'Bearer ${DEVIN_API_KEY}' },
    });
    expect(byName['legacy-sse'].transport).toBe('sse');
    expect(byName['no-discriminant'].transport).toBe('http');
  });

  it('tolerates a file that is the server map directly (no mcpServers wrapper)', () => {
    const content = readFixture('t6-mcp-bare.json');
    const config = parseMcp(content, 'project');

    expect(config.parseErrors).toEqual([]);
    expect(config.servers.map((s) => s.name).sort()).toEqual(['playwright', 'sequential-thinking']);
    const playwright = config.servers.find((s) => s.name === 'playwright');
    expect(playwright?.transport).toBe('stdio');
    expect(playwright?.command).toBe('npx');
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
});

describe('parsePluginMarketplace', () => {
  it('parses an official-style marketplace with both string and object source forms', () => {
    const content = readFixture('t6-marketplace-official-style.json');
    const marketplace = parsePluginMarketplace(content, '/Users/dev/.claude/plugins/marketplaces/official/.claude-plugin/marketplace.json');

    expect(marketplace.kind).toBe('plugin-marketplace');
    expect(marketplace.name).toBe('claude-plugins-official');
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

    expect(marketplace.name).toBe('lsc-marketplace');
    expect(marketplace.description).toBe('A claude plugins marketplace with custom plugins');
    expect(marketplace.owner).toEqual({ name: 'Dev Person' });
    expect(marketplace.plugins).toEqual([
      { name: 'lsc-claude-basics', source: './plugins/claude-basics', description: 'A collection of agents and skills for every project.' },
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
});
