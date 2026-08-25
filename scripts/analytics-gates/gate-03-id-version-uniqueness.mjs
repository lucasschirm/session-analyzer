import { fail, pass, runPnpmTest } from './lib/runner.mjs';

const gate = 'ID / version uniqueness';

const { ok, stdout, stderr } = runPnpmTest(
  '@lucasschirm/sal-db',
  'tests/unit/metric-registry.test.ts',
  'versions a metric when its meaning changes',
);

if (!ok) {
  fail(gate, `${stdout}\n${stderr}`.trim());
}
pass(gate);
