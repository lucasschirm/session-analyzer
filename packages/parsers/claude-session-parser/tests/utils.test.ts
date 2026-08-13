import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { stripBom, splitLines, safeJsonParse, clampBlob } from '../src/utils/text.js';
import { makeParseError } from '../src/utils/errors.js';
import { parseFrontmatter, normalizeGlobs } from '../src/utils/frontmatter.js';
import { splitMcpToolName, mcpServerNameToNamespace } from '../src/utils/mcp-names.js';
import { isSkillTool, isAgentTool, ALWAYS_AVAILABLE_TOOLS } from '../src/utils/tool-names.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

describe('stripBom', () => {
  it('strips a leading UTF-8 BOM', () => {
    expect(stripBom('﻿hello')).toBe('hello');
  });

  it('leaves text without a BOM unchanged', () => {
    expect(stripBom('hello')).toBe('hello');
  });

  it('handles an empty string without throwing', () => {
    expect(stripBom('')).toBe('');
  });
});

describe('splitLines', () => {
  it('is CRLF-tolerant and preserves 1-based line numbering across blank lines', () => {
    const content = 'a\r\nb\r\n\r\nc';
    expect(splitLines(content)).toEqual([
      { lineNumber: 1, text: 'a' },
      { lineNumber: 2, text: 'b' },
      { lineNumber: 3, text: '' },
      { lineNumber: 4, text: 'c' },
    ]);
  });

  it('splits plain LF content the same way', () => {
    const content = 'x\ny\nz';
    expect(splitLines(content)).toEqual([
      { lineNumber: 1, text: 'x' },
      { lineNumber: 2, text: 'y' },
      { lineNumber: 3, text: 'z' },
    ]);
  });
});

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse<{ a: number }>('{"a":1}')).toEqual({ value: { a: 1 } });
  });

  it('never throws on invalid JSON — returns an error instead', () => {
    const result = safeJsonParse('{not valid json');
    expect(result.value).toBeNull();
    expect(typeof result.error).toBe('string');
    expect(result.error!.length).toBeGreaterThan(0);
  });
});

describe('clampBlob', () => {
  it('returns text unchanged when under the byte cap', () => {
    expect(clampBlob('hello', 100)).toBe('hello');
  });

  it('returns text unchanged when maxBytes is omitted', () => {
    expect(clampBlob('hello world')).toBe('hello world');
  });

  it('truncates ASCII text to the byte cap', () => {
    expect(clampBlob('hello world', 5)).toBe('hello');
  });

  it('never splits a multi-byte character mid-codepoint', () => {
    // 'h' = 1 byte, 'é' = 2 bytes — a 2-byte budget can only fit 'h'.
    expect(clampBlob('héllo', 2)).toBe('h');
  });
});

describe('makeParseError', () => {
  it('builds the shared ParseError shape with only the provided optional fields', () => {
    expect(makeParseError('invalid_json', 'bad json', { line: 5 })).toEqual({
      code: 'invalid_json',
      message: 'bad json',
      line: 5,
    });
  });

  it('omits uuid/rawSnippet entirely when not provided', () => {
    const error = makeParseError('unknown_entry_type', 'nope');
    expect(error).toEqual({ code: 'unknown_entry_type', message: 'nope' });
    expect('uuid' in error).toBe(false);
    expect('rawSnippet' in error).toBe(false);
  });
});

