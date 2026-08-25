import type { RollupPolicy } from '@lucasschirm/sal-db-core';
import {
  FRESH_SCHEMA_SQL,
  IngestionSourceStore,
  MetricDefinitionStore,
  MetricValueStore,
  PortfolioStore,
  ProjectStore,
  SessionStore,
  StatisticalPolicyStore,
  TenantStore,
} from '@lucasschirm/sal-db-core';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import {
  applySessionRollupContributions,
  isRollupReconciled,
  makeDefaultRollupPolicy,
  rebuildProjectPortfolioRollups,
  reconcileRollupTotals,
} from '../../src/rollup-reconciliation.js';

const TENANT_ID = 't-test';
const PORTFOLIO_ID = 'p-test';
const SOURCE_ID = 's-test';
const PROJECT_ID = 'prj-test';
const SESSION_ID = 'se-test';
const CHILD_SESSION_ID = 'se-child';
const ANALYSIS_RELEASE_ID = 'ar-test';
const BASE_TIME = new Date('2026-08-24T12:00:00Z').getTime();

async function createExecutor(): Promise<WasmSqliteExecutor> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  return executor;
}

async function seedIdentity(executor: WasmSqliteExecutor): Promise<void> {
  await TenantStore.insert(executor, { id: TENANT_ID, name: 'Test' });
  await PortfolioStore.insert(executor, {
    id: PORTFOLIO_ID,
    tenantId: TENANT_ID,
    name: 'Portfolio',
  });
  await IngestionSourceStore.insert(executor, {
    id: SOURCE_ID,
    portfolioId: PORTFOLIO_ID,
    nativeSourceId: 'src',
    displayName: 'Source',
    type: 'test',
    authority: 'local',
  });
  await ProjectStore.insert(executor, {
    id: PROJECT_ID,
    portfolioId: PORTFOLIO_ID,
    name: 'project',
  });
  await executor.exec(
    `INSERT INTO analysis_releases
     (id, ontology_version, metric_registry_version, statistical_policy_version,
      rollup_policy_version, mapping_version, created_at, is_default)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [ANALYSIS_RELEASE_ID, '0.1.0', '0.1.0', '0.1.0', '0.1.0', '0.1.0', BASE_TIME, 0],
  );
}

async function createStatisticalPolicy(executor: WasmSqliteExecutor): Promise<string> {
  return StatisticalPolicyStore.insert(executor, {
    policyId: 'sp-test',
    version: 1,
    name: 'Default',
    observationUnit: 'session',
    eligibility: 'all',
  });
}

async function createMetricDefinition(
  executor: WasmSqliteExecutor,
  params: {
    metricId: string;
    rootInclusion: 'root_only' | 'inclusive';
    statisticalPolicyId: string;
    dimensions?: readonly string[];
    unit?: string;
    valueType?: 'integer' | 'real';
  },
): Promise<string> {
  return MetricDefinitionStore.insert(executor, {
    metricId: params.metricId,
    version: 1,
    label: params.metricId,
    description: 'test metric',
    family: 'test',
    measurementClass: 'observed',
    unit: params.unit ?? 'count',
    valueType: params.valueType ?? 'integer',
    grain: 'session',
    dimensions: params.dimensions ?? [],
    populationRule: 'all',
    statusRule: 'none',
    aggregation: 'sum',
    statisticalPolicyId: params.statisticalPolicyId,
    comparabilityGroupInputs: [],
    missingDataBehavior: 'unknown',
    rootInclusion: params.rootInclusion,
    provenanceRequirement: 'test',
  });
}

async function createSession(
  executor: WasmSqliteExecutor,
  sessionId: string,
  nativeSessionId: string,
  overrides?: { model?: string; mode?: string; taskCohort?: string },
): Promise<void> {
  await SessionStore.insert(executor, {
    id: sessionId,
    projectId: PROJECT_ID,
    ingestionSourceId: SOURCE_ID,
    nativeSessionId,
    harness: 'claude-code',
    occurrenceTime: BASE_TIME,
    model: overrides?.model ?? 'claude-sonnet',
    mode: overrides?.mode ?? 'auto',
    taskCohort: overrides?.taskCohort ?? 'feature',
  });
}

async function createGeneration(
  executor: WasmSqliteExecutor,
  sessionId: string,
  generationId: string,
): Promise<void> {
  await executor.exec(
    `INSERT INTO transformation_generations
     (id, session_id, analysis_release_id, parser_version, transformer_version,
      ontology_version, metric_version, schema_version, status, source_availability, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      generationId,
      sessionId,
      ANALYSIS_RELEASE_ID,
      '0.1.0',
      '0.1.0',
      '0.1.0',
      '0.1.0',
      '0.1.0',
      'committed',
      'local',
      BASE_TIME,
    ],
  );
}

