import { fail, pass, runPnpmTest } from './lib/runner.mjs';

const gate = 'schema drift guard';

const { ok, stdout, stderr } = runPnpmTest(
  '@lucasschirm/sal-db',
  'tests/pipeline/pipe-010-schema-drift-guard.test.ts',
);

if (!ok) {
  fail(gate, `${stdout}\n${stderr}`.trim());
}
pass(gate);
