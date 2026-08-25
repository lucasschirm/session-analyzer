import { fail, pass, runPnpmTest } from './lib/runner.mjs';

const gate = 'fresh == upgraded schema parity';

const { ok, stdout, stderr } = runPnpmTest(
  '@lucasschirm/sal-db-core',
  'tests/unit/schema-parity.test.ts',
);

if (!ok) {
  fail(gate, `${stdout}\n${stderr}`.trim());
}
pass(gate);
