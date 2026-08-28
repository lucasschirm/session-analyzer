import { fail, pass, runPnpmTest } from './lib/runner.mjs';

const gate = 'transformer conformance';

const { ok, stdout, stderr } = runPnpmTest(
  '@lucasschirm/sal-transformer',
  'tests/unit/conformance.test.ts',
);

if (!ok) {
  fail(gate, `${stdout}\n${stderr}`.trim());
}
pass(gate);
