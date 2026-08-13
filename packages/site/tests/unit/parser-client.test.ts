import { describe, expect, it, vi } from 'vitest';
import { parseInWorker } from '../../src/workers/parser-client';
import type { ParseErrorResponse, ParseRequest, ParseResponse } from '../../src/workers/session-parser.worker';
import type { ParsedSession } from '../../src/types';

class FakeParserWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: ParseRequest[] = [];
  terminated = false;

  postMessage(request: ParseRequest): void {
    this.posted.push(request);
  }

  respond(response: ParseResponse | ParseErrorResponse): void {
    this.onmessage?.({ data: response } as MessageEvent);
  }

  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }

  terminate(): void {
    this.terminated = true;
  }
}

const parsedSession: ParsedSession = {
  session: {
    id: 's1',
    project_id: 'p1',
    source: 'claude',
    title: 'file.jsonl',
    started_at: 1,
    ended_at: 2,
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 15,
    models: [],
    context_compactions: 0,
    total_turns: 1,
    files_read: 0,
    files_written: 0,
    agent_invocations: 0,
    tool_executions: [],
    events: [],
    messages: [],
    tasks: [],
    subagents: [],
  },
  parseErrors: [],
};

describe('parseInWorker', () => {
  it('posts a parse request and resolves with the worker result', async () => {
    const worker = new FakeParserWorker();

    const promise = parseInWorker('{"type": "message_start"}', {
      projectId: 'p1',
      title: 'file.jsonl',
      createWorker: () => worker as unknown as Worker,
    });

    expect(worker.posted[0]).toMatchObject({ type: 'parse', projectId: 'p1', title: 'file.jsonl' });
    worker.respond({ type: 'result', result: parsedSession });

    await expect(promise).resolves.toEqual(parsedSession);
    expect(worker.terminated).toBe(true);
  });

  it('rejects when the worker replies with an error', async () => {
    const worker = new FakeParserWorker();

    const promise = parseInWorker('bad', {
      projectId: 'p1',
      createWorker: () => worker as unknown as Worker,
    });
    worker.respond({ type: 'error', message: 'Parser exploded' });

    await expect(promise).rejects.toThrow('Parser exploded');
    expect(worker.terminated).toBe(true);
  });

  it('rejects and terminates on worker runtime errors', async () => {
    const worker = new FakeParserWorker();

    const promise = parseInWorker('bad', {
      projectId: 'p1',
      createWorker: () => worker as unknown as Worker,
    });
    worker.fail('script error');

    await expect(promise).rejects.toThrow('Parser worker error: script error');
    expect(worker.terminated).toBe(true);
  });
});

describe('parseInWorker timeout safety', () => {
  it('uses fake timers to enforce the parse timeout', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeParserWorker();

      const promise = parseInWorker('payload', {
        projectId: 'p1',
        createWorker: () => worker as unknown as Worker,
      });
      const assertion = expect(promise).rejects.toThrow('Session parsing timed out');

      await vi.advanceTimersByTimeAsync(60_001);
      await assertion;
      expect(worker.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
