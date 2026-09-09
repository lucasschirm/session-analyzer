import { chmodSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuildBuild } from 'esbuild';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const binDir = resolve(packageRoot, 'bin');

const FORBIDDEN_PACKAGE = '@lucasschirm/sal-claude-session-parser';
const FORBIDDEN_PATHS = ['packages/parsers/claude-session-parser', 'parsers/claude-session-parser'];
const SHEBANG =
  '#!/usr/bin/env node\nimport { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\n';
const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

const DEFAULT_ENTRIES = {
  'session-start': 'src/session-start.ts',
  'session-end': 'src/session-end.ts',
  hook: 'src/hook.ts',
  'transcript-watcher': 'src/transcript-watcher.ts',
  'claude-sync': 'src/cli.ts',
};

// NOTE(#274): this build previously carried a `stripSyncCliGuards` esbuild
// plugin that regex-stripped `@lucasschirm/sal-sync`'s
// `if (import.meta.url... && process.argv[1] === ...)` self-invoking CLI
// guards out of `packages/sync/src/cli/{watch,run}.ts` at bundle time. That
// masked the symptom for this plugin only (`devin-session-sync`, which had
// no equivalent workaround, silently no-op'd — see #274) without fixing the
// underlying defect: those guards relied on `import.meta.url`/
// `process.argv[1]` identity, which is meaningless once bundled alongside
// another entry point. The guards have since been removed at the source
// (`packages/sync/src/cli/watch.ts` and `run.ts` are now pure, side-effect
// -free exports; their standalone-process behavior lives in
// `watch-entry.ts`/`run-entry.ts`, which are never re-exported through the
// package barrel), so this bundle-time patch is no longer needed and has
// been removed rather than kept as a vestigial no-op.

/**
 * Bundle the Claude Code plugin entry points into single-file executables.
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
    ...options.esbuildOptions,
  });

  const outputs = [];
  const forbiddenInputs = [];

  for (const [outputPath, outputInfo] of Object.entries(result.metafile.outputs)) {
    if (outputInfo.entryPoint) {
      const absOutputPath = resolve(packageRoot, outputPath);
      const finalOutputPath = absOutputPath.replace(/\.js$/, '');
      renameSync(absOutputPath, finalOutputPath);
      chmodSync(finalOutputPath, 0o755);
      // Derive the output name from the file name (without extension), which
      // matches the entry point key. This is more reliable than
      // `outputInfo.entryPoint` which is the source file path.
      const outputName = basename(finalOutputPath);
      outputs.push({
        name: outputName,
        path: finalOutputPath,
        bytes: outputInfo.bytes,
      });
    }

    for (const inputPath of Object.keys(outputInfo.inputs ?? {})) {
      if (
        inputPath.includes(FORBIDDEN_PACKAGE) ||
        FORBIDDEN_PATHS.some((p) => inputPath.includes(p))
      ) {
        forbiddenInputs.push(inputPath);
      }
    }
  }

  for (const inputPath of Object.keys(result.metafile.inputs)) {
    if (
      inputPath.includes(FORBIDDEN_PACKAGE) ||
      FORBIDDEN_PATHS.some((p) => inputPath.includes(p))
    ) {
      forbiddenInputs.push(inputPath);
    }
  }

  if (forbiddenInputs.length > 0) {
    const unique = [...new Set(forbiddenInputs)];
    throw new Error(
      `Forbidden package ${FORBIDDEN_PACKAGE} detected in bundle: ${unique.join(', ')}`,
    );
  }

  for (const output of outputs) {
    if (output.bytes > MAX_BUNDLE_BYTES) {
      throw new Error(
        `Bundle ${output.name} exceeds size limit: ${output.bytes} bytes > ${MAX_BUNDLE_BYTES} bytes`,
      );
    }
  }

  return outputs;
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
