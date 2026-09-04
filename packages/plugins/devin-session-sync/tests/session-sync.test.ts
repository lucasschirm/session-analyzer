import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildObjectKey,
  type DiscoveryResult,
  type PutObjectInput,
  type PutObjectResult,
  type StorageAdapter,
  sha256Hex,
} from '@lucasschirm/sal-sync';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DevinHarnessProfile } from '../src/devin-profile.js';
import { buildDevinJsonl } from '../src/extractor/jsonl-writer.js';
import type {
  DevinExtractedTables,
  DevinMessageNodeRow,
  DevinPromptHistoryRow,
  DevinSchemaDescriptor,
  DevinSessionRow,
  DevinToolCallStateRow,
} from '../src/extractor/types.js';
import {
  applyHardBlocklist,
  buildSchemaDescriptorCandidate,
  devinSessionStateKey,
  discoverSessionPlanCandidates,
  extractPlanFrontmatterSessionId,
  materializeSessionTranscript,
  readAtifTranscriptCandidate,
  runDevinSessionSync,
} from '../src/session-sync.js';
import { devinModelsCaptureOptions } from './models/fixture.js';

class RecordingStorageAdapter implements StorageAdapter {
  readonly calls: PutObjectInput[] = [];
  private readonly objects = new Map<string, { body: Uint8Array; sha256: string }>();

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const key = buildObjectKey(input);
    const sha256 = input.contentSha256 ?? sha256Hex(Buffer.from(input.body).toString('utf8'));
    this.calls.push(input);
    this.objects.set(key, { body: input.body, sha256 });
    return { key, sha256, etag: `"${sha256}"` };
  }

  getStoredContent(key: string): string | undefined {
    const existing = this.objects.get(key);
    return existing ? Buffer.from(existing.body).toString('utf8') : undefined;
  }
}

const SCHEMA_DESCRIPTOR: DevinSchemaDescriptor = {
  devinCliVersion: '3000.6.7',
  refineryVersion: 16,
  refineryMigrations: [],
  tableChecksums: {},
  supported: true,
  warnings: [],
};

function sessionRow(overrides: Partial<DevinSessionRow> = {}): DevinSessionRow {
  return {
    id: 'sess-1',
    working_directory: '/tmp',
    backend_type: null,
    model: null,
    agent_mode: null,
    created_at: null,
    last_activity_at: 500,
    title: null,
    main_chain_id: null,
    cogs_json: null,
    workspace_dirs: null,
    hidden: null,
    metadata: null,
    ...overrides,
  };
}

function messageRow(overrides: Partial<DevinMessageNodeRow> = {}): DevinMessageNodeRow {
  return {
    row_id: 1,
    session_id: 'sess-1',
    node_id: 1,
    parent_node_id: null,
    chat_message: '{"role":"user","content":"hi"}',
    created_at: 1,
    metadata: null,
    ...overrides,
  };
}

function promptRow(overrides: Partial<DevinPromptHistoryRow> = {}): DevinPromptHistoryRow {
  return { id: 1, content: 'hi', timestamp: 1, session_id: 'sess-1', is_shell: 0, ...overrides };
}

function toolCallRow(overrides: Partial<DevinToolCallStateRow> = {}): DevinToolCallStateRow {
  return {
    row_id: 1,
    session_id: 'sess-1',
    tool_call_id: 'call-1',
    tool_call_json: '{}',
    tool_call_update_json: null,
    ...overrides,
  };
}

function tablesOf(overrides: Partial<DevinExtractedTables> = {}): DevinExtractedTables {
  return { sessions: [], messageNodes: [], promptHistory: [], toolCallStates: [], ...overrides };
}

// --- Subagent cross-pass correlation fixtures (regression: issue reported
// alongside #286) -----------------------------------------------------------

function subagentNode(
  rowId: number,
  nodeId: number,
  parentNodeId: number | null,
  chatMessage: Record<string, unknown>,
): DevinMessageNodeRow {
  return messageRow({
    row_id: rowId,
    node_id: nodeId,
    parent_node_id: parentNodeId,
    chat_message: JSON.stringify(chatMessage),
  });
}

function runSubagentToolCall(toolCallId: string, task: string): DevinToolCallStateRow {
  return toolCallRow({
    row_id: 1,
    tool_call_id: toolCallId,
    tool_call_json: JSON.stringify({
      toolCallId,
      rawInput: { profile: 'subagent_explore', task },
      _meta: { 'cognition.ai/inferenceToolName': 'run_subagent' },
    }),
  });
}

function syntheticMessageLines(content: string): Array<Record<string, unknown>> {
  return content
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((l) => l.type === 'message' && l.row_id === -1);
}

