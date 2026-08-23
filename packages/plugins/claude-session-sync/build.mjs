import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuildBuild } from 'esbuild';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const syncPackageRoot = resolve(packageRoot, '..', '..', 'sync');
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

const GUARD_PATTERN =
  /if\s*\(\s*import\.meta\.url\.startsWith\s*\(\s*['"]file:['"]\s*\)\s*&&\s*process\.argv\s*\[\s*1\s*\]\s*===\s*fileURLToPath\s*\(\s*import\.meta\.url\s*\)\s*\)\s*\{[^{}]*\}\s*/g;

function isInsideSyncPackage(absPath) {
  let rp;
  try {
    rp = realpathSync(absPath);
  } catch {
    return false;
  }
  const normalized = rp.endsWith(sep) ? rp : `${rp}${sep}`;
  const syncRoot = syncPackageRoot.endsWith(sep) ? syncPackageRoot : `${syncPackageRoot}${sep}`;
  return normalized.startsWith(syncRoot);
}

function stripSyncCliGuards() {
  return {
    name: 'strip-sync-cli-guards',
    setup(build) {
      build.onLoad({ filter: /\.[jt]s$/ }, (args) => {
        if (!isInsideSyncPackage(args.path)) {
          return;
        }
        const source = readFileSync(args.path, 'utf8');
        const stripped = source.replace(GUARD_PATTERN, '');
        if (stripped === source) {
          return;
        }
        return { contents: stripped, loader: 'js' };
      });
    },
  };
}

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
    plugins: [stripSyncCliGuards()],
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
