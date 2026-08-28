import { beforeAll, describe, expect, it } from 'vitest';

import {
  beginGeneration,
  buildGenerationScopedTableSql,
  buildInsertCandidateSql,
  commitGeneration,
  FRESH_SCHEMA_SQL,
  getCurrentGenerationId,
  getVisibleRows,
  insertCandidateRows,
  rollbackGeneration,
} from '../../src/index.js';
import { getSchemaSnapshot } from '../helpers/schema-snapshot.js';
import { getSqlite3, WasmSqliteExecutor } from '../helpers/sqlite-wasm-adapter.js';

beforeAll(async () => {
  await getSqlite3();
});

async function createExecutor(): Promise<WasmSqliteExecutor> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  return executor;
}

async function seedAnalysisRelease(executor: WasmSqliteExecutor, id: string): Promise<void> {
  await executor.exec(
    `INSERT INTO analysis_releases (
      id, ontology_version, metric_registry_version, statistical_policy_version,
      rollup_policy_version, mapping_version, created_at, is_default
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, '1', '1', '1', '1', '1', 1, 1],
  );
}

async function seedSession(executor: WasmSqliteExecutor, id: string): Promise<void> {
  await executor.exec(
    `INSERT INTO sessions (
      id, project_id, ingestion_source_id, environment_id, harness,
      native_session_id, finality, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, 'project-1', 'source-1', null, 'claude', 'native-1', 'open', 1, 1],
  );
}

const EVIDENCE_TABLE_SQL = buildGenerationScopedTableSql({
  tableName: 'test_evidence',
  baseColumns: [
    { name: 'session_id', type: 'TEXT NOT NULL' },
    { name: 'entity_key', type: 'TEXT NOT NULL' },
    { name: 'value', type: 'TEXT NOT NULL' },
  ],
  businessKeyColumns: ['session_id', 'entity_key'],
});

function makeBeginInput(sessionId: string) {
  return {
    sessionId,
    analysisReleaseId: 'ar-1',
    parserVersion: '1',
    transformerVersion: '1',
    ontologyVersion: '1',
    metricVersion: '1',
    schemaVersion: '1',
  };
}

