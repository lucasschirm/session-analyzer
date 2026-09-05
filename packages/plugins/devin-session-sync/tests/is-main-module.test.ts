import { describe, expect, it } from 'vitest';
import { isMainModule } from '../src/is-main-module.js';

describe('isMainModule', () => {
  it('returns false for a non-file:// URL', () => {
    expect(isMainModule('https://example.com/foo.js')).toBe(false);
  });

  it('returns false when process.argv[1] is unset', () => {
    const original = process.argv[1];
    (process.argv as unknown as Record<number, string | undefined>)[1] = undefined;
    try {
      expect(isMainModule('file:///tmp/foo.js')).toBe(false);
    } finally {
      process.argv[1] = original;
    }
  });

  it('returns false when the resolved real path does not match', () => {
    expect(isMainModule('file:///tmp/definitely-not-argv1.js')).toBe(false);
  });

  it('returns false (without throwing) when realpathSync fails for a nonexistent argv[1]', () => {
    const original = process.argv[1];
    process.argv[1] = '/nonexistent/path/to/nowhere.js';
    try {
      expect(isMainModule('file:///nonexistent/path/to/nowhere.js')).toBe(false);
    } finally {
      process.argv[1] = original;
    }
  });
});
