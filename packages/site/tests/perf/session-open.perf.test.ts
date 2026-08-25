// @vitest-environment node

import {
  createAnalyticsDataSource,
  createSha256ContentHasher,
  DefaultIngestionOrchestrator,
} from '@lucasschirm/sal-db';
import {
  FRESH_SCHEMA_SQL,
  type SqliteExecutor,
  type SqliteTransaction,
} from '@lucasschirm/sal-db-core';
import { TransformerRegistry } from '@lucasschirm/sal-transformer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type BenchmarkFixture,
  BenchmarkTransformer,
  generateBenchmarkFixture,
  getManualBundle,
} from '../../../db/tests/fixtures/benchmark.js';
import { WasmSqliteExecutor } from '../../src/db/wasm-sqlite-executor.js';

function getBudget(name: 'p95Millis' | 'queryCount' | 'ingestionMillis'): number {
  const isCi = process.env.CI === 'true';
  const base = isCi ? 1.5 : 1;
  const budgets = {
    p95Millis: 250 * base,
    queryCount: 10,
    ingestionMillis: 60_000 * base,
  };
  return budgets[name];
}

class InstrumentedExecutor implements SqliteExecutor {
  private sqlLog: { readonly sql: string; readonly params: readonly unknown[] }[] = [];

  constructor(private readonly wrapped: SqliteExecutor) {}

  get backend() {
    return this.wrapped.backend;
  }

  isBusy() {
    return this.wrapped.isBusy();
  }

  isClosed() {
    return this.wrapped.isClosed();
  }

  async close() {
    return this.wrapped.close();
  }

  resetLog() {
    this.sqlLog = [];
  }

  get logged() {
    return this.sqlLog;
  }

  async exec(sql: string, params?: readonly unknown[]) {
    this.sqlLog.push({ sql, params: params ?? [] });
    return this.wrapped.exec(sql, params as never);
  }

  transaction<T>(callback: (tx: SqliteTransaction) => Promise<T>): Promise<T> {
    return this.wrapped.transaction(async (tx) => callback(tx as never)) as Promise<T>;
  }
}

async function createExecutor() {
  const base = await WasmSqliteExecutor.create({
    filename: '/test-analytics.sqlite3',
    preferOpfs: false,
  });
  await base.exec(FRESH_SCHEMA_SQL);
  return new InstrumentedExecutor(base);
}

async function ingestFixture(executor: SqliteExecutor, fixture: BenchmarkFixture) {
  const registry = new TransformerRegistry();
  const transformer = new BenchmarkTransformer();
  transformer.addFixture(fixture);
  registry.register(transformer);

  const hasher = createSha256ContentHasher();
  const orchestrator = new DefaultIngestionOrchestrator({
    executor,
    hasher,
    registry,
    resolver: { resolve: async (ref) => ({ ...ref, content: new Uint8Array(0) }) },
    analysisReleaseId: 'ar-default',
  });

  const receipts = [];
  for (const session of fixture.rootSessions) {
    const bundle = await getManualBundle(session);
    const receipt = await orchestrator.ingestManual(bundle);
    receipts.push(receipt);
  }
  return receipts;
}

describe('site session-open read budget', () => {
  let fixture: BenchmarkFixture;
  let executor: InstrumentedExecutor;

  beforeAll(async () => {
    fixture = generateBenchmarkFixture({
      projects: 2,
      sources: 2,
      environments: 2,
      sessions: 50,
      childDepth: 0,
      childCount: 0,
      evidenceCount: 5,
      payloadSize: 100,
      componentCount: 3,
    });
    executor = await createExecutor();
    const start = Date.now();
    const receipts = await ingestFixture(executor, fixture);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(getBudget('ingestionMillis'));
    const failed = receipts.filter((r) => r.status !== 'committed');
    expect(failed).toHaveLength(0);
  });

  afterAll(async () => {
    await executor.close();
  });

  it('opens a session with a bounded number of indexed queries', async () => {
    const dataSource = createAnalyticsDataSource(executor, createSha256ContentHasher());
    const sample = fixture.rootSessions.slice(0, Math.min(20, fixture.rootSessions.length));
    let totalQueries = 0;
    for (const session of sample) {
      executor.resetLog();
      const summary = await dataSource.session.getSummary(session.sessionId);
      expect(summary.headlineMetrics.length).toBeGreaterThan(0);
      totalQueries += executor.logged.length;

      for (const { sql } of executor.logged) {
        if (sql.trim().startsWith('SELECT')) {
          const { rows } = await executor.exec(`EXPLAIN QUERY PLAN ${sql}`, []);
          const details = rows.map((r) => String(r.detail ?? r.Detail));
          const hasScan = details.some((d) => d.includes('SCAN ') && !d.includes('sqlite_master'));
          expect(hasScan).toBe(false);
        }
      }
    }
    const avg = totalQueries / sample.length;
    expect(avg).toBeLessThanOrEqual(getBudget('queryCount'));
  });

  it('honors the p95 session-open latency budget', async () => {
    const dataSource = createAnalyticsDataSource(executor, createSha256ContentHasher());
    const sample = fixture.rootSessions.slice(0, Math.min(50, fixture.rootSessions.length));
    const latencies: number[] = [];
    for (const session of sample) {
      const start = Date.now();
      await dataSource.session.getSummary(session.sessionId);
      latencies.push(Date.now() - start);
    }
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? latencies[latencies.length - 1];
    expect(p95).toBeLessThan(getBudget('p95Millis'));
  });
});
