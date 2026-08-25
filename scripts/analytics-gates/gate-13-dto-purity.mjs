import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, repoRoot } from './lib/runner.mjs';

const gate = 'DTO purity';

const dtoPath = join(repoRoot, 'packages/db/src/dto.ts');
const indexPath = join(repoRoot, 'packages/db/src/index.ts');

const dto = readFileSync(dtoPath, 'utf8');
const index = readFileSync(indexPath, 'utf8');

const importLines = dto
  .split('\n')
  .filter((line) => line.trim().startsWith('import ') || line.trim().startsWith('require('));
if (importLines.length > 0) {
  fail(gate, `dto.ts must not import runtime dependencies, found:\n${importLines.join('\n')}`);
}

const forbidden = ['Sqlite', 'sqlite', '@lucasschirm/sal-db-core', 'node:', 'import type {'];
for (const token of forbidden) {
  if (dto.includes(token)) {
    fail(gate, `dto.ts contains forbidden runtime token: ${token}`);
  }
}

if (!index.includes('dto.js') && !index.includes('./dto.js')) {
  fail(gate, 'packages/db/src/index.ts does not re-export dto.js');
}

pass(gate);
