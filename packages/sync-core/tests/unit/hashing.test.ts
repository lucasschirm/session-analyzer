import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../../src/index.js';

describe('sha256Hex', () => {
  it('matches the empty string SHA-256 test vector', async () => {
    const input = new TextEncoder().encode('');
    const result = await sha256Hex(input);
    expect(result).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('matches the SHA-256 test vector for "abc"', async () => {
    const input = new TextEncoder().encode('abc');
    const result = await sha256Hex(input);
    expect(result).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('matches the SHA-256 test vector for the long message', async () => {
    const input = new TextEncoder().encode(
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    );
    const result = await sha256Hex(input);
    expect(result).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('produces a 64-character lowercase hex string', async () => {
    const input = new TextEncoder().encode('hello');
    const result = await sha256Hex(input);
    expect(result).toHaveLength(64);
    expect(result).toBe(result.toLowerCase());
  });

  it('produces different digests when input changes', async () => {
    const a = await sha256Hex(new TextEncoder().encode('content-a'));
    const b = await sha256Hex(new TextEncoder().encode('content-b'));
    expect(a).not.toBe(b);
  });

  it('agrees with node:crypto createHash for random input', async () => {
    const input = new TextEncoder().encode('random input with unicode: café');
    const expected = createHash('sha256').update(input).digest('hex');
    const result = await sha256Hex(input);
    expect(result).toBe(expected);
  });
});
