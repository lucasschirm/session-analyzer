#!/usr/bin/env node
/**
 * Aligns both session-sync plugins to the higher of their two versions.
 *
 * The version-patch workflow bumps both plugins together via
 * `pnpm -r version:patch`, but a manual edit or a divergent starting version
 * (e.g. devin-session-sync shipped at 0.1.0 while claude-session-sync was
 * already at 0.2.39) can drift them. Rather than failing CI on divergence,
 * this script takes the higher version and applies it to both plugins'
 * `package.json` and manifest `plugin.json` files, so the next bump/publish
 * converges them automatically.
 *
 * Run locally: `node scripts/align-plugin-versions.mjs`
 * Run in CI:    invoked by `.github/workflows/version-patch.yml` before bumping.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const plugins = ['packages/plugins/claude-session-sync', 'packages/plugins/devin-session-sync'];

/** Manifest directories each plugin may carry (claude has only
 * `.claude-plugin`; devin has only `.devin-plugin`). The script silently
 * skips a manifest dir that doesn't exist for a given plugin. */
const manifestDirs = ['.claude-plugin', '.devin-plugin'];

function readVersion(dir) {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, dir, 'package.json'), 'utf8'));
  return pkg.version;
}

/** Compares two `major.minor.patch` strings; >0 if a>b, <0 if a<b, 0 if equal. */
function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function writeJson(filePath, data) {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

const versions = plugins.map(readVersion);
const higher = compareSemver(versions[0], versions[1]) >= 0 ? versions[0] : versions[1];

let aligned = false;
for (const dir of plugins) {
  const pkgPath = resolve(repoRoot, dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.version === higher) continue;

  const oldVersion = pkg.version;
  pkg.version = higher;
  writeJson(pkgPath, pkg);

  for (const manifestDir of manifestDirs) {
    const manifestPath = resolve(repoRoot, dir, manifestDir, 'plugin.json');
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.version = higher;
      writeJson(manifestPath, manifest);
    } catch {
      // Manifest directory not present for this plugin (e.g. claude has no
      // `.devin-plugin`); skip silently.
    }
  }

  console.log(`Aligned ${pkg.name}: ${oldVersion} -> ${higher}`);
  aligned = true;
}

if (!aligned) {
  console.log(`Plugin versions already match at ${higher}.`);
}
