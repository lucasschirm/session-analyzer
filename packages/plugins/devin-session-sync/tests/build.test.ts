import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { build } from '../build.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

describe('build (esbuild bin bundling)', () => {
  let outdir: string;

  beforeEach(async () => {
    outdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-build-test-'));
  });

  afterEach(async () => {
    await fsp.rm(outdir, { recursive: true, force: true });
  });

  it('bundles all 5 entry points into executable, shebanged single files', async () => {
    const outputs = await build({ outdir });
    const names = outputs.map((o) => o.name).sort();
    expect(names).toEqual(['devin-sync', 'hook', 'session-end', 'session-start', 'watcher']);

    for (const output of outputs) {
      const stat = await fsp.stat(output.path);
      expect(stat.mode & 0o111).not.toBe(0);
      const content = await fsp.readFile(output.path, 'utf8');
      expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
      expect(output.bytes).toBeLessThan(5 * 1024 * 1024);
    }
  }, 60000);

  it('throws when a bundled input path matches the forbidden devin-session-parser package', async () => {
    const forbiddenDir = path.join(outdir, 'src', 'parsers', 'devin-session-parser');
    await fsp.mkdir(forbiddenDir, { recursive: true });
    await fsp.writeFile(path.join(forbiddenDir, 'index.ts'), 'export const x = 1;\n');
    const entryPath = path.join(outdir, 'src', 'entry.ts');
    await fsp.writeFile(entryPath, `export * from './parsers/devin-session-parser/index.js';\n`);

    await expect(
      build({
        outdir: path.join(outdir, 'bin'),
        entryPoints: { entry: path.relative(packageRoot, entryPath) },
      }),
    ).rejects.toThrow(/Forbidden package/);
  }, 30000);

  it('limits the published artifact to .devin-plugin, bin, hooks.json, and package.json', async () => {
    const pkg = JSON.parse(await fsp.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    expect(pkg.files).toEqual(
      expect.arrayContaining(['.devin-plugin', 'bin', 'hooks.json', 'package.json']),
    );
    expect(pkg.files).not.toContain('.claude-plugin');
    expect(pkg.files).not.toContain('node_modules');
  });

  it('bump-plugin-version script updates .devin-plugin/plugin.json without referencing .claude-plugin', async () => {
    const { execFileSync } = await import('node:child_process');
    const scriptPath = path.join(packageRoot, 'scripts', 'bump-plugin-version.js');
    const manifestPath = path.join(packageRoot, '.devin-plugin', 'plugin.json');
    const originalManifest = await fsp.readFile(manifestPath, 'utf8');
    try {
      execFileSync(process.execPath, [scriptPath], { timeout: 5000 });
      const updated = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      const pkg = JSON.parse(await fsp.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
      expect(updated.version).toBe(pkg.version);
    } finally {
      await fsp.writeFile(manifestPath, originalManifest);
    }
  });
});
