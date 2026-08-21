import { describe, expect, it } from 'vitest';
import type { ParsedSession } from '../../src/types';
import {
  decodeTransferredBuffer,
  handleParseRequest,
  type ParseRequest,
  parseSession,
} from '../../src/workers/session-parser.worker';

const encoder = new TextEncoder();

const sampleAgenticPi = `{"type": "session", "version": 3, "id": "pi_123", "cwd": "/workspace"}
{"type": "message_update", "role": "user", "content": "Add API route"}
{"type": "tool_execution_start", "tool": "file_write", "target": "api.controller.ts"}
{"type": "usage_snapshot", "tokens": {"input": 100, "output": 50}, "cost_usd": 0.001}`;

function stripUnstableFields(parsed: ParsedSession): ParsedSession {
  return {
    ...parsed,
    session: {
      ...parsed.session,
      id: 'stable',
      started_at: 0,
      ended_at: 0,
      events: parsed.session.events.map((event) => ({
        ...event,
        id: 'stable',
        session_id: 'stable',
        timestamp: 0,
      })),
      messages: parsed.session.messages.map((message) => ({
        ...message,
        id: 'stable',
        session_id: 'stable',
        timestamp: 0,
      })),
      tool_executions: parsed.session.tool_executions.map((tool) => ({
        ...tool,
        id: 'stable',
        session_id: 'stable',
        timestamp: 0,
      })),
    },
  };
}

describe('decodeTransferredBuffer', () => {
  it('decodes an ASCII ArrayBuffer to the same string', () => {
    const text = 'Hello, parser!';
    const buffer = encoder.encode(text).buffer;

    expect(decodeTransferredBuffer(buffer)).toBe(text);
  });

  it('decodes multi-byte text split across many small chunks', () => {
    const text = 'こんにちは世界 🌍'.repeat(100);
    const bytes = encoder.encode(text);

    const decoded = decodeTransferredBuffer(bytes.buffer, 7);

    expect(decoded).toBe(text);
  });

  it('matches the output of a single TextDecoder.decode() call', () => {
    const text = 'Line 1\nLine 2\némoji 🎉';
    const bytes = encoder.encode(text);

    const decoded = decodeTransferredBuffer(bytes.buffer, 5);
    const expected = new TextDecoder().decode(bytes);

    expect(decoded).toBe(expected);
  });
});

describe('handleParseRequest', () => {
  it('produces identical output for string and ArrayBuffer payloads', () => {
    const title = 'parity.jsonl';
    const stringRequest: ParseRequest = {
      type: 'parse',
      payload: sampleAgenticPi,
      projectId: 'p1',
      title,
    };
    const bufferRequest: ParseRequest = {
      type: 'parse',
      payload: encoder.encode(sampleAgenticPi).buffer,
      projectId: 'p1',
      title,
    };

    const fromString = handleParseRequest(stringRequest);
    const fromBuffer = handleParseRequest(bufferRequest);

    if (fromString.type !== 'result' || fromBuffer.type !== 'result') {
      throw new Error('Expected both requests to parse successfully');
    }

    expect(stripUnstableFields(fromBuffer.result)).toEqual(stripUnstableFields(fromString.result));
  });

  it('returns a result response for a known format', () => {
    const request: ParseRequest = {
      type: 'parse',
      payload: sampleAgenticPi,
      projectId: 'p1',
    };

    const response = handleParseRequest(request);

    expect(response.type).toBe('result');
    if (response.type === 'result') {
      expect(response.result.session.source).toBe('agentic_pi');
      expect(response.result.session.input_tokens).toBe(100);
      expect(response.result.session.tool_executions.length).toBe(1);
    }
  });

  it('returns a result with parse errors for unrecognised content', () => {
    const request: ParseRequest = {
      type: 'parse',
      payload: 'not valid session data',
      projectId: 'p1',
    };

    const response = handleParseRequest(request);

    expect(response.type).toBe('result');
    if (response.type === 'result') {
      expect(response.result.parseErrors.length).toBeGreaterThan(0);
    }
  });
});

describe('parseSession string vs ArrayBuffer parity', () => {
  it('produces the same parsed result from an ArrayBuffer decoded in the worker', () => {
    const title = 'parity.jsonl';
    const fromString = parseSession(sampleAgenticPi, 'p1', title);
    const buffer = encoder.encode(sampleAgenticPi).buffer;
    const fromBuffer = parseSession(decodeTransferredBuffer(buffer), 'p1', title);

    expect(stripUnstableFields(fromBuffer)).toEqual(stripUnstableFields(fromString));
  });
});
