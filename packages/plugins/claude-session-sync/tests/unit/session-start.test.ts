import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@lucasschirm/sal-sync', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@lucasschirm/sal-sync')>();
  return {
    ...mod,
    sessionStart: vi.fn(),
  };
});

import { sessionStart } from '@lucasschirm/sal-sync';
import { runSessionStart } from '../../src/session-start.js';

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'sess-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp/project',
    hook_event_name: 'SessionStart',
    model: 'claude-sonnet-5',
    ...overrides,
  };
}

describe('runSessionStart', () => {
  const mock = vi.mocked(sessionStart);

  beforeEach(() => {
    mock.mockReset();
    mock.mockResolvedValue({ exitCode: 0 });
  });

  it('maps SessionStart input to sal-sync sessionStart', async () => {
    const spawnWatcher = vi.fn().mockReturnValue({ unref: vi.fn(), pid: 1234 });
    const exitCode = await runSessionStart(validInput(), {
      env: { SAL_PROJECT_ID: 'proj-1' },
      spawnWatcher,
    });

    expect(exitCode).toBe(0);
    expect(mock).toHaveBeenCalledOnce();

    const options = mock.mock.calls[0][0];
    expect(options.input).toMatchObject({
      session_id: 'sess-1',
      cwd: '/tmp/project',
      transcript_path: '/tmp/transcript.jsonl',
      harness: 'claude',
      harness_version: '0.1.0',
      model: 'claude-sonnet-5',
      trigger: 'session-start',
    });
    expect(options.input.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(options.spawnWatcher).toBe(spawnWatcher);
  });

  it('supplies a default spawnWatcher when none is provided', async () => {
    const envPath = '/custom/watcher.js';
    const exitCode = await runSessionStart(validInput(), {
      env: { SAL_PROJECT_ID: 'proj-1' },
      watcherPath: envPath,
    });

    expect(exitCode).toBe(0);
    expect(mock).toHaveBeenCalledOnce();
    expect(typeof mock.mock.calls[0][0].spawnWatcher).toBe('function');
  });

  it('returns 0 and does not call sessionStart for malformed input', async () => {
    const exitCode = await runSessionStart(
      { session_id: 'sess-1' },
      { env: { SAL_PROJECT_ID: 'proj-1' } },
    );

    expect(exitCode).toBe(0);
    expect(mock).not.toHaveBeenCalled();
  });
});