describe('materializeSessionTranscript', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-materialize-'));
  });

  afterEach(async () => {
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it("writes only the given session's rows to <dataDir>/devin/transcripts/<sessionId>.jsonl", async () => {
    const tables: DevinExtractedTables = {
      sessions: [
        {
          id: 'sess-1',
          working_directory: '/tmp',
          backend_type: null,
          model: null,
          agent_mode: null,
          created_at: null,
          last_activity_at: 500,
          title: null,
          main_chain_id: null,
          cogs_json: null,
          workspace_dirs: null,
          hidden: null,
          metadata: null,
        },
        {
          id: 'sess-2',
          working_directory: '/tmp',
          backend_type: null,
          model: null,
          agent_mode: null,
          created_at: null,
          last_activity_at: 999,
          title: null,
          main_chain_id: null,
          cogs_json: null,
          workspace_dirs: null,
          hidden: null,
          metadata: null,
        },
      ],
      messageNodes: [],
      promptHistory: [],
      toolCallStates: [],
    };

    const transcriptPath = await materializeSessionTranscript(tables, 'sess-1', dataDir);
    expect(transcriptPath).toBe(path.join(dataDir, 'devin', 'transcripts', 'sess-1.jsonl'));

    const content = await fsp.readFile(transcriptPath, 'utf8');
    expect(content).toContain('"sess-1"');
    expect(content).not.toContain('"sess-2"');
  });

  it("appends only newly-arrived rows on a second call, leaving the first call's content byte-for-byte untouched as a strict prefix", async () => {
    const batch1 = tablesOf({
      sessions: [sessionRow()],
      messageNodes: [messageRow({ row_id: 1, node_id: 1 })],
    });
    const transcriptPath = await materializeSessionTranscript(batch1, 'sess-1', dataDir);
    const afterFirst = await fsp.readFile(transcriptPath, 'utf8');

    const batch2 = tablesOf({
      sessions: [sessionRow()],
      messageNodes: [messageRow({ row_id: 1, node_id: 1 }), messageRow({ row_id: 2, node_id: 2 })],
    });
    await materializeSessionTranscript(batch2, 'sess-1', dataDir);
    const afterSecond = await fsp.readFile(transcriptPath, 'utf8');

    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    const appendedLines = afterSecond.slice(afterFirst.length).trim().split('\n');
    // Exactly the one new message row, plus one more re-appended session line.
    expect(appendedLines).toHaveLength(2);
    expect(appendedLines.some((l) => JSON.parse(l).node_id === 2)).toBe(true);
    expect(appendedLines.filter((l) => JSON.parse(l).type === 'session')).toHaveLength(1);
  });

  it('a session synced twice with no new rows grows by exactly one line (the re-appended session line)', async () => {
    const tables = tablesOf({
      sessions: [sessionRow()],
      messageNodes: [messageRow()],
      promptHistory: [promptRow()],
      toolCallStates: [toolCallRow()],
    });
    const transcriptPath = await materializeSessionTranscript(tables, 'sess-1', dataDir);
    const afterFirst = await fsp.readFile(transcriptPath, 'utf8');
    const firstLineCount = afterFirst.trim().split('\n').length;

    // Same tables again (simulating a re-sync with nothing new since the
    // last pass) — this is the primary "we used to rewrite everything, now
    // we don't" regression proof.
    await materializeSessionTranscript(tables, 'sess-1', dataDir);
    const afterSecond = await fsp.readFile(transcriptPath, 'utf8');

    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    const secondLineCount = afterSecond.trim().split('\n').length;
    expect(secondLineCount - firstLineCount).toBe(1);
    const appended = afterSecond.slice(afterFirst.length).trim();
    expect(JSON.parse(appended).type).toBe('session');
  });

  it('two concurrent syncs of the same session never duplicate rows (FileLock serializes the read-derive-append critical section)', async () => {
    const tables = tablesOf({
      sessions: [sessionRow()],
      messageNodes: [messageRow({ row_id: 1, node_id: 1 })],
      promptHistory: [promptRow({ id: 1 })],
      toolCallStates: [toolCallRow()],
    });

    // Two independent "processes" (e.g. a hook and the watcher poll loop)
    // racing to sync the SAME session with the SAME source snapshot. Without
    // FileLock, each would independently read "no existing file"/"no prior
    // watermark" and each append its own full copy of every row — permanent
    // duplication the old full-rewrite never risked (this issue found and
    // fixed during PR review, since append-only isn't self-correcting under
    // a race the way a full rewrite was).
    const [pathA, pathB] = await Promise.all([
      materializeSessionTranscript(tables, 'sess-1', dataDir),
      materializeSessionTranscript(tables, 'sess-1', dataDir),
    ]);
    expect(pathA).toBe(pathB);

    const content = await fsp.readFile(pathA, 'utf8');
    const lines = content
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    // `session` lines are intentionally re-appended every call regardless of
    // content (pre-existing last-write-wins replay semantics, unaffected by
    // this fix) — two calls correctly produce two. What the lock actually
    // guards is the watermark-filtered rows: exactly one of each real row,
    // never duplicated by the second call racing the first.
    expect(lines.filter((l) => l.type === 'session')).toHaveLength(2);
    expect(lines.filter((l) => l.type === 'message')).toHaveLength(1);
    expect(lines.filter((l) => l.type === 'prompt')).toHaveLength(1);
    expect(lines.filter((l) => l.type === 'tool_call')).toHaveLength(1);
  });

  it('a legacy full-rewrite fixture file (no watermark tracking assumed) produces no duplicates on the next incremental call', async () => {
    const tables = tablesOf({
      sessions: [sessionRow()],
      messageNodes: [messageRow({ row_id: 1 }), messageRow({ row_id: 2, node_id: 2 })],
      promptHistory: [promptRow({ id: 1 }), promptRow({ id: 2 })],
    });
    const transcriptPath = path.join(dataDir, 'devin', 'transcripts', 'sess-1.jsonl');
    await fsp.mkdir(path.dirname(transcriptPath), { recursive: true });
    // Seed the file exactly as the OLD full-rewrite code would have left it.
    const { text } = buildDevinJsonl(tables);
    await fsp.writeFile(transcriptPath, text, 'utf8');

    await materializeSessionTranscript(tables, 'sess-1', dataDir);
    const content = await fsp.readFile(transcriptPath, 'utf8');

    const messageNodeIds = content
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((l) => l.type === 'message')
      .map((l) => l.node_id);
    expect(messageNodeIds).toEqual([1, 2]); // no duplicates
  });

  it('handles a corrupted mid-file line by skipping it, without losing the rest of the derived watermark or crashing', async () => {
    const tables = tablesOf({
      sessions: [sessionRow()],
      messageNodes: [messageRow({ row_id: 1 })],
    });
    const transcriptPath = path.join(dataDir, 'devin', 'transcripts', 'sess-1.jsonl');
    await fsp.mkdir(path.dirname(transcriptPath), { recursive: true });
    const { text } = buildDevinJsonl(tables);
    await fsp.writeFile(transcriptPath, `${text}{this is not valid json\n`, 'utf8');

    const nextTables = tablesOf({
      sessions: [sessionRow()],
      messageNodes: [messageRow({ row_id: 1 }), messageRow({ row_id: 2, node_id: 2 })],
    });
    await expect(materializeSessionTranscript(nextTables, 'sess-1', dataDir)).resolves.toBe(
      transcriptPath,
    );

    const content = await fsp.readFile(transcriptPath, 'utf8');
    const messageNodeIds = content
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((l): l is { type: string; node_id: number } => l !== null && l.type === 'message')
      .map((l) => l.node_id);
    // row_id:1 was already in the file (behind the derived watermark of 1),
    // so only the genuinely-new row_id:2 is appended.
    expect(messageNodeIds).toEqual([1, 2]);
  });

  it('round-trips chat_message.metadata.generation_model byte-for-byte into a newly-appended message line (Addendum regression)', async () => {
    const chatMessage = JSON.stringify({
      role: 'assistant',
      content: 'done',
      metadata: { generation_model: 'claude-opus-4', effort: 'high' },
    });
    const tables = tablesOf({
      sessions: [sessionRow()],
      messageNodes: [messageRow({ row_id: 1, chat_message: chatMessage })],
    });

    const transcriptPath = await materializeSessionTranscript(tables, 'sess-1', dataDir);
    const content = await fsp.readFile(transcriptPath, 'utf8');
    const messageLine = content
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((l) => l.type === 'message');

    expect(messageLine.chat_message).toBe(chatMessage);
    expect(JSON.parse(messageLine.chat_message).metadata.generation_model).toBe('claude-opus-4');
  });

  it(
    'correlates a subagent completion notification arriving in a LATER sync pass with its ' +
      "tagged node from an EARLIER pass (regression: #286's incremental filtering broke this)",
    async () => {
      const callSite = subagentNode(1, 1, null, { role: 'assistant', content: 'run it bg' });
      const startedPointer = subagentNode(2, 2, 1, {
        role: 'tool',
        content: 'Background subagent started with agent_id=55c47591 running in the background.',
        tool_call_id: 'functions.run_subagent:1',
        metadata: { extensions: { 'subagent/agent_id': '55c47591' } },
      });
      const toolCalls = [
        runSubagentToolCall('functions.run_subagent:1', 'Explore the billing module'),
      ];

      // Pass 1: the tagged "started" pointer and its run_subagent invocation
      // arrive together. No completion yet — a background subagent still
      // running. Only a synthetic prompt line can be produced this pass.
      const pass1Tables = tablesOf({
        sessions: [sessionRow()],
        messageNodes: [callSite, startedPointer],
        toolCallStates: toolCalls,
      });
      const transcriptPath = await materializeSessionTranscript(pass1Tables, 'sess-1', dataDir);
      const afterPass1 = await fsp.readFile(transcriptPath, 'utf8');
      const synthAfterPass1 = syntheticMessageLines(afterPass1);
      expect(synthAfterPass1).toHaveLength(1);
      expect(synthAfterPass1[0]?.chat_message).toContain('Explore the billing module');

      // Pass 2: sessions.db is always read in FULL (per session-sync.ts's own
      // doc comment) — so `tables` here again contains every row, including
      // the pass-1 rows the file already absorbed, PLUS the completion
      // notification that only just arrived. Before the fix, subagent
      // synthetic-line derivation used the internally-filtered "genuinely
      // new" batch (just the notification, missing the tagged node) and
      // silently produced nothing, forever.
      const notification = subagentNode(3, 3, 2, {
        role: 'system',
        content:
          '<subagent_completion_notification>\n[Background subagent with agent_id=55c47591 ' +
          'completed]\n\nfull background report',
      });
      const pass2Tables = tablesOf({
        sessions: [sessionRow()],
        messageNodes: [callSite, startedPointer, notification],
        toolCallStates: toolCalls,
      });
      await materializeSessionTranscript(pass2Tables, 'sess-1', dataDir);
      const afterPass2 = await fsp.readFile(transcriptPath, 'utf8');

      const synthAfterPass2 = syntheticMessageLines(afterPass2);
      // Exactly the original prompt plus the newly-correlated result — the
      // prompt is never duplicated, and a result now exists at all.
      expect(synthAfterPass2).toHaveLength(2);
      const resultLine = synthAfterPass2.find((l) => {
        const bookkeeping = JSON.parse(l.metadata as string);
        return bookkeeping['sal/synthetic_subagent_kind'] === 'result';
      });
      expect(resultLine).toBeDefined();
      const resultContent = JSON.parse(resultLine?.chat_message as string).content;
      expect(resultContent).toBe(
        '<subagent_completion_notification>\n[Background subagent with agent_id=55c47591 ' +
          'completed]\n\nfull background report',
      );
      // The result correlates back to the SAME prompt node minted in pass 1
      // — not a second, duplicate prompt/result pair.
      const promptLine = synthAfterPass2.find((l) => {
        const bookkeeping = JSON.parse(l.metadata as string);
        return bookkeeping['sal/synthetic_subagent_kind'] === 'prompt';
      });
      expect(resultLine?.parent_node_id).toBe(promptLine?.node_id);
      expect(promptLine?.node_id).toBe(synthAfterPass1[0]?.node_id);
    },
  );

  it('does not re-emit an already-written synthetic subagent prompt/result pair on a second sync of unchanged data', async () => {
    const callSite = subagentNode(1, 1, null, {
      role: 'assistant',
      content: 'calling run_subagent',
    });
    const taggedResult = subagentNode(2, 2, 1, {
      role: 'tool',
      content: 'Subagent agent_id=44472e00 completed successfully:\n\nfull foreground report',
      tool_call_id: 'functions.run_subagent:1',
      metadata: { extensions: { 'subagent/agent_id': '44472e00' } },
    });
    const tables = tablesOf({
      sessions: [sessionRow()],
      messageNodes: [callSite, taggedResult],
      toolCallStates: [runSubagentToolCall('functions.run_subagent:1', 'Explore the auth module')],
    });

    const transcriptPath = await materializeSessionTranscript(tables, 'sess-1', dataDir);
    const afterFirst = await fsp.readFile(transcriptPath, 'utf8');
    expect(syntheticMessageLines(afterFirst)).toHaveLength(2); // one prompt + one result

    // Same (unchanged) full tables synced again — simulating the next poll
    // with nothing genuinely new.
    await materializeSessionTranscript(tables, 'sess-1', dataDir);
    const afterSecond = await fsp.readFile(transcriptPath, 'utf8');

    expect(syntheticMessageLines(afterSecond)).toHaveLength(2); // still exactly one pair, not two
  });
});

