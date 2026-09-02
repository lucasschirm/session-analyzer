import {
  ComponentIdentityStore,
  EnvironmentStore,
  FRESH_SCHEMA_SQL,
  IngestionSourceStore,
  InvocationStore,
  ModelRequestStore,
  ModelUsageStore,
  PortfolioStore,
  ProjectStore,
  SessionStore,
  SourceProjectStore,
  TenantStore,
  TurnStore,
} from '@lucasschirm/sal-db-core';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import {
  createProjectBehaviorView,
  getDurationHistogram,
  getProjectModelHarnessCohorts,
  getStatStrip,
  getTopTools,
  getWeeklyToolErrorRate,
} from '../../src/project-behavior.js';

const TENANT_ID = 'tenant-pb169';
const PORTFOLIO_ID = 'portfolio-pb169';
const SOURCE_ID = 'source-pb169';
const ENV_ID = 'env-pb169';
const PROJECT_ID = 'project-pb169';

async function createExecutor(): Promise<WasmSqliteExecutor> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  await TenantStore.insert(executor, { id: TENANT_ID, name: 'Test' });
  await PortfolioStore.insert(executor, { id: PORTFOLIO_ID, tenantId: TENANT_ID, name: 'P' });
  await IngestionSourceStore.insert(executor, {
    id: SOURCE_ID,
    portfolioId: PORTFOLIO_ID,
    nativeSourceId: 'src',
    displayName: 'Source',
    type: 'claude_code',
    authority: 'local',
  });
  await EnvironmentStore.insert(executor, PORTFOLIO_ID, {
    id: ENV_ID,
    ingestionSourceId: SOURCE_ID,
    nativeEnvironmentId: 'env-native',
  });
  await ProjectStore.insert(executor, { id: PROJECT_ID, portfolioId: PORTFOLIO_ID, name: 'alpha' });
  await SourceProjectStore.insert(executor, PORTFOLIO_ID, {
    projectId: PROJECT_ID,
    ingestionSourceId: SOURCE_ID,
    nativeProjectId: 'native-alpha',
  });
  return executor;
}

async function insertSession(
  executor: WasmSqliteExecutor,
  id: string,
  startTime: number | null,
  endTime: number | null = null,
  outcome: string | null = null,
): Promise<void> {
  await SessionStore.insert(executor, {
    id,
    projectId: PROJECT_ID,
    ingestionSourceId: SOURCE_ID,
    nativeSessionId: id,
    harness: 'claude-code',
    finality: 'final',
    startTime,
    endTime,
    outcome,
  });
}

