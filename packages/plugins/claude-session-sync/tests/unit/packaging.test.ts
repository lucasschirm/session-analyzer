import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const binDir = resolve(packageRoot, 'bin');
const executables = ['session-start', 'session-end', 'hook', 'transcript-watcher', 'claude-sync'];

type BuildOutput = { name: string; path: string; bytes: number };

type BuildOptions = {
  entryPoints?: Record<string, string>;
  outdir?: string;
  esbuildOptions?: Record<string, unknown>;
};

async function runBuild(options?: BuildOptions): Promise<BuildOutput[]> {
  const mod = await import('../../build.mjs');
  return (mod as { build: (opts?: BuildOptions) => Promise<BuildOutput[]> }).build(options);
}

describe('plugin packaging', () => {
  beforeAll(async () => {
    const outputs = await runBuild();
    expect(outputs).toHaveLength(5);
    for (const { name } of outputs) {
      expect(executables).toContain(name.replace(/^src\//, '').replace(/\.ts$/, ''));
    }
  });

  it('produces four executable bin files with shebangs and no .js extension', () => {
    for (const name of executables) {
      const binPath = resolve(binDir, name);
      const stats = statSync(binPath);
      expect(stats.isFile()).toBe(true);
      expect(stats.mode & 0o111).not.toBe(0);

      const firstLine = readFileSync(binPath, 'utf8').split('\n')[0];
      expect(firstLine).toBe('#!/usr/bin/env node');
    }
  });

  it('bundles sal-sync and AWS SDK without node_modules at runtime', () => {
    for (const name of executables) {
      const bundle = readFileSync(resolve(binDir, name), 'utf8');
      expect(bundle).toContain('S3Client');
      expect(bundle).toContain('PutObjectCommand');
      expect(bundle).not.toContain('@lucasschirm/sal-claude-session-parser');
      expect(bundle).not.toContain('node_modules');
    }
  });

  it('keeps each bundle under the 5 MiB build-time size limit', () => {
    for (const name of executables) {
      const { size } = statSync(resolve(binDir, name));
      expect(size).toBeLessThan(5 * 1024 * 1024);
    }
  });

  it('runs each executable without node_modules', () => {
    for (const name of executables) {
      const binPath = resolve(binDir, name);
      expect(() => {
        execFileSync(process.execPath, [binPath, '--help'], { timeout: 5000 });
      }).not.toThrow();
    }
  });

  it('fails the build if the forbidden parser package would be bundled', async () => {
    const tempRoot = mkdtempSync(resolve(packageRoot, 'tests', 'forbidden-'));
    const tempSource = resolve(tempRoot, 'forbidden.ts');
    const tempOutdir = resolve(tempRoot, 'out');
    const parserIndex = resolve(
      packageRoot,
      '..',
      '..',
      'parsers',
      'claude-session-parser',
      'src',
      'index.ts',
    );
    const importPath = relative(dirname(tempSource), parserIndex).replace(/\\/g, '/');

    writeFileSync(
      tempSource,
      `import { parseSession } from "./${importPath}";\nconsole.log(parseSession(""));\n`,
    );

    try {
      await expect(
        runBuild({
          entryPoints: { forbidden: tempSource },
          outdir: tempOutdir,
        }),
      ).rejects.toThrow('@lucasschirm/sal-claude-session-parser');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('limits the published artifact to the manifest, hooks, and bundled bins', () => {
    const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
    expect(pkg.files).toEqual(
      expect.arrayContaining(['.claude-plugin', 'bin', 'hooks', 'package.json']),
    );
    expect(pkg.files).not.toContain('node_modules');
    expect(pkg.files).not.toContain('package-lock.json');
    expect(pkg.files).not.toContain('pnpm-lock.yaml');
  });

  it('declares both claude-sync and claude-session-sync bin aliases', () => {
    const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
    expect(pkg.bin).toBeDefined();
    expect(pkg.bin['claude-sync']).toBe('./bin/claude-sync');
    expect(pkg.bin['claude-session-sync']).toBe('./bin/claude-sync');
  });

  it('claude-sync --version prints the package version', () => {
    const binPath = resolve(binDir, 'claude-sync');
    const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
    const output = execFileSync(process.execPath, [binPath, '--version'], {
      timeout: 5000,
      encoding: 'utf8',
    }).trim();
    expect(output).toBe(pkg.version);
  });

  it('claude-sync --help prints usage text', () => {
    const binPath = resolve(binDir, 'claude-sync');
    const output = execFileSync(process.execPath, [binPath, '--help'], {
      timeout: 5000,
      encoding: 'utf8',
    });
    expect(output).toContain('claude-sync');
    expect(output).toContain('sync');
    expect(output).toContain('list');
    expect(output).toContain('download');
    expect(output).toContain('SAL_PROJECT_ID');
  });

  it('claude-sync with no args prints help and exits 0', () => {
    const binPath = resolve(binDir, 'claude-sync');
    const output = execFileSync(process.execPath, [binPath], {
      timeout: 5000,
      encoding: 'utf8',
    });
    expect(output).toContain('claude-sync');
  });
});
