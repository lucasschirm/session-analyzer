// @vitest-environment node

import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import {
  createAnalyticsDataSource,
  createSha256ContentHasher,
  DefaultIngestionOrchestrator,
} from '@lucasschirm/sal-db';
import { FRESH_SCHEMA_SQL } from '@lucasschirm/sal-db-core';
import { TransformerRegistry } from '@lucasschirm/sal-transformer';
import type { Database } from '@sqlite.org/sqlite-wasm';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type BenchmarkSession,
  BenchmarkTransformer,
  getManualBundle,
} from '../../../db/tests/fixtures/benchmark.js';
import { LegacyDatabase } from '../../src/db/legacy-database.js';
import { WasmSqliteExecutor } from '../../src/db/wasm-sqlite-executor.js';

const FILENAME = `/tmp/sal-legacy-parity-${randomUUID()}.sqlite3`;

const PROJECT_ID = 'project-legacy';
const SESSION_ID = 'session-legacy';
const INPUT_TOKENS = 1234;
const OUTPUT_TOKENS = 567;
const CACHE_CREATION = 89;
const CACHE_READ = 45;
const TOTAL_TOKENS = INPUT_TOKENS + OUTPUT_TOKENS;

function makeLegacySession(): BenchmarkSession {
  return {
    sessionId: SESSION_ID,
    rootSessionId: SESSION_ID,
    projectId: PROJECT_ID,
    sourceId: 'legacy-source',
    environmentId: 'legacy-env',
    harness: 'claude-code',
    mode: 'auto',
    taskCohort: 'feature',
    startTime: new Date(Date.UTC(2025, 7, 1, 10, 0, 0)).toISOString(),
    endTime: new Date(Date.UTC(2025, 7, 1, 10, 30, 0)).toISOString(),
    finality: 'final',
    inputTokens: INPUT_TOKENS,
    outputTokens: OUTPUT_TOKENS,
    cacheCreationTokens: CACHE_CREATION,
    cacheReadTokens: CACHE_READ,
    toolCount: 12,
    filesRead: 3,
    filesWritten: 2,
    evidenceCount: 3,
    payloadSize: 100,
    componentCount: 2,
    isLateArrival: false,
    isDeleted: false,
  };
}

describe('legacy database parity', () => {
  let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;

  beforeAll(async () => {
    sqlite3 = await sqlite3InitModule();
    const db = new sqlite3.oo1.DB(FILENAME, 'c');
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, session_count INTEGER NOT NULL DEFAULT 0);
      INSERT INTO projects VALUES ('${PROJECT_ID}', 'Legacy Project', '', ${Date.now()}, ${Date.now()}, 1);

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        model TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      INSERT INTO sessions VALUES (
        '${SESSION_ID}', '${PROJECT_ID}', 'legacy', 'Legacy Session',
        ${Date.UTC(2025, 7, 1, 10, 0, 0)}, ${Date.UTC(2025, 7, 1, 10, 30, 0)},
        ${INPUT_TOKENS}, ${OUTPUT_TOKENS}, ${CACHE_CREATION}, ${CACHE_READ}, ${TOTAL_TOKENS},
        NULL, 'claude-3-5-sonnet-20241022'
      );
    `);
    db.close();
  });

  afterAll(async () => {
    try {
      await unlink(FILENAME);
    } catch {
      // ignore
    }
  });

  it('validates token counts against the legacy read-only database', async () => {
    const legacy = new LegacyDatabase(sqlite3);
    const storage = await legacy.initialize(FILENAME);
    expect(storage).toBe('memory');

    const legacyDb = (legacy as unknown as { db: Database }).db;
    const legacyRow = legacyDb.selectObject(
      'SELECT input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens FROM sessions WHERE id = ?',
      [SESSION_ID],
    ) as {
      input_tokens: number;
      output_tokens: number;
      cache_creation_tokens: number;
      cache_read_tokens: number;
      total_tokens: number;
    };

    const executor = await WasmSqliteExecutor.create({
      filename: '/test-parity.sqlite3',
      preferOpfs: false,
    });
    await executor.exec(FRESH_SCHEMA_SQL);

    const session = makeLegacySession();
    const registry = new TransformerRegistry();
    const transformer = new BenchmarkTransformer();
    transformer.addSession(session);
    registry.register(transformer);

    const orchestrator = new DefaultIngestionOrchestrator({
      executor,
      hasher: createSha256ContentHasher(),
      registry,
      resolver: { resolve: async (ref) => ({ ...ref, content: new Uint8Array(0) }) },
      analysisReleaseId: 'ar-default',
    });

    const bundle = await getManualBundle(session);
    const receipt = await orchestrator.ingestManual(bundle);
    expect(receipt.status).toBe('committed');

    const dataSource = createAnalyticsDataSource(executor, createSha256ContentHasher());
    const summary = await dataSource.session.getSummary(SESSION_ID);

    const getMetric = (id: string) => summary.headlineMetrics.find((m) => m.metricId === id);
    expect(getMetric('input_tokens')?.value).toBe(legacyRow.input_tokens);
    expect(getMetric('output_tokens')?.value).toBe(legacyRow.output_tokens);
    expect(getMetric('cache_creation_tokens')?.value).toBe(legacyRow.cache_creation_tokens);
    expect(getMetric('cache_read_tokens')?.value).toBe(legacyRow.cache_read_tokens);
    expect((getMetric('input_tokens')?.value ?? 0) + (getMetric('output_tokens')?.value ?? 0)).toBe(
      legacyRow.total_tokens,
    );

    await executor.close();
    legacy.close();
  });
});
