import {
  FRESH_SCHEMA_SQL,
  type SqliteExecutor,
  type SqliteTransaction,
} from '@lucasschirm/sal-db-core';
import { TransformerRegistry } from '@lucasschirm/sal-transformer-shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createAnalyticsDataSource } from '../../src/analytics.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import {
  applySessionRollupContributions,
  isRollupReconciled,
  reconcileRollupTotals,
} from '../../src/rollup-reconciliation.js';
import {
  type BenchmarkFixture,
  BenchmarkTransformer,
  generateBenchmarkFixture,
  getManualBundle,
} from '../fixtures/benchmark.js';

function getBenchmarkScale() {
  const env = process.env.BENCHMARK_SCALE;
  if (env === 'large') {
    return {
      projects: 10,
      sources: 5,
      environments: 5,
      sessions: 1000,
      childDepth: 2,
      childCount: 2,
      evidenceCount: 10,
      payloadSize: 1000,
      componentCount: 10,
    };
  }
  if (env === 'ci') {
    return {
      projects: 3,
      sources: 2,
      environments: 2,
      sessions: 50,
      childDepth: 2,
      childCount: 2,
      evidenceCount: 5,
      payloadSize: 100,
      componentCount: 5,
    };
  }
  return {
    projects: 2,
    sources: 2,
    environments: 2,
    sessions: 20,
    childDepth: 1,
    childCount: 2,
    evidenceCount: 5,
    payloadSize: 100,
    componentCount: 3,
  };
}

