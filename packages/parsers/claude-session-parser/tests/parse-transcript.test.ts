import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseSessionTranscript } from '../src/session/parse-transcript.js';
import type { AttachmentEntry, ContentBlock, UserEntry } from '../src/types/session.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

describe('parseSessionTranscript — happy path', () => {
  const content = readFixture('t2-happy-path.jsonl');
  const session = parseSessionTranscript(content);

  it('parses every line without a ParseError', () => {
    expect(session.parseErrors).toEqual([]);
  });

  it('produces one entry per non-blank line, with matching lineNumber', () => {
    expect(session.entries).toHaveLength(24);
    expect(session.entries.map((e) => e.lineNumber)).toEqual(
      Array.from({ length: 24 }, (_, i) => i + 1),
    );
  });

  it('discriminates every entry to the right union member', () => {
    const types = session.entries.map((e) => e.type);
    expect(types).toEqual([
      'mode',
      'permission-mode',
      'file-history-snapshot',
      'attachment',
      'attachment',
      'attachment',
      'attachment',
      'attachment',
      'attachment',
      'attachment',
      'user',
      'ai-title',
      'assistant',
      'user',
      'system',
      'last-prompt',
      'agent-name',
      'pr-link',
      'bridge-session',
      'queue-operation',
      'file-history-delta',
      'relocated',
      'worktree-state',
      'summary',
    ]);
  });

  it('parses attachment sub-types correctly', () => {
    const attachments = session.entries.filter((e): e is AttachmentEntry => e.type === 'attachment');
    expect(attachments.map((a) => a.attachment.type)).toEqual([
      'hook_success',
      'deferred_tools_delta',
      'agent_listing_delta',
      'skill_listing',
      'mcp_instructions_delta',
      'nested_memory',
      'command_permissions',
    ]);
  });

  it('preserves assistant message content blocks, usage, and attribution fields', () => {
    const assistant = session.entries.find((e) => e.type === 'assistant');
    if (assistant?.type !== 'assistant') throw new Error('expected assistant entry');
    expect(assistant.message.model).toBe('model-a');
    expect(assistant.message.content).toEqual([
      { type: 'text', text: "I'll read the README first." },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'README.md' } },
    ]);
    expect(assistant.message.usage?.input_tokens).toBe(5);
    expect(assistant.message.usage?.iterations).toHaveLength(1);
    expect(assistant.attributionSkill).toBe('example:doc-summary');
    expect(assistant.attributionPlugin).toBe('example');
  });

  it('keeps session_id (snake) and sessionId (camel) distinct when both are present', () => {
    const raw = { type: 'user', sessionId: 'camel-id', session_id: 'snake-id', uuid: 'x', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } };
    const single = parseSessionTranscript(JSON.stringify(raw));
    const entry = single.entries[0];
    if (entry?.type !== 'user') throw new Error('expected user entry');
    expect(entry.sessionId).toBe('camel-id');
    expect(entry.session_id).toBe('snake-id');
  });

  it('computes aggregateUsage from the one assistant entry present', () => {
    expect(session.aggregateUsage.inputTokens).toBe(5);
    expect(session.aggregateUsage.outputTokens).toBe(40);
    expect(session.aggregateUsage.models['model-a']).toEqual({
      inputTokens: 5,
      outputTokens: 40,
      cacheCreationTokens: 100,
      cacheReadTokens: 20,
    });
  });

  it('folds root singular fields using first-wins semantics', () => {
    expect(session.sessionId).toBe('sess-happy-1');
    expect(session.cwd).toBe('/Users/dev/project');
    expect(session.gitBranch).toBe('main');
    expect(session.aiTitle).toBe('Summarize the README');
    expect(session.agentName).toBe('readme-summarizer');
    expect(session.cliVersions).toEqual(['2.1.200']);
  });

  it('never retains raw JSON by default', () => {
    for (const entry of session.entries) {
      expect((entry as Record<string, unknown>).raw).toBeUndefined();
    }
  });
});

describe('parseSessionTranscript — input normalization', () => {
  it('strips a leading BOM, tolerates CRLF, and skips a blank line while keeping real lineNumber', () => {
    const content = readFixture('t2-bom-crlf.jsonl');
    const session = parseSessionTranscript(content);
    expect(session.parseErrors).toEqual([]);
    expect(session.entries).toHaveLength(2);
    expect(session.entries[0]?.type).toBe('mode');
    expect(session.entries[0]?.lineNumber).toBe(1);
    // Line 2 is blank and skipped — the next real entry is line 3, not 2.
    expect(session.entries[1]?.type).toBe('ai-title');
    expect(session.entries[1]?.lineNumber).toBe(3);
  });
});

