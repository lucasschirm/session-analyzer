import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const tscBin = join(packageRoot, 'node_modules', '.bin', 'tsc');

/**
 * Placeholder build entry point for `devin-session-sync`.
 *
 * This package currently ships no bin executables — it only hosts the
 * SQLite->JSONL extractor module (`src/extractor/`) added by DS-F2 (#157).
 * The esbuild-based single-file bin build (bundling the plugin manifest,
 * hook entry points, and `devin-sync` CLI, mirroring
 * `packages/plugins/claude-session-sync/build.mjs`) is wired up by DS-F3
 * (#158) once those pieces land.
 *
 * Until then, `build()` just type-checks/compiles `src/` via `tsc` so
 * `pnpm -r build` succeeds for this package.
 *
 * @returns {Array<{name: string, path: string, bytes: number}>} always
 *   empty today — kept as the return shape esbuild-based builds use so
 *   DS-F3 (#158) can swap this implementation in place without touching
 *   call sites.
 */
export function build() {
  execFileSync(tscBin, ['-p', 'tsconfig.json'], {
    cwd: packageRoot,
    stdio: 'inherit',
  });
  return [];
}

function main() {
  build();
  console.log('devin-session-sync: compiled src/ via tsc (no bin entries yet, see DS-F3 #158)');
}

if (import.meta.url.startsWith('file:') && process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
