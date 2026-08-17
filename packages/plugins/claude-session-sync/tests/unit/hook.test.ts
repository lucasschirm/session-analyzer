import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@lucasschirm/sal-sync', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@lucasschirm/sal-sync')>();
  return {
    ...mod,
    capture: vi.fn(),
  };
});

import { capture } from '@lucasschirm/sal-sync';
import { runHook } from '../../src/hook.js';

function hookInput(event: string, overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'sess-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp/project',
    hook_event_name: event,
    model: 'claude-sonnet-5',
    ...overrides,
  };
}

describe('runHook', () => {
  const mock = vi.mocked(capture);

  beforeEach(() => {
    mock.mockReset();
    mock.mockResolvedValue({ exitCode: 0 });
  });

  it.each([
    ['PreCompact', 'pre-compact'],
    ['PostCompact', 'post-compact'],
    ['Stop', 'stop'],
    ['StopFailure', 'stop-failure'],
    ['SubagentStop', 'subagent-stop'],
  ] as const)('routes %s to capture with %s trigger', async (event, expectedTrigger) => {
    const exitCode = await runHook(hookInput(event), { env: { SAL_PROJECT_ID: 'proj-1' } });

    expect(exitCode).toBe(0);
    expect(mock).toHaveBeenCalledOnce();
    expect(mock.mock.calls[0][0].input?.trigger).toBe(expectedTrigger);
    expect(mock.mock.calls[0][0].input?.harness).toBe('claude');
  });

  it('falls back to manual trigger for unrecognized events', async () => {
    await runHook(hookInput('SomeOtherEvent'), { env: { SAL_PROJECT_ID: 'proj-1' } });

    expect(mock).toHaveBeenCalledOnce();
    expect(mock.mock.calls[0][0].input?.trigger).toBe('manual');
  });

  it('returns 0 and does not call capture for malformed input', async () => {
    const exitCode = await runHook({ session_id: 'sess-1' }, { env: { SAL_PROJECT_ID: 'proj-1' } });

    expect(exitCode).toBe(0);
    expect(mock).not.toHaveBeenCalled();
  });
});
