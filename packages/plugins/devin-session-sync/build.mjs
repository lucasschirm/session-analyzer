import { chmodSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuildBuild } from 'esbuild';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const binDir = resolve(packageRoot, 'bin');

// TODO(DS-F6 #155): once `@lucasschirm/devin-session-parser` exists, this
// guard becomes load-bearing exactly like `claude-session-sync/build.mjs`'s
// equivalent for `@lucasschirm/sal-claude-session-parser` — a transformer
// package must never be bundled into a sync plugin's bin executables
// (parsing happens downstream in `packages/db` ingestion, not in this
// plugin). Kept active now (never matches, since the package doesn't exist
// yet) rather than added later, per this issue's explicit instruction not to
// skip the guard silently.
const FORBIDDEN_PACKAGE = '@lucasschirm/devin-session-parser';
const FORBIDDEN_PATHS = ['packages/parsers/devin-session-parser', 'parsers/devin-session-parser'];
const SHEBANG =
  '#!/usr/bin/env node\nimport { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\n';
const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

const DEFAULT_ENTRIES = {
  'session-start': 'src/session-start.ts',
  'session-end': 'src/session-end.ts',
  hook: 'src/hook.ts',
  watcher: 'src/watcher.ts',
  'devin-sync': 'src/cli.ts',
};

/**
 * Bundle the Devin plugin entry points into single-file executables.
 *
 * @param {object} [options]
 * @param {Record<string, string>} [options.entryPoints] - map of output names to entry files
 * @param {string} [options.outdir] - output directory, defaults to `bin`
 * @param {Partial<import('esbuild').BuildOptions>} [options.esbuildOptions] - additional esbuild options
 * @returns {Promise<Array<{name: string, path: string, bytes: number}>>}
 */
export async function build(options = {}) {
  const outdir = resolve(options.outdir ?? binDir);

  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });

  const result = await esbuildBuild({
    entryPoints: options.entryPoints ?? DEFAULT_ENTRIES,
    outdir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    treeShaking: true,
    minify: true,
    sourcemap: false,
    metafile: true,
    banner: { js: SHEBANG },
    // node:sqlite (used by the extractor bundled into every bin here) has no
    // JS shim; esbuild must leave it as a runtime import rather than trying
    // to resolve/bundle it.
    external: ['node:sqlite'],
    ...options.esbuildOptions,
  });

  const outputs = collectOutputs(result, packageRoot);
  assertNoForbiddenInputs(result);
  assertBundleSizeLimits(outputs);

  return outputs;
}

function collectOutputs(result, root) {
  const outputs = [];
  for (const [outputPath, outputInfo] of Object.entries(result.metafile.outputs)) {
    if (!outputInfo.entryPoint) continue;
    const absOutputPath = resolve(root, outputPath);
    const finalOutputPath = absOutputPath.replace(/\.js$/, '');
    renameOutput(absOutputPath, finalOutputPath);
    outputs.push({
      name: basename(finalOutputPath),
      path: finalOutputPath,
      bytes: outputInfo.bytes,
    });
  }
  return outputs;
}

function renameOutput(from, to) {
  renameSync(from, to);
  chmodSync(to, 0o755);
}

function assertNoForbiddenInputs(result) {
  const forbiddenInputs = new Set();
  for (const outputInfo of Object.values(result.metafile.outputs)) {
    for (const inputPath of Object.keys(outputInfo.inputs ?? {})) {
      if (isForbiddenInput(inputPath)) forbiddenInputs.add(inputPath);
    }
  }
  for (const inputPath of Object.keys(result.metafile.inputs)) {
    if (isForbiddenInput(inputPath)) forbiddenInputs.add(inputPath);
  }
  if (forbiddenInputs.size > 0) {
    throw new Error(
      `Forbidden package ${FORBIDDEN_PACKAGE} detected in bundle: ${[...forbiddenInputs].join(', ')}`,
    );
  }
}

function isForbiddenInput(inputPath) {
  return (
    inputPath.includes(FORBIDDEN_PACKAGE) || FORBIDDEN_PATHS.some((p) => inputPath.includes(p))
  );
}

function assertBundleSizeLimits(outputs) {
  for (const output of outputs) {
    if (output.bytes > MAX_BUNDLE_BYTES) {
      throw new Error(
        `Bundle ${output.name} exceeds size limit: ${output.bytes} bytes > ${MAX_BUNDLE_BYTES} bytes`,
      );
    }
  }
}

async function main() {
  const outputs = await build();
  for (const output of outputs) {
    console.log(`Built ${output.name} (${output.bytes} bytes) -> ${output.path}`);
  }
}

if (import.meta.url.startsWith('file:') && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
