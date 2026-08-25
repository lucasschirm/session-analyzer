import { fail, pass, runPnpmTest } from './lib/runner.mjs';

const gate = 'manifest contract tests';

const results = [
  runPnpmTest('@lucasschirm/sal-db-core', 'tests/unit/manifest.test.ts'),
  runPnpmTest('@lucasschirm/sal-db', 'tests/unit/manual-ingestion.test.ts'),
];

for (const { ok, stdout, stderr } of results) {
  if (!ok) {
    fail(gate, `${stdout}\n${stderr}`.trim());
  }
}

pass(gate);
