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
    expect(result.error?.length).toBeGreaterThan(0);
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

// ---------------------------------------------------------------------------
// C5: additional branch-coverage cases for frontmatter.ts / text.ts /
// errors.ts / mcp-names.ts. All inline strings — fully synthetic, no
// fixture files needed per the coverage plan.
// ---------------------------------------------------------------------------

describe('normalizeGlobs (additional branch cases)', () => {
  it('normalizes a numeric scalar to a single stringified entry', () => {
    expect(normalizeGlobs({ globs: 42 })).toEqual(['42']);
  });

  it('strips surrounding quotes from each comma-separated entry', () => {
    expect(normalizeGlobs({ globs: '"src/**", "lib/**"' })).toEqual(['src/**', 'lib/**']);
  });

  it('treats an explicit null globs value as an empty array', () => {
    expect(normalizeGlobs({ globs: null })).toEqual([]);
  });
});

describe('parseFrontmatter (findKeyColon quote handling)', () => {
  it('treats a colon inside a quoted value, an unspaced colon in a URL, a keyless line, a comment, and an empty key as non-separators or skips', () => {
    const md = [
      '---',
      "title: 'a: b'",
      'url: http://example.invalid/x',
      'just text with no colon separator',
      '# a comment line',
      ': value with empty key',
      'foo: bar',
      '---',
      'body text',
    ].join('\n');

    const { frontmatter, body } = parseFrontmatter(md);
    expect(frontmatter).toEqual({
      title: 'a: b',
      url: 'http://example.invalid/x',
      foo: 'bar',
    });
    expect(body).toBe('body text');
  });
});

describe('parseFrontmatter (map edge cases)', () => {
  it('tolerates a blank line inside the frontmatter block', () => {
    const md = ['---', 'a: 1', '', 'b: 2', '---', ''].join('\n');
    expect(parseFrontmatter(md).frontmatter).toEqual({ a: 1, b: 2 });
  });

  it('stops parsing defensively at inconsistent indentation mid-map', () => {
    const md = ['---', 'a: 1', '  b: 2', 'c: 3', '---', ''].join('\n');
    // The indented "b: 2" line breaks the map walk before "c: 3" is reached.
    expect(parseFrontmatter(md).frontmatter).toEqual({ a: 1 });
  });

  it('resolves a bare "key:" with nothing following and no indented block to null', () => {
    const md = ['---', 'key:', 'sibling: value', '---', ''].join('\n');
    expect(parseFrontmatter(md).frontmatter).toEqual({ key: null, sibling: 'value' });
  });

  it('tolerates blank lines between a "key:" and its block list', () => {
    const md = ['---', 'key:', '', '  - a', '  - b', '---', ''].join('\n');
    expect(parseFrontmatter(md).frontmatter).toEqual({ key: ['a', 'b'] });
  });
});

describe('parseFrontmatter (list edge cases)', () => {
  it('tolerates an interior blank line inside a block list', () => {
    const md = ['---', 'items:', '  - a', '', '  - b', '---', ''].join('\n');
    expect(parseFrontmatter(md).frontmatter).toEqual({ items: ['a', 'b'] });
  });

  it('breaks a list at an inconsistent item indent', () => {
    const md = ['---', 'items:', '  - a', '    - b', '---', ''].join('\n');
    expect(parseFrontmatter(md).frontmatter).toEqual({ items: ['a'] });
  });

  it('parses a bare "-" list item as null', () => {
    const md = ['---', 'items:', '  -', '  - b', '---', ''].join('\n');
    expect(parseFrontmatter(md).frontmatter).toEqual({ items: [null, 'b'] });
  });
});

describe('parseFrontmatter (block scalars)', () => {
  it('preserves interior blank lines in a "|" literal block', () => {
    const md = ['---', 'desc: |', '  line one', '', '  line two', '---', ''].join('\n');
    expect(parseFrontmatter(md).frontmatter.desc).toBe('line one\n\nline two');
  });

  it('joins a ">" folded block into paragraphs on a blank-line break', () => {
    const md = ['---', 'desc: >', '  para one line a', '  para one line b', '', '  para two', '---', ''].join('\n');
    expect(parseFrontmatter(md).frontmatter.desc).toBe('para one line a para one line b\n\npara two');
  });

  it('resolves "key: |" with nothing indented under it to an empty string', () => {
    const md = ['---', 'desc: |', 'next: 1', '---', ''].join('\n');
    expect(parseFrontmatter(md).frontmatter).toEqual({ desc: '', next: 1 });
  });

  it('trims trailing blank lines from a block scalar', () => {
    const md = ['---', 'desc: |', '  line one', '  line two', '', '---', ''].join('\n');
    expect(parseFrontmatter(md).frontmatter.desc).toBe('line one\nline two');
  });
});

