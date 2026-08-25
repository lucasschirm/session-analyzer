import { fail, pass, runPnpmTest } from './lib/runner.mjs';

const gate = 'policy versioning';

const { ok, stdout, stderr } = runPnpmTest(
  '@lucasschirm/sal-db',
  'tests/unit/metric-registry.test.ts',
  'validates policies are versioned and complete',
);

if (!ok) {
  fail(gate, `${stdout}\n${stderr}`.trim());
}
pass(gate);
