import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { readStdin } from '../../../src/cli/read-stdin.js';

function streamOf(text: string): NodeJS.ReadableStream {
  return Readable.from([text]) as unknown as NodeJS.ReadableStream;
}

describe('readStdin', () => {
  it('parses valid JSON input', async () => {
    const result = await readStdin(streamOf('{"a":1}'));
    expect(result).toEqual({ a: 1 });
  });

  it('resolves undefined for empty input', async () => {
    const result = await readStdin(streamOf(''));
    expect(result).toBeUndefined();
  });

  it('resolves undefined for malformed JSON rather than rejecting', async () => {
    const result = await readStdin(streamOf('not json'));
    expect(result).toBeUndefined();
  });

  it('rejects when the stream errors', async () => {
    const stream = new Readable({
      read() {
        this.emit('error', new Error('boom'));
      },
    });
    await expect(readStdin(stream as unknown as NodeJS.ReadableStream)).rejects.toThrow('boom');
  });
});
