#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
/**
 * Publishes each workspace package defining a `version:publish` script independently.
 *
 * Runs each package's `version:publish` in isolation with retries and handles
 * "already published" registry responses as successes. A failure in one package
 * never prevents other packages from running. If any package ultimately fails,
 * exits with code 1 after all packages have been attempted.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(__dirname, '..');

const WORKSPACE_GLOBS = [
  'packages/*',
  'packages/parsers/*',
  'packages/plugins/*',
  'packages/transformers/*',
];

export const ALREADY_PUBLISHED_REGEX = /cannot publish over|previously published|EPUBLISHCONFLICT/i;

export function getWorkspacePackages(rootDir = repoRoot) {
  const packages = [];
  for (const glob of WORKSPACE_GLOBS) {
    const base = join(rootDir, glob.replace('/*', ''));
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const dir = join(base, entry);
      const pkg = readPackageJson(dir);
      if (!pkg) continue;
      packages.push({
        name: pkg.name,
        version: pkg.version,
        dir,
        relDir: relative(rootDir, dir),
        packageJson: pkg,
      });
    }
  }
  return packages;
}

function readPackageJson(dir) {
  try {
    if (!statSync(dir).isDirectory()) return null;
    const pkgJsonPath = join(dir, 'package.json');
    if (!existsSync(pkgJsonPath)) return null;
    return JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  } catch {
    return null;
  }
}

export function getPublishablePackages(rootDir = repoRoot) {
  return getWorkspacePackages(rootDir).filter(
    (pkg) => typeof pkg.packageJson?.scripts?.['version:publish'] === 'string',
  );
}

export function isAlreadyPublished(output) {
  return ALREADY_PUBLISHED_REGEX.test(output);
}

export function getNewestNpmDebugLog() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const logDirs = [join(home, '.npm', '_logs'), '/home/runner/.npm/_logs'];
  let newest = null;
  let newestMtime = 0;
  for (const dir of logDirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.includes('debug')) continue;
      const p = join(dir, file);
      const mtime = statSync(p).mtimeMs;
      if (mtime > newestMtime) {
        newestMtime = mtime;
        newest = p;
      }
    }
  }
  return newest;
}

export function printNpmDebugLogs() {
  const logPath = getNewestNpmDebugLog();
  if (!logPath) return;
  try {
    console.log(`\n=== npm debug log (${logPath}) ===`);
    const lines = readFileSync(logPath, 'utf8').split('\n');
    console.log(lines.slice(-80).join('\n'));
  } catch (err) {
    console.error(`Could not read npm debug logs: ${err.message}`);
  }
}

export function defaultRunner(pkg) {
  return spawnSync('pnpm', ['run', 'version:publish'], {
    cwd: pkg.dir,
    encoding: 'utf8',
    stdio: 'pipe',
    env: process.env,
  });
}

function logAttemptFailure(pkg, attempt, maxAttempts, result, retryDelayMs) {
  if (attempt < maxAttempts) {
    const sec = Math.round(retryDelayMs / 1000);
    console.log(
      `::warning::Publish attempt ${attempt} for ${pkg.name} failed (exit ${result?.status}); retrying in ${sec}s...`,
    );
  } else {
    console.error(
      `::error::pnpm run version:publish failed for ${pkg.name} after ${maxAttempts} attempts (exit ${result?.status})`,
    );
    printNpmDebugLogs();
  }
}

export async function publishPackage(pkg, options = {}) {
  const {
    maxAttempts = Number.parseInt(process.env.MAX_ATTEMPTS || '2', 10),
    retryDelayMs = Number.parseInt(process.env.RETRY_DELAY_MS || '15000', 10),
    runner = defaultRunner,
    sleep = (ms) => new Promise((res) => setTimeout(res, ms)),
  } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`Publishing ${pkg.name}@${pkg.version} (attempt ${attempt}/${maxAttempts})...`);
    const result = runner(pkg);
    const output = ((result?.stdout || '') + (result?.stderr || '')).trim();
    if (output) console.log(output);

    if (result?.status === 0) {
      console.log(`✓ ${pkg.name}@${pkg.version}: completed successfully.`);
      return { name: pkg.name, version: pkg.version, status: 'published' };
    }
    if (isAlreadyPublished(output)) {
      console.log(
        `✓ ${pkg.name}@${pkg.version}: version already published on npm; treating as success.`,
      );
      return { name: pkg.name, version: pkg.version, status: 'already-published' };
    }
    logAttemptFailure(pkg, attempt, maxAttempts, result, retryDelayMs);
    if (attempt < maxAttempts) await sleep(retryDelayMs);
  }
  return { name: pkg.name, version: pkg.version, status: 'failed', exitCode: 1 };
}

export async function publishAllPackages(packages, options = {}) {
  const results = [];
  const total = packages.length;
  console.log(`Found ${total} package(s) with "version:publish" script.`);

  for (let i = 0; i < total; i++) {
    const pkg = packages[i];
    console.log(`\n[${i + 1}/${total}] Processing ${pkg.name}@${pkg.version} (${pkg.relDir})...`);
    const res = await publishPackage(pkg, options);
    results.push(res);
  }

  printSummary(results);
  const failed = results.filter((r) => r.status === 'failed');
  return { success: failed.length === 0, results, failed };
}

function printSummary(results) {
  console.log('\n================ Publish Summary ================');
  for (const r of results) {
    const icon = r.status === 'failed' ? '❌' : '✓';
    console.log(
      `${icon} ${r.name}@${r.version}: ${r.status}${r.exitCode !== undefined ? ` (exit ${r.exitCode})` : ''}`,
    );
  }
  console.log('=================================================');
}

export async function main() {
  const packages = getPublishablePackages();
  const { success } = await publishAllPackages(packages);
  if (!success) {
    process.exit(1);
  }
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
