import { fail, pass, runPnpmTest } from './lib/runner.mjs';

const gate = 'comparability group prevention';

const { ok, stdout, stderr } = runPnpmTest(
  '@lucasschirm/sal-db',
  'tests/unit/metric-registry.test.ts',
  'prevents mixed comparability groups',
);

if (!ok) {
  fail(gate, `${stdout}\n${stderr}`.trim());
}
pass(gate);
