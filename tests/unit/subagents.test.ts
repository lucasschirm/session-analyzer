import { describe, expect, it } from 'vitest';
import {
  classifyUploadedFiles,
  mergeSubagentIntoSession,
  parseSubagentMeta,
  type UploadedFile,
} from '../../src/lib/subagents';
import type { DashboardSession } from '../../src/types';

function uploaded(relativePath: string, content = ''): UploadedFile {
  const name = relativePath.split('/').pop() ?? relativePath;
  return { file: new File([content], name), relativePath };
}

function emptySession(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id: 's1',
    project_id: 'p1',
    source: 'claude',
    title: 'main.jsonl',
    started_at: 0,
    ended_at: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
    models: [],
    context_compactions: 0,
    total_turns: 0,
    files_read: 0,
    files_written: 0,
    agent_invocations: 0,
    tool_executions: [],
    events: [],
    messages: [],
    tasks: [],
    subagents: [],
    ...overrides,
  };
}

describe('classifyUploadedFiles', () => {
  it('treats top-level .json/.jsonl/.log files as main transcripts', () => {
    const result = classifyUploadedFiles([
      uploaded('session.jsonl'),
      uploaded('other.json'),
      uploaded('legacy.log'),
    ]);

    expect(result.mainFiles.map((u) => u.relativePath)).toEqual([
      'session.jsonl',
      'other.json',
      'legacy.log',
    ]);
    expect(result.subagentGroups).toEqual([]);
  });

  it('groups subagents/agent-<id>.jsonl with its .meta.json sidecar by id', () => {
    const result = classifyUploadedFiles([
      uploaded('bb11b861-c31a/subagents/agent-af8ea70bf38e12f2c.jsonl'),
      uploaded('bb11b861-c31a/subagents/agent-af8ea70bf38e12f2c.meta.json'),
    ]);

    expect(result.mainFiles).toEqual([]);
    expect(result.subagentGroups.length).toBe(1);
    expect(result.subagentGroups[0].agentId).toBe('af8ea70bf38e12f2c');
    expect(result.subagentGroups[0].jsonl?.relativePath).toContain('.jsonl');
    expect(result.subagentGroups[0].meta?.relativePath).toContain('.meta.json');
  });

  it('matches subagent files even without a "subagents/" path prefix (plain multi-file selection)', () => {
    const result = classifyUploadedFiles([
      uploaded('agent-xyz.jsonl'),
      uploaded('agent-xyz.meta.json'),
    ]);

    expect(result.subagentGroups.length).toBe(1);
    expect(result.subagentGroups[0].agentId).toBe('xyz');
  });

  it('silently skips tool-results overflow files and other unrelated files', () => {
    const result = classifyUploadedFiles([
      uploaded('bb11b861-c31a/tool-results/bj4qorrjs.txt'),
      uploaded('bb11b861-c31a/.DS_Store'),
    ]);

    expect(result.mainFiles).toEqual([]);
    expect(result.subagentGroups).toEqual([]);
  });

  it('handles a folder containing a main transcript sibling plus subagents', () => {
    const result = classifyUploadedFiles([
      uploaded('bb11b861-c31a-4513-b356-9893c59008dd.jsonl'),
      uploaded('bb11b861-c31a-4513-b356-9893c59008dd/subagents/agent-abc.jsonl'),
      uploaded('bb11b861-c31a-4513-b356-9893c59008dd/subagents/agent-abc.meta.json'),
      uploaded('bb11b861-c31a-4513-b356-9893c59008dd/tool-results/xyz.txt'),
    ]);

    expect(result.mainFiles.length).toBe(1);
    expect(result.subagentGroups.length).toBe(1);
  });
});

describe('parseSubagentMeta', () => {
  it('extracts agentType and description', () => {
    const meta = parseSubagentMeta(
      '{"agentType":"general-purpose","description":"Update AGENTS.md","toolUseId":"x","model":"haiku"}'
    );
    expect(meta).toEqual({ agentType: 'general-purpose', description: 'Update AGENTS.md' });
  });

  it('returns an empty object for invalid JSON', () => {
    expect(parseSubagentMeta('not json')).toEqual({});
  });
});