async function createIntegerMetricValue(
  executor: WasmSqliteExecutor,
  params: {
    metricDefinitionId: string;
    generationId: string;
    sessionId: string;
    value: number;
    rootInclusion: 'root_only' | 'inclusive';
    dimensionsKey?: string | null;
    valueId?: string;
  },
): Promise<string> {
  return MetricValueStore.insert(executor, {
    id: params.valueId,
    metricDefinitionId: params.metricDefinitionId,
    generationId: params.generationId,
    sessionId: params.sessionId,
    valueType: 'integer',
    integerValue: params.value,
    valueClass: 'exact',
    rootInclusion: params.rootInclusion,
    dimensionsKey: params.dimensionsKey ?? null,
    isUnavailable: false,
    isNotApplicable: false,
  });
}

async function applyInTx(
  executor: WasmSqliteExecutor,
  input: {
    sessionId: string;
    generationId: string;
    previousGenerationId?: string;
    isRoot?: boolean;
    rollupPolicy?: RollupPolicy;
  },
): Promise<void> {
  await executor.transaction(async (tx) => {
    await applySessionRollupContributions(tx, {
      sessionId: input.sessionId,
      generationId: input.generationId,
      previousGenerationId: input.previousGenerationId,
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      isRoot: input.isRoot,
      rollupPolicy: input.rollupPolicy,
    });
  });
}

async function countContributions(
  executor: WasmSqliteExecutor,
  sessionId: string,
): Promise<number> {
  const { rows } = await executor.exec(
    'SELECT COUNT(*) AS c FROM rollup_contributions WHERE session_id = ?',
    [sessionId],
  );
  return Number(rows[0]?.c ?? 0);
}

async function fetchProjectDailySum(
  executor: WasmSqliteExecutor,
  metricDefinitionId: string,
  dayBucket: string,
): Promise<number | null> {
  const { rows } = await executor.exec(
    `SELECT value_sum FROM project_daily_rollups
     WHERE project_id = ? AND analysis_release_id = ? AND metric_definition_id = ? AND day_bucket = ?`,
    [PROJECT_ID, ANALYSIS_RELEASE_ID, metricDefinitionId, dayBucket],
  );
  if (rows.length === 0) return null;
  return asNumber(rows[0].value_sum);
}

async function fetchPortfolioDailySum(
  executor: WasmSqliteExecutor,
  metricDefinitionId: string,
  dayBucket: string,
): Promise<number | null> {
  const { rows } = await executor.exec(
    `SELECT value_sum FROM portfolio_daily_rollups
     WHERE portfolio_id = ? AND analysis_release_id = ? AND metric_definition_id = ? AND day_bucket = ?`,
    [PORTFOLIO_ID, ANALYSIS_RELEASE_ID, metricDefinitionId, dayBucket],
  );
  if (rows.length === 0) return null;
  return asNumber(rows[0].value_sum);
}