describe('parseSessionTranscript — invalid JSON', () => {
  it('records exactly one ParseError for the bad line and keeps parsing the rest', () => {
    const content = readFixture('t2-invalid-json.jsonl');
    const session = parseSessionTranscript(content);
    expect(session.parseErrors).toHaveLength(1);
    expect(session.parseErrors[0]?.code).toBe('invalid_json');
    expect(session.parseErrors[0]?.line).toBe(2);
    expect(session.parseErrors[0]?.rawSnippet).toBeDefined();

    expect(session.entries).toHaveLength(2);
    expect(session.entries[0]).toMatchObject({ type: 'mode', lineNumber: 1 });
    expect(session.entries[1]).toMatchObject({ type: 'ai-title', lineNumber: 3 });
  });

  it('never throws on invalid JSON', () => {
    expect(() => parseSessionTranscript(readFixture('t2-invalid-json.jsonl'))).not.toThrow();
  });
});

describe('parseSessionTranscript — unknown types', () => {
  it('counts unrecognized entry.type and attachment.type in unknownTypes without a ParseError', () => {
    const content = readFixture('t2-unknown-type.jsonl');
    const session = parseSessionTranscript(content);
    expect(session.parseErrors).toEqual([]);
    expect(session.unknownTypes).toEqual({
      'future-entry-kind': 1,
      future_attachment_kind: 1,
    });
    // The unrecognized top-level entry still lands in `entries` as an UnknownEntry.
    const unknownEntry = session.entries.find((e) => e.type === 'future-entry-kind');
    expect(unknownEntry).toBeDefined();
    expect(unknownEntry && 'raw' in unknownEntry ? (unknownEntry as { raw: unknown }).raw : undefined).toBeDefined();
  });
});

describe('parseSessionTranscript — root fields, cwd/gitBranch change mid-session', () => {
  it('keeps the first-seen cwd/gitBranch on the root, while entries carry the full history', () => {
    const content = readFixture('t2-root-fields-first-wins.jsonl');
    const session = parseSessionTranscript(content);
    expect(session.cwd).toBe('/Users/dev/project-a');
    expect(session.gitBranch).toBe('main');
    expect(session.cliVersions).toEqual(['2.1.200', '2.1.300']);

    const [first, second] = session.entries;
    expect(first?.type).toBe('user');
    expect(second?.type).toBe('user');
    if (first?.type === 'user' && second?.type === 'user') {
      expect(first.cwd).toBe('/Users/dev/project-a');
      expect(second.cwd).toBe('/Users/dev/project-b');
      expect(second.gitBranch).toBe('feature-x');
    }
  });
});

describe('parseSessionTranscript — aiTitle last-wins', () => {
  it('uses the last ai-title entry, not the first', () => {
    const content = readFixture('t2-ai-title-last-wins.jsonl');
    const session = parseSessionTranscript(content);
    expect(session.aiTitle).toBe('Second Title (rewritten)');
  });
});

