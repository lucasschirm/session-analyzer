import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';
import { ensureDist, printResult, repoRoot } from './lib/runner.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const gates = [
  'check-verify-scripts',
  'gate-01-metric-registry-reference',
  'gate-02-metadata-completeness',
  'gate-03-id-version-uniqueness',
  'gate-04-manifest-contract-tests',
  'gate-05-migration-append-only-checksum',
  'gate-06-fresh-upgraded-schema-parity',
  'gate-07-acyclic-dependencies',
  'gate-08-transformer-conformance',
  'gate-09-comparability-group-prevention',
  'gate-10-rollup-reconciliation',
  'gate-11-policy-versioning',
  'gate-12-index-usage',
  'gate-13-dto-purity',
  'gate-14-documentation-index',
];

ensureDist();

const failed = [];
const passed = [];

for (const name of gates) {
  const script = `scripts/analytics-gates/${name}.mjs`;
  const { status, stdout, stderr } = spawnSync('node', [script], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const output = `${stdout}\n${stderr}`.trim();
  if (status !== 0) {
    failed.push({ name, output });
    printResult(name, false, 'see output below');
    if (output) console.log(output);
  } else {
    passed.push(name);
    const firstLine = output.split('\n')[0] ?? '';
    console.log(`${firstLine}`);
  }
}

console.log();
console.log(
  `${styleText('green', `${passed.length} passed`)}, ${styleText('red', `${failed.length} failed`)}`,
);

if (failed.length > 0) {
  console.log();
  console.log(styleText('red', 'Failures:'));
  for (const { name, output } of failed) {
    console.log(`  - ${name}`);
    console.log(
      output
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n'),
    );
  }
  process.exit(1);
}

process.exit(0);