function asNumber(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function makePolicy(overrides: Partial<RollupPolicy>): RollupPolicy {
  return { ...makeDefaultRollupPolicy(ANALYSIS_RELEASE_ID), ...overrides } as RollupPolicy;
}

describe('rollup reconciliation', () => {
  it('applies root-only and inclusive contributions to project and portfolio rollups', async () => {
    const executor = await createExecutor();
    await seedIdentity(executor);
    const statPolicyId = await createStatisticalPolicy(executor);
    await createSession(executor, SESSION_ID, 'sess1');
    await createGeneration(executor, SESSION_ID, 'gen-1');

    const rootOnlyDef = await createMetricDefinition(executor, {
      metricId: 'test:count:root_only',
      rootInclusion: 'root_only',
      statisticalPolicyId: statPolicyId,
    });
    const inclusiveDef = await createMetricDefinition(executor, {
      metricId: 'test:count:inclusive',
      rootInclusion: 'inclusive',
      statisticalPolicyId: statPolicyId,
    });

    await createIntegerMetricValue(executor, {
      metricDefinitionId: rootOnlyDef,
      generationId: 'gen-1',
      sessionId: SESSION_ID,
      value: 10,
      rootInclusion: 'root_only',
      valueId: 'mv-root-1',
    });
    await createIntegerMetricValue(executor, {
      metricDefinitionId: inclusiveDef,
      generationId: 'gen-1',
      sessionId: SESSION_ID,
      value: 25,
      rootInclusion: 'inclusive',
      valueId: 'mv-inc-1',
    });

    await applyInTx(executor, { sessionId: SESSION_ID, generationId: 'gen-1' });

    const contributions = await countContributions(executor, SESSION_ID);
    expect(contributions).toBeGreaterThan(0);

    const dayBucket = '2026-08-24';
    expect(await fetchProjectDailySum(executor, rootOnlyDef, dayBucket)).toBe(10);
    expect(await fetchProjectDailySum(executor, inclusiveDef, dayBucket)).toBe(25);
    expect(await fetchPortfolioDailySum(executor, rootOnlyDef, dayBucket)).toBe(10);
    expect(await fetchPortfolioDailySum(executor, inclusiveDef, dayBucket)).toBe(25);

    const reconciliation = await reconcileRollupTotals(
      executor,
      PROJECT_ID,
      PORTFOLIO_ID,
      ANALYSIS_RELEASE_ID,
    );
    expect(isRollupReconciled(reconciliation)).toBe(true);
    expect(reconciliation).toEqual([]);
  });

  it('keeps child sessions independently queryable without contributing to portfolio rollups', async () => {
    const executor = await createExecutor();
    await seedIdentity(executor);
    const statPolicyId = await createStatisticalPolicy(executor);
    await createSession(executor, CHILD_SESSION_ID, 'child1');
    await createGeneration(executor, CHILD_SESSION_ID, 'gen-child');

    const childDef = await createMetricDefinition(executor, {
      metricId: 'test:child:inclusive',
      rootInclusion: 'inclusive',
      statisticalPolicyId: statPolicyId,
    });
    await createIntegerMetricValue(executor, {
      metricDefinitionId: childDef,
      generationId: 'gen-child',
      sessionId: CHILD_SESSION_ID,
      value: 5,
      rootInclusion: 'inclusive',
      valueId: 'mv-child-1',
    });

    await applyInTx(executor, {
      sessionId: CHILD_SESSION_ID,
      generationId: 'gen-child',
      isRoot: false,
    });

    const { rows: metricRows } = await executor.exec(
      'SELECT COUNT(*) AS c FROM metric_values WHERE session_id = ?',
      [CHILD_SESSION_ID],
    );
    expect(Number(metricRows[0]?.c ?? 0)).toBe(1);

    const { rows: projectRows } = await executor.exec(
      'SELECT value_sum FROM project_daily_rollups WHERE project_id = ? AND metric_definition_id = ?',
      [PROJECT_ID, childDef],
    );
    expect(projectRows.length).toBe(1);
    expect(asNumber(projectRows[0]?.value_sum)).toBe(5);

    const { rows: portfolioRows } = await executor.exec(
      'SELECT value_sum FROM portfolio_daily_rollups WHERE portfolio_id = ? AND metric_definition_id = ?',
      [PORTFOLIO_ID, childDef],
    );
    expect(portfolioRows.length).toBe(0);

    const { rows: childContributions } = await executor.exec(
      'SELECT contribution_scope, portfolio_id, project_id FROM rollup_contributions WHERE session_id = ?',
      [CHILD_SESSION_ID],
    );
    expect(childContributions.length).toBeGreaterThan(0);
    for (const row of childContributions) {
      expect(row.portfolio_id).toBeNull();
      expect(row.project_id).not.toBeNull();
    }
  });

  it('reconciles project and portfolio daily and dimension totals', async () => {
    const executor = await createExecutor();
    await seedIdentity(executor);
    const statPolicyId = await createStatisticalPolicy(executor);
    await createSession(executor, SESSION_ID, 'sess1');
    await createGeneration(executor, SESSION_ID, 'gen-1');

    const policy = makePolicy({
      supportedDimensions: JSON.stringify(['model', 'harness']),
      cardinalityCaps: JSON.stringify({ model: 4, harness: 4 }),
    });

    const def = await createMetricDefinition(executor, {
      metricId: 'test:reconcile',
      rootInclusion: 'root_only',
      statisticalPolicyId: statPolicyId,
      dimensions: ['model'],
    });
    await createIntegerMetricValue(executor, {
      metricDefinitionId: def,
      generationId: 'gen-1',
      sessionId: SESSION_ID,
      value: 20,
      rootInclusion: 'root_only',
      dimensionsKey: 'model-a',
      valueId: 'mv-reconcile-1',
    });

    await applyInTx(executor, {
      sessionId: SESSION_ID,
      generationId: 'gen-1',
      rollupPolicy: policy,
    });

    const reconciliation = await reconcileRollupTotals(
      executor,
      PROJECT_ID,
      PORTFOLIO_ID,
      ANALYSIS_RELEASE_ID,
    );
    expect(isRollupReconciled(reconciliation)).toBe(true);
    expect(reconciliation).toEqual([]);

    const { rows: dimRows } = await executor.exec(
      `SELECT dimension_name, dimension_value, value_sum
       FROM project_dimension_rollups
       WHERE project_id = ? AND metric_definition_id = ? AND dimension_name = 'model'`,
      [PROJECT_ID, def],
    );
    const modelRow = dimRows.find((r) => r.dimension_value === 'model-a');
    expect(modelRow).toBeDefined();
    expect(asNumber(modelRow?.value_sum)).toBe(20);
  });

  it('replaces a previous generation by subtracting old and adding new contributions', async () => {
    const executor = await createExecutor();
    await seedIdentity(executor);
    const statPolicyId = await createStatisticalPolicy(executor);
    await createSession(executor, SESSION_ID, 'sess1');
    await createGeneration(executor, SESSION_ID, 'gen-1');
    await createGeneration(executor, SESSION_ID, 'gen-2');

    const def = await createMetricDefinition(executor, {
      metricId: 'test:replace',
      rootInclusion: 'root_only',
      statisticalPolicyId: statPolicyId,
    });
    await createIntegerMetricValue(executor, {
      metricDefinitionId: def,
      generationId: 'gen-1',
      sessionId: SESSION_ID,
      value: 10,
      rootInclusion: 'root_only',
      valueId: 'mv-replace-1',
    });
    await createIntegerMetricValue(executor, {
      metricDefinitionId: def,
      generationId: 'gen-2',
      sessionId: SESSION_ID,
      value: 30,
      rootInclusion: 'root_only',
      valueId: 'mv-replace-2',
    });

    await applyInTx(executor, { sessionId: SESSION_ID, generationId: 'gen-1' });
    expect(await fetchProjectDailySum(executor, def, '2026-08-24')).toBe(10);

    await applyInTx(executor, {
      sessionId: SESSION_ID,
      generationId: 'gen-2',
      previousGenerationId: 'gen-1',
    });

    const { rows: oldRows } = await executor.exec(
      'SELECT COUNT(*) AS c FROM rollup_contributions WHERE session_id = ? AND generation_id = ?',
      [SESSION_ID, 'gen-1'],
    );
    expect(Number(oldRows[0]?.c ?? 0)).toBe(0);

    const { rows: newRows } = await executor.exec(
      'SELECT COUNT(*) AS c FROM rollup_contributions WHERE session_id = ? AND generation_id = ?',
      [SESSION_ID, 'gen-2'],
    );
    expect(Number(newRows[0]?.c ?? 0)).toBeGreaterThan(0);

    expect(await fetchProjectDailySum(executor, def, '2026-08-24')).toBe(30);
    expect(await fetchPortfolioDailySum(executor, def, '2026-08-24')).toBe(30);

    const reconciliation = await reconcileRollupTotals(
      executor,
      PROJECT_ID,
      PORTFOLIO_ID,
      ANALYSIS_RELEASE_ID,
    );
    expect(isRollupReconciled(reconciliation)).toBe(true);
  });

  it('rebuilds stale rollups from current contribution rows', async () => {
    const executor = await createExecutor();
    await seedIdentity(executor);
    const statPolicyId = await createStatisticalPolicy(executor);
    await createSession(executor, SESSION_ID, 'sess1');
    await createGeneration(executor, SESSION_ID, 'gen-1');

    const def = await createMetricDefinition(executor, {
      metricId: 'test:stale',
      rootInclusion: 'root_only',
      statisticalPolicyId: statPolicyId,
    });
    await createIntegerMetricValue(executor, {
      metricDefinitionId: def,
      generationId: 'gen-1',
      sessionId: SESSION_ID,
      value: 15,
      rootInclusion: 'root_only',
      valueId: 'mv-stale-1',
    });

    await applyInTx(executor, { sessionId: SESSION_ID, generationId: 'gen-1' });

    await executor.exec(
      `UPDATE project_daily_rollups
       SET value_sum = 0, value_count = 0
       WHERE project_id = ? AND analysis_release_id = ? AND metric_definition_id = ?`,
      [PROJECT_ID, ANALYSIS_RELEASE_ID, def],
    );

    await executor.transaction(async (tx) => {
      await rebuildProjectPortfolioRollups(
        tx,
        PROJECT_ID,
        PORTFOLIO_ID,
        ANALYSIS_RELEASE_ID,
        'gen-1',
      );
    });

    expect(await fetchProjectDailySum(executor, def, '2026-08-24')).toBe(15);

    const { rows: rollupRows } = await executor.exec(
      'SELECT generation_id FROM project_daily_rollups WHERE project_id = ? AND metric_definition_id = ?',
      [PROJECT_ID, def],
    );
    expect(rollupRows[0]?.generation_id).toBe('gen-1');

    const reconciliation = await reconcileRollupTotals(
      executor,
      PROJECT_ID,
      PORTFOLIO_ID,
      ANALYSIS_RELEASE_ID,
    );
    expect(isRollupReconciled(reconciliation)).toBe(true);
  });

  it('applies rollup policy cardinality caps and top-N/other grouping', async () => {
    const executor = await createExecutor();
    await seedIdentity(executor);
    const statPolicyId = await createStatisticalPolicy(executor);
    await createSession(executor, SESSION_ID, 'sess1');
    await createGeneration(executor, SESSION_ID, 'gen-1');

    const policy = makePolicy({
      supportedDimensions: JSON.stringify(['model']),
      cardinalityCaps: JSON.stringify({ model: 2 }),
      topNBehavior: 'cap',
    });

    const def = await createMetricDefinition(executor, {
      metricId: 'test:cap',
      rootInclusion: 'inclusive',
      statisticalPolicyId: statPolicyId,
      dimensions: ['model'],
    });

    await createIntegerMetricValue(executor, {
      metricDefinitionId: def,
      generationId: 'gen-1',
      sessionId: SESSION_ID,
      value: 10,
      rootInclusion: 'inclusive',
      dimensionsKey: 'model-a',
      valueId: 'mv-cap-a',
    });
    await createIntegerMetricValue(executor, {
      metricDefinitionId: def,
      generationId: 'gen-1',
      sessionId: SESSION_ID,
      value: 30,
      rootInclusion: 'inclusive',
      dimensionsKey: 'model-b',
      valueId: 'mv-cap-b',
    });
    await createIntegerMetricValue(executor, {
      metricDefinitionId: def,
      generationId: 'gen-1',
      sessionId: SESSION_ID,
      value: 20,
      rootInclusion: 'inclusive',
      dimensionsKey: 'model-c',
      valueId: 'mv-cap-c',
    });

    await applyInTx(executor, {
      sessionId: SESSION_ID,
      generationId: 'gen-1',
      rollupPolicy: policy,
    });

    const { rows: dimRows } = await executor.exec(
      `SELECT dimension_value, value_sum, is_other, top_n_rank
       FROM project_dimension_rollups
       WHERE project_id = ? AND metric_definition_id = ? AND dimension_name = 'model'
       ORDER BY top_n_rank IS NULL, top_n_rank, value_sum DESC`,
      [PROJECT_ID, def],
    );
    const top1 = dimRows.find((r) => r.dimension_value === 'model-b');
    const top2 = dimRows.find((r) => r.dimension_value === 'model-c');
    const other = dimRows.find((r) => r.is_other === 1);
    expect(top1).toBeDefined();
    expect(asNumber(top1?.value_sum)).toBe(30);
    expect(top1?.top_n_rank).toBe(1);
    expect(top2).toBeDefined();
    expect(asNumber(top2?.value_sum)).toBe(20);
    expect(top2?.top_n_rank).toBe(2);
    expect(other).toBeDefined();
    expect(asNumber(other?.value_sum)).toBe(10);

    expect(await fetchProjectDailySum(executor, def, '2026-08-24')).toBe(60);

    const reconciliation = await reconcileRollupTotals(
      executor,
      PROJECT_ID,
      PORTFOLIO_ID,
      ANALYSIS_RELEASE_ID,
    );
    expect(isRollupReconciled(reconciliation)).toBe(true);
  });
});
