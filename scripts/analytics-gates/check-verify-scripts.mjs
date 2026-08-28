import { getWorkspacePackages } from './lib/packages.mjs';
import { fail, pass } from './lib/runner.mjs';

const gate = 'package verify scripts';

const packages = getWorkspacePackages();
const missing = packages
  .filter((p) => !p.packageJson.scripts?.verify)
  .map((p) => p.name ?? p.relDir);

if (missing.length > 0) {
  fail(gate, `packages missing verify script: ${missing.join(', ')}`);
}
pass(gate);
