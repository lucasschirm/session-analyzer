import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  DEVIN_HARNESS,
  type DevinHookInput,
  devinEventToSyncTrigger,
  parseDevinHookInput,
  readStdin,
  toHarnessSession,
  toSyncInput,
} from '../src/devin.js';
import { DevinHarnessProfile } from '../src/devin-profile.js';

describe('parseDevinHookInput', () => {
  it('parses valid stdin JSON for each of the 4 wired events', () => {
    for (const eventName of ['SessionStart', 'Stop', 'PostCompaction', 'SessionEnd']) {
      const raw = { session_id: 'sess-1', cwd: '/tmp/proj', hook_event_name: eventName };
      const result = parseDevinHookInput(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input.session_id).toBe('sess-1');
        expect(result.input.hook_event_name).toBe(eventName);
      }
    }
  });

  it('reports missing session_id without throwing', () => {
    const result = parseDevinHookInput({ cwd: '/tmp/proj' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toContain('session_id');
  });

  it('handles malformed (non-object) input without throwing', () => {
    for (const raw of [null, undefined, 'a string', 42, ['array']]) {
      const result = parseDevinHookInput(raw);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects a blank session_id', () => {
    const result = parseDevinHookInput({ session_id: '   ' });
    expect(result.ok).toBe(false);
  });
});

describe('devinEventToSyncTrigger', () => {
  it('maps each of the 4 wired events to the expected trigger', () => {
    expect(devinEventToSyncTrigger('SessionStart')).toBe('session-start');
    expect(devinEventToSyncTrigger('Stop')).toBe('stop');
    expect(devinEventToSyncTrigger('PostCompaction')).toBe('post-compact');
    expect(devinEventToSyncTrigger('SessionEnd')).toBe('session-end');
  });

  it('falls back to manual for an unwired or missing event', () => {
    expect(devinEventToSyncTrigger('PreToolUse')).toBe('manual');
    expect(devinEventToSyncTrigger(undefined)).toBe('manual');
  });
});

describe('toHarnessSession', () => {
  it('carries session_id, cwd, and optional fields', () => {
    const input: DevinHookInput = {
      session_id: 'sess-1',
      cwd: '/tmp/proj',
      started_at: '2026-01-01T00:00:00Z',
      model: 'devin-1',
    };
    const session = toHarnessSession(input);
    expect(session).toMatchObject({
      harness: DEVIN_HARNESS,
      sessionId: 'sess-1',
      cwd: '/tmp/proj',
      startedAt: '2026-01-01T00:00:00Z',
      model: 'devin-1',
    });
  });

  it('falls back to the provided cwd when the hook input omits it', () => {
    const session = toHarnessSession({ session_id: 'sess-1' }, '/fallback/cwd');
    expect(session.cwd).toBe('/fallback/cwd');
  });
});

describe('toSyncInput', () => {
  it('threads harness identity from the profile, never a hardcoded literal', () => {
    const session = toHarnessSession({ session_id: 'sess-1', cwd: '/tmp' });
    const input = toSyncInput(session, 'stop', '/tmp/sess-1.jsonl');
    expect(input.harness).toBe(DevinHarnessProfile.harness);
    expect(input.harness_version).toBe(DevinHarnessProfile.harnessVersion);
    expect(input.transcript_path).toBe('/tmp/sess-1.jsonl');
    expect(input.trigger).toBe('stop');
  });
});

describe('readStdin', () => {
  it('parses JSON piped on stdin', async () => {
    const stream = Readable.from([Buffer.from(JSON.stringify({ session_id: 'sess-1' }))]);
    const result = await readStdin(stream);
    expect(result).toEqual({ session_id: 'sess-1' });
  });

  it('resolves undefined for empty stdin', async () => {
    const stream = Readable.from([]);
    const result = await readStdin(stream);
    expect(result).toBeUndefined();
  });

  it('resolves undefined for malformed JSON rather than throwing', async () => {
    const stream = Readable.from([Buffer.from('not json')]);
    const result = await readStdin(stream);
    expect(result).toBeUndefined();
  });
});