describe('generation visibility primitives', () => {
  it('creates a generation-scoped table with the expected constraints', async () => {
    const executor = await createExecutor();
    await executor.exec(EVIDENCE_TABLE_SQL);

    const snapshot = await getSchemaSnapshot(executor);
    const table = snapshot.tables.find((t) => t.name === 'test_evidence');
    expect(table).toBeDefined();

    const columnNames = table?.columns.map((c) => c.name);
    expect(columnNames).toContain('generation_id');

    const index = table?.indexes.find((i) => i.name === 'idx_test_evidence_generation_scope');
    expect(index).toBeDefined();
    expect(index?.columns).toContain('session_id');
    expect(index?.columns).toContain('entity_key');
    expect(index?.columns).toContain('generation_id');
    expect(index?.unique).toBe(1);
  });

  it('inserts candidates that coexist with current rows and switches atomically', async () => {
    const executor = await createExecutor();
    await seedAnalysisRelease(executor, 'ar-1');
    await seedSession(executor, 's1');
    await executor.exec(EVIDENCE_TABLE_SQL);

    const sessionId = 's1';
    const gen1 = 'g1';
    const gen2 = 'g2';

    await executor.transaction(async (tx) => {
      await beginGeneration(tx, gen1, makeBeginInput(sessionId), 1);
      await insertCandidateRows(
        tx,
        'test_evidence',
        ['session_id', 'entity_key', 'value'],
        [[sessionId, 'k1', 'v1']],
        gen1,
      );
      await commitGeneration(tx, sessionId, gen1, 1);
    });

    let current = await getCurrentGenerationId(executor, sessionId);
    expect(current).toBe(gen1);

    let visible = await getVisibleRows(executor, sessionId, 'test_evidence');
    expect(visible.map((row) => row.value)).toEqual(['v1']);

    await executor.transaction(async (tx) => {
      await beginGeneration(tx, gen2, makeBeginInput(sessionId), 2);
      await insertCandidateRows(
        tx,
        'test_evidence',
        ['session_id', 'entity_key', 'value'],
        [[sessionId, 'k1', 'v2']],
        gen2,
      );
      await commitGeneration(tx, sessionId, gen2, 2);
    });

    current = await getCurrentGenerationId(executor, sessionId);
    expect(current).toBe(gen2);

    visible = await getVisibleRows(executor, sessionId, 'test_evidence');
    expect(visible.map((row) => row.value)).toEqual(['v2']);

    const { rows: gen1Row } = await executor.exec(
      'SELECT status, superseded_by_id FROM transformation_generations WHERE id = ?',
      [gen1],
    );
    expect(gen1Row[0].status).toBe('superseded');
    expect(gen1Row[0].superseded_by_id).toBe(gen2);

    const { rows: allRows } = await executor.exec(
      'SELECT value FROM test_evidence WHERE session_id = ? ORDER BY generation_id',
      [sessionId],
    );
    expect(allRows.map((row) => row.value)).toEqual(['v1', 'v2']);
  });

  it('transaction rollback leaves the previous generation visible', async () => {
    const executor = await createExecutor();
    await seedAnalysisRelease(executor, 'ar-1');
    await seedSession(executor, 's1');
    await executor.exec(EVIDENCE_TABLE_SQL);

    const sessionId = 's1';
    const gen1 = 'g1';
    const gen2 = 'g2';

    await executor.transaction(async (tx) => {
      await beginGeneration(tx, gen1, makeBeginInput(sessionId), 1);
      await insertCandidateRows(
        tx,
        'test_evidence',
        ['session_id', 'entity_key', 'value'],
        [[sessionId, 'k1', 'v1']],
        gen1,
      );
      await commitGeneration(tx, sessionId, gen1, 1);
    });

    await expect(
      executor.transaction(async (tx) => {
        await beginGeneration(tx, gen2, makeBeginInput(sessionId), 2);
        await insertCandidateRows(
          tx,
          'test_evidence',
          ['session_id', 'entity_key', 'value'],
          [[sessionId, 'k1', 'v2']],
          gen2,
        );
        throw new Error('intentional failure');
      }),
    ).rejects.toThrow('intentional failure');

    const current = await getCurrentGenerationId(executor, sessionId);
    expect(current).toBe(gen1);

    const visible = await getVisibleRows(executor, sessionId, 'test_evidence');
    expect(visible.map((row) => row.value)).toEqual(['v1']);

    const { rows } = await executor.exec('SELECT id FROM transformation_generations WHERE id = ?', [
      gen2,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('rollbackGeneration marks a pending generation as failed without changing current', async () => {
    const executor = await createExecutor();
    await seedAnalysisRelease(executor, 'ar-1');
    await seedSession(executor, 's1');
    await executor.exec(EVIDENCE_TABLE_SQL);

    const sessionId = 's1';
    const gen1 = 'g1';
    const gen2 = 'g2';

    await executor.transaction(async (tx) => {
      await beginGeneration(tx, gen1, makeBeginInput(sessionId), 1);
      await insertCandidateRows(
        tx,
        'test_evidence',
        ['session_id', 'entity_key', 'value'],
        [[sessionId, 'k1', 'v1']],
        gen1,
      );
      await commitGeneration(tx, sessionId, gen1, 1);
    });

    await executor.transaction(async (tx) => {
      await beginGeneration(tx, gen2, makeBeginInput(sessionId), 2);
      await insertCandidateRows(
        tx,
        'test_evidence',
        ['session_id', 'entity_key', 'value'],
        [[sessionId, 'k1', 'v2']],
        gen2,
      );
      await rollbackGeneration(tx, gen2);
    });

    const current = await getCurrentGenerationId(executor, sessionId);
    expect(current).toBe(gen1);

    const visible = await getVisibleRows(executor, sessionId, 'test_evidence');
    expect(visible.map((row) => row.value)).toEqual(['v1']);

    const { rows } = await executor.exec(
      'SELECT status FROM transformation_generations WHERE id = ?',
      [gen2],
    );
    expect(rows[0].status).toBe('failed');
  });

  it('rejects invalid identifiers when building DDL or inserts', () => {
    expect(() =>
      buildGenerationScopedTableSql({
        tableName: 'bad-table',
        baseColumns: [],
        businessKeyColumns: [],
      }),
    ).toThrow(/Invalid SQLite identifier/);

    expect(() => buildInsertCandidateSql('ok_table', ['bad col'], [['x']], 'g1')).toThrow(
      /Invalid SQLite identifier/,
    );

    expect(() => buildInsertCandidateSql('ok_table', ['col'], [['x', 'y']], 'g1')).toThrow(
      /Row length/,
    );
  });

  it('builds a generation-scoped table with defaults and not-null columns', async () => {
    const executor = await createExecutor();
    const sql = buildGenerationScopedTableSql({
      tableName: 'test_with_defaults',
      baseColumns: [
        { name: 'active', type: 'INTEGER', notNull: true, defaultValue: 1 },
        { name: 'label', type: 'TEXT', defaultValue: 'default' },
      ],
      businessKeyColumns: ['active'],
    });

    await executor.exec(sql);
    const snapshot = await getSchemaSnapshot(executor);
    const table = snapshot.tables.find((t) => t.name === 'test_with_defaults');
    expect(table).toBeDefined();

    const active = table?.columns.find((c) => c.name === 'active');
    expect(String(active?.dflt_value)).toBe('1');
    expect(active?.notnull).toBe(1);

    const label = table?.columns.find((c) => c.name === 'label');
    expect(String(label?.dflt_value)).toBe("'default'");
  });

  it('returns undefined current generation when none is committed', async () => {
    const executor = await createExecutor();
    await seedSession(executor, 's1');
    const current = await getCurrentGenerationId(executor, 's1');
    expect(current).toBeUndefined();
  });

  it('rejects commit for a missing or foreign generation', async () => {
    const executor = await createExecutor();
    await seedAnalysisRelease(executor, 'ar-1');
    await seedSession(executor, 's1');

    await executor.transaction(async (tx) => {
      await beginGeneration(tx, 'g1', makeBeginInput('s1'), 1);
      await commitGeneration(tx, 's1', 'g1', 1);
    });

    await expect(
      executor.transaction(async (tx) => {
        await commitGeneration(tx, 's1', 'missing', 2);
      }),
    ).rejects.toThrow(/Generation not found/);

    await seedSession(executor, 's2');
    await executor.transaction(async (tx) => {
      await beginGeneration(tx, 'g2', makeBeginInput('s2'), 2);
    });

    await expect(
      executor.transaction(async (tx) => {
        await commitGeneration(tx, 's1', 'g2', 2);
      }),
    ).rejects.toThrow(/belongs to session/);
  });

  it('rejects rollback for missing or non-pending generations', async () => {
    const executor = await createExecutor();
    await seedAnalysisRelease(executor, 'ar-1');
    await seedSession(executor, 's1');

    await executor.transaction(async (tx) => {
      await beginGeneration(tx, 'g1', makeBeginInput('s1'), 1);
      await commitGeneration(tx, 's1', 'g1', 1);
    });

    await expect(
      executor.transaction(async (tx) => {
        await rollbackGeneration(tx, 'missing');
      }),
    ).rejects.toThrow(/Generation not found/);

    await expect(
      executor.transaction(async (tx) => {
        await rollbackGeneration(tx, 'g1');
      }),
    ).rejects.toThrow(/status is committed/);
  });
});
