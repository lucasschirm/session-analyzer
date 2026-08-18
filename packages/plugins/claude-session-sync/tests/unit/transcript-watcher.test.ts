import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@lucasschirm/sal-sync', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@lucasschirm/sal-sync')>();
  return {
    ...mod,
    watch: vi.fn(),
  };
});

import { watch, watchTranscripts } from '@lucasschirm/sal-sync';
import { runTranscriptWatcher } from '../../src/transcript-watcher.js';

describe('runTranscriptWatcher', () => {
  const watchMock = vi.mocked(watch);

  beforeEach(() => {
    watchMock.mockReset();
    watchMock.mockResolvedValue({ exitCode: 0 });
  });

  it('delegates to sal-sync watch with the transcript watcher core', async () => {
    const argv = ['--session-id', 'sess-1', '--transcript-path', '/tmp/transcript.jsonl'];
    const exitCode = await runTranscriptWatcher({ argv });

    expect(exitCode).toBe(0);
    expect(watchMock).toHaveBeenCalledOnce();
    const options = watchMock.mock.calls[0][0];
    expect(options.argv).toEqual(argv);
    expect(options.watcher).toBe(watchTranscripts);
  });
});