describe('parseFrontmatter', () => {
  it('parses a folded ">" scalar, a one-level nested map, and an inline list', () => {
    const { frontmatter, body } = parseFrontmatter(readFixture('t1-skill-frontmatter.md'));
    expect(frontmatter.name).toBe('example-policy');
    expect(frontmatter.description).toBe(
      'This skill should be used whenever example-token fidelity matters — ' +
        'extracting tokens, generating component or layout code, or auditing ' +
        'generated code.',
    );
    expect(frontmatter.metadata).toEqual({ version: '0.1.0' });
    expect(frontmatter['allowed-tools']).toEqual(['Read', 'Edit', 'Bash']);
    expect(body).toContain('# Token Governance');
    expect(body).toContain('Body content here.');
  });

  it('parses double-quoted scalars with \\n escapes and an embedded colon', () => {
    const { frontmatter } = parseFrontmatter(readFixture('t1-agent-definition.md'));
    expect(frontmatter.name).toBe('example-agent');
    expect(frontmatter.description).toBe('Line one\nLine two "quoted" and a colon: still fine');
    expect(frontmatter.model).toBe('inherit');
    expect(frontmatter.memory).toBe('user');
  });

  it('parses block lists', () => {
    const { frontmatter } = parseFrontmatter(readFixture('t1-agent-definition.md'));
    expect(frontmatter.tools).toEqual(['Bash', 'Read', 'WebFetch']);
  });

  it('parses single-quoted scalars', () => {
    const { frontmatter } = parseFrontmatter(readFixture('t1-agent-definition.md'));
    expect(frontmatter.color).toBe('blue');
  });

  it('parses a literal "|" block preserving newlines, plus booleans and numbers', () => {
    const { frontmatter } = parseFrontmatter(readFixture('t1-literal-block.md'));
    expect(frontmatter.description).toBe('Line one of the literal block.\nLine two of the literal block.');
    expect(frontmatter.notes).toBe(true);
    expect(frontmatter.count).toBe(42);
  });

  it('returns an empty frontmatter object and the original body when there is no "---" block', () => {
    const original = readFixture('t1-no-frontmatter.md');
    const { frontmatter, body } = parseFrontmatter(original);
    expect(frontmatter).toEqual({});
    expect(body).toBe(original);
  });

  it('never throws and falls back cleanly on an unterminated frontmatter block', () => {
    const original = readFixture('t1-unterminated-frontmatter.md');
    expect(() => parseFrontmatter(original)).not.toThrow();
    const { frontmatter, body } = parseFrontmatter(original);
    expect(frontmatter).toEqual({});
    expect(body).toBe(original);
  });
});

describe('normalizeGlobs', () => {
  it('normalizes a YAML block list under "paths:"', () => {
    const { frontmatter } = parseFrontmatter(readFixture('t1-rule-paths-list.md'));
    expect(normalizeGlobs(frontmatter)).toEqual(['packages/renderer/src/widgets/**', 'packages/example-renderer/**']);
  });

  it('normalizes a comma-separated quoted scalar under "globs:"', () => {
    const { frontmatter } = parseFrontmatter(readFixture('t1-rule-globs-comma.md'));
    expect(normalizeGlobs(frontmatter)).toEqual(['*.ts', '*.tsx']);
  });

  it('returns an empty array when neither key is present', () => {
    expect(normalizeGlobs({})).toEqual([]);
    expect(normalizeGlobs(null)).toEqual([]);
  });
});

describe('splitMcpToolName / mcpServerNameToNamespace', () => {
  it('splits a namespaced MCP tool name', () => {
    expect(splitMcpToolName('mcp__acme_mcp__foo')).toEqual({ server: 'acme_mcp', tool: 'foo' });
  });

  it('preserves hyphens in the namespace', () => {
    expect(splitMcpToolName('mcp__claude-in-chrome__navigate')).toEqual({
      server: 'claude-in-chrome',
      tool: 'navigate',
    });
  });

  it('returns null for names that are not mcp tool names', () => {
    expect(splitMcpToolName('Bash')).toBeNull();
    expect(splitMcpToolName('mcp__onlyOneSegment')).toBeNull();
  });

  it('maps a colon-separated server name to its underscored namespace', () => {
    expect(mcpServerNameToNamespace('acme:mcp')).toBe('acme_mcp');
  });

  it('preserves hyphens when mapping a server name with no colon', () => {
    expect(mcpServerNameToNamespace('claude-in-chrome')).toBe('claude-in-chrome');
  });
});

describe('isSkillTool / isAgentTool', () => {
  it('recognizes the Skill tool', () => {
    expect(isSkillTool('Skill')).toBe(true);
    expect(isSkillTool('Bash')).toBe(false);
  });

  it('recognizes both the current Agent name and the legacy Task name', () => {
    expect(isAgentTool('Agent')).toBe(true);
    expect(isAgentTool('Task')).toBe(true);
  });

  it('does NOT match the unrelated todo-management Task* tools', () => {
    for (const name of ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop']) {
      expect(isAgentTool(name)).toBe(false);
    }
  });
});

describe('ALWAYS_AVAILABLE_TOOLS', () => {
  it('includes the corpus-derived base toolset', () => {
    for (const tool of ['Agent', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write', 'Skill']) {
      expect(ALWAYS_AVAILABLE_TOOLS).toContain(tool);
    }
  });
});
