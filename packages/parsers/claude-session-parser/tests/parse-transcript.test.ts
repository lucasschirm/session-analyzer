import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseSessionTranscript } from '../src/session/parse-transcript.js';
import { accumulateUsage } from '../src/session/aggregate-usage.js';
import { clampBlob } from '../src/utils/text.js';
import type {
  AssistantEntry,
  AttachmentEntry,
  ContentBlock,
  SystemEntry,
  UserEntry,
} from '../src/types/session.js';

function entryAt<T extends { type: string }>(session: { entries: unknown[] }, index: number, type: string): T {
  const entry = session.entries[index] as { type: string } | undefined;
  if (entry?.type !== type) throw new Error(`expected entries[${index}] to be type '${type}', got '${entry?.type}'`);
  return entry as T;
}

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

// ---------------------------------------------------------------------------
// C1 — entry-parsers.ts branch coverage: optional fields, timestamp error
// paths, truncation-signal resolution, and strArr non-array handling.
// ---------------------------------------------------------------------------

describe('parseEntry (via parseSessionTranscript) — optional-fields fixture', () => {
  const content = readFixture('c1-optional-fields.jsonl');
  const session = parseSessionTranscript(content, { skipTimelines: true });

  it('parses all eleven lines', () => {
    expect(session.entries).toHaveLength(11);
  });

  it('missing timestamp -> missing_timestamp ParseError, timestampMs 0, entry kept', () => {
    const entry = session.entries[0];
    expect(entry?.type).toBe('user');
    if (entry?.type !== 'user') throw new Error('expected user entry');
    expect(entry.timestamp).toBe('');
    expect(entry.timestampMs).toBe(0);
    expect('ownerAccountUuid' in entry).toBe(false);
    expect('ownerOrganizationUuid' in entry).toBe(false);
    expect('isAbortedMidStream' in entry).toBe(false);
    expect(session.parseErrors).toContainEqual({
      code: 'missing_timestamp',
      message: 'Entry has no parseable timestamp field',
      line: 1,
      uuid: 'of-1',
    });
  });

  it('unparseable timestamp -> invalid_timestamp ParseError, raw string preserved, timestampMs 0', () => {
    const entry = session.entries[1];
    expect(entry?.type).toBe('user');
    if (entry?.type !== 'user') throw new Error('expected user entry');
    expect(entry.timestamp).toBe('not-a-date');
    expect(entry.timestampMs).toBe(0);
    const err = session.parseErrors.find((e) => e.line === 2);
    expect(err?.code).toBe('invalid_timestamp');
    expect(err?.uuid).toBe('of-2');
  });

  it('copies the rare base optional fields (ownerAccountUuid, ownerOrganizationUuid, isAbortedMidStream) when present', () => {
    const entry = session.entries[2];
    expect(entry?.type).toBe('user');
    if (entry?.type !== 'user') throw new Error('expected user entry');
    expect(entry.ownerAccountUuid).toBe('acct-fake-0001');
    expect(entry.ownerOrganizationUuid).toBe('org-fake-0001');
    expect(entry.isAbortedMidStream).toBe(true);
  });

  it('assistant: non-array message.content -> content: []; diagnostics + attribution/error fields copied', () => {
    const entry = session.entries[3] as AssistantEntry;
    expect(entry.type).toBe('assistant');
    expect(entry.message.content).toEqual([]);
    expect(entry.message.diagnostics?.cache_miss_reason).toEqual({
      type: 'cold_start',
      cache_missed_input_tokens: 42,
    });
    expect(entry.attributionMcpServer).toBe('zephyr:tools');
    expect(entry.attributionMcpTool).toBe('forecast');
    expect(entry.attributionAgent).toBe('docs-drafter');
    expect(entry.error).toEqual({ message: 'synthetic upstream failure' });
    expect(entry.isApiErrorMessage).toBe(true);
    expect(entry.apiErrorStatus).toBe(529);
  });

  function toolResultBlock(entry: UserEntry): (ContentBlock & { truncated?: unknown }) | undefined {
    const content = entry.message.content;
    if (typeof content === 'string') return undefined;
    return content.find((b) => b.type === 'tool_result') as (ContentBlock & { truncated?: unknown }) | undefined;
  }

  it('array-of-text-parts tool_result content carries the inline_char_count marker', () => {
    const entry = session.entries[4] as UserEntry;
    expect(toolResultBlock(entry)?.truncated).toEqual({ kind: 'inline_char_count', droppedChars: 321 });
  });

  it('string-shaped toolUseResult supplies the truncation marker but is never stored as entry.toolUseResult', () => {
    const entry = session.entries[5] as UserEntry;
    expect(toolResultBlock(entry)?.truncated).toEqual({ kind: 'inline_char_count', droppedChars: 77 });
    expect(entry.toolUseResult).toBeUndefined();
  });

  it('toolUseResult.stdout marker resolves the signal when the block itself has none', () => {
    const entry = session.entries[6] as UserEntry;
    expect(toolResultBlock(entry)?.truncated).toEqual({ kind: 'inline_char_count', droppedChars: 55 });
    expect(entry.toolUseResult?.stdout).toContain('characters truncated');
  });

  it('copies the full user optional-field list verbatim', () => {
    const entry = session.entries[7] as UserEntry;
    expect(entry.isMeta).toBe(true);
    expect(entry.promptId).toBe('prompt-fake-0001');
    expect(entry.promptSource).toBe('user-typed');
    expect(entry.origin).toBe('cli');
    expect(entry.permissionMode).toBe('default');
    expect(entry.sourceToolUseID).toBe('tool-prev-1');
    expect(entry.sourceToolAssistantUUID).toBe('of-4');
    expect(entry.toolDenialKind).toBe('user-denied');
    expect(entry.toolEndsTurn).toBe(true);
    expect(entry.isCompactSummary).toBe(false);
    expect(entry.isVisibleInTranscriptOnly).toBe(true);
    expect(entry.interruptedByShutdown).toBe(false);
    expect(entry.interruptedMessageId).toBe('msg-int-fake-1');
    expect(entry.userFeedback).toEqual({ rating: 'up' });
    expect(entry.queuePriority).toBe(3);
    expect(entry.classifierMetaLines).toEqual(['classifier-line-a', 'classifier-line-b']);
  });

  it('parses a stop_hook_summary-shaped system entry with its full optional field set', () => {
    const entry = session.entries[8] as SystemEntry;
    expect(entry.type).toBe('system');
    expect(entry.subtype).toBe('stop_hook_summary');
    expect(entry.toolUseID).toBe('tool-stop-1');
    expect(entry.durationMs).toBe(120);
    expect(entry.messageCount).toBe(4);
    expect(entry.hookCount).toBe(2);
    expect(entry.hookInfos).toEqual([
      { command: 'scripts/lint-check.sh', durationMs: 80 },
      { command: 'scripts/format-check.sh' },
    ]);
    expect('durationMs' in (entry.hookInfos?.[1] ?? {})).toBe(false);
    expect(entry.hookErrors).toEqual([{ command: 'scripts/format-check.sh', error: 'exit 1' }]);
    expect(entry.hookAdditionalContext).toEqual(['Formatting issues were found.']);
    expect(entry.preventedContinuation).toBe(true);
    expect(entry.stopReason).toBe('hook-blocked');
    expect(entry.hasOutput).toBe(true);
    expect(entry.url).toBe('https://example.invalid/hook-run/1');
    expect(entry.logicalParentUuid).toBe('of-4');
    expect(entry.pendingBackgroundAgentCount).toBe(1);
  });

  it('non-string/non-array block content and a marker-less string toolUseResult both resolve to no signal', () => {
    const entry = session.entries[10] as UserEntry;
    expect(toolResultBlock(entry)?.truncated).toBeUndefined();
    expect(entry.toolUseResult).toBeUndefined();
  });

  it('strArr falls back to [] when the raw field is not an array', () => {
    const entry = session.entries[9] as AttachmentEntry;
    expect(entry.attachment.type).toBe('deferred_tools_delta');
    if (entry.attachment.type !== 'deferred_tools_delta') throw new Error('expected deferred_tools_delta');
    expect(entry.attachment.addedNames).toEqual([]);
    expect(entry.attachment.addedLines).toEqual(['Bash']);
  });
});

