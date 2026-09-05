import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  CLAUDE_SYNC_TRIGGERS,
  claudeEventToSyncTrigger,
  parseClaudeHookInput,
  readStdin,
  toHarnessSession,
  toSyncInput,
} from '../../src/claude.js';
import { CLAUDE_HARNESS, CLAUDE_HARNESS_VERSION } from '../../src/claude-profile.js';

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'sess-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp/project',
    hook_event_name: 'SessionStart',
    model: 'claude-sonnet-5',
    ...overrides,
  };
}

describe('parseClaudeHookInput', () => {
  it('accepts a valid SessionStart payload', () => {
    const result = parseClaudeHookInput(baseInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.session_id).toBe('sess-1');
      expect(result.input.transcript_path).toBe('/tmp/transcript.jsonl');
      expect(result.input.cwd).toBe('/tmp/project');
    }
  });

  it('reports missing required fields', () => {
    const result = parseClaudeHookInput({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(['session_id', 'cwd', 'transcript_path']);
    }
  });

  it('rejects empty string values', () => {
    const result = parseClaudeHookInput({
      session_id: '',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '   ',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain('session_id');
      expect(result.missing).toContain('cwd');
    }
  });

  it('rejects non-object input', () => {
    const result = parseClaudeHookInput('not-json');
    expect(result.ok).toBe(false);
  });
});

describe('toHarnessSession', () => {
  it('maps Claude fields to the shared HarnessSession model', () => {
    const input = baseInput({
      started_at: '2026-08-17T00:00:00Z',
      ended_at: '2026-08-17T01:00:00Z',
      reason: 'completed',
    });
    const session = toHarnessSession(parseClaudeHookInput(input).ok ? input : baseInput());
    expect(session.harness).toBe('claude');
    expect(session.sessionId).toBe('sess-1');
    expect(session.cwd).toBe('/tmp/project');
    expect(session.transcriptPath).toBe('/tmp/transcript.jsonl');
    expect(session.startedAt).toBe('2026-08-17T00:00:00Z');
    expect(session.endedAt).toBe('2026-08-17T01:00:00Z');
    expect(session.endReason).toBe('completed');
    expect(session.model).toBe('claude-sonnet-5');
  });
});

describe('toSyncInput', () => {
  it('produces a HookInput with harness metadata and snake-case fields', () => {
    const input = baseInput({ reason: 'completed' });
    const session = toHarnessSession(input);
    const hookInput = toSyncInput(session, 'session-end');
    expect(hookInput.session_id).toBe('sess-1');
    expect(hookInput.cwd).toBe('/tmp/project');
    expect(hookInput.transcript_path).toBe('/tmp/transcript.jsonl');
    expect(hookInput.harness).toBe(CLAUDE_HARNESS);
    expect(hookInput.harness_version).toBe(CLAUDE_HARNESS_VERSION);
    expect(hookInput.reason).toBe('completed');
    expect(hookInput.trigger).toBe('session-end');
    expect(hookInput.model).toBe('claude-sonnet-5');
  });

  it('lets extra fields merge without overwriting the trigger', () => {
    const input = baseInput({ source: 'startup' });
    const session = toHarnessSession(input);
    const hookInput = toSyncInput(session, 'session-start', {
      source: 'startup',
      trigger: 'should-be-ignored',
    });
    expect(hookInput.trigger).toBe('session-start');
    expect(hookInput.source).toBe('startup');
  });
});

describe('claudeEventToSyncTrigger', () => {
  it.each(Object.entries(CLAUDE_SYNC_TRIGGERS))(
    'maps Claude %s to sal-sync %s',
    (event, trigger) => {
      expect(claudeEventToSyncTrigger(event)).toBe(trigger);
    },
  );

  it('falls back to manual for unknown events', () => {
    expect(claudeEventToSyncTrigger('UnknownEvent')).toBe('manual');
    expect(claudeEventToSyncTrigger(undefined)).toBe('manual');
  });
});

describe('readStdin', () => {
  it('parses JSON from a readable stream', async () => {
    const stdin = Readable.from([
      JSON.stringify({ session_id: 's', cwd: '/', transcript_path: '/t' }),
    ]);
    const raw = await readStdin(stdin);
    expect(raw).toEqual({ session_id: 's', cwd: '/', transcript_path: '/t' });
  });

  it('returns undefined for empty input', async () => {
    const stdin = Readable.from(['']);
    const raw = await readStdin(stdin);
    expect(raw).toBeUndefined();
  });

  it('returns undefined for invalid JSON', async () => {
    const stdin = Readable.from(['not-json']);
    const raw = await readStdin(stdin);
    expect(raw).toBeUndefined();
  });
});
