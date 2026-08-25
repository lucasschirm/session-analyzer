import { fail, pass, runPnpmTest } from './lib/runner.mjs';

const gate = 'metric registry / reference match';

const { ok, stdout, stderr } = runPnpmTest(
  '@lucasschirm/sal-db',
  'tests/unit/metric-registry.test.ts',
  'validates the registry against a generated reference',
);

if (!ok) {
  fail(gate, `${stdout}\n${stderr}`.trim());
}
pass(gate);