// ---------------------------------------------------------------------------
// C1 — attachment "zoo": every ClaudeAttachment switch arm not otherwise
// exercised through parseEntry directly.
// ---------------------------------------------------------------------------

describe('parseEntry (via parseSessionTranscript) — attachment zoo fixture', () => {
  const content = readFixture('c1-attachment-zoo.jsonl');
  const session = parseSessionTranscript(content, { skipTimelines: true });
  const attachments = session.entries.filter((e): e is AttachmentEntry => e.type === 'attachment').map((e) => e.attachment);

  it('parses all 27 attachments and discriminates every type correctly', () => {
    expect(attachments.map((a) => a.type)).toEqual([
      'agent_listing_delta',
      'dynamic_skill',
      'invoked_skills',
      'mcp_instructions_delta',
      'nested_memory',
      'compact_file_reference',
      'hook_additional_context',
      'read_truncation_notice',
      'task_reminder',
      'todo_reminder',
      'file',
      'edited_text_file',
      'diagnostics',
      'structured_output',
      'queued_command',
      'plan_mode',
      'plan_mode_exit',
      'auto_mode',
      'auto_mode_exit',
      'agent_mention',
      'date_change',
      'max_turns_reached',
      'hook_non_blocking_error',
      'hook_system_message',
      'hook_success',
      'skill_listing',
      '',
    ]);
  });

  it('agent_listing_delta carries showConcurrencyNote when present', () => {
    const a = attachments[0];
    if (a.type !== 'agent_listing_delta') throw new Error('expected agent_listing_delta');
    expect(a.showConcurrencyNote).toBe(true);
  });

  it('dynamic_skill fields round-trip', () => {
    const a = attachments[1];
    if (a.type !== 'dynamic_skill') throw new Error('expected dynamic_skill');
    expect(a.skillDir).toBe('/home/testuser/.claude/skills/csv-wrangler');
    expect(a.skillNames).toEqual(['csv-wrangler']);
    expect(a.displayPath).toBe('csv-wrangler');
  });

  it('invoked_skills filters out non-record items from skills[]', () => {
    const a = attachments[2];
    if (a.type !== 'invoked_skills') throw new Error('expected invoked_skills');
    expect(a.skills).toHaveLength(1);
    expect(a.skills[0]?.name).toBe('csv-wrangler');
  });

  it('nested_memory.content.globs is copied when present', () => {
    const a = attachments[4];
    if (a.type !== 'nested_memory') throw new Error('expected nested_memory');
    expect(a.content.globs).toEqual(['src/**', 'lib/**']);
    expect(a.content.contentDiffersFromDisk).toBe(true);
  });

  it('compact_file_reference fields round-trip', () => {
    const a = attachments[5];
    if (a.type !== 'compact_file_reference') throw new Error('expected compact_file_reference');
    expect(a.filename).toBe('style.md');
    expect(a.displayPath).toBe('.claude/rules/style.md');
  });

  it('hook_additional_context fields round-trip', () => {
    const a = attachments[6];
    if (a.type !== 'hook_additional_context') throw new Error('expected hook_additional_context');
    expect(a.content).toEqual(['Additional context line one.', 'Additional context line two.']);
    expect(a.hookName).toBe('PreToolUse:lint');
    expect(a.hookEvent).toBe('PreToolUse');
    expect(a.toolUseID).toBe('tool-hook-1');
  });

  it('read_truncation_notice fields round-trip', () => {
    const a = attachments[7];
    if (a.type !== 'read_truncation_notice') throw new Error('expected read_truncation_notice');
    expect(a.banner).toBe('[Showing lines 1-200 of 4000 total, ~12000 tokens, capped at 8000]');
    expect(a.toolUseID).toBe('tool-read-2');
  });

  it('pass-through attachment family round-trips {...raw, type} verbatim', () => {
    expect(attachments[8]).toEqual({ type: 'task_reminder', content: [{ task: 'Update the changelog' }], itemCount: 1 });
    expect(attachments[9]).toEqual({ type: 'todo_reminder', items: [{ status: 'pending', text: 'Write more tests' }] });
    expect(attachments[10]).toEqual({ type: 'file', filename: 'notes.md', content: 'Some synthetic notes.' });
    expect(attachments[11]).toEqual({ type: 'edited_text_file', filename: 'notes.md', snippet: '- added a synthetic line' });
    expect(attachments[12]).toEqual({ type: 'diagnostics', files: ['src/example.ts'], isNew: true });
    expect(attachments[13]).toEqual({ type: 'structured_output', data: { result: 'ok' }, toolUseID: 'tool-structured-1' });
    expect(attachments[14]).toEqual({
      type: 'queued_command',
      prompt: 'Run the linter.',
      commandMode: 'auto',
      timestamp: '2026-08-01T11:05:00.000Z',
    });
    expect(attachments[15]).toEqual({
      type: 'plan_mode',
      reminderType: 'entered',
      isSubAgent: false,
      planFilePath: '/home/testuser/projects/orbit-tracker/.claude/plans/telemetry.md',
      planExists: true,
    });
    expect(attachments[16]).toEqual({
      type: 'plan_mode_exit',
      planFilePath: '/home/testuser/projects/orbit-tracker/.claude/plans/telemetry.md',
      planExists: true,
    });
    expect(attachments[17]).toEqual({ type: 'auto_mode', autoModeConsentFlow: true, bashFirst: false, steerOnly: false });
    expect(attachments[18]).toEqual({ type: 'auto_mode_exit' });
    expect(attachments[19]).toEqual({ type: 'agent_mention', agentType: 'docs-drafter' });
    expect(attachments[20]).toEqual({ type: 'date_change', newDate: '2026-08-02' });
    expect(attachments[21]).toEqual({ type: 'max_turns_reached', maxTurns: 50, turnCount: 50 });
    expect(attachments[22]).toEqual({
      type: 'hook_non_blocking_error',
      hookName: 'PostToolUse:format',
      hookEvent: 'PostToolUse',
      toolUseID: 'tool-hook-2',
      stdout: '',
      stderr: 'formatter failed',
      exitCode: 1,
      command: 'scripts/format-check.sh',
      durationMs: 30,
    });
    expect(attachments[23]).toEqual({
      type: 'hook_system_message',
      content: 'Hook produced a system message.',
      hookName: 'Stop',
      hookEvent: 'Stop',
      toolUseID: 'tool-hook-3',
    });
  });

  it('an attachment with no type field at all is caught by the default arm with unknownType undefined', () => {
    expect(attachments[26]).toEqual({ type: '', note: 'no type field at all on this attachment object' });
    expect(session.unknownTypes).toEqual({});
  });

  describe('clampBlob plumbing via options.maxBlobBytes', () => {
    const clamped = parseSessionTranscript(content, { skipTimelines: true, maxBlobBytes: 8 });
    const clampedAttachments = clamped.entries
      .filter((e): e is AttachmentEntry => e.type === 'attachment')
      .map((e) => e.attachment);

    it('clamps mcp_instructions_delta.addedBlocks entries', () => {
      const original = attachments[3];
      const shrunk = clampedAttachments[3];
      if (original.type !== 'mcp_instructions_delta' || shrunk.type !== 'mcp_instructions_delta') {
        throw new Error('expected mcp_instructions_delta');
      }
      expect(shrunk.addedBlocks[0]).toBe(clampBlob(original.addedBlocks[0] ?? '', 8));
      expect(shrunk.addedBlocks[0]?.length).toBeLessThan(original.addedBlocks[0]?.length ?? 0);
    });

    it('clamps nested_memory.content.rawContent', () => {
      const original = attachments[4];
      const shrunk = clampedAttachments[4];
      if (original.type !== 'nested_memory' || shrunk.type !== 'nested_memory') throw new Error('expected nested_memory');
      expect(shrunk.content.rawContent).toBe(clampBlob(original.content.rawContent, 8));
      expect(shrunk.content.rawContent.length).toBeLessThan(original.content.rawContent.length);
    });

    it('clamps hook_success.stdout', () => {
      const original = attachments[24];
      const shrunk = clampedAttachments[24];
      if (original.type !== 'hook_success' || shrunk.type !== 'hook_success') throw new Error('expected hook_success');
      expect(shrunk.stdout).toBe(clampBlob(original.stdout, 8));
      expect(shrunk.stdout.length).toBeLessThan(original.stdout.length);
    });

    it('clamps skill_listing.content', () => {
      const original = attachments[25];
      const shrunk = clampedAttachments[25];
      if (original.type !== 'skill_listing' || shrunk.type !== 'skill_listing') throw new Error('expected skill_listing');
      expect(shrunk.content).toBe(clampBlob(original.content, 8));
      expect(shrunk.content.length).toBeLessThan(original.content.length);
    });

    it('clamps invoked_skills[].content', () => {
      const original = attachments[2];
      const shrunk = clampedAttachments[2];
      if (original.type !== 'invoked_skills' || shrunk.type !== 'invoked_skills') throw new Error('expected invoked_skills');
      expect(shrunk.skills[0]?.content).toBe(clampBlob(original.skills[0]?.content ?? '', 8));
      expect((shrunk.skills[0]?.content.length ?? 0)).toBeLessThan(original.skills[0]?.content.length ?? 0);
    });
  });
});

