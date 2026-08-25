import { beforeAll, describe, expect, it } from 'vitest';

import { FRESH_SCHEMA_SQL, MIGRATIONS, MigrationRunner } from '../../src/index.js';
import { getSchemaSnapshot } from '../helpers/schema-snapshot.js';
import { getSqlite3, WasmSqliteExecutor } from '../helpers/sqlite-wasm-adapter.js';

beforeAll(async () => {
  await getSqlite3();
});

describe('fresh schema parity', () => {
  it('fresh schema equals sequentially upgraded schema', async () => {
    const freshExecutor = await WasmSqliteExecutor.create();
    await freshExecutor.exec(FRESH_SCHEMA_SQL);

    const sequentialExecutor = await WasmSqliteExecutor.create();
    const runner = new MigrationRunner(sequentialExecutor, MIGRATIONS);
    await runner.migrate();

    const fresh = await getSchemaSnapshot(freshExecutor);
    const sequential = await getSchemaSnapshot(sequentialExecutor);

    expect(fresh).toEqual(sequential);
  });
});
