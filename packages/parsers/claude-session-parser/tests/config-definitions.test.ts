import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseAgentDefinition } from '../src/config/agent-definition.js';
import { parseRuleDefinition } from '../src/config/rule-definition.js';
import { parseSkillDefinition } from '../src/config/skill-definition.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

// ---------------------------------------------------------------------------
// parseAgentDefinition
// ---------------------------------------------------------------------------

describe('parseAgentDefinition', () => {
  it('parses a realistic full agent file (block-list tools, quoted scalars, memory)', () => {
    const result = parseAgentDefinition(
      readFixture('t1-agent-definition.md'),
      '/Users/dev/.claude/agents/example-agent.md',
    );
    expect(result.kind).toBe('agent-definition');
    expect(result.name).toBe('example-agent');
    expect(result.description).toBe('Line one\nLine two "quoted" and a colon: still fine');
    expect(result.model).toBe('inherit');
    expect(result.memory).toBe('user');
    expect(result.tools).toEqual(['Bash', 'Read', 'WebFetch']);
    expect(result.color).toBe('blue');
    expect(result.body).toContain('You are an example agent.');
    expect(result.scope).toBe('user');
    expect(result.parseErrors).toEqual([]);
    // Lossless: the complete frontmatter object survives, not just the
    // fields promoted to typed properties.
    expect(result.frontmatter.name).toBe('example-agent');
    expect(result.frontmatter.tools).toEqual(['Bash', 'Read', 'WebFetch']);
  });

  it('treats a file with no frontmatter as plain prose — no error, body is the whole file', () => {
    const original = readFixture('t1-no-frontmatter.md');
    const result = parseAgentDefinition(original, '/Users/dev/project/.claude/agents/plain.md');
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(original);
    expect(result.scope).toBe('project');
    // No "name" anywhere and no frontmatter — falls back to the sourcePath
    // basename and records why.
    expect(result.name).toBe('plain');
    expect(result.parseErrors).toEqual([
      expect.objectContaining({ code: 'missing_name_fallback' }),
    ]);
  });

  it('records an unterminated-frontmatter ParseError but never throws', () => {
    const original = readFixture('t1-unterminated-frontmatter.md');
    expect(() =>
      parseAgentDefinition(original, '/Users/dev/.claude/agents/broken.md'),
    ).not.toThrow();
    const result = parseAgentDefinition(original, '/Users/dev/.claude/agents/broken.md');
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(original);
    expect(result.name).toBe('broken'); // sourcePath basename fallback
    const codes = result.parseErrors.map((e) => e.code);
    expect(codes).toContain('unterminated_frontmatter');
    expect(codes).toContain('missing_name_fallback');
  });

  it('normalizes comma-separated tools and keeps an unknown extra frontmatter key ("effort")', () => {
    const result = parseAgentDefinition(
      readFixture('t7-agent-tools-comma.md'),
      '/Users/dev/.claude/agents/explore.md',
    );
    expect(result.name).toBe('explore');
    expect(result.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash']);
    expect(result.color).toBe('cyan');
    expect(result.frontmatter.effort).toBe('xhigh');
    expect(result.parseErrors).toEqual([]);
  });

  it('normalizes the "*" all-tools sentinel to [\'*\']', () => {
    const result = parseAgentDefinition(readFixture('t7-agent-tools-all-star.md'));
    expect(result.tools).toEqual(['*']);
  });

  it('normalizes the human-readable "All tools" sentinel to the same [\'*\'] form', () => {
    const result = parseAgentDefinition(readFixture('t7-agent-tools-all-words.md'));
    expect(result.tools).toEqual(['*']);
  });

  it('normalizes a whitespace-only "tools" string to undefined', () => {
    const result = parseAgentDefinition(
      '---\nname: whitespace-tools-agent\ntools: "  "\n---\nBody.\n',
    );
    expect(result.tools).toBeUndefined();
  });

  it('normalizes a "tools" value of the wrong type (number) to undefined', () => {
    const result = parseAgentDefinition('---\nname: numeric-tools-agent\ntools: 42\n---\nBody.\n');
    expect(result.tools).toBeUndefined();
  });

  it('falls back to the sourcePath basename when "name" is missing, and records why', () => {
    const result = parseAgentDefinition(
      readFixture('t7-agent-missing-name.md'),
      '/Users/dev/.claude/agents/nameless.md',
    );
    expect(result.name).toBe('nameless');
    expect(result.frontmatter.reviewedBy).toBe('platform-team');
    expect(result.parseErrors).toEqual([
      expect.objectContaining({ code: 'missing_name_fallback' }),
    ]);
  });

  it('falls back to an empty name and a distinct error code when neither "name" nor sourcePath is available', () => {
    const result = parseAgentDefinition(readFixture('t7-agent-missing-name.md'));
    expect(result.name).toBe('');
    expect(result.parseErrors).toEqual([expect.objectContaining({ code: 'missing_name' })]);
  });

  it('handles empty-string input without throwing', () => {
    const result = parseAgentDefinition('');
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe('');
    expect(result.name).toBe('');
    expect(result.scope).toBe('unknown');
    expect(result.parseErrors).toEqual([expect.objectContaining({ code: 'missing_name' })]);
  });

  describe('scope inference from sourcePath shapes', () => {
    it('infers "user" for a path under a home .claude directory', () => {
      expect(
        parseAgentDefinition('---\nname: a\n---\n', '/Users/dev/.claude/agents/a.md').scope,
      ).toBe('user');
      expect(
        parseAgentDefinition('---\nname: a\n---\n', '/home/dev/.claude/agents/a.md').scope,
      ).toBe('user');
      expect(parseAgentDefinition('---\nname: a\n---\n', '~/.claude/agents/a.md').scope).toBe(
        'user',
      );
    });

    it('infers "project" for .claude nested inside a repo checkout', () => {
      expect(
        parseAgentDefinition('---\nname: a\n---\n', '/Users/dev/code/my-repo/.claude/agents/a.md')
          .scope,
      ).toBe('project');
      expect(parseAgentDefinition('---\nname: a\n---\n', '.claude/agents/a.md').scope).toBe(
        'project',
      );
    });

    it('infers "plugin" for any path with a /plugins/ segment, even under a home .claude root', () => {
      expect(
        parseAgentDefinition(
          '---\nname: a\n---\n',
          '/Users/dev/.claude/plugins/marketplaces/example/plugins/foo/agents/a.md',
        ).scope,
      ).toBe('plugin');
    });

    it('infers "unknown" when the path carries no .claude evidence at all', () => {
      expect(parseAgentDefinition('---\nname: a\n---\n', 'agents/a.md').scope).toBe('unknown');
    });

    it('respects an explicit scope argument over path inference', () => {
      expect(
        parseAgentDefinition('---\nname: a\n---\n', '/Users/dev/.claude/agents/a.md', 'managed')
          .scope,
      ).toBe('managed');
    });
  });
});

// ---------------------------------------------------------------------------
// parseSkillDefinition
// ---------------------------------------------------------------------------

describe('parseSkillDefinition', () => {
  it('parses a realistic full skill file (folded description, inline allowed-tools list, nested map)', () => {
    const result = parseSkillDefinition(
      readFixture('t7-skill-full.md'),
      '/Users/dev/.claude/plugins/marketplaces/example/plugins/example-plugin/skills/example-skill/SKILL.md',
    );
    expect(result.kind).toBe('skill-definition');
    expect(result.name).toBe('example-skill');
    expect(result.description).toContain('sample output formatting matters');
    expect(result.allowedTools).toEqual(['Read', 'Edit', 'Bash']);
    expect(result.pluginPrefix).toBe('example-plugin');
    expect(result.body).toContain('# Example Skill');
    expect(result.frontmatter.metadata).toEqual({ version: '0.1.0' });
    expect(result.supportingFiles).toBeUndefined();
    expect(result.parseErrors).toEqual([]);
  });

  it('treats a file with no frontmatter as plain prose — no error, body is the whole file', () => {
    const original = readFixture('t1-no-frontmatter.md');
    const result = parseSkillDefinition(original, '/Users/dev/.claude/skills/plain/SKILL.md');
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(original);
    expect(result.name).toBe('SKILL');
  });

  it('records an unterminated-frontmatter ParseError but never throws', () => {
    const original = readFixture('t1-unterminated-frontmatter.md');
    expect(() => parseSkillDefinition(original)).not.toThrow();
    const result = parseSkillDefinition(original);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(original);
    const codes = result.parseErrors.map((e) => e.code);
    expect(codes).toContain('unterminated_frontmatter');
  });

  it('normalizes a comma-separated "allowed-tools" scalar and keeps an unknown extra key', () => {
    const result = parseSkillDefinition(readFixture('t7-skill-allowed-tools-comma.md'));
    expect(result.allowedTools).toEqual(['Read', 'Glob', 'Grep', 'Bash']);
    expect(result.frontmatter['argument-hint']).toBe('<required-arg> [optional-arg]');
  });

  it('derives pluginPrefix from a "plugin:skill"-qualified name in frontmatter (precedence over sourcePath)', () => {
    const result = parseSkillDefinition(
      readFixture('t7-skill-qualified-name.md'),
      '/Users/dev/.claude/plugins/marketplaces/example/plugins/other-plugin/skills/custom-skill/SKILL.md',
    );
    expect(result.name).toBe('pep:custom-skill');
    expect(result.pluginPrefix).toBe('pep');
  });

  it('derives pluginPrefix from sourcePath when the name is bare', () => {
    const result = parseSkillDefinition(
      '---\nname: sample-plugin\n---\nBody.\n',
      '/Users/dev/.claude/plugins/marketplaces/example/plugins/sample-plugin/skills/sample-plugin/SKILL.md',
    );
    expect(result.pluginPrefix).toBe('sample-plugin');
  });

  it('leaves pluginPrefix undefined for a plain user-level skill path', () => {
    const result = parseSkillDefinition(
      '---\nname: my-skill\n---\nBody.\n',
      '/Users/dev/.claude/skills/my-skill/SKILL.md',
    );
    expect(result.pluginPrefix).toBeUndefined();
    expect(result.scope).toBe('user');
  });

  it('infers "project" scope for a sourcePath under a project .claude/ root', () => {
    const result = parseSkillDefinition(
      '---\nname: example-skill\n---\nBody.\n',
      '/Users/dev/code/my-repo/.claude/skills/example-skill/SKILL.md',
    );
    expect(result.scope).toBe('project');
  });

  it('normalizes an empty "allowed-tools" string to undefined', () => {
    const result = parseSkillDefinition(
      '---\nname: empty-allowed-tools-skill\nallowed-tools: ""\n---\nBody.\n',
    );
    expect(result.allowedTools).toBeUndefined();
  });

  it('normalizes an "allowed-tools" value of the wrong type (number) to undefined', () => {
    const result = parseSkillDefinition(
      '---\nname: numeric-allowed-tools-skill\nallowed-tools: 42\n---\nBody.\n',
    );
    expect(result.allowedTools).toBeUndefined();
  });

  it('normalizes the lowercase "all tools" spelling variant to [\'*\']', () => {
    const result = parseSkillDefinition(
      '---\nname: lowercase-all-tools-skill\nallowed-tools: "all tools"\n---\nBody.\n',
    );
    expect(result.allowedTools).toEqual(['*']);
  });

  it('falls back to the sourcePath basename when "name" is missing', () => {
    const result = parseSkillDefinition(
      '---\ndescription: no name here\n---\nBody.\n',
      '/Users/dev/.claude/skills/mystery/SKILL.md',
    );
    expect(result.name).toBe('SKILL');
    expect(result.parseErrors).toEqual([
      expect.objectContaining({ code: 'missing_name_fallback' }),
    ]);
  });

  it('handles empty-string input without throwing', () => {
    const result = parseSkillDefinition('');
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe('');
    expect(result.name).toBe('');
    expect(result.parseErrors).toEqual([expect.objectContaining({ code: 'missing_name' })]);
  });
});

// ---------------------------------------------------------------------------
// parseRuleDefinition
// ---------------------------------------------------------------------------

describe('parseRuleDefinition', () => {
  it('parses a realistic rule file: comma glob scalar, heading title, unknown extra key survives', () => {
    const result = parseRuleDefinition(
      readFixture('t7-rule-basic.md'),
      '/Users/dev/project/.claude/rules/typescript.md',
    );
    expect(result.kind).toBe('rule-definition');
    expect(result.ruleKind).toBe('rule');
    expect(result.title).toBe('TypeScript Conventions');
    expect(result.globs).toEqual(['src/**/*.ts', 'src/**/*.tsx']);
    expect(result.frontmatter.globs).toEqual(['src/**/*.ts', 'src/**/*.tsx']);
    expect(result.frontmatter.severity).toBe('high');
    expect(result.scope).toBe('project');
    expect(result.parseErrors).toEqual([]);
  });

  it('normalizes "globs:" (comma scalar) and "paths:" (YAML list) to the identical string[]', () => {
    const viaGlobs = parseRuleDefinition(
      readFixture('t7-rule-basic.md'),
      '.claude/rules/typescript.md',
    );
    const viaPaths = parseRuleDefinition(
      readFixture('t7-rule-paths-equiv.md'),
      '.claude/rules/typescript-2.md',
    );
    expect(viaGlobs.globs).toEqual(['src/**/*.ts', 'src/**/*.tsx']);
    expect(viaPaths.globs).toEqual(viaGlobs.globs);
  });

  it('treats a file with no frontmatter as plain prose', () => {
    const original = readFixture('t1-no-frontmatter.md');
    const result = parseRuleDefinition(original, '/Users/dev/project/CLAUDE.md');
    expect(result.frontmatter.description).toBeUndefined();
    expect(result.frontmatter.globs).toEqual([]);
    expect(result.body).toBe(original);
    expect(result.globs).toEqual([]);
    expect(result.parseErrors).toEqual([]);
  });

  it('records an unterminated-frontmatter ParseError but never throws', () => {
    const original = readFixture('t1-unterminated-frontmatter.md');
    expect(() => parseRuleDefinition(original, '.claude/rules/broken.md')).not.toThrow();
    const result = parseRuleDefinition(original, '.claude/rules/broken.md');
    expect(result.body).toBe(original);
    const codes = result.parseErrors.map((e) => e.code);
    expect(codes).toContain('unterminated_frontmatter');
  });

  it('title precedence: a frontmatter "title:" key wins when the body has no heading', () => {
    const result = parseRuleDefinition(
      readFixture('t7-rule-title-frontmatter.md'),
      '.claude/rules/no-heading.md',
    );
    expect(result.title).toBe('Explicit Frontmatter Title');
    expect(result.globs).toEqual([]);
  });

  it('title precedence: falls back to the sourcePath basename when there is no heading and no frontmatter title', () => {
    const result = parseRuleDefinition(
      readFixture('t7-rule-plain.md'),
      '/Users/dev/project/.claude/rules/plain-notes.md',
    );
    expect(result.title).toBe('plain-notes');
    expect(result.frontmatter.description).toBeUndefined();
    expect(result.frontmatter.globs).toEqual([]);
  });

  describe('scope inference from sourcePath shapes', () => {
    it('infers "user" for the /home/ alternative home-directory pattern', () => {
      const result = parseRuleDefinition('# Title\nBody.', '/home/testuser/.claude/rules/x.md');
      expect(result.scope).toBe('user');
    });

    it('infers "project" for a bare relative .claude/rules path', () => {
      const result = parseRuleDefinition('# Title\nBody.', '.claude/rules/x.md');
      expect(result.scope).toBe('project');
    });

    it('infers "unknown" for an empty sourcePath', () => {
      const result = parseRuleDefinition('# Title\nBody.', '');
      expect(result.scope).toBe('unknown');
    });

    it('infers "plugin" for a rule sourcePath with a /plugins/ segment, even under a home .claude root', () => {
      const result = parseRuleDefinition(
        '# Title\nBody.',
        '/Users/dev/.claude/plugins/marketplaces/example/plugins/example-plugin/rules/x.md',
      );
      expect(result.scope).toBe('plugin');
    });
  });

  describe('ruleKind discrimination', () => {
    it('classifies CLAUDE.md / AGENTS.md and their variants as "memory"', () => {
      expect(parseRuleDefinition('# x', '/Users/dev/.claude/CLAUDE.md').ruleKind).toBe('memory');
      expect(parseRuleDefinition('# x', '/Users/dev/project/AGENTS.md').ruleKind).toBe('memory');
      expect(parseRuleDefinition('# x', '/Users/dev/project/CLAUDE.local.md').ruleKind).toBe(
        'memory',
      );
    });

    it('classifies files under .claude/rules/ as "rule"', () => {
      expect(parseRuleDefinition('# x', '/Users/dev/project/.claude/rules/style.md').ruleKind).toBe(
        'rule',
      );
    });

    it('defaults unrecognized paths to "rule" rather than mislabeling them as memory', () => {
      expect(parseRuleDefinition('# x', '/Users/dev/project/notes.md').ruleKind).toBe('rule');
    });
  });

  it('handles empty-string input without throwing (sourcePath is required but content may still be empty)', () => {
    const result = parseRuleDefinition('', '/Users/dev/.claude/CLAUDE.md');
    expect(result.frontmatter.description).toBeUndefined();
    expect(result.frontmatter.globs).toEqual([]);
    expect(result.body).toBe('');
    expect(result.globs).toEqual([]);
    expect(result.title).toBe('CLAUDE');
    expect(result.ruleKind).toBe('memory');
    expect(result.parseErrors).toEqual([]);
  });
});
