import { getWorkspacePackages } from './lib/packages.mjs';
import { fail, pass, runPnpmTest } from './lib/runner.mjs';

const gate = 'transformer conformance';

// Every transformer plugin package (packages/transformers/*-transformer, e.g.
// claude-transformer today, devin-transformer in future) must pass the
// shared transformer conformance suite via its own conformance test. This
// excludes transformer-shared (the contract layer itself, not a plugin) and
// any non-plugin package under packages/transformers/ (e.g. a registry
// composition package).
const transformerPlugins = getWorkspacePackages().filter(
  (pkg) => pkg.relDir.startsWith('packages/transformers/') && pkg.name.endsWith('-transformer'),
);

if (transformerPlugins.length === 0) {
  fail(gate, 'No transformer plugin packages found under packages/transformers/');
}

const failures = [];
for (const plugin of transformerPlugins) {
  const { ok, stdout, stderr } = runPnpmTest(plugin.name, 'tests/unit/conformance.test.ts');
  if (!ok) {
    failures.push(`${plugin.name}:\n${stdout}\n${stderr}`.trim());
  }
}

if (failures.length > 0) {
  fail(gate, failures.join('\n\n'));
}
pass(gate);