function getBudget(
  name:
    | 'ingestionMillis'
    | 'sessionOpenMillis'
    | 'rebuildMillis'
    | 'p95Millis'
    | 'queryCount'
    | 'memoryMB',
): number {
  const isCi = process.env.CI === 'true';
  const base = isCi ? 1.5 : 1;
  const budgets = {
    ingestionMillis: 60_000 * base,
    sessionOpenMillis: 200 * base,
    rebuildMillis: 30_000 * base,
    p95Millis: 250 * base,
    queryCount: 10,
    memoryMB: 256,
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
  const base = await WasmSqliteExecutor.create();
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

async function applyRollupsForFixture(executor: SqliteExecutor, fixture: BenchmarkFixture) {
  for (const session of fixture.rootSessions) {
    const { rows } = await executor.exec(
      'SELECT current_generation_id FROM sessions WHERE id = ?',
      [session.sessionId],
    );
    const current = rows[0]?.current_generation_id as string | undefined;
    if (!current) continue;
    await applySessionRollupContributions(executor, {
      sessionId: session.sessionId,
      generationId: current,
      analysisReleaseId: 'ar-default',
      generationToken: current,
    });
  }
}

async function explainPlan(executor: SqliteExecutor, sql: string, params: readonly unknown[]) {
  const { rows } = await executor.exec(`EXPLAIN QUERY PLAN ${sql}`, [...params]);
  return rows.map((r) => String(r.detail ?? r.Detail));
}

async function assertIndexed(
  executor: SqliteExecutor,
  sql: string,
  params: readonly unknown[],
  expectedIndexes: readonly string[],
) {
  const details = await explainPlan(executor, sql, params);
  const hasScan = details.some((d) => d.includes('SCAN ') && !d.includes('sqlite_master'));
  const usesExpected = expectedIndexes.some((idx) => details.some((d) => d.includes(idx)));

  if (hasScan) {
    throw new Error(`plan contains table scan for: ${sql}\n${details.join('\n')}`);
  }
  if (expectedIndexes.length > 0 && !usesExpected) {
    throw new Error(
      `expected index not used for: ${sql}\nexpected: ${expectedIndexes.join(', ')}\nplan:\n${details.join('\n')}`,
    );
  }
}

describe('benchmark fixtures', () => {
  let fixture: BenchmarkFixture;
  let executor: InstrumentedExecutor;
  let receipts: Awaited<ReturnType<typeof ingestFixture>>;

  beforeAll(async () => {
    const scale = getBenchmarkScale();
    fixture = generateBenchmarkFixture(scale);
    executor = await createExecutor();
    const start = Date.now();
    receipts = await ingestFixture(executor, fixture);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(getBudget('ingestionMillis'));
  });

  afterAll(async () => {
    await executor.close();
  });

  it('ingests all root sessions successfully', () => {
    const failed = receipts.filter((r) => r.status !== 'committed');
    expect(failed).toHaveLength(0);
    expect(receipts.length).toBe(fixture.rootSessions.length);
  });

  it('persists the expected number of sessions and metric values', async () => {
    const { rows: sessionRows } = await executor.exec('SELECT COUNT(*) AS c FROM sessions');
    const { rows: metricRows } = await executor.exec('SELECT COUNT(*) AS c FROM metric_values');
    const sessionCount = Number(sessionRows[0].c);
    const metricCount = Number(metricRows[0].c);
    expect(sessionCount).toBeGreaterThanOrEqual(fixture.sessions.length);
    expect(metricCount).toBeGreaterThanOrEqual(sessionCount);
  });

  it('keeps session-open queries bounded and indexed', async () => {
    const dataSource = createAnalyticsDataSource(executor, createSha256ContentHasher());
    const sample = fixture.rootSessions.slice(0, Math.min(20, fixture.rootSessions.length));
    let totalQueries = 0;
    for (const session of sample) {
      executor.resetLog();
      const summary = await dataSource.session.getSummary(session.sessionId);
      expect(summary.headlineMetrics.length).toBeGreaterThan(0);
      totalQueries += executor.logged.length;
    }
    const avg = totalQueries / sample.length;
    expect(avg).toBeLessThanOrEqual(getBudget('queryCount'));

    for (const { sql } of executor.logged) {
      if (sql.trim().startsWith('SELECT')) {
        const hasScan = (await explainPlan(executor, sql, [])).some(
          (d) => d.includes('SCAN ') && !d.includes('sqlite_master'),
        );
        expect(hasScan).toBe(false);
      }
    }
  });

  it('honors the session-open read budget', async () => {
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

  it('keeps project-list and portfolio overview queries bounded', async () => {
    const dataSource = createAnalyticsDataSource(executor, createSha256ContentHasher());
    const latencies: number[] = [];

    for (let i = 0; i < 20; i++) {
      executor.resetLog();
      const start = Date.now();
      await dataSource.portfolio.getOverview({});
      await dataSource.portfolio.getProjectList({});
      latencies.push(Date.now() - start);
      expect(executor.logged.length).toBeLessThanOrEqual(getBudget('queryCount') * 5);
    }

    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? latencies[latencies.length - 1];
    expect(p95).toBeLessThan(getBudget('p95Millis') * 2);
  });

  it('reconciles rollup totals after materializing contributions', async () => {
    await applyRollupsForFixture(executor, fixture);
    const nativeProjectId = fixture.projects[0];
    if (!nativeProjectId) return;
    const { rows } = await executor.exec(
      'SELECT id, portfolio_id FROM projects WHERE name = ? LIMIT 1',
      [nativeProjectId],
    );
    if (rows.length === 0) return;
    const canonicalProjectId = String(rows[0].id);
    const portfolioId = String(rows[0].portfolio_id);
    const mismatches = await reconcileRollupTotals(
      executor,
      canonicalProjectId,
      portfolioId,
      'ar-default',
    );
    expect(isRollupReconciled(mismatches)).toBe(true);
  });
});

describe('query plan assertions', () => {
  let executor: SqliteExecutor;

  beforeAll(async () => {
    executor = await createExecutor();
    const fixture = generateBenchmarkFixture({
      projects: 2,
      sources: 2,
      environments: 2,
      sessions: 20,
      childDepth: 1,
      childCount: 2,
      evidenceCount: 3,
      payloadSize: 50,
      componentCount: 3,
    });
    await ingestFixture(executor, fixture);
    await applyRollupsForFixture(executor, fixture);
  });

  afterAll(async () => {
    await executor.close();
  });

  it('uses the expected indexes for common dashboard queries', async () => {
    const cases = [
      {
        sql: 'SELECT * FROM sessions WHERE project_id = ?',
        params: ['project-1'],
        expectedIndexes: ['idx_sessions_project'],
      },
      {
        sql: 'SELECT * FROM sessions WHERE current_generation_id = ?',
        params: ['gen-1'],
        expectedIndexes: ['idx_sessions_current_generation'],
      },
      {
        sql: 'SELECT * FROM sessions WHERE id = ?',
        params: ['sess-1'],
        expectedIndexes: ['idx_sessions_id', 'sqlite_autoindex_sessions_1', 'INTEGER PRIMARY KEY'],
      },
      {
        sql: 'SELECT * FROM metric_values WHERE session_id = ? AND generation_id = ?',
        params: ['sess-1', 'gen-1'],
        expectedIndexes: ['idx_metric_values_session'],
      },
      {
        sql: 'SELECT * FROM project_daily_rollups WHERE project_id = ? AND day_bucket = ?',
        params: ['project-1', '2026-08-24'],
        expectedIndexes: ['idx_project_daily_rollups_day'],
      },
      {
        sql: 'SELECT * FROM source_manifests WHERE session_id = ?',
        params: ['sess-1'],
        expectedIndexes: ['idx_source_manifests_session'],
      },
    ];

    for (const { sql, params, expectedIndexes } of cases) {
      await assertIndexed(executor, sql, params, expectedIndexes);
    }
  });
});
