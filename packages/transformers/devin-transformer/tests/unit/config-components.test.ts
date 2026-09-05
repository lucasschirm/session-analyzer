import { describe, expect, it } from 'vitest';
import { DevinTransformer } from '../../src/index.js';

function artifact(relativePath: string, content: string, mediaType = 'text/plain') {
  return { relativePath, content, mediaType };
}

function classify(paths: { relativePath: string; content: string; mediaType?: string }[]) {
  return DevinTransformer.classifyArtifacts({
    artifacts: paths.map((p) => artifact(p.relativePath, p.content, p.mediaType)),
    sourceIdentity: { sourceId: 'src-1' },
  });
}

function kindOf(result: ReturnType<typeof classify>, relativePath: string) {
  return result.artifacts.find((a) => a.relativePath === relativePath);
}

const SKILL_MD = `---\nname: my-skill\ndescription: does things\n---\nBody.`;
const AGENT_MD = `---\nname: my-agent\ndescription: does agent things\n---\nBody.`;
const RULE_MD = `---\ntrigger: glob\ndescription: a rule\n---\nBody.`;

describe('DEVIN_KINDS: #342 config artifact classification coverage', () => {
  it('AC1: every real allowlisted path family classifies to a non-unclassified kind', () => {
    // Every relativePath below is the EXACT shape `discover()` produces for
    // an allowlisted pattern, proven by devin-session-sync's
    // devin-profile.test.ts (workspace + DS-B18 (#270) + global suites).
    const paths = [
      '.devin/hooks.v1.json',
      '.devin/hooks/pre-tool.json',
      '.devin/config.json',
      '.windsurf/settings.json',
      'AGENTS.md',
      'AGENTS.local.md',
      'AGENT.md',
      '.devin/rules/style.md',
      '.devin/global_rules.md',
      '.devin/skills/my-skill/SKILL.md',
      '.devin/agents/my-agent/AGENT.md',
      '.agents/skills/shared-skill/SKILL.md',
      '.agents/agents/shared-agent/AGENT.md',
      '.config/devin/config.json',
      'plugins/discovered.json',
      '.config/devin/AGENTS.md',
      '.config/devin/AGENT.md',
      '.config/devin/AGENTS.local.md',
      '.config/devin/skills/global-skill/SKILL.md',
      '.config/devin/agents/global-agent/AGENT.md',
    ];
    const result = classify(paths.map((relativePath) => ({ relativePath, content: '{}' })));
    for (const path of paths) {
      expect(kindOf(result, path)?.kind, `${path} must not be unclassified`).not.toBe(
        'unclassified',
      );
    }
    expect(result.warnings ?? []).toEqual([]);
  });

  it('classifies root memory files as rule/memory, workspace and global', () => {
    const result = classify([
      { relativePath: 'AGENTS.md', content: '# Team notes' },
      { relativePath: 'AGENT.md', content: '# Team notes' },
      { relativePath: 'AGENTS.local.md', content: '# Local notes' },
      { relativePath: '.config/devin/AGENTS.md', content: '# Global notes' },
    ]);
    for (const path of ['AGENTS.md', 'AGENT.md', 'AGENTS.local.md']) {
      expect(kindOf(result, path)?.kind).toBe('rule');
      expect(kindOf(result, path)?.scope).toBe('workspace');
      expect(kindOf(result, path)?.role).toBe('memory');
    }
    expect(kindOf(result, '.config/devin/AGENTS.md')?.scope).toBe('global');
  });

  it('disambiguates root AGENT.md from a nested .devin/agents/<name>/AGENT.md', () => {
    const result = classify([
      { relativePath: 'AGENT.md', content: '# root memory' },
      { relativePath: '.devin/agents/my-agent/AGENT.md', content: AGENT_MD },
    ]);
    expect(kindOf(result, 'AGENT.md')?.kind).toBe('rule');
    expect(kindOf(result, 'AGENT.md')?.role).toBe('memory');
    expect(kindOf(result, '.devin/agents/my-agent/AGENT.md')?.kind).toBe('agent');
    expect(kindOf(result, '.devin/agents/my-agent/AGENT.md')?.role).toBeUndefined();
  });

  it('extracts one skill component per SKILL.md, keyed on the parent directory name', () => {
    const result = classify([
      { relativePath: '.devin/skills/my-skill/SKILL.md', content: SKILL_MD },
    ]);
    expect(result.components).toHaveLength(1);
    expect(result.components[0].kind).toBe('skill');
    expect(result.components[0].identity.nativeId).toBe('my-skill');
    expect(result.components[0].identity.nativeId).not.toBe(result.components[0].componentId);
  });

  it('a non-SKILL.md file under a skill directory still classifies via the supporting-file catch-all, with no component', () => {
    const result = classify([
      { relativePath: '.devin/skills/my-skill/reference.md', content: '# Reference' },
    ]);
    const classified = kindOf(result, '.devin/skills/my-skill/reference.md');
    expect(classified?.kind).toBe('skill');
    expect(classified?.role).toBe('supporting-file');
    expect(result.components).toEqual([]);
  });

  it('a loose file directly under .devin/skills/ (no name subdirectory) still classifies via the loose-file catch-all, with no component (PR #375 review finding 1)', () => {
    // packages/sync/src/discovery/glob.ts's walkRecursive recurses from the
    // base directory itself, so a file with no name subdirectory at all
    // (e.g. a stray README) is captured by sync too, not just the nested
    // `<name>/SKILL.md` shape.
    const result = classify([{ relativePath: '.devin/skills/README.md', content: '# Readme' }]);
    const classified = kindOf(result, '.devin/skills/README.md');
    expect(classified?.kind).toBe('skill');
    expect(classified?.scope).toBe('workspace');
    expect(classified?.role).toBe('loose-file');
    expect(result.components).toEqual([]);
  });

  it('a loose file directly under every skill/agent directory family (workspace, global, cross-harness) classifies without a component', () => {
    const paths = [
      '.devin/skills/loose.md',
      '.devin/agents/loose.md',
      '.agents/skills/loose.md',
      '.agents/agents/loose.md',
      '.config/devin/skills/loose.md',
      '.config/devin/agents/loose.md',
    ];
    const result = classify(paths.map((relativePath) => ({ relativePath, content: 'x' })));
    for (const path of paths) {
      const classified = kindOf(result, path);
      expect(classified?.kind, path).not.toBe('unclassified');
      expect(classified?.role, path).toBe('loose-file');
    }
    expect(result.components).toEqual([]);
  });

  it('extracts one agent component per AGENT.md, keyed on the parent directory name', () => {
    const result = classify([
      { relativePath: '.devin/agents/my-agent/AGENT.md', content: AGENT_MD },
    ]);
    expect(result.components).toHaveLength(1);
    expect(result.components[0].kind).toBe('agent');
    expect(result.components[0].identity.nativeId).toBe('my-agent');
  });

  it('extracts skill/agent components from the cross-harness .agents/ convention too', () => {
    const result = classify([
      { relativePath: '.agents/skills/shared-skill/SKILL.md', content: SKILL_MD },
      { relativePath: '.agents/agents/shared-agent/AGENT.md', content: AGENT_MD },
    ]);
    const kinds = result.components.map((c) => c.kind).sort();
    expect(kinds).toEqual(['agent', 'skill']);
  });

  it('classifies global skills/agents under .config/devin/ distinctly from workspace .devin/', () => {
    const result = classify([
      { relativePath: '.devin/skills/my-skill/SKILL.md', content: SKILL_MD },
      { relativePath: '.config/devin/skills/my-skill/SKILL.md', content: SKILL_MD },
    ]);
    expect(kindOf(result, '.devin/skills/my-skill/SKILL.md')?.scope).toBe('workspace');
    expect(kindOf(result, '.config/devin/skills/my-skill/SKILL.md')?.scope).toBe('global');
    // Same native name, different scope+path -> distinct component identities.
    const ids = new Set(result.components.map((c) => c.componentId));
    expect(ids.size).toBe(2);
  });

  it('extracts one rule component per file, keyed on the stable basename regardless of heading/frontmatter content', () => {
    const result = classify([
      { relativePath: '.devin/rules/heading.md', content: '# My Heading\nBody' },
      { relativePath: '.devin/rules/desc-only.md', content: RULE_MD },
      { relativePath: '.devin/rules/plain.md', content: 'no frontmatter, no heading' },
    ]);
    const byNative = new Map(result.components.map((c) => [c.identity.nativeId, c]));
    expect(byNative.get('heading')?.kind).toBe('rule');
    expect(byNative.get('desc-only')?.kind).toBe('rule');
    expect(byNative.get('plain')?.kind).toBe('rule');
  });

  it('a rule componentId stays stable when only its heading/description content changes (PR #375 review, second round)', () => {
    // .agents/rules/component-identity-not-display-name.md: identity is
    // never keyed on something display/content-derived. Same path -> same
    // componentId, even though the heading and description text differ.
    const before = classify([
      { relativePath: '.devin/rules/style.md', content: '# Original Heading\nBody v1' },
    ]);
    const after = classify([
      {
        relativePath: '.devin/rules/style.md',
        content:
          '---\ndescription: a totally different description\n---\n# A Different Heading\nBody v2',
      },
    ]);
    expect(before.components).toHaveLength(1);
    expect(after.components).toHaveLength(1);
    expect(after.components[0].componentId).toBe(before.components[0].componentId);
    expect(after.components[0].identity.nativeId).toBe('style');
  });

  it('documents the known scope-collision limitation: .devin/rules/** always defaults to workspace scope', () => {
    // Both the real workspace pattern and the real global `~/.devin/rules/**`
    // pattern normalize to the SAME relativePath prefix (no `scope` field on
    // `Artifact`) - `scope: 'workspace'` is the documented best-effort
    // default (`.agents/rules/manifest-backed-classification.md`).
    const result = classify([{ relativePath: '.devin/rules/team-style.md', content: RULE_MD }]);
    expect(kindOf(result, '.devin/rules/team-style.md')?.scope).toBe('workspace');
  });

  it('classifies windsurf rules as rule and other windsurf files as settings', () => {
    const result = classify([
      { relativePath: '.windsurf/rules/style.md', content: RULE_MD },
      { relativePath: '.windsurf/settings.json', content: '{}' },
    ]);
    expect(kindOf(result, '.windsurf/rules/style.md')?.kind).toBe('rule');
    expect(kindOf(result, '.windsurf/settings.json')?.kind).toBe('settings');
    expect(kindOf(result, '.windsurf/settings.json')?.role).toBe('windsurf');
  });

  it('classifies .devin/hooks/** as settings with no component extraction (undocumented convention)', () => {
    const result = classify([
      { relativePath: '.devin/hooks/pre-tool.json', content: '{"anything":true}' },
    ]);
    expect(kindOf(result, '.devin/hooks/pre-tool.json')?.kind).toBe('settings');
    expect(kindOf(result, '.devin/hooks/pre-tool.json')?.role).toBe('hooks-dir');
    expect(result.components).toEqual([]);
  });

  it('extracts tool components from .devin/hooks.v1.json (Claude-Code-hook-compatible, no wrapper key)', () => {
    const hooks = JSON.stringify({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
    });
    const result = classify([{ relativePath: '.devin/hooks.v1.json', content: hooks }]);
    expect(kindOf(result, '.devin/hooks.v1.json')?.kind).toBe('settings');
    expect(result.components).toHaveLength(1);
    expect(result.components[0].kind).toBe('tool');
    expect(result.components[0].identity.nativeId).toBe('PreToolUse:command');
  });

  it('malformed hooks.v1.json degrades gracefully: kind stays settings, zero components, no crash', () => {
    const result = classify([{ relativePath: '.devin/hooks.v1.json', content: 'not-json' }]);
    expect(kindOf(result, '.devin/hooks.v1.json')?.kind).toBe('settings');
    expect(result.components).toEqual([]);
  });

  it('classifies the real global config.json relativePath (.config/devin/config.json)', () => {
    const result = classify([{ relativePath: '.config/devin/config.json', content: '{}' }]);
    expect(kindOf(result, '.config/devin/config.json')?.kind).toBe('settings');
    expect(kindOf(result, '.config/devin/config.json')?.scope).toBe('global');
  });

  describe('plugins/discovered.json (undocumented schema - deliberately conservative)', () => {
    it('classifies the artifact even though its schema is unknown', () => {
      const result = classify([{ relativePath: 'plugins/discovered.json', content: '{}' }]);
      expect(kindOf(result, 'plugins/discovered.json')?.kind).toBe('settings');
      expect(kindOf(result, 'plugins/discovered.json')?.role).toBe('discovered-catalog');
    });

    it('extracts skill/agent entries from an unambiguous shape, and NEVER an mcp-kind entry', () => {
      const catalog = JSON.stringify([
        { name: 'catalog-skill', kind: 'skill' },
        { name: 'catalog-agent', kind: 'agent' },
        { name: 'catalog-mcp-server', kind: 'mcp' },
      ]);
      const result = classify([{ relativePath: 'plugins/discovered.json', content: catalog }]);
      const kinds = result.components.map((c) => c.kind).sort();
      expect(kinds).toEqual(['agent', 'skill']);
      expect(result.components.map((c) => c.identity.nativeId)).not.toContain('catalog-mcp-server');
    });

    it('returns zero components for any unrecognized shape rather than guessing', () => {
      const shapes = ['{}', '{"skills":["a"]}', '[{"noName":true}]', '[{"name":"x"}]', 'not-json'];
      for (const content of shapes) {
        const result = classify([{ relativePath: 'plugins/discovered.json', content }]);
        expect(result.components, `shape ${content} must yield zero components`).toEqual([]);
      }
    });
  });

  describe('classification confidence', () => {
    it('is exact when skill/agent frontmatter carries the expected name key', () => {
      const result = classify([
        { relativePath: '.devin/skills/my-skill/SKILL.md', content: SKILL_MD },
      ]);
      expect(kindOf(result, '.devin/skills/my-skill/SKILL.md')?.confidence).toBe('exact');
    });

    it('downgrades to inferred when frontmatter is missing entirely', () => {
      const result = classify([
        { relativePath: '.devin/skills/my-skill/SKILL.md', content: 'no frontmatter here' },
      ]);
      expect(kindOf(result, '.devin/skills/my-skill/SKILL.md')?.confidence).toBe('inferred');
    });

    it('is exact for a rule with trigger/description frontmatter, and for a reserved memory filename', () => {
      const result = classify([
        { relativePath: '.devin/rules/style.md', content: RULE_MD },
        { relativePath: 'AGENTS.md', content: 'plain text, no frontmatter' },
      ]);
      expect(kindOf(result, '.devin/rules/style.md')?.confidence).toBe('exact');
      expect(kindOf(result, 'AGENTS.md')?.confidence).toBe('exact');
    });
  });

  it('component identity is stable across two classifications of the same source+scope+path+name', () => {
    const first = classify([
      { relativePath: '.devin/skills/my-skill/SKILL.md', content: SKILL_MD },
    ]);
    const second = classify([
      { relativePath: '.devin/skills/my-skill/SKILL.md', content: SKILL_MD },
    ]);
    expect(first.components[0].componentId).toBe(second.components[0].componentId);
  });
});
