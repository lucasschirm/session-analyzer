import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@lucasschirm/sal-sync', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@lucasschirm/sal-sync')>();
  return {
    ...mod,
    sessionEnd: vi.fn(),
  };
});

import { sessionEnd } from '@lucasschirm/sal-sync';
import { runSessionEnd } from '../../src/session-end.js';

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'sess-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp/project',
    hook_event_name: 'SessionEnd',
    reason: 'completed',
    ...overrides,
  };
}

describe('runSessionEnd', () => {
  const mock = vi.mocked(sessionEnd);

  beforeEach(() => {
    mock.mockReset();
    mock.mockResolvedValue({ exitCode: 0, budgetExhausted: false });
  });

  it('maps SessionEnd input to sal-sync sessionEnd', async () => {
    const exitCode = await runSessionEnd(validInput(), { env: { SAL_PROJECT_ID: 'proj-1' } });

    expect(exitCode).toBe(0);
    expect(mock).toHaveBeenCalledOnce();

    const options = mock.mock.calls[0][0];
    expect(options.input).toMatchObject({
      session_id: 'sess-1',
      cwd: '/tmp/project',
      transcript_path: '/tmp/transcript.jsonl',
      reason: 'completed',
      harness: 'claude',
      harness_version: '0.1.0',
      trigger: 'session-end',
    });
    expect(options.input.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns 0 and does not call sessionEnd for malformed input', async () => {
    const exitCode = await runSessionEnd(
      { session_id: 'sess-1' },
      { env: { SAL_PROJECT_ID: 'proj-1' } },
    );

    expect(exitCode).toBe(0);
    expect(mock).not.toHaveBeenCalled();
  });
});