describe('parseSessionTranscript — aggregateUsage', () => {
  const content = readFixture('t2-usage-aggregation.jsonl');
  const session = parseSessionTranscript(content);

  it('sums top-level usage fields across every assistant entry, treating missing usage as 0', () => {
    // model-a: (10+3) input, (20+4) output, (5+0) cache_creation, (2+0) cache_read
    // model-b: 100 input, 200 output
    // u-4: no usage at all -> +0
    // u-5: usage but no model -> input+7, output+8 (still counted at top level)
    expect(session.aggregateUsage.inputTokens).toBe(10 + 3 + 100 + 0 + 7);
    expect(session.aggregateUsage.outputTokens).toBe(20 + 4 + 200 + 0 + 8);
    expect(session.aggregateUsage.cacheCreationTokens).toBe(5);
    expect(session.aggregateUsage.cacheReadTokens).toBe(2);
  });

  it('splits totals per model', () => {
    expect(session.aggregateUsage.models['model-a']).toEqual({
      inputTokens: 13,
      outputTokens: 24,
      cacheCreationTokens: 5,
      cacheReadTokens: 2,
    });
    expect(session.aggregateUsage.models['model-b']).toEqual({
      inputTokens: 100,
      outputTokens: 200,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
  });

  it('does NOT bucket the model-less entry under `models`, but still counts it at the top level', () => {
    expect(Object.keys(session.aggregateUsage.models).sort()).toEqual(['model-a', 'model-b']);
  });

  it('does not double-count usage.iterations — the top-level totals alone match the expected sum', () => {
    // The first entry's usage.iterations mirrors its own top-level fields
    // exactly (input 10 / output 20 / etc). If iterations were summed in
    // addition to the top-level fields, inputTokens would be 20 higher than
    // asserted above (10 extra from the mirrored iteration on model "model-a").
    expect(session.aggregateUsage.models['model-a']?.inputTokens).toBe(13);
  });
});

describe('parseSessionTranscript — retainRaw', () => {
  const content = readFixture('t2-retain-raw.jsonl');

  it('attaches the raw parsed object when retainRaw is true', () => {
    const session = parseSessionTranscript(content, { retainRaw: true });
    const entry = session.entries[0] as UserEntry & { raw?: Record<string, unknown> };
    expect(entry.raw).toBeDefined();
    expect(entry.raw?.type).toBe('user');
    expect(entry.raw?.uuid).toBe('u-1');
  });

  it('omits the raw object by default', () => {
    const session = parseSessionTranscript(content);
    const entry = session.entries[0] as UserEntry & { raw?: Record<string, unknown> };
    expect(entry.raw).toBeUndefined();
  });

  it('omits the raw object when retainRaw is explicitly false', () => {
    const session = parseSessionTranscript(content, { retainRaw: false });
    const entry = session.entries[0] as UserEntry & { raw?: Record<string, unknown> };
    expect(entry.raw).toBeUndefined();
  });
});

describe('parseSessionTranscript — truncation signals', () => {
  const content = readFixture('t2-truncation.jsonl');
  const session = parseSessionTranscript(content, { skipTimelines: true });

  function toolResultBlock(entryIndex: number): (ContentBlock & { truncated?: unknown }) | undefined {
    const entry = session.entries[entryIndex];
    if (entry?.type !== 'user') return undefined;
    const content = entry.message.content;
    if (typeof content === 'string') return undefined;
    return content.find((b) => b.type === 'tool_result') as (ContentBlock & { truncated?: unknown }) | undefined;
  }

  it('parses the inline "[N characters truncated]" marker into an inline_char_count signal', () => {
    const block = toolResultBlock(1);
    expect(block?.truncated).toEqual({ kind: 'inline_char_count', droppedChars: 19506 });
  });

  it('maps toolUseResult.file.truncatedByTokenCap to a file_token_cap signal', () => {
    const block = toolResultBlock(3);
    expect(block?.truncated).toEqual({ kind: 'file_token_cap' });
  });

  it('maps Glob/Grep toolUseResult.truncated to a search_truncated signal', () => {
    const block = toolResultBlock(5);
    expect(block?.truncated).toEqual({ kind: 'search_truncated' });
  });
});

describe('parseSessionTranscript — garbage input never throws', () => {
  it('handles an empty string', () => {
    expect(() => parseSessionTranscript('')).not.toThrow();
    const session = parseSessionTranscript('');
    expect(session.entries).toEqual([]);
    expect(session.parseErrors).toEqual([]);
  });

  it('handles a plain text file (not JSON at all)', () => {
    const text = 'Hello world\nThis is not JSON.\nJust plain text.\n';
    expect(() => parseSessionTranscript(text)).not.toThrow();
    const session = parseSessionTranscript(text);
    expect(session.entries).toEqual([]);
    expect(session.parseErrors.length).toBeGreaterThan(0);
    expect(session.parseErrors.every((e) => e.code === 'invalid_json')).toBe(true);
  });

  it('handles a top-level JSON array instead of JSONL', () => {
    expect(() => parseSessionTranscript('[1, 2, 3]')).not.toThrow();
    const session = parseSessionTranscript('[1, 2, 3]');
    expect(session.parseErrors).toEqual([]);
    // Not a transcript entry object — defensively treated as an unknown entry,
    // never thrown, never crashes downstream aggregation/timeline derivation.
    expect(session.entries).toHaveLength(1);
    expect(session.aggregateUsage.inputTokens).toBe(0);
  });

  it('handles a bare JSON primitive line', () => {
    expect(() => parseSessionTranscript('42')).not.toThrow();
    expect(() => parseSessionTranscript('null')).not.toThrow();
    expect(() => parseSessionTranscript('"just a string"')).not.toThrow();
  });
});

describe('parseSessionTranscript — skipTimelines', () => {
  it('returns empty timeline arrays without throwing when skipTimelines is set', () => {
    const content = readFixture('t2-happy-path.jsonl');
    const session = parseSessionTranscript(content, { skipTimelines: true });
    expect(session.tools).toEqual([]);
    expect(session.skills).toEqual([]);
    expect(session.agents).toEqual([]);
    expect(session.rules).toEqual([]);
    expect(session.mcpServers).toEqual([]);
    expect(session.permissionModes).toEqual([]);
    expect(session.hooks).toEqual([]);
    expect(session.compactions).toEqual([]);
    expect(session.prLinks).toEqual([]);
    expect(session.subagentLaunches).toEqual([]);
  });
});
