import { fail, pass, runPnpmTest } from './lib/runner.mjs';

const gate = 'rollup reconciliation';

const { ok, stdout, stderr } = runPnpmTest(
  '@lucasschirm/sal-db',
  'tests/unit/rollup-reconciliation.test.ts',
);

if (!ok) {
  fail(gate, `${stdout}\n${stderr}`.trim());
}
pass(gate);
