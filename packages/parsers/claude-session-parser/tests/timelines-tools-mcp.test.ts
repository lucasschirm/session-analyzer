import { describe, expect, it } from 'vitest';

import { deriveToolTimeline } from '../src/session/timelines/tools.js';
import { deriveMcpTimeline } from '../src/session/timelines/mcp.js';
import type {
  AssistantEntry,
  AttachmentEntry,
  ClaudeAttachment,
  ClaudeCodeEntry,
  ContentBlock,
} from '../src/types/session.js';

// ---------------------------------------------------------------------------
// Fixture builders. `parseSessionTranscript` (T2) may still be a stub on
// this branch, so `ClaudeCodeEntry[]` arrays are built directly here rather
// than parsed from JSONL, per the task brief. Content is distilled/
// anonymized from real transcripts found via:
//   grep -l 'deferred_tools_delta' ~/.claude/projects/*/*.jsonl
//   grep -o '"type":"mcp_instructions_delta"' ~/.claude/projects/*/*.jsonl
// (server names `pep:mcp`, `claude-in-chrome`, `context7`, `devin`; the
// colon-to-underscore tool-name mapping; the LSP-four-days-later delta
// shape; and the `pendingMcpServers` -> tools-offered transition are all
// real, corroborated patterns — see comments in src/session/timelines/mcp.ts).
// ---------------------------------------------------------------------------

let uuidCounter = 0;
function nextUuid(): string {
  uuidCounter += 1;
  return `uuid-${uuidCounter}`;
}

const SESSION_ID = 'session-t3-fixture';
const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_MS = Date.parse('2026-08-01T00:00:00.000Z');

function baseFields(lineNumber: number, timestampMs: number) {
  return {
    uuid: nextUuid(),
    parentUuid: null,
    timestamp: new Date(timestampMs).toISOString(),
    timestampMs,
    isSidechain: false,
    sessionId: SESSION_ID,
    lineNumber,
  };
}

function attachmentEntry(lineNumber: number, timestampMs: number, attachment: ClaudeAttachment): AttachmentEntry {
  return {
    ...baseFields(lineNumber, timestampMs),
    type: 'attachment',
    attachment,
  };
}

function assistantEntry(
  lineNumber: number,
  timestampMs: number,
  content: ContentBlock[],
  extra: Partial<AssistantEntry> = {},
): AssistantEntry {
  return {
    ...baseFields(lineNumber, timestampMs),
    type: 'assistant',
    message: { role: 'assistant', content },
    ...extra,
  };
}

let toolUseCounter = 0;
function toolUse(name: string, input: Record<string, unknown> = {}): ContentBlock {
  toolUseCounter += 1;
  return { type: 'tool_use', id: `toolu-${toolUseCounter}`, name, input };
}

// ---------------------------------------------------------------------------
// deriveToolTimeline
// ---------------------------------------------------------------------------