describe('parseFrontmatter (inline lists)', () => {
  it('parses an empty inline list', () => {
    const md = ['---', 'items: []', '---', ''].join('\n');
    expect(parseFrontmatter(md).frontmatter).toEqual({ items: [] });
  });

  it('does not split on commas inside quoted inline-list entries', () => {
    const md = ['---', 'items: ["a, b", \'c\']', '---', ''].join('\n');
    expect(parseFrontmatter(md).frontmatter).toEqual({ items: ['a, b', 'c'] });
  });
});

describe('parseFrontmatter (parseScalar)', () => {
  it('parses null/~/float/empty-quoted scalars', () => {
    const md = ['---', 'a: null', 'b: ~', 'c: 3.14', 'd: ""', '---', ''].join('\n');
    expect(parseFrontmatter(md).frontmatter).toEqual({ a: null, b: null, c: 3.14, d: '' });
  });
});

describe('parseFrontmatter (quoted keys)', () => {
  it('unquotes both double- and single-quoted keys', () => {
    const md = ['---', '"my key": v1', "'my key two': v2", '---', ''].join('\n');
    expect(parseFrontmatter(md).frontmatter).toEqual({ 'my key': 'v1', 'my key two': 'v2' });
  });
});

describe('parseFrontmatter (unescapeDoubleQuoted)', () => {
  it('handles tab, CR, escaped quote, escaped backslash, and an unknown escape', () => {
    // Raw YAML source line (backslashes are literal, not JS escapes):
    // key: "a\tb\rc\"d\\e\qf"
    const md = `---\n${String.raw`key: "a\tb\rc\"d\\e\qf"`}\n---\n`;
    const { frontmatter } = parseFrontmatter(md);
    expect(frontmatter.key).toBe('a\tb\rc"d\\eqf');
  });
});

describe('clampBlob / utf8ByteLength (multibyte boundaries)', () => {
  // 'a' = 1 byte, 'é' = 2 bytes, '€' = 3 bytes, '😀' = 4 bytes (surrogate
  // pair, 2 UTF-16 code units), 'x' = 1 byte. Cumulative byte offsets:
  // a=1, é=3, €=6, 😀=10, x=11.
  const text = 'aé€😀x';

  it('cuts before a 2-byte character when the budget cannot fit it', () => {
    expect(clampBlob(text, 1)).toBe('a');
    expect(clampBlob(text, 2)).toBe('a');
  });

  it('includes a 2-byte character exactly at its byte boundary', () => {
    expect(clampBlob(text, 3)).toBe('aé');
  });

  it('cuts before a 3-byte character when the budget cannot fit it', () => {
    expect(clampBlob(text, 4)).toBe('aé');
    expect(clampBlob(text, 5)).toBe('aé');
  });

  it('includes a 3-byte character exactly at its byte boundary', () => {
    expect(clampBlob(text, 6)).toBe('aé€');
  });

  it('never splits a surrogate pair when the budget lands inside a 4-byte character', () => {
    for (const n of [7, 8, 9]) {
      const result = clampBlob(text, n);
      expect(result).toBe('aé€');
      // No dangling high surrogate at the end of the result.
      const last = result.charCodeAt(result.length - 1);
      expect(last).not.toBeGreaterThanOrEqual(0xd800);
    }
  });

  it('includes a 4-byte surrogate-pair character exactly at its byte boundary', () => {
    expect(clampBlob(text, 10)).toBe('aé€😀');
  });

  it('leaves text unchanged when maxBytes exactly equals its byte length', () => {
    expect(clampBlob(text, 11)).toBe(text);
  });

  it('returns an empty string when maxBytes is 0', () => {
    expect(clampBlob(text, 0)).toBe('');
    expect(clampBlob('😀', 3)).toBe('');
  });

  it('returns text unchanged when maxBytes is negative', () => {
    expect(clampBlob(text, -1)).toBe(text);
  });

  it('includes a lone surrogate-pair character exactly at its byte boundary', () => {
    expect(clampBlob('😀', 4)).toBe('😀');
  });
});

describe('makeParseError (uuid option)', () => {
  it('sets uuid when provided', () => {
    expect(makeParseError('c', 'm', { uuid: 'u-1' })).toEqual({ code: 'c', message: 'm', uuid: 'u-1' });
  });
});

describe('splitMcpToolName (empty segments)', () => {
  it('returns null for an empty server segment', () => {
    expect(splitMcpToolName('mcp____x')).toBeNull();
  });

  it('returns null for an empty tool segment', () => {
    expect(splitMcpToolName('mcp__srv__')).toBeNull();
  });
});