describe('applyHardBlocklist', () => {
  function discoveryWith(relativePaths: string[]): DiscoveryResult {
    return {
      artifacts: relativePaths.map((relativePath) => ({
        projectId: 'proj',
        sessionId: 'sess',
        scope: 'global' as const,
        relativePath,
        sha256: 'a'.repeat(64),
        size: 10,
        absolutePath: `/tmp/${relativePath}`,
      })),
      errors: [],
      totalBytes: relativePaths.length * 10,
      filesDiscovered: relativePaths.length,
    };
  }

  it('strips credentials.toml, mcp/oauth/**, and logs/** even against a permissive allowlist stub (deny-wins)', () => {
    const discovery = discoveryWith([
      'credentials.toml',
      'nested/credentials.toml',
      'mcp/oauth/token.json',
      'logs/session.log',
      'config.json',
    ]);
    const result = applyHardBlocklist(discovery);
    const kept = result.artifacts.map((a) => a.relativePath);
    expect(kept).toEqual(['config.json']);
    expect(result.filesDiscovered).toBe(1);
    expect(result.totalBytes).toBe(10);
  });

  it('is a no-op when nothing matches the blocklist', () => {
    const discovery = discoveryWith(['config.json', 'AGENTS.md']);
    expect(applyHardBlocklist(discovery)).toBe(discovery);
  });
});

