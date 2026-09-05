import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isMainModule } from '../../../src/cli/is-main-module.js';

describe('isMainModule', () => {
  let tempRoot: string;
  const originalArgv = [...process.argv];

  beforeEach(() => {
    tempRoot = mkdtempSync(resolve(import.meta.dirname, '..', 'is-main-module-'));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    process.argv = [...originalArgv];
  });

  it('returns false when the module URL is not a file: URL', () => {
    expect(isMainModule('https://example.com/mod.js')).toBe(false);
  });

  it('returns true when argv[1] matches the module path directly', () => {
    const filePath = resolve(tempRoot, 'entry.mjs');
    writeFileSync(filePath, '');
    process.argv[1] = filePath;

    expect(isMainModule(pathToFileURL(filePath).href)).toBe(true);
  });

  it('returns true when argv[1] is a symlink resolving to the module path', () => {
    const realPath = resolve(tempRoot, 'real-entry.mjs');
    const linkPath = resolve(tempRoot, 'linked-entry.mjs');
    writeFileSync(realPath, '');
    symlinkSync(realPath, linkPath);
    process.argv[1] = linkPath;

    expect(isMainModule(pathToFileURL(realPath).href)).toBe(true);
  });

  it('returns false when argv[1] points to an unrelated file', () => {
    const filePath = resolve(tempRoot, 'entry.mjs');
    const otherPath = resolve(tempRoot, 'other.mjs');
    writeFileSync(filePath, '');
    process.argv[1] = otherPath;

    expect(isMainModule(pathToFileURL(filePath).href)).toBe(false);
  });

  it('returns false when argv[1] is missing', () => {
    process.argv = [process.argv[0] ?? 'node'];
    expect(isMainModule(pathToFileURL(resolve(tempRoot, 'entry.mjs')).href)).toBe(false);
  });
});
