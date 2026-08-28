import { describe, expect, it } from 'vitest';
import {
  defaultProgressParser,
  pollHeartbeat,
  syncProgressFilesParser,
} from '../../e2e/helpers/heartbeat';

describe('defaultProgressParser', () => {
  it('parses a percentage value', () => {
    expect(defaultProgressParser('Upload 42% complete')).toBe(42);
  });

  it('parses the first count/total fraction', () => {
    expect(defaultProgressParser('Projects 1/5 | Sessions 0/2')).toBe(1);
  });

  it('parses a plain number', () => {
    expect(defaultProgressParser('Step 7 of 10')).toBe(7);
  });

  it('returns null when no numeric content is present', () => {
    expect(defaultProgressParser('Processing...')).toBeNull();
  });
});

describe('syncProgressFilesParser', () => {
  it('returns the files-downloaded count from sync bar text', () => {
    expect(syncProgressFilesParser('Projects 1/1 | Sessions 1/1 | Files 0/2')).toBe(0);
  });

  it('falls back to the default parser when no Files segment exists', () => {
    expect(syncProgressFilesParser('Loading... 5%')).toBe(5);
  });
});

describe('pollHeartbeat', () => {
  it('passes for a monotonically advancing series', async () => {
    let i = 0;
    const values = ['Files 0/1', 'Files 0/1', 'Files 1/1'];
    const result = await pollHeartbeat(async () => values[i++] ?? values[values.length - 1], {
      intervalMs: 1,
      timeoutMs: 50,
      parser: syncProgressFilesParser,
    });
    expect(result.distinct).toEqual([0, 1]);
    expect(result.series).toEqual([0, 1]);
  });

  it('fails for a frozen series', async () => {
    await expect(
      pollHeartbeat(async () => 'Files 0/1', {
        intervalMs: 1,
        timeoutMs: 50,
        parser: syncProgressFilesParser,
      }),
    ).rejects.toThrow(/stalled/);
  });

  it('fails for a non-monotonic series', async () => {
    let i = 0;
    const values = ['Files 0/2', 'Files 1/2', 'Files 0/2'];
    await expect(
      pollHeartbeat(async () => values[i++], {
        intervalMs: 1,
        timeoutMs: 50,
        parser: syncProgressFilesParser,
      }),
    ).rejects.toThrow(/monotonic/);
  });

  it('uses the default parser when none is provided', async () => {
    let i = 0;
    const values = ['0%', '0%', '50%'];
    const result = await pollHeartbeat(async () => values[i++] ?? values[values.length - 1], {
      intervalMs: 1,
      timeoutMs: 50,
    });
    expect(result.distinct).toEqual([0, 50]);
  });
});