describe('extractPlanFrontmatterSessionId', () => {
  it('extracts the session id from YAML frontmatter', () => {
    const content = '---\nsession: sess-abc\ntitle: Plan\n---\n# Plan body\n';
    expect(extractPlanFrontmatterSessionId(content)).toBe('sess-abc');
  });

  it('handles quoted session ids', () => {
    const content = '---\nsession: "sess-abc"\n---\nbody\n';
    expect(extractPlanFrontmatterSessionId(content)).toBe('sess-abc');
  });

  it('returns undefined when there is no frontmatter', () => {
    expect(extractPlanFrontmatterSessionId('# just a plan\n')).toBeUndefined();
  });

  it('returns undefined when frontmatter has no session field', () => {
    const content = '---\ntitle: Plan\n---\nbody\n';
    expect(extractPlanFrontmatterSessionId(content)).toBeUndefined();
  });
});

describe('discoverSessionPlanCandidates', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-plans-'));
    await fsp.mkdir(path.join(homeDir, '.devin', 'plans'), { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  async function writePlan(fileName: string, sessionId: string | undefined): Promise<void> {
    const frontmatter = sessionId ? `---\nsession: ${sessionId}\n---\n` : '';
    await fsp.writeFile(path.join(homeDir, '.devin', 'plans', fileName), `${frontmatter}# Plan\n`);
  }

  it('includes only plans whose frontmatter session matches the session id', async () => {
    await writePlan('plan-aaa.md', 'sess-1');
    await writePlan('plan-bbb.md', 'sess-2');
    await writePlan('plan-ccc.md', undefined);

    const results = await discoverSessionPlanCandidates(homeDir, 'sess-1', 'proj');
    expect(results).toHaveLength(1);
    expect(results[0]?.candidate.relativePath).toBe('plans/plan-aaa.md');
    expect(results[0]?.candidate.scope).toBe('session');
  });

  it('returns an empty array when the plans directory does not exist', async () => {
    const results = await discoverSessionPlanCandidates(
      path.join(homeDir, 'no-such-home'),
      'sess-1',
      'proj',
    );
    expect(results).toEqual([]);
  });
});

describe('readAtifTranscriptCandidate', () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-atif-'));
  });

  afterEach(async () => {
    await fsp.rm(dataRoot, { recursive: true, force: true });
  });

  it('copies transcripts/<sessionId>.json to native/atif-transcript.json when present', async () => {
    await fsp.mkdir(path.join(dataRoot, 'transcripts'), { recursive: true });
    await fsp.writeFile(path.join(dataRoot, 'transcripts', 'sess-1.json'), '{"native":true}');

    const candidate = await readAtifTranscriptCandidate(dataRoot, 'sess-1', 'proj');
    expect(candidate?.candidate.relativePath).toBe('native/atif-transcript.json');
    expect(candidate?.candidate.scope).toBe('session');
  });

  it('returns undefined when the native transcript is absent', async () => {
    const candidate = await readAtifTranscriptCandidate(dataRoot, 'sess-missing', 'proj');
    expect(candidate).toBeUndefined();
  });
});

