import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const repoRoot = join(__dirname, '../../..');

export function runPnpm(args, options = {}) {
  const { status, stdout, stderr } = spawnSync('pnpm', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
  return { ok: status === 0, status, stdout, stderr };
}

export function runPnpmTest(pkg, path, filterName, options = {}) {
  const args = ['--filter', pkg, 'test'];
  if (path) args.push(path);
  if (filterName) args.push('-t', filterName);
  return runPnpm(args, { timeout: 180000, ...options });
}

export function ensureDist() {
  const markers = [
    'packages/db-core/dist/index.js',
    'packages/db/dist/index.js',
    'packages/transformer/dist/index.js',
  ];
  const missing = markers.filter((m) => !existsSync(join(repoRoot, m)));
  if (missing.length === 0) return;
  const { ok, stderr } = runPnpm(['-r', 'build'], { timeout: 300000 });
  if (!ok) throw new Error(`Build failed before gates could run:\n${stderr}`);
}

export function printResult(name, ok, details = '') {
  const icon = ok ? '✅' : '❌';
  const color = ok ? 'green' : 'red';
  console.log(`${icon} ${styleText(color, name)}${details ? `: ${details}` : ''}`);
}

export function fail(name, message) {
  printResult(name, false, message);
  process.exit(1);
}

export function pass(name) {
  printResult(name, true);
  process.exit(0);
}
