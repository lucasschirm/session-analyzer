import { fail, pass, runPnpmTest } from './lib/runner.mjs';

const gate = 'migration append-only / checksummed';

const { ok, stdout, stderr } = runPnpmTest(
  '@lucasschirm/sal-db-core',
  'tests/unit/migrations.test.ts',
);

if (!ok) {
  fail(gate, `${stdout}\n${stderr}`.trim());
}
pass(gate);