describe('buildSchemaDescriptorCandidate', () => {
  it('builds a runtime-scoped native/schema-descriptor.json candidate', () => {
    const candidate = buildSchemaDescriptorCandidate(SCHEMA_DESCRIPTOR, 'proj', 'sess-1');
    expect(candidate.candidate.scope).toBe('runtime');
    expect(candidate.candidate.relativePath).toBe('native/schema-descriptor.json');
    expect(JSON.parse(candidate.candidate.content)).toMatchObject({ devinCliVersion: '3000.6.7' });
  });
});

describe('runDevinSessionSync', () => {
  let dataDir: string;
  let homeDir: string;

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-sync-data-'));
    homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-sync-home-'));
  });

  afterEach(async () => {
    await fsp.rm(dataDir, { recursive: true, force: true });
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  const baseConfig = {
    projectId: 'proj-1',
    disabled: false,
    captureTranscripts: true,
    storage: { type: 's3' as const },
    limits: {
      maxFileBytes: 10_000_000,
      maxTotalBytes: 100_000_000,
      maxFiles: 1000,
      maxTranscriptBytes: 10_000_000,
      maxJsonDepth: 20,
      maxJsonlLineBytes: 1_000_000,
    },
    timeouts: { syncTimeoutMs: 5000, hookUploadTimeoutMs: 5000, sessionEndBudgetMs: 5000 },
    retries: 0,
  };

  const sessionTables: DevinExtractedTables = {
    sessions: [
      {
        id: 'sess-1',
        working_directory: '/tmp/workspace',
        backend_type: 'anthropic',
        model: 'devin-1',
        agent_mode: 'default',
        created_at: 100,
        last_activity_at: 200,
        title: 'Test session',
        main_chain_id: null,
        cogs_json: null,
        workspace_dirs: null,
        hidden: 0,
        metadata: null,
      },
    ],
    messageNodes: [
      {
        row_id: 1,
        session_id: 'sess-1',
        node_id: 1,
        parent_node_id: null,
        chat_message: 'hello with a secret AKIAIOSFODNN7EXAMPLE',
        created_at: 200,
        metadata: null,
      },
    ],
    promptHistory: [
      { id: 1, content: 'do the thing', timestamp: 150, session_id: 'sess-1', is_shell: 0 },
    ],
    toolCallStates: [
      {
        row_id: 1,
        session_id: 'sess-1',
        tool_call_id: 'call-1',
        tool_call_json: '{}',
        tool_call_update_json: null,
      },
    ],
  };

  it('emits a manifest with harness:devin, correct harnessVersion, and all 4 classification keys on every artifact', async () => {
    const storage = new RecordingStorageAdapter();
    const events: string[] = [];

    const outcome = await runDevinSessionSync({
      models: devinModelsCaptureOptions,
      tables: sessionTables,
      schemaDescriptor: SCHEMA_DESCRIPTOR,
      sessionId: 'sess-1',
      cwd: '/tmp/workspace',
      config: baseConfig,
      dataDir,
      storageAdapter: storage,
      trigger: 'manual',
      profile: DevinHarnessProfile,
      homeDir,
      dataRoot: homeDir,
      onProgress: (event) => events.push(event.type),
    });

    expect(outcome.failed).toBe(0);
    expect(events).toContain('progress');
    expect(events[events.length - 1]).toBe('success');

    const manifestCall = storage.calls.find((c) => c.scope === 'manifest');
    if (!manifestCall) throw new Error('expected a manifest upload call');
    const manifest = JSON.parse(Buffer.from(manifestCall.body).toString('utf8'));
    expect(manifest.harness).toBe('devin');
    expect(manifest.harnessVersion).toBe(DevinHarnessProfile.harnessVersion);

    for (const artifact of manifest.artifacts) {
      expect(artifact).toMatchObject({
        projectId: expect.any(String),
        sessionId: 'sess-1',
        scope: expect.any(String),
        relativePath: expect.any(String),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    }

    const scopes = manifest.artifacts.map((a: { scope: string }) => a.scope);
    expect(scopes).toContain('session'); // transcript.jsonl
    expect(scopes).toContain('runtime'); // native/schema-descriptor.json + models

    const artifactPaths = manifest.artifacts.map((a: { relativePath: string }) => a.relativePath);
    expect(artifactPaths).toContain('native/models.json');
    expect(artifactPaths).toContain('native/models-list.raw.json');
  });

  it('resolves dataRoot from home/cwd/env when not explicitly supplied', async () => {
    const storage = new RecordingStorageAdapter();
    const outcome = await runDevinSessionSync({
      models: devinModelsCaptureOptions,
      tables: sessionTables,
      schemaDescriptor: SCHEMA_DESCRIPTOR,
      sessionId: 'sess-1',
      cwd: '/tmp/workspace',
      config: baseConfig,
      dataDir,
      storageAdapter: storage,
      trigger: 'manual',
      profile: DevinHarnessProfile,
      homeDir,
      env: {},
      // dataRoot intentionally omitted — exercises the resolveDevinPaths fallback.
    });
    expect(outcome.failed).toBe(0);
  });

  it('reuses an existing session record on a second sync rather than overwriting startedAt', async () => {
    const storage = new RecordingStorageAdapter();
    const runOnce = () =>
      runDevinSessionSync({
        models: devinModelsCaptureOptions,
        tables: sessionTables,
        schemaDescriptor: SCHEMA_DESCRIPTOR,
        sessionId: 'sess-1',
        cwd: '/tmp/workspace',
        config: baseConfig,
        dataDir,
        storageAdapter: storage,
        trigger: 'manual',
        profile: DevinHarnessProfile,
        homeDir,
        dataRoot: homeDir,
      });

    const first = await runOnce();
    const second = await runOnce();
    expect(first.failed).toBe(0);
    expect(second.failed).toBe(0);
  });

  it('sanitizes captured config JSON before upload', async () => {
    await fsp.mkdir(path.join(homeDir, '.config', 'devin'), { recursive: true });
    await fsp.writeFile(
      path.join(homeDir, '.config', 'devin', 'config.json'),
      JSON.stringify({ apiKey: 'sk-super-secret-value-should-be-redacted' }),
    );

    const storage = new RecordingStorageAdapter();
    await runDevinSessionSync({
      models: devinModelsCaptureOptions,
      tables: sessionTables,
      schemaDescriptor: SCHEMA_DESCRIPTOR,
      sessionId: 'sess-1',
      cwd: '/tmp/workspace-empty',
      config: baseConfig,
      dataDir,
      storageAdapter: storage,
      trigger: 'manual',
      profile: DevinHarnessProfile,
      homeDir,
      dataRoot: homeDir,
    });

    const casCall = storage.calls.find((c) => c.scope === 'global');
    if (!casCall) throw new Error('expected a global-scope upload call');
    const uploadedContent = Buffer.from(casCall.body).toString('utf8');
    expect(uploadedContent).not.toContain('sk-super-secret-value-should-be-redacted');
  });

  it('only includes plans whose frontmatter session matches, end-to-end', async () => {
    await fsp.mkdir(path.join(homeDir, '.devin', 'plans'), { recursive: true });
    await fsp.writeFile(
      path.join(homeDir, '.devin', 'plans', 'plan-match.md'),
      '---\nsession: sess-1\n---\n# Match\n',
    );
    await fsp.writeFile(
      path.join(homeDir, '.devin', 'plans', 'plan-other.md'),
      '---\nsession: sess-other\n---\n# Other\n',
    );

    const storage = new RecordingStorageAdapter();
    await runDevinSessionSync({
      models: devinModelsCaptureOptions,
      tables: sessionTables,
      schemaDescriptor: SCHEMA_DESCRIPTOR,
      sessionId: 'sess-1',
      cwd: '/tmp/workspace-empty',
      config: baseConfig,
      dataDir,
      storageAdapter: storage,
      trigger: 'manual',
      profile: DevinHarnessProfile,
      homeDir,
      dataRoot: homeDir,
    });

    const planKeys = storage.calls
      .filter((c) => c.relativePath.startsWith('plans/'))
      .map((c) => c.relativePath);
    expect(planKeys).toEqual(['plans/plan-match.md']);
  });

  it('records a manifest-upload failure as a terminal failure event without throwing', async () => {
    const failingStorage: StorageAdapter = {
      putObject: async (input) => {
        if (input.scope === 'manifest') {
          throw new Error('manifest upload failed');
        }
        return { key: 'x', sha256: sha256Hex(Buffer.from(input.body).toString('utf8')) };
      },
    };
    const events: string[] = [];

    const outcome = await runDevinSessionSync({
      models: devinModelsCaptureOptions,
      tables: sessionTables,
      schemaDescriptor: SCHEMA_DESCRIPTOR,
      sessionId: 'sess-1',
      cwd: '/tmp/workspace',
      config: baseConfig,
      dataDir,
      storageAdapter: failingStorage,
      trigger: 'manual',
      profile: DevinHarnessProfile,
      homeDir,
      dataRoot: homeDir,
      onProgress: (event) => events.push(event.type),
    });

    expect(outcome.errors.length).toBeGreaterThan(0);
    expect(events[events.length - 1]).toBe('failure');
  });

  it('does not fail the sync when only the models-capture side-capture fails (#266)', async () => {
    const storage = new RecordingStorageAdapter();
    const events: Array<{ type: string; message: string }> = [];

    const outcome = await runDevinSessionSync({
      models: {
        devinCliVersion: 'v1',
        runModelsList: async () => {
          throw new Error('devin cli unavailable');
        },
      },
      tables: sessionTables,
      schemaDescriptor: SCHEMA_DESCRIPTOR,
      sessionId: 'sess-1',
      cwd: '/tmp/workspace',
      config: baseConfig,
      dataDir,
      storageAdapter: storage,
      trigger: 'manual',
      profile: DevinHarnessProfile,
      homeDir,
      dataRoot: homeDir,
      onProgress: (event) => events.push({ type: event.type, message: event.message }),
    });

    // The real session artifacts uploaded fine — a models-capture failure
    // alone must never flip the whole sync to failed.
    expect(outcome.failed).toBe(0);
    expect(outcome.errors).toEqual([]);

    // But it must never be silently dropped either: it is recorded as a
    // distinguishable warning, separate from `errors`, and the mid-stream
    // capture failure is still visible as its own progress event — emitted
    // as 'progress' (never 'failure'), so CLI/hook output never shows a
    // failure-looking line for a sync that ultimately succeeded.
    expect(outcome.warnings).toEqual(['devin cli unavailable']);
    expect(
      events.some((e) => e.type === 'progress' && e.message.includes('devin cli unavailable')),
    ).toBe(true);
    expect(events.some((e) => e.type === 'failure')).toBe(false);
    expect(events[events.length - 1]?.type).toBe('success');
    expect(events[events.length - 1]?.message).toContain('warning');

    const manifestCall = storage.calls.find((c) => c.scope === 'manifest');
    if (!manifestCall) throw new Error('expected a manifest upload call');
    const manifest = JSON.parse(Buffer.from(manifestCall.body).toString('utf8'));
    const artifactPaths = manifest.artifacts.map((a: { relativePath: string }) => a.relativePath);
    expect(artifactPaths).not.toContain('native/models.json');
  });

  it('still reports failure when models capture succeeds but a real artifact upload fails (regression guard)', async () => {
    const failingStorage: StorageAdapter = {
      putObject: async (input) => {
        if (input.scope === 'manifest') {
          throw new Error('manifest upload failed');
        }
        return { key: 'x', sha256: sha256Hex(Buffer.from(input.body).toString('utf8')) };
      },
    };
    const events: string[] = [];

    const outcome = await runDevinSessionSync({
      models: devinModelsCaptureOptions,
      tables: sessionTables,
      schemaDescriptor: SCHEMA_DESCRIPTOR,
      sessionId: 'sess-1',
      cwd: '/tmp/workspace',
      config: baseConfig,
      dataDir,
      storageAdapter: failingStorage,
      trigger: 'manual',
      profile: DevinHarnessProfile,
      homeDir,
      dataRoot: homeDir,
      onProgress: (event) => events.push(event.type),
    });

    expect(outcome.warnings).toEqual([]);
    expect(outcome.errors.length).toBeGreaterThan(0);
    expect(events[events.length - 1]).toBe('failure');
  });

  it(
    'produces internally-consistent, distinctly-keyed manifests when the same ' +
      'Devin session id is synced under two different projects (DS-B23/#275 regression)',
    async () => {
      const storage = new RecordingStorageAdapter();

      const runFor = (projectId: string) =>
        runDevinSessionSync({
          models: devinModelsCaptureOptions,
          tables: sessionTables,
          schemaDescriptor: SCHEMA_DESCRIPTOR,
          sessionId: 'sess-1',
          cwd: '/tmp/workspace',
          config: { ...baseConfig, projectId },
          dataDir,
          storageAdapter: storage,
          trigger: 'manual',
          profile: DevinHarnessProfile,
          homeDir,
          dataRoot: homeDir,
        });

      // First sync under project A, as if SAL_PROJECT_ID were (correctly, at
      // the time) set to the wrong/old project for this local Devin session.
      const outcomeA = await runFor('project-a');
      expect(outcomeA.failed).toBe(0);

      // Second sync of the *same* Devin session id, after correcting
      // SAL_PROJECT_ID to the right project. Before the fix, resolveSessionData
      // looked up local session state by sessionId alone, found (and reused)
      // project A's stale SessionData, and stamped the manifest's top-level
      // projectId with "project-a" while every artifacts[].projectId entry
      // (built fresh from the current config) correctly said "project-b".
      const outcomeB = await runFor('project-b');
      expect(outcomeB.failed).toBe(0);

      const manifestCalls = storage.calls.filter((c) => c.scope === 'manifest');
      expect(manifestCalls).toHaveLength(2);

      const manifestFor = (projectId: string) => {
        const call = manifestCalls.find((c) => c.projectId === projectId);
        if (!call) throw new Error(`expected a manifest upload call for ${projectId}`);
        return JSON.parse(Buffer.from(call.body).toString('utf8'));
      };

      for (const projectId of ['project-a', 'project-b']) {
        const manifest = manifestFor(projectId);
        expect(manifest.projectId).toBe(projectId);
        expect(manifest.sessionId).toBe('sess-1');
        expect(manifest.artifacts.length).toBeGreaterThan(0);
        for (const artifact of manifest.artifacts as Array<{ projectId: string }>) {
          expect(artifact.projectId).toBe(projectId);
        }
      }

      // The two manifests must have been stored under their own,
      // project-scoped keys — not the same key overwriting each other.
      const keys = manifestCalls.map((c) => buildObjectKey(c));
      expect(new Set(keys).size).toBe(2);
      expect(keys.some((k) => k.startsWith('project-a/sess-1/'))).toBe(true);
      expect(keys.some((k) => k.startsWith('project-b/sess-1/'))).toBe(true);
    },
  );
});

describe('devinSessionStateKey', () => {
  it('produces distinct keys for the same sessionId under different projects', () => {
    const keyA = devinSessionStateKey('project-a', 'sess-1');
    const keyB = devinSessionStateKey('project-b', 'sess-1');
    expect(keyA).not.toBe(keyB);
  });

  it('produces the same key for the same (projectId, sessionId) pair', () => {
    expect(devinSessionStateKey('project-a', 'sess-1')).toBe(
      devinSessionStateKey('project-a', 'sess-1'),
    );
  });
});