describe('deriveToolTimeline', () => {
  it('returns [] for an empty entry list without throwing', () => {
    expect(deriveToolTimeline([])).toEqual([]);
  });

  it('returns [] for entries with no attachments and no tool_use blocks', () => {
    const entries: ClaudeCodeEntry[] = [
      assistantEntry(1, BASE_MS, [{ type: 'text', text: 'hello' }]),
    ];
    expect(deriveToolTimeline(entries)).toEqual([]);
  });

  it('records an initial deferred_tools_delta and a real multi-day-later mid-session delta in chronological order', () => {
    // Distilled from a real corpus session: an initial delta near the top of
    // the transcript, then a single `LSP` addition four days later.
    const initial = attachmentEntry(3, BASE_MS, {
      type: 'deferred_tools_delta',
      addedNames: ['WebFetch', 'WebSearch'],
      addedLines: ['WebFetch', 'WebSearch'],
      removedNames: [],
    });
    const midSession = attachmentEntry(4021, BASE_MS + 4 * DAY_MS, {
      type: 'deferred_tools_delta',
      addedNames: ['LSP'],
      addedLines: ['LSP'],
      removedNames: [],
    });

    const records = deriveToolTimeline([initial, midSession]);

    const lsp = records.find((r) => r.tool === 'LSP');
    expect(lsp).toBeDefined();
    expect(lsp?.availability).toEqual([
      expect.objectContaining({ action: 'deferred', lineNumber: 4021, timestampMs: BASE_MS + 4 * DAY_MS }),
    ]);

    const webFetch = records.find((r) => r.tool === 'WebFetch');
    expect(webFetch?.availability[0]).toMatchObject({ action: 'deferred', lineNumber: 3 });

    // Ordering across the whole session is chronological: WebFetch/WebSearch
    // (line 3) were recorded before LSP (line 4021).
    const order = records.map((r) => r.tool);
    expect(order.indexOf('WebFetch')).toBeLessThan(order.indexOf('LSP'));
  });

  it('models a removal followed by a re-add distinctly from a fresh deferral', () => {
    const deferred = attachmentEntry(10, BASE_MS, {
      type: 'deferred_tools_delta',
      addedNames: ['mcp__devin__ask_question'],
      addedLines: ['mcp__devin__ask_question'],
      removedNames: [],
    });
    const removed = attachmentEntry(730, BASE_MS + 1000, {
      type: 'deferred_tools_delta',
      addedNames: [],
      addedLines: [],
      removedNames: ['mcp__devin__ask_question'],
    });
    const readded = attachmentEntry(900, BASE_MS + 2000, {
      type: 'deferred_tools_delta',
      addedNames: ['mcp__devin__ask_question'],
      addedLines: [],
      removedNames: [],
      readdedNames: ['mcp__devin__ask_question'],
    });

    const records = deriveToolTimeline([deferred, removed, readded]);
    const record = records.find((r) => r.tool === 'mcp__devin__ask_question');
    expect(record?.availability.map((e) => e.action)).toEqual(['deferred', 'removed', 'readded']);
    // mcp-shaped tool name still gets mcpServer/mcpToolName populated even
    // though it's tracked as a plain tool record here.
    expect(record?.mcpServer).toBe('devin');
    expect(record?.mcpToolName).toBe('ask_question');
  });

  it('infers alwaysAvailable for a tool invoked but never present in any deferred_tools_delta, and false for a deferred one', () => {
    const delta = attachmentEntry(1, BASE_MS, {
      type: 'deferred_tools_delta',
      addedNames: ['WebFetch'],
      addedLines: ['WebFetch'],
      removedNames: [],
    });
    const bashCall = assistantEntry(2, BASE_MS + 1000, [toolUse('Bash', { command: 'ls' })]);
    const webFetchCall = assistantEntry(3, BASE_MS + 2000, [toolUse('WebFetch', { url: 'https://example.com' })]);

    const records = deriveToolTimeline([delta, bashCall, webFetchCall]);

    const bash = records.find((r) => r.tool === 'Bash');
    expect(bash?.alwaysAvailable).toBe(true);
    expect(bash?.invocationCount).toBe(1);

    const webFetch = records.find((r) => r.tool === 'WebFetch');
    expect(webFetch?.alwaysAvailable).toBe(false);
  });

  it('parses a description out of an addedLines entry that carries more than the bare name', () => {
    const delta = attachmentEntry(1, BASE_MS, {
      type: 'deferred_tools_delta',
      addedNames: ['DesignSync', 'Monitor'],
      addedLines: ['DesignSync: sync design tokens from Figma', 'Monitor'],
      removedNames: [],
    });

    const records = deriveToolTimeline([delta]);
    const designSync = records.find((r) => r.tool === 'DesignSync');
    expect(designSync?.description).toBe('sync design tokens from Figma');

    const monitor = records.find((r) => r.tool === 'Monitor');
    expect(monitor?.description).toBeUndefined();
  });

  it('derives "undeferred" only from an unambiguous ToolSearch select: query, never from a free-text query', () => {
    const selectCall = assistantEntry(1, BASE_MS, [
      toolUse('ToolSearch', { query: 'select:mcp__pep_mcp__validate_metadata_file,mcp__github__create_pull_request', max_results: 5 }),
    ]);
    const freeTextCall = assistantEntry(2, BASE_MS + 1000, [
      toolUse('ToolSearch', { query: 'notebook jupyter', max_results: 5 }),
    ]);

    const records = deriveToolTimeline([selectCall, freeTextCall]);

    const validate = records.find((r) => r.tool === 'mcp__pep_mcp__validate_metadata_file');
    expect(validate?.availability).toEqual([expect.objectContaining({ action: 'undeferred' })]);

    const createPr = records.find((r) => r.tool === 'mcp__github__create_pull_request');
    expect(createPr?.availability).toEqual([expect.objectContaining({ action: 'undeferred' })]);

    // ToolSearch itself was invoked twice; neither invocation created a
    // spurious 'undeferred' event for ToolSearch or for "notebook"/"jupyter".
    const toolSearch = records.find((r) => r.tool === 'ToolSearch');
    expect(toolSearch?.invocationCount).toBe(2);
    expect(toolSearch?.availability.every((e) => e.action === 'invoked')).toBe(true);
    expect(records.find((r) => r.tool === 'notebook jupyter')).toBeUndefined();
  });

  it('ignores command_permissions attachments entirely (a different axis, permission scoping not availability)', () => {
    const permissions = attachmentEntry(1, BASE_MS, {
      type: 'command_permissions',
      allowedTools: ['Bash', 'Read', 'NeverDeferredOrInvoked'],
    });
    const records = deriveToolTimeline([permissions]);
    expect(records).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deriveMcpTimeline
// ---------------------------------------------------------------------------

describe('deriveMcpTimeline', () => {
  it('returns [] for an empty entry list without throwing', () => {
    expect(deriveMcpTimeline([])).toEqual([]);
  });

  it('returns [] for entries with no MCP-related attachments or invocations', () => {
    const entries: ClaudeCodeEntry[] = [assistantEntry(1, BASE_MS, [toolUse('Bash', {})])];
    expect(deriveMcpTimeline(entries)).toEqual([]);
  });

  it('records mcp_instructions_delta for an initial delta, matching blocks to servers by header rather than array position', () => {
    // Distilled from a real corpus mcp_instructions_delta: three servers
    // added at once, including the plugin-qualified duplicate of context7.
    const delta = attachmentEntry(8, BASE_MS, {
      type: 'mcp_instructions_delta',
      addedNames: ['claude-in-chrome', 'context7'],
      addedBlocks: [
        '## claude-in-chrome\nAutomates the Chrome browser via a connected extension.',
        '## context7\nFetches current library documentation. … [truncated]',
      ],
      removedNames: [],
    });

    const records = deriveMcpTimeline([delta]);
    const chrome = records.find((r) => r.server === 'claude-in-chrome');
    const context7 = records.find((r) => r.server === 'context7');

    expect(chrome?.instructions).toBe('Automates the Chrome browser via a connected extension.');
    expect(chrome?.availability).toEqual([expect.objectContaining({ action: 'instructions_added', lineNumber: 8 })]);
    // The literal "… [truncated]" suffix is retained verbatim.
    expect(context7?.instructions).toBe('Fetches current library documentation. … [truncated]');
  });

  it('clears instructions on instructions_removed and records the event', () => {
    const added = attachmentEntry(1, BASE_MS, {
      type: 'mcp_instructions_delta',
      addedNames: ['devin'],
      addedBlocks: ['## devin\nManages autonomous Devin sessions.'],
      removedNames: [],
    });
    const removed = attachmentEntry(2, BASE_MS + 1000, {
      type: 'mcp_instructions_delta',
      addedNames: [],
      addedBlocks: [],
      removedNames: ['devin'],
    });

    const records = deriveMcpTimeline([added, removed]);
    const devin = records.find((r) => r.server === 'devin');
    expect(devin?.instructions).toBeUndefined();
    expect(devin?.availability.map((e) => e.action)).toEqual(['instructions_added', 'instructions_removed']);
  });

  it('round-trips colon-to-underscore server naming, including a hyphenated server name, back from mcp__ tool names', () => {
    // Real gotcha (spec §2/MCP): .mcp.json declares "pep:mcp"; the tool name
    // embeds it as mcp__pep_mcp__<tool>. Establish the literal name first
    // via attributionMcpServer (as Claude Code itself reports it, colon
    // intact), matching how a real transcript actually surfaces it.
    const attributed = assistantEntry(
      1,
      BASE_MS,
      [{ type: 'text', text: 'Validating metadata…' }],
      { attributionMcpServer: 'pep:mcp', attributionMcpTool: 'validate_metadata_file' },
    );
    const invokePep = assistantEntry(2, BASE_MS + 1000, [
      toolUse('mcp__pep_mcp__validate_metadata_file', { tableUuid: 'abc' }),
    ]);
    // claude-in-chrome has a hyphen, no colon — namespace mapping is the
    // identity function here (hyphens are preserved as-is).
    const invokeChrome = assistantEntry(3, BASE_MS + 2000, [
      toolUse('mcp__claude-in-chrome__computer', { action: 'screenshot' }),
    ]);

    const records = deriveMcpTimeline([attributed, invokePep, invokeChrome]);

    const pep = records.find((r) => r.server === 'pep:mcp');
    expect(pep?.toolNamespace).toBe('pep_mcp');
    expect(pep?.invokedTools).toEqual([{ tool: 'validate_metadata_file', count: 1 }]);
    expect(pep?.availability).toEqual([expect.objectContaining({ action: 'invoked', lineNumber: 2 })]);

    const chrome = records.find((r) => r.server === 'claude-in-chrome');
    expect(chrome?.toolNamespace).toBe('claude-in-chrome');
    expect(chrome?.invokedTools).toEqual([{ tool: 'computer', count: 1 }]);
  });

  it('aggregates repeated invocations of the same MCP tool into a single count entry', () => {
    const entries: ClaudeCodeEntry[] = [
      assistantEntry(1, BASE_MS, [toolUse('mcp__pep_mcp__generate_ulid', {})]),
      assistantEntry(2, BASE_MS + 1000, [toolUse('mcp__pep_mcp__generate_ulid', {})]),
      assistantEntry(3, BASE_MS + 2000, [toolUse('mcp__pep_mcp__generate_ulid', {})]),
    ];
    const records = deriveMcpTimeline(entries);
    const pep = records.find((r) => r.server === 'pep_mcp'); // no literal-name signal observed — falls back to the namespace itself
    expect(pep?.invokedTools).toEqual([{ tool: 'generate_ulid', count: 3 }]);
    expect(pep?.availability).toHaveLength(3);
  });

  it('marks a server pending, then clears pending once its tools are actually offered (real transition: pendingMcpServers -> addedNames)', () => {
    // Distilled from a real corpus session: a `pendingMcpServers: ["devin"]`
    // delta followed later by an `addedNames: ["mcp__devin__..."]` delta.
    const pending = attachmentEntry(730, BASE_MS, {
      type: 'deferred_tools_delta',
      addedNames: [],
      addedLines: [],
      removedNames: [],
      pendingMcpServers: ['devin'],
    });
    const connected = attachmentEntry(734, BASE_MS + 1000, {
      type: 'deferred_tools_delta',
      addedNames: ['mcp__devin__ask_question', 'mcp__devin__generate_wiki'],
      addedLines: ['mcp__devin__ask_question', 'mcp__devin__generate_wiki'],
      removedNames: [],
    });

    const [afterPending] = deriveMcpTimeline([pending]);
    expect(afterPending.pending).toBe(true);
    expect(afterPending.availability).toEqual([expect.objectContaining({ action: 'pending' })]);

    const records = deriveMcpTimeline([pending, connected]);
    const devin = records.find((r) => r.server === 'devin');
    expect(devin?.pending).toBe(false);
    expect(devin?.offeredTools.sort()).toEqual(['ask_question', 'generate_wiki']);
    expect(devin?.availability.map((e) => e.action)).toEqual(['pending', 'tools_offered']);
  });

  it('marks a server needs_auth, distinct from pending, and clears needsAuth once tools are offered', () => {
    const needsAuth = attachmentEntry(1, BASE_MS, {
      type: 'deferred_tools_delta',
      addedNames: [],
      addedLines: [],
      removedNames: [],
      needsAuthMcpServers: ['plugin:github:github'],
    });
    const records = deriveMcpTimeline([needsAuth]);
    const github = records.find((r) => r.server === 'plugin:github:github');
    expect(github?.needsAuth).toBe(true);
    expect(github?.pending).toBe(false);
    expect(github?.availability).toEqual([expect.objectContaining({ action: 'needs_auth' })]);
  });

  it('removes an offered tool from offeredTools and records tools_removed', () => {
    const offered = attachmentEntry(1, BASE_MS, {
      type: 'deferred_tools_delta',
      addedNames: ['mcp__context7__resolve-library-id', 'mcp__context7__query-docs'],
      addedLines: ['mcp__context7__resolve-library-id', 'mcp__context7__query-docs'],
      removedNames: [],
    });
    const removed = attachmentEntry(2, BASE_MS + 1000, {
      type: 'deferred_tools_delta',
      addedNames: [],
      addedLines: [],
      removedNames: ['mcp__context7__resolve-library-id'],
    });

    const records = deriveMcpTimeline([offered, removed]);
    const context7 = records.find((r) => r.server === 'context7');
    expect(context7?.offeredTools).toEqual(['query-docs']);
    expect(context7?.availability.map((e) => e.action)).toEqual(['tools_offered', 'tools_removed']);
  });

  it('does not count sticky attributionMcpServer/attributionMcpTool turns as invocations', () => {
    // Real transcripts keep attributionMcpServer/attributionMcpTool set
    // across many subsequent turns whose actual tool_use is unrelated
    // (Bash, Read, TaskUpdate, ...) — only real mcp__* tool_use blocks
    // should count.
    const entries: ClaudeCodeEntry[] = [
      assistantEntry(1, BASE_MS, [toolUse('mcp__pep_mcp__validate_metadata_file', {})], {
        attributionMcpServer: 'pep:mcp',
        attributionMcpTool: 'validate_metadata_file',
      }),
      assistantEntry(2, BASE_MS + 1000, [toolUse('Bash', { command: 'ls' })], {
        attributionMcpServer: 'pep:mcp',
        attributionMcpTool: 'validate_metadata_file',
      }),
      assistantEntry(3, BASE_MS + 2000, [toolUse('Read', { file_path: '/x' })], {
        attributionMcpServer: 'pep:mcp',
        attributionMcpTool: 'validate_metadata_file',
      }),
    ];

    const records = deriveMcpTimeline(entries);
    const pep = records.find((r) => r.server === 'pep:mcp');
    expect(pep?.invokedTools).toEqual([{ tool: 'validate_metadata_file', count: 1 }]);
    expect(pep?.availability).toHaveLength(1);
  });
});
