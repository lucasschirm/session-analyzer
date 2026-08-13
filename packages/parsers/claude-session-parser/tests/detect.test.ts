import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { detectClaudeCode, detectClaudeCodeArtifact } from '../src/detect.js';
import { parseSubagentMeta } from '../src/session/subagent-meta.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

// ---------------------------------------------------------------------------
// detectClaudeCode
// ---------------------------------------------------------------------------

describe('detectClaudeCode', () => {
  it('detects a real-shaped main session transcript', () => {
    expect(detectClaudeCode(readFixture('t8-session-transcript.jsonl'))).toBe(true);
  });

  it('detects a real-shaped subagent transcript', () => {
    expect(detectClaudeCode(readFixture('t8-subagent-transcript.jsonl'))).toBe(true);
  });

  it('returns false for an empty string', () => {
    expect(detectClaudeCode('')).toBe(false);
  });

  it('returns false for whitespace-only content', () => {
    expect(detectClaudeCode('   \n\n  \n')).toBe(false);
  });

  it('strips a leading BOM and tolerates CRLF line endings', () => {
    const withBomAndCrlf =
      '﻿' +
      readFixture('t8-session-transcript.jsonl').split('\n').join('\r\n');
    expect(detectClaudeCode(withBomAndCrlf)).toBe(true);
  });

  it('tolerates leading blank lines before the first real entry', () => {
    const content = '\n\n   \n' + readFixture('t8-session-transcript.jsonl');
    expect(detectClaudeCode(content)).toBe(true);
  });

  it('does not throw on a truncated transcript (first line cut mid-JSON) and still detects via a later valid line', () => {
    expect(() => detectClaudeCode(readFixture('t8-truncated-transcript.jsonl'))).not.toThrow();
    expect(detectClaudeCode(readFixture('t8-truncated-transcript.jsonl'))).toBe(true);
  });

  it('does not throw when the entire content is a single truncated line', () => {
    const content = '{"type":"user","sessionId":"s1","uuid":"u1theRestIsCutOf';
    expect(() => detectClaudeCode(content)).not.toThrow();
    expect(detectClaudeCode(content)).toBe(false);
  });

  it('scans only a bounded prefix: a valid header followed by megabytes of garbage still detects correctly, quickly', () => {
    const header = readFixture('t8-session-transcript.jsonl');
    const garbageTail = 'not json at all, '.repeat(400_000); // ~7MB of non-JSON text
    const content = header + garbageTail;

    const start = Date.now();
    const result = detectClaudeCode(content);
    const elapsedMs = Date.now() - start;

    expect(result).toBe(true);
    // A bounded prefix scan should be near-instant regardless of how much
    // garbage follows the header - a full-file scan of ~7MB would still be
    // fast in absolute terms, so this is a loose ceiling, not a tight
    // benchmark, but it would catch an accidental full-file split/parse.
    expect(elapsedMs).toBeLessThan(500);
  });

  it('returns false, quickly, for megabytes of content with no Claude Code signal at all', () => {
    const content = 'not json at all, '.repeat(400_000);
    const start = Date.now();
    expect(detectClaudeCode(content)).toBe(false);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('returns false for Antigravity session content (JSON array of sandbox events)', () => {
    const content = JSON.stringify([
      { timestamp: '2026-08-11T12:00:00Z', event: 'tool_exec', tool: 'bash', cmd: 'npm run build' },
      { timestamp: '2026-08-11T12:05:00Z', event: 'file_write', file: 'dist/main.js' },
    ]);
    expect(detectClaudeCode(content)).toBe(false);
  });

  it('returns false for Agentic Pi session content ({"type":"session","version":3} JSONL)', () => {
    const content = [
      '{"type":"session","version":3,"id":"pi_789","cwd":"/workspace"}',
      '{"type":"message_update","role":"user","content":"Add a route"}',
      '{"type":"tool_execution_start","tool":"file_write","target":"api.controller.ts"}',
    ].join('\n');
    expect(detectClaudeCode(content)).toBe(false);
  });

  it('returns false for OpenCode/Codex session content (action-field JSON logs)', () => {
    const content = [
      '{"timestamp":1691760000,"action":"user_command","text":"Format the codebase"}',
      '{"timestamp":1691760005,"action":"cli_exec","command":"prettier --write ."}',
    ].join('\n');
    expect(detectClaudeCode(content)).toBe(false);
  });

  it('returns false for MCP JSON-RPC trace content', () => {
    const content = [
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_file_tool"}}',
      '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"ok"}]}}',
    ].join('\n');
    expect(detectClaudeCode(content)).toBe(false);
  });

  it('returns false for Local Runner log content', () => {
    const content = [
      '{"timestamp":"2026-08-11T12:45:00Z","model":"qwen2.5-coder","prompt_eval_count":1024,"eval_count":256}',
      '{"timestamp":"2026-08-11T12:46:00Z","model":"gemma-2-9b","warning":"VRAM allocation constraint near limit"}',
    ].join('\n');
    expect(detectClaudeCode(content)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectClaudeCodeArtifact
// ---------------------------------------------------------------------------

describe('detectClaudeCodeArtifact', () => {
  it('returns "unknown" for empty content', () => {
    expect(detectClaudeCodeArtifact({ content: '' })).toBe('unknown');
  });

  it('returns "unknown" for whitespace-only content', () => {
    expect(detectClaudeCodeArtifact({ content: '   \n  ' })).toBe('unknown');
  });

  it('returns "unknown" for a JSON object with no recognizable shape', () => {
    expect(detectClaudeCodeArtifact({ content: '{"foo":"bar"}' })).toBe('unknown');
  });

  it('returns "unknown" for a top-level JSON array', () => {
    expect(detectClaudeCodeArtifact({ content: '[1,2,3]' })).toBe('unknown');
  });

  it('returns "unknown" for malformed JSON that starts with "{"', () => {
    expect(detectClaudeCodeArtifact({ content: '{"foo": ' })).toBe('unknown');
  });

  it('returns "unknown" for unrelated prose markdown with no frontmatter or path hint', () => {
    expect(detectClaudeCodeArtifact({ content: 'Just some notes, nothing structured here.' })).toBe('unknown');
  });

  describe('session-transcript', () => {
    it('classifies a real-shaped main transcript with no path hint', () => {
      const content = readFixture('t8-session-transcript.jsonl');
      expect(detectClaudeCodeArtifact({ content })).toBe('session-transcript');
    });

    it('classifies a main transcript even under a misleading path (content wins)', () => {
      const content = readFixture('t8-session-transcript.jsonl');
      expect(
        detectClaudeCodeArtifact({ content, relativePath: 'projects/example/9c3f1a20.jsonl' }),
      ).toBe('session-transcript');
    });
  });

  describe('subagent-transcript', () => {
    it('classifies a real-shaped subagent transcript by content alone (isSidechain/agentId), no path needed', () => {
      const content = readFixture('t8-subagent-transcript.jsonl');
      expect(detectClaudeCodeArtifact({ content })).toBe('subagent-transcript');
    });

    it('classifies a subagent transcript with a corroborating subagents/ path', () => {
      const content = readFixture('t8-subagent-transcript.jsonl');
      expect(
        detectClaudeCodeArtifact({
          content,
          relativePath: 'projects/example/9c3f1a20/subagents/agent-a-sub-0001.jsonl',
        }),
      ).toBe('subagent-transcript');
    });
  });

  describe('subagent-meta', () => {
    it('classifies a real-shaped agent-<id>.meta.json sidecar', () => {
      const content = readFixture('t8-subagent-meta.json');
      expect(
        detectClaudeCodeArtifact({ content, fileName: 'agent-a-sub-0001.meta.json' }),
      ).toBe('subagent-meta');
    });

    it('classifies the same content correctly even with no filename at all', () => {
      const content = readFixture('t8-subagent-meta.json');
      expect(detectClaudeCodeArtifact({ content })).toBe('subagent-meta');
    });
  });

  describe('settings', () => {
    it('classifies a real-shaped settings.json', () => {
      const content = readFixture('t8-settings.json');
      expect(detectClaudeCodeArtifact({ content, fileName: 'settings.json' })).toBe('settings');
    });
  });

  describe('mcp-config', () => {
    it('classifies a real-shaped .mcp.json with an mcpServers wrapper', () => {
      const content = readFixture('t8-mcp-config.json');
      expect(detectClaudeCodeArtifact({ content, fileName: '.mcp.json' })).toBe('mcp-config');
    });

    it('classifies a bare server-name -> server-config map (no mcpServers wrapper)', () => {
      const content = readFixture('t8-mcp-config-bare.json');
      expect(detectClaudeCodeArtifact({ content })).toBe('mcp-config');
    });
  });

  describe('plugin-marketplace', () => {
    it('classifies a real-shaped .claude-plugin/marketplace.json', () => {
      const content = readFixture('t8-plugin-marketplace.json');
      expect(
        detectClaudeCodeArtifact({ content, relativePath: '.claude-plugin/marketplace.json' }),
      ).toBe('plugin-marketplace');
    });
  });

  describe('agent-definition', () => {
    it('classifies real-shaped agent frontmatter (model/memory/tools/color) with no path hint', () => {
      const content = readFixture('t8-agent-definition.md');
      expect(detectClaudeCodeArtifact({ content })).toBe('agent-definition');
    });

    it('classifies an agent file under an agents/ path even with a generic filename', () => {
      const content = '---\nname: bare\ndescription: minimal frontmatter, no agent/skill-only key\n---\nBody.';
      expect(
        detectClaudeCodeArtifact({ content, relativePath: 'plugin/agents/bare.md' }),
      ).toBe('agent-definition');
    });
  });

  describe('skill-definition', () => {
    it('classifies real-shaped skill frontmatter (metadata/allowed-tools) with no path hint', () => {
      const content = readFixture('t8-skill-definition.md');
      expect(detectClaudeCodeArtifact({ content })).toBe('skill-definition');
    });

    it('falls back to the skills/<name>/SKILL.md path when frontmatter alone is ambiguous (bare `tools:` key)', () => {
      const content = readFixture('t8-skill-ambiguous-frontmatter.md');
      expect(
        detectClaudeCodeArtifact({
          content,
          relativePath: 'plugin/skills/ambiguous-tools-skill/SKILL.md',
        }),
      ).toBe('skill-definition');
    });
  });

  describe('rule-definition', () => {
    it('classifies real-shaped rule frontmatter (paths:/globs:) with no path hint', () => {
      const content = readFixture('t8-rule-definition.md');
      expect(detectClaudeCodeArtifact({ content })).toBe('rule-definition');
    });

    it('classifies a rules/ path file with no frontmatter signal via path', () => {
      const content = '# Some rule\n\nNo frontmatter here, just prose.';
      expect(
        detectClaudeCodeArtifact({ content, relativePath: '.claude/rules/some-rule.md' }),
      ).toBe('rule-definition');
    });

    it('classifies a bare CLAUDE.md memory file by its reserved filename, even with no frontmatter', () => {
      const content = readFixture('t8-claude-md-memory.md');
      expect(detectClaudeCodeArtifact({ content, fileName: 'CLAUDE.md' })).toBe('rule-definition');
    });

    it('classifies a bare AGENTS.md memory file by its reserved filename, overriding an agents/ directory path', () => {
      const content = '# Folder map\n\nDocumentation, not an agent definition.';
      expect(
        detectClaudeCodeArtifact({ content, relativePath: '.claude/agents/AGENTS.md' }),
      ).toBe('rule-definition');
    });
  });

  // -------------------------------------------------------------------------
  // Filename traps (spec §6 site follow-up item 4): a config file whose name
  // happens to match the subagent-file regex (`agent-<x>.jsonl` or
  // `agent-<x>.meta.json`) must still be classified by its real content, not
  // mis-claimed as a subagent artifact by filename alone.
  // -------------------------------------------------------------------------

  describe('filename traps', () => {
    it('classifies settings content by shape even when misnamed agent-<x>.jsonl', () => {
      const content = readFixture('t8-settings.json');
      expect(detectClaudeCodeArtifact({ content, fileName: 'agent-x.jsonl' })).toBe('settings');
    });

    it('classifies mcp-config content by shape even when misnamed agent-<x>.jsonl', () => {
      const content = readFixture('t8-mcp-config.json');
      expect(detectClaudeCodeArtifact({ content, fileName: 'agent-x.jsonl' })).toBe('mcp-config');
    });

    it('classifies mcp-config content by shape even when misnamed agent-<x>.meta.json', () => {
      const content = readFixture('t8-mcp-config.json');
      expect(detectClaudeCodeArtifact({ content, fileName: 'agent-x.meta.json' })).toBe('mcp-config');
    });

    it('classifies settings content by shape even when misnamed agent-<x>.meta.json', () => {
      const content = readFixture('t8-settings.json');
      expect(detectClaudeCodeArtifact({ content, fileName: 'agent-x.meta.json' })).toBe('settings');
    });

    it('still correctly classifies a genuine subagent-meta file named agent-<x>.meta.json', () => {
      const content = readFixture('t8-subagent-meta.json');
      expect(detectClaudeCodeArtifact({ content, fileName: 'agent-a-sub-0001.meta.json' })).toBe(
        'subagent-meta',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// parseSubagentMeta
// ---------------------------------------------------------------------------

describe('parseSubagentMeta', () => {
  it('parses a real-shaped agent-<id>.meta.json object', () => {
    const result = parseSubagentMeta(readFixture('t8-subagent-meta.json'));
    expect(result).toEqual({
      agentType: 'general-purpose',
      description: 'Summarize the contents of the example directory',
      toolUseId: 'toolu_01ABCDEFGHIJKLMNOPQRSTUV',
      spawnDepth: 1,
      model: 'haiku',
      parseErrors: [],
    });
  });

  it('handles missing optional fields, keeping only what is present', () => {
    const result = parseSubagentMeta('{"agentType":"general-purpose"}');
    expect(result.agentType).toBe('general-purpose');
    expect(result.description).toBeUndefined();
    expect(result.toolUseId).toBeUndefined();
    expect(result.spawnDepth).toBeUndefined();
    expect(result.model).toBeUndefined();
    expect(result.parseErrors).toEqual([]);
  });

  it('never throws on invalid JSON, and records a ParseError instead', () => {
    expect(() => parseSubagentMeta('{not valid json')).not.toThrow();
    const result = parseSubagentMeta('{not valid json');
    expect(result.parseErrors.length).toBeGreaterThan(0);
    expect(result.parseErrors[0].code).toBe('invalid_json');
  });

  it('never throws on a top-level JSON array, and records a ParseError instead', () => {
    const result = parseSubagentMeta('[1,2,3]');
    expect(result.parseErrors.length).toBeGreaterThan(0);
  });

  it('returns an empty result (no error) for an empty string', () => {
    expect(parseSubagentMeta('')).toEqual({ parseErrors: [] });
  });

  it('strips a leading BOM before parsing', () => {
    const result = parseSubagentMeta('﻿{"agentType":"general-purpose"}');
    expect(result.agentType).toBe('general-purpose');
    expect(result.parseErrors).toEqual([]);
  });

  it('ignores fields with the wrong type rather than throwing or including them', () => {
    const result = parseSubagentMeta('{"agentType":123,"spawnDepth":"not-a-number"}');
    expect(result.agentType).toBeUndefined();
    expect(result.spawnDepth).toBeUndefined();
    expect(result.parseErrors).toEqual([]);
  });
});
