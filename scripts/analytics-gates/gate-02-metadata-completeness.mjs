import { fail, pass, runPnpmTest } from './lib/runner.mjs';

const gate = 'metadata completeness';

const { ok, stdout, stderr } = runPnpmTest(
  '@lucasschirm/sal-db',
  'tests/unit/metric-registry.test.ts',
  'produces a release matrix for every phase 1-3 metric',
);

if (!ok) {
  fail(gate, `${stdout}\n${stderr}`.trim());
}
pass(gate);