async function insertGeneration(
  executor: WasmSqliteExecutor,
  sessionId: string,
  generationId: string,
): Promise<void> {
  const { rows } = await executor.exec('SELECT id FROM analysis_releases WHERE id = ?', [
    'pb169-ar',
  ]);
  if (rows.length === 0) {
    await executor.exec(
      `INSERT INTO analysis_releases
       (id, ontology_version, metric_registry_version, statistical_policy_version,
        rollup_policy_version, mapping_version, created_at, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['pb169-ar', '0.1.0', '0.1.0', '0.1.0', '0.1.0', '0.1.0', 1, 0],
    );
  }
  await executor.exec(
    `INSERT INTO transformation_generations
     (id, session_id, analysis_release_id, parser_version, transformer_version,
      ontology_version, metric_version, schema_version, status, source_availability, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      generationId,
      sessionId,
      'pb169-ar',
      '0.1.0',
      '0.1.0',
      '0.1.0',
      '0.1.0',
      '0.1.0',
      'committed',
      'local',
      1,
    ],
  );
}

async function insertTurn(
  executor: WasmSqliteExecutor,
  sessionId: string,
  generationId: string,
  ordering: number,
): Promise<void> {
  await TurnStore.insert(executor, { sessionId, generationId, ordering, role: 'human' } as never);
}

async function insertModelRequest(
  executor: WasmSqliteExecutor,
  sessionId: string,
  generationId: string,
  requestOrder: number,
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
): Promise<string> {
  return ModelRequestStore.insert(executor, {
    sessionId,
    generationId,
    requestOrder,
    model,
    provider: 'anthropic',
    inputTokens,
    outputTokens,
    status: 'success',
  } as never);
}

async function insertCost(
  executor: WasmSqliteExecutor,
  sessionId: string,
  generationId: string,
  requestId: string,
  cost: number | null,
): Promise<void> {
  await ModelUsageStore.insert(executor, {
    sessionId,
    generationId,
    requestId,
    tokenClass: 'input',
    tokenCount: 10,
    isEstimated: false,
    cost,
  } as never);
}

async function insertToolComponent(
  executor: WasmSqliteExecutor,
  nativeId: string,
): Promise<string> {
  return ComponentIdentityStore.insert(executor, {
    portfolioId: PORTFOLIO_ID,
    kind: 'tool',
    nativeId,
    canonicalSourceIdentity: `tool:${nativeId}`,
    displayName: nativeId,
  });
}

async function insertToolInvocation(
  executor: WasmSqliteExecutor,
  sessionId: string,
  generationId: string,
  componentId: string,
  status: 'completed' | 'failed',
  createdAt: number,
): Promise<void> {
  const startId = `start-${sessionId}-${createdAt}-${Math.random()}`;
  await InvocationStore.insert(executor, {
    sessionId,
    generationId,
    kind: 'tool',
    componentId,
    startId,
    rootSessionId: sessionId,
    status,
  } as never);
  await executor.exec(
    'UPDATE invocations SET created_at = ? WHERE session_id = ? AND kind = ? AND start_id = ?',
    [createdAt, sessionId, 'tool', startId],
  );
}

describe('getStatStrip (issue #169)', () => {
  it('reports duration/turns percentiles null with knownN 0 when no session has both bounds', async () => {
    const executor = await createExecutor();
    await insertSession(executor, 's-open', 1000, null);
    const result = await getStatStrip(executor, PROJECT_ID, {});
    expect(result.sessions.current).toBe(1);
    expect(result.durationMedianMs).toEqual({ value: null, eligibleN: 1, knownN: 0 });
    expect(result.turnsMedian).toEqual({ value: null, eligibleN: 1, knownN: 0 });
  });

  it('computes median/p90 duration and turns from known sessions', async () => {
    const executor = await createExecutor();
    await insertSession(executor, 's1', 1000, 2000);
    await insertGeneration(executor, 's1', 'gen-1');
    await insertTurn(executor, 's1', 'gen-1', 0);
    await insertTurn(executor, 's1', 'gen-1', 1);
    await insertSession(executor, 's2', 1000, 4000);
    await insertGeneration(executor, 's2', 'gen-2');
    await insertTurn(executor, 's2', 'gen-2', 0);

    const result = await getStatStrip(executor, PROJECT_ID, {});
    expect(result.durationMedianMs.knownN).toBe(2);
    expect(result.durationMedianMs.value).toBeGreaterThan(0);
    expect(result.turnsMedian.knownN).toBe(2);
  });

  it('reports tokens/cost per session as null when no session has known values', async () => {
    const executor = await createExecutor();
    await insertSession(executor, 's1', 1000);
    const result = await getStatStrip(executor, PROJECT_ID, {});
    expect(result.tokensPerSession).toEqual({ value: null, eligibleN: 1, knownN: 0 });
    expect(result.costPerSession).toEqual({ value: null, eligibleN: 1, knownN: 0 });
  });

  it('averages known tokens/cost per session, excluding unknown sessions from the denominator', async () => {
    const executor = await createExecutor();
    await insertSession(executor, 's1', 1000);
    await insertGeneration(executor, 's1', 'gen-1');
    const reqId = await insertModelRequest(executor, 's1', 'gen-1', 0, 'claude-sonnet', 100, 50);
    await insertCost(executor, 's1', 'gen-1', reqId, 0.2);
    await insertSession(executor, 's-no-tokens', 2000);

    const result = await getStatStrip(executor, PROJECT_ID, {});
    expect(result.tokensPerSession).toEqual({ value: 150, eligibleN: 2, knownN: 1 });
    expect(result.costPerSession).toEqual({ value: 0.2, eligibleN: 2, knownN: 1 });
  });
});

describe('getDurationHistogram (issue #169)', () => {
  it('bins a duration exactly on an edge into the upper (>=) bin', async () => {
    const executor = await createExecutor();
    await insertSession(executor, 's1', 0, 60_000);
    const histogram = await getDurationHistogram(executor, PROJECT_ID, {});
    const secondBin = histogram.bins[1];
    expect(secondBin.startMs).toBe(60_000);
    expect(secondBin.count).toBe(1);
    expect(histogram.bins[0].count).toBe(0);
  });

  it('reports knownN below eligibleN when a session is missing end_time', async () => {
    const executor = await createExecutor();
    await insertSession(executor, 's1', 0, 60_000);
    await insertSession(executor, 's2', 0, null);
    const histogram = await getDurationHistogram(executor, PROJECT_ID, {});
    expect(histogram.eligibleN).toBe(2);
    expect(histogram.knownN).toBe(1);
  });

  it('leaves the final bin open-ended (endMs: null)', async () => {
    const executor = await createExecutor();
    const histogram = await getDurationHistogram(executor, PROJECT_ID, {});
    expect(histogram.bins[histogram.bins.length - 1].endMs).toBeNull();
  });
});

describe('getWeeklyToolErrorRate (issue #169)', () => {
  it('reports rate null (not 0) for a project with zero tool calls', async () => {
    const executor = await createExecutor();
    const series = await getWeeklyToolErrorRate(executor, PROJECT_ID, undefined);
    expect(series.series).toEqual([]);
    expect(series.currentValue).toBeNull();
    expect(series.currentWeekN).toBe(0);
  });

  it('computes a real rate and exposes it as currentValue for the latest week', async () => {
    const executor = await createExecutor();
    await insertSession(executor, 's1', 1000);
    await insertGeneration(executor, 's1', 'gen-1');
    const bash = await insertToolComponent(executor, 'bash');
    await insertToolInvocation(executor, 's1', 'gen-1', bash, 'completed', 1_700_000_000_000);
    await insertToolInvocation(executor, 's1', 'gen-1', bash, 'failed', 1_700_000_001_000);

    const series = await getWeeklyToolErrorRate(executor, PROJECT_ID, undefined);
    expect(series.series).toHaveLength(1);
    expect(series.series[0].rate).toBeCloseTo(0.5);
    expect(series.currentValue).toBeCloseTo(0.5);
    expect(series.currentWeekN).toBe(2);
  });
});

describe('getTopTools (issue #169)', () => {
  it('ranks tools by invocation count, kind=tool only', async () => {
    const executor = await createExecutor();
    await insertSession(executor, 's1', 1000);
    await insertGeneration(executor, 's1', 'gen-1');
    const bash = await insertToolComponent(executor, 'bash');
    await insertToolInvocation(executor, 's1', 'gen-1', bash, 'completed', 2000);
    await insertToolInvocation(executor, 's1', 'gen-1', bash, 'completed', 2100);

    const list = await getTopTools(executor, PROJECT_ID, {});
    expect(list.rows).toEqual([{ componentId: bash, displayName: 'bash', invocationCount: 2 }]);
    expect(list.totalInvocations).toBe(2);
  });
});

describe('getProjectModelHarnessCohorts (issue #169)', () => {
  it('flags a cohort below the low-n threshold', async () => {
    const executor = await createExecutor();
    await insertSession(executor, 's1', 1000, null, 'clean');
    await insertGeneration(executor, 's1', 'gen-1');
    await insertModelRequest(executor, 's1', 'gen-1', 0, 'claude-sonnet', 100, 50);

    const cohorts = await getProjectModelHarnessCohorts(executor, PROJECT_ID, {});
    expect(cohorts.rows).toHaveLength(1);
    expect(cohorts.rows[0]).toMatchObject({
      model: 'claude-sonnet',
      harness: 'claude-code',
      n: 1,
      cleanRate: 1,
      lowN: true,
    });
  });

  it('reports medianCost null when no session in the cohort has known cost', async () => {
    const executor = await createExecutor();
    await insertSession(executor, 's1', 1000);
    await insertGeneration(executor, 's1', 'gen-1');
    await insertModelRequest(executor, 's1', 'gen-1', 0, 'claude-sonnet', 100, 50);

    const cohorts = await getProjectModelHarnessCohorts(executor, PROJECT_ID, {});
    expect(cohorts.rows[0].medianCost).toBeNull();
  });
});

describe('createProjectBehaviorView (issue #169 wiring)', () => {
  it('exposes the new methods through the view factory', async () => {
    const executor = await createExecutor();
    await insertSession(executor, 's1', 1000);
    const view = createProjectBehaviorView(executor);
    expect(await view.getStatStrip(PROJECT_ID, {})).toBeDefined();
    expect(await view.getDurationHistogram(PROJECT_ID, {})).toBeDefined();
    expect(await view.getWeeklyToolErrorRate(PROJECT_ID)).toBeDefined();
    expect(await view.getTopTools(PROJECT_ID, {})).toBeDefined();
    expect(await view.getModelHarnessCohorts(PROJECT_ID, {})).toBeDefined();
  });
});