describe('mergeSubagentIntoSession', () => {
  it('adds the subagent tokens/cache into the parent session totals', () => {
    const session = emptySession({ input_tokens: 100, output_tokens: 50, total_tokens: 150 });
    const sub = emptySession({
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_tokens: 5,
      cache_read_tokens: 2,
      total_tokens: 37,
      model: 'claude-haiku-4-5',
      tool_executions: [
        { id: 't1', session_id: 'sub', timestamp: 1, tool_name: 'Bash', tool_type: 'tool_use', success: true },
      ],
    });

    mergeSubagentIntoSession(session, 'agent-1', sub, { agentType: 'general-purpose', description: 'Do X' });

    expect(session.input_tokens).toBe(110);
    expect(session.output_tokens).toBe(70);
    expect(session.cache_creation_tokens).toBe(5);
    expect(session.cache_read_tokens).toBe(2);
    expect(session.total_tokens).toBe(187);
    expect(session.models).toEqual([
      { model: 'claude-haiku-4-5', input_tokens: 10, output_tokens: 20, cache_creation_tokens: 5, cache_read_tokens: 2 },
    ]);
    expect(session.subagents.length).toBe(1);
    expect(session.subagents[0]).toMatchObject({
      agent_id: 'agent-1',
      agent_type: 'general-purpose',
      description: 'Do X',
      model: 'claude-haiku-4-5',
      total_tokens: 37,
      tool_call_count: 1,
    });
  });

  it('merges subagent model usage into an existing model bucket the parent already uses', () => {
    const session = emptySession({
      models: [{ model: 'claude-sonnet-5', input_tokens: 1, output_tokens: 1, cache_creation_tokens: 0, cache_read_tokens: 0 }],
    });
    const sub = emptySession({ input_tokens: 5, output_tokens: 5, total_tokens: 10, model: 'claude-sonnet-5' });

    mergeSubagentIntoSession(session, 'agent-1', sub, {});

    expect(session.models).toEqual([
      { model: 'claude-sonnet-5', input_tokens: 6, output_tokens: 6, cache_creation_tokens: 0, cache_read_tokens: 0 },
    ]);
  });

  it('is idempotent when the same agent id is re-merged (re-upload of the same folder)', () => {
    const session = emptySession({ input_tokens: 100, total_tokens: 100 });
    const sub = emptySession({ input_tokens: 10, output_tokens: 20, total_tokens: 30, model: 'claude-haiku-4-5' });

    mergeSubagentIntoSession(session, 'agent-1', sub, { description: 'v1' });
    mergeSubagentIntoSession(session, 'agent-1', sub, { description: 'v1' });
    mergeSubagentIntoSession(session, 'agent-1', sub, { description: 'v1' });

    expect(session.input_tokens).toBe(110);
    expect(session.total_tokens).toBe(130);
    expect(session.models).toEqual([
      { model: 'claude-haiku-4-5', input_tokens: 10, output_tokens: 20, cache_creation_tokens: 0, cache_read_tokens: 0 },
    ]);
    expect(session.subagents.length).toBe(1);
  });

  it('replaces the summary and adjusts totals when a re-merge reports different usage', () => {
    const session = emptySession();
    const first = emptySession({ input_tokens: 10, total_tokens: 10, model: 'claude-haiku-4-5' });
    const second = emptySession({ input_tokens: 40, total_tokens: 40, model: 'claude-haiku-4-5' });

    mergeSubagentIntoSession(session, 'agent-1', first, {});
    mergeSubagentIntoSession(session, 'agent-1', second, {});

    expect(session.input_tokens).toBe(40);
    expect(session.total_tokens).toBe(40);
    expect(session.subagents.length).toBe(1);
    expect(session.subagents[0].total_tokens).toBe(40);
  });

  it('supports multiple distinct subagents accumulating independently', () => {
    const session = emptySession();
    const subA = emptySession({ input_tokens: 10, total_tokens: 10, model: 'claude-haiku-4-5' });
    const subB = emptySession({ input_tokens: 20, total_tokens: 20, model: 'claude-opus-5' });

    mergeSubagentIntoSession(session, 'agent-a', subA, { description: 'A' });
    mergeSubagentIntoSession(session, 'agent-b', subB, { description: 'B' });

    expect(session.input_tokens).toBe(30);
    expect(session.total_tokens).toBe(30);
    expect(session.subagents.length).toBe(2);
    expect(session.models.length).toBe(2);
  });
});