// ---------------------------------------------------------------------------
// C1 — aggregate-usage.ts residual branch: non-numeric usage fields.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// C1 — sparse/minimal entries: exercises the `?? <default>` fallback side of
// every optional-field extraction, plus the `isRecord(...) ? ... : {}`
// fallback for missing nested objects (message/attachment/backup/
// worktreeSession/compactMetadata sub-objects), which the happy-path and
// optional-fields fixtures above never reach because they always supply a
// well-formed value for every field they touch.
// ---------------------------------------------------------------------------

describe('parseEntry (via parseSessionTranscript) — sparse/minimal-fields fixture', () => {
  const content = readFixture('c1-sparse-entries.jsonl');
  const session = parseSessionTranscript(content, { skipTimelines: true });

  it('parses all 34 lines and keeps every entry despite near-total field omission', () => {
    expect(session.entries).toHaveLength(34);
  });

  it('a bare {"type":"assistant"} defaults uuid/sessionId to "" and content to [], and records missing_timestamp with no uuid on the error', () => {
    const entry = entryAt<AssistantEntry>(session, 0, 'assistant');
    expect(entry.uuid).toBe('');
    expect(entry.sessionId).toBe('');
    expect(entry.timestamp).toBe('');
    expect(entry.timestampMs).toBe(0);
    expect(entry.message.content).toEqual([]);
    const err = session.parseErrors.find((e) => e.line === 1);
    expect(err).toEqual({ code: 'missing_timestamp', message: 'Entry has no parseable timestamp field', line: 1 });
    expect(err && 'uuid' in err).toBe(false);
  });

  it('a bare {"type":"user"} defaults message.content to [] via the missing-message fallback', () => {
    const entry = entryAt<UserEntry>(session, 1, 'user');
    expect(entry.message.content).toEqual([]);
  });

  it('a system entry with no subtype and sparse nested objects hits every ?? fallback at once', () => {
    const entry = entryAt<SystemEntry>(session, 2, 'system');
    expect(entry.subtype).toBe('');
    expect(entry.hookInfos).toEqual([{ command: '' }]);
    expect(entry.compactMetadata).toEqual({
      trigger: '',
      preTokens: 0,
      postTokens: 0,
      cumulativeDroppedTokens: 0,
      durationMs: 0,
      preservedSegment: { headUuid: '', anchorUuid: '', tailUuid: '' },
      preservedMessages: { anchorUuid: '', uuids: [], allUuids: [] },
    });
  });

  it('an attachment entry with no "attachment" key at all falls back to the unknown-type default arm', () => {
    const entry = entryAt<AttachmentEntry>(session, 3, 'attachment');
    expect(entry.attachment).toEqual({ type: '' });
  });

  it('deferred_tools_delta with only {type} defaults addedLines/removedNames to []', () => {
    const entry = entryAt<AttachmentEntry>(session, 4, 'attachment');
    if (entry.attachment.type !== 'deferred_tools_delta') throw new Error('expected deferred_tools_delta');
    expect(entry.attachment.addedNames).toEqual([]);
    expect(entry.attachment.addedLines).toEqual([]);
    expect(entry.attachment.removedNames).toEqual([]);
  });

  it('agent_listing_delta with only {type} defaults every array/bool field', () => {
    const entry = entryAt<AttachmentEntry>(session, 5, 'attachment');
    if (entry.attachment.type !== 'agent_listing_delta') throw new Error('expected agent_listing_delta');
    expect(entry.attachment.addedTypes).toEqual([]);
    expect(entry.attachment.addedLines).toEqual([]);
    expect(entry.attachment.removedTypes).toEqual([]);
    expect(entry.attachment.isInitial).toBe(false);
  });

  it('skill_listing with only {type} defaults names/content/skillCount/isInitial', () => {
    const entry = entryAt<AttachmentEntry>(session, 6, 'attachment');
    if (entry.attachment.type !== 'skill_listing') throw new Error('expected skill_listing');
    expect(entry.attachment.names).toEqual([]);
    expect(entry.attachment.content).toBe('');
    expect(entry.attachment.skillCount).toBe(0);
    expect(entry.attachment.isInitial).toBe(false);
  });

  it('dynamic_skill with only {type} defaults skillDir/skillNames/displayPath', () => {
    const entry = entryAt<AttachmentEntry>(session, 7, 'attachment');
    if (entry.attachment.type !== 'dynamic_skill') throw new Error('expected dynamic_skill');
    expect(entry.attachment.skillDir).toBe('');
    expect(entry.attachment.skillNames).toEqual([]);
    expect(entry.attachment.displayPath).toBe('');
  });

  it('invoked_skills with a bare {} item defaults name/path/content on that item', () => {
    const entry = entryAt<AttachmentEntry>(session, 8, 'attachment');
    if (entry.attachment.type !== 'invoked_skills') throw new Error('expected invoked_skills');
    expect(entry.attachment.skills).toEqual([{ name: '', path: '', content: '' }]);
  });

  it('invoked_skills with skills missing entirely defaults to []', () => {
    const entry = entryAt<AttachmentEntry>(session, 9, 'attachment');
    if (entry.attachment.type !== 'invoked_skills') throw new Error('expected invoked_skills');
    expect(entry.attachment.skills).toEqual([]);
  });

  it('mcp_instructions_delta with only {type} defaults addedNames/addedBlocks/removedNames', () => {
    const entry = entryAt<AttachmentEntry>(session, 10, 'attachment');
    if (entry.attachment.type !== 'mcp_instructions_delta') throw new Error('expected mcp_instructions_delta');
    expect(entry.attachment.addedNames).toEqual([]);
    expect(entry.attachment.addedBlocks).toEqual([]);
    expect(entry.attachment.removedNames).toEqual([]);
  });

  it('command_permissions with only {type} defaults allowedTools to []', () => {
    const entry = entryAt<AttachmentEntry>(session, 11, 'attachment');
    if (entry.attachment.type !== 'command_permissions') throw new Error('expected command_permissions');
    expect(entry.attachment.allowedTools).toEqual([]);
  });

  it('nested_memory with only {type} defaults every field including the missing content sub-object', () => {
    const entry = entryAt<AttachmentEntry>(session, 12, 'attachment');
    if (entry.attachment.type !== 'nested_memory') throw new Error('expected nested_memory');
    expect(entry.attachment.path).toBe('');
    expect(entry.attachment.content).toEqual({
      path: '',
      type: 'Unknown',
      content: '',
      contentDiffersFromDisk: false,
      rawContent: '',
    });
  });

  it('compact_file_reference with only {type} defaults filename/displayPath', () => {
    const entry = entryAt<AttachmentEntry>(session, 13, 'attachment');
    if (entry.attachment.type !== 'compact_file_reference') throw new Error('expected compact_file_reference');
    expect(entry.attachment.filename).toBe('');
    expect(entry.attachment.displayPath).toBe('');
  });

  it('hook_success with only {type} defaults every string/number field', () => {
    const entry = entryAt<AttachmentEntry>(session, 14, 'attachment');
    if (entry.attachment.type !== 'hook_success') throw new Error('expected hook_success');
    expect(entry.attachment.hookName).toBe('');
    expect(entry.attachment.hookEvent).toBe('');
    expect(entry.attachment.toolUseID).toBe('');
    expect(entry.attachment.content).toBe('');
    expect(entry.attachment.stdout).toBe('');
    expect(entry.attachment.stderr).toBe('');
    expect(entry.attachment.exitCode).toBe(0);
    expect(entry.attachment.command).toBe('');
    expect(entry.attachment.durationMs).toBe(0);
  });

  it('hook_additional_context with only {type} defaults content/hookName/hookEvent/toolUseID', () => {
    const entry = entryAt<AttachmentEntry>(session, 15, 'attachment');
    if (entry.attachment.type !== 'hook_additional_context') throw new Error('expected hook_additional_context');
    expect(entry.attachment.content).toEqual([]);
    expect(entry.attachment.hookName).toBe('');
    expect(entry.attachment.hookEvent).toBe('');
    expect(entry.attachment.toolUseID).toBe('');
  });

  it('read_truncation_notice with only {type} defaults banner/toolUseID', () => {
    const entry = entryAt<AttachmentEntry>(session, 16, 'attachment');
    if (entry.attachment.type !== 'read_truncation_notice') throw new Error('expected read_truncation_notice');
    expect(entry.attachment.banner).toBe('');
    expect(entry.attachment.toolUseID).toBe('');
  });

  it('bare uuid-less bookkeeping entries default every field to "" / 0 / false', () => {
    expect(session.entries[17]).toEqual({ type: 'mode', mode: '', sessionId: '', lineNumber: 18 });
    expect(session.entries[18]).toEqual({
      type: 'permission-mode',
      permissionMode: '',
      sessionId: '',
      lineNumber: 19,
    });
    expect(session.entries[19]).toEqual({ type: 'ai-title', aiTitle: '', sessionId: '', lineNumber: 20 });
    expect(session.entries[20]).toEqual({
      type: 'last-prompt',
      lastPrompt: '',
      leafUuid: '',
      sessionId: '',
      lineNumber: 21,
    });
    expect(session.entries[21]).toEqual({ type: 'agent-name', agentName: '', sessionId: '', lineNumber: 22 });
    expect(session.entries[22]).toEqual({
      type: 'pr-link',
      sessionId: '',
      prNumber: 0,
      prUrl: '',
      prRepository: '',
      timestamp: '',
      lineNumber: 23,
    });
    expect(session.entries[23]).toEqual({
      type: 'bridge-session',
      sessionId: '',
      bridgeSessionId: '',
      lastSequenceNum: 0,
      lineNumber: 24,
    });
    expect(session.entries[24]).toEqual({
      type: 'queue-operation',
      operation: '',
      timestamp: '',
      sessionId: '',
      content: '',
      lineNumber: 25,
    });
    expect(session.entries[25]).toEqual({
      type: 'file-history-snapshot',
      messageId: '',
      snapshot: undefined,
      isSnapshotUpdate: false,
      lineNumber: 26,
    });
    expect(session.entries[28]).toEqual({ type: 'relocated', sessionId: '', relocatedCwd: '', lineNumber: 29 });
    expect(session.entries[30]).toEqual({ type: 'summary', summary: '', leafUuid: '', lineNumber: 31 });
  });

  it('file-history-delta with no "backup" key defaults every backup field, backupFileName falling to null', () => {
    const entry = session.entries[26];
    expect(entry).toEqual({
      type: 'file-history-delta',
      messageId: '',
      snapshotMessageId: '',
      trackingPath: '',
      backup: { backupFileName: null, version: 0, backupTime: '', realParentDir: '' },
      timestamp: '',
      lineNumber: 27,
    });
  });

  it('file-history-delta with a string backup.backupFileName keeps it (the non-null ternary branch)', () => {
    const entry = session.entries[27];
    expect(entry).toEqual({
      type: 'file-history-delta',
      messageId: '',
      snapshotMessageId: '',
      trackingPath: '',
      backup: { backupFileName: 'backup-fake-0001.bak', version: 0, backupTime: '', realParentDir: '' },
      timestamp: '',
      lineNumber: 28,
    });
  });

  it('worktree-state with no "worktreeSession" key defaults every nested field', () => {
    const entry = session.entries[29];
    expect(entry).toEqual({
      type: 'worktree-state',
      worktreeSession: {
        originalCwd: '',
        preEnterOriginalCwd: '',
        worktreePath: '',
        worktreeName: '',
        worktreeBranch: '',
        originalBranch: '',
        originalHeadCommit: '',
      },
      lineNumber: 30,
    });
  });

  it('assistant usage: {} defaults every numeric usage field to 0 via entry-parsers own numOr0', () => {
    const entry = entryAt<AssistantEntry>(session, 31, 'assistant');
    expect(entry.message.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it('an empty-string timestamp takes the missing_timestamp path but preserves the empty string (not the missing-field branch)', () => {
    const entry = entryAt<UserEntry>(session, 32, 'user');
    expect(entry.timestamp).toBe('');
    expect(entry.timestampMs).toBe(0);
    const err = session.parseErrors.find((e) => e.uuid === 'sp-empty-ts');
    expect(err?.code).toBe('missing_timestamp');
  });

  it('invalid_timestamp with no uuid at all omits uuid from the ParseError', () => {
    const entry = entryAt<UserEntry>(session, 33, 'user');
    expect(entry.uuid).toBe('');
    expect(entry.timestamp).toBe('not-a-date');
    const err = session.parseErrors.find((e) => e.line === 34);
    expect(err).toEqual({ code: 'invalid_timestamp', message: 'Unparseable timestamp: "not-a-date"', line: 34 });
    expect(err && 'uuid' in err).toBe(false);
  });
});

describe('accumulateUsage — non-numeric usage fields', () => {
  it('treats a non-numeric usage.input_tokens as 0 without throwing', () => {
    const entries = [
      {
        type: 'assistant',
        uuid: 'a-1',
        parentUuid: null,
        timestamp: '2026-08-01T00:00:00.000Z',
        timestampMs: 0,
        isSidechain: false,
        sessionId: 'sess-usage-garbage',
        lineNumber: 1,
        message: {
          role: 'assistant',
          content: [],
          model: 'model-garbage',
          usage: {
            // Cast through unknown: exercising the runtime defensive branch,
            // not something the type system would allow a real caller to do.
            input_tokens: 'not-a-number' as unknown as number,
            output_tokens: 40,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 2,
          },
        },
      },
    ] as unknown as Parameters<typeof accumulateUsage>[0];

    const usage = accumulateUsage(entries);
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(40);
    expect(usage.models['model-garbage']).toEqual({
      inputTokens: 0,
      outputTokens: 40,
      cacheCreationTokens: 5,
      cacheReadTokens: 2,
    });
  });
});
