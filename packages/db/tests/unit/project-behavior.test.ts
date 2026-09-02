import {
  ComponentContextEventStore,
  ComponentIdentityStore,
  ComponentLifecycleEventStore,
  ComponentVersionStore,
  EnvironmentStore,
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
import { beforeEach, describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { rebuildProjectDistributions } from '../../src/distributions.js';
import {
  createProjectBehaviorView,
  getComparisons,
  getConfigurationTimeline,
  getOutliers,
  getProjectBehaviorSummary,
  getSessionTrendSeries,
  recordHeuristicProjectBehaviorInsight,
  recordProjectBehaviorInsight,
} from '../../src/project-behavior.js';
import {
  applySessionRollupContributions,
  rebuildProjectPortfolioRollups,
} from '../../src/rollup-reconciliation.js';

const TENANT_ID = 'tenant-pb';
const PORTFOLIO_ID = 'portfolio-pb';
const SOURCE_ID = 'source-pb';
const ENVIRONMENT_ID = 'env-pb';
const PROJECT_ID = 'project-pb';
const ANALYSIS_RELEASE_ID = 'ar-pb';
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
  await EnvironmentStore.insert(executor, PORTFOLIO_ID, {
    id: ENVIRONMENT_ID,
    ingestionSourceId: SOURCE_ID,
    nativeEnvironmentId: 'env-native',
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
    policyId: 'sp-pb',
    version: 1,
    name: 'Default',
    observationUnit: 'session',
    eligibility: 'all',
    percentileMinimumN: 1,
    outlierPolicy: 'iqr:1.5',
  });
}

async function createMetricDefinition(
  executor: WasmSqliteExecutor,
  params: {
    metricId: string;
    statisticalPolicyId: string;
    aggregation: 'distribution' | 'sum' | 'count';
    valueType: 'real' | 'integer';
    unit: string;
  },
): Promise<string> {
  return MetricDefinitionStore.insert(executor, {
    metricId: params.metricId,
    version: 1,
    label: params.metricId,
    description: 'test metric',
    family: 'test',
    measurementClass: 'observed',
    unit: params.unit,
    valueType: params.valueType,
    grain: 'session',
    dimensions: [],
    populationRule: 'all',
    statusRule: 'none',
    aggregation: params.aggregation,
    statisticalPolicyId: params.statisticalPolicyId,
    comparabilityGroupInputs: [],
    missingDataBehavior: 'unknown',
    rootInclusion: 'root_only',
    provenanceRequirement: 'test',
  });
}

async function createSession(
  executor: WasmSqliteExecutor,
  sessionId: string,
  nativeSessionId: string,
  occurrenceTime: number,
  overrides?: { mode?: string; taskCohort?: string },
): Promise<void> {
  await SessionStore.insert(executor, {
    id: sessionId,
    projectId: PROJECT_ID,
    ingestionSourceId: SOURCE_ID,
    nativeSessionId,
    harness: 'claude-code',
    occurrenceTime,
    model: 'claude-sonnet',
    mode: overrides?.mode ?? 'auto',
    taskCohort: overrides?.taskCohort ?? 'feature',
  });
}

async function createGeneration(
  executor: WasmSqliteExecutor,
  sessionId: string,
  generationId: string,
  createdAt = BASE_TIME,
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
      createdAt,
    ],
  );
  await SessionStore.update(executor, PROJECT_ID, sessionId, {
    currentGenerationId: generationId,
  });
}

async function createRealMetricValue(
  executor: WasmSqliteExecutor,
  metricDefinitionId: string,
  generationId: string,
  sessionId: string,
  value: number,
  valueId: string,
): Promise<string> {
  return MetricValueStore.insert(executor, {
    id: valueId,
    metricDefinitionId,
    generationId,
    sessionId,
    valueType: 'real',
    numericValue: value,
    valueClass: 'exact',
    rootInclusion: 'root_only',
    dimensionsKey: null,
    isUnavailable: false,
    isNotApplicable: false,
  });
}

async function createIntegerMetricValue(
  executor: WasmSqliteExecutor,
  metricDefinitionId: string,
  generationId: string,
  sessionId: string,
  value: number,
  valueId: string,
): Promise<string> {
  return MetricValueStore.insert(executor, {
    id: valueId,
    metricDefinitionId,
    generationId,
    sessionId,
    valueType: 'integer',
    integerValue: value,
    valueClass: 'exact',
    rootInclusion: 'root_only',
    dimensionsKey: null,
    isUnavailable: false,
    isNotApplicable: false,
  });
}

async function applyRollupsForSession(
  executor: WasmSqliteExecutor,
  sessionId: string,
  generationId: string,
): Promise<void> {
  await executor.transaction(async (tx) => {
    await applySessionRollupContributions(tx, {
      sessionId,
      generationId,
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      isRoot: true,
    });
  });
}

describe('project-behavior', () => {
  let executor: WasmSqliteExecutor;

  beforeEach(async () => {
    executor = await createExecutor();
    await seedIdentity(executor);
  });

  it('records deterministic insight evidence with stable IDs', async () => {
    const generationId = 'gen-insight';
    await createSession(executor, 'se-insight', 'sess-insight', BASE_TIME);
    await createGeneration(executor, 'se-insight', generationId);

    const input = {
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      recipeId: 'pb-insight',
      recipeVersion: 1,
      insightKind: 'trend' as const,
      wordingInputs: { metricId: 'm-duration' },
      evidenceIds: ['ev-1'],
      confidence: 'high',
      confidenceReason: 'complete coverage',
      determinismVersion: 'deterministic-v1',
      generationId,
    };

    const id1 = await recordProjectBehaviorInsight(executor, input);
    const id2 = await recordProjectBehaviorInsight(executor, input);
    expect(id1).toBe(id2);

    const different = { ...input, recipeId: 'pb-insight-2', wordingInputs: { metricId: 'm-cost' } };
    const id3 = await recordProjectBehaviorInsight(executor, different);
    expect(id3).not.toBe(id1);
  });

  it('records heuristic insight after deterministic variant', async () => {
    const generationId = 'gen-heuristic';
    await createSession(executor, 'se-heuristic', 'sess-heuristic', BASE_TIME);
    await createGeneration(executor, 'se-heuristic', generationId);

    const deterministic = {
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      recipeId: 'pb-heuristic',
      recipeVersion: 1,
      insightKind: 'anomaly' as const,
      wordingInputs: { metricId: 'm-duration' },
      evidenceIds: ['ev-1'],
      confidence: 'high',
      determinismVersion: 'deterministic-v1',
      generationId,
    };

    await recordProjectBehaviorInsight(executor, deterministic);

    const heuristic = {
      ...deterministic,
      determinismVersion: 'heuristic-v1',
      confidenceReason: 'model estimate',
      generationId: 'gen-heuristic-missing',
    };
    await expect(recordHeuristicProjectBehaviorInsight(executor, heuristic)).rejects.toThrow(
      /Deterministic insight must exist/,
    );
  });

  it('returns project behavior summary from daily rollups', async () => {
    const statPolicyId = await createStatisticalPolicy(executor);
    const defId = await createMetricDefinition(executor, {
      metricId: 'm-duration',
      statisticalPolicyId: statPolicyId,
      aggregation: 'sum',
      valueType: 'real',
      unit: 'ms',
    });

    await createSession(executor, 'se-1', 'sess-1', BASE_TIME);
    await createGeneration(executor, 'se-1', 'gen-1');

    await createRealMetricValue(executor, defId, 'gen-1', 'se-1', 100, 'mv-1');

    await applyRollupsForSession(executor, 'se-1', 'gen-1');
    await executor.transaction(async (tx) => {
      await rebuildProjectPortfolioRollups(
        tx,
        PROJECT_ID,
        PORTFOLIO_ID,
        ANALYSIS_RELEASE_ID,
        'gen-1',
      );
    });

    const summary = await getProjectBehaviorSummary(executor, PROJECT_ID, {
      analysisReleaseId: ANALYSIS_RELEASE_ID,
    });

    expect(summary.headlineMetrics.length).toBeGreaterThan(0);
    const durationMetric = summary.headlineMetrics.find((m) => m.metricId === 'm-duration');
    expect(durationMetric).toBeDefined();
    expect(durationMetric?.unit).toBe('ms');
    expect(durationMetric?.value).not.toBeNull();
    expect(summary.token.analysisReleaseId).toBe(ANALYSIS_RELEASE_ID);
  });

  it('returns session trend series from daily rollups', async () => {
    const statPolicyId = await createStatisticalPolicy(executor);
    const defId = await createMetricDefinition(executor, {
      metricId: 'm-cost',
      statisticalPolicyId: statPolicyId,
      aggregation: 'sum',
      valueType: 'integer',
      unit: 'cents',
    });

    await createSession(executor, 'se-t1', 'sess-t1', BASE_TIME);
    await createGeneration(executor, 'se-t1', 'gen-t1');
    await createSession(executor, 'se-t2', 'sess-t2', BASE_TIME + 86_400_000);
    await createGeneration(executor, 'se-t2', 'gen-t2');

    await createIntegerMetricValue(executor, defId, 'gen-t1', 'se-t1', 100, 'mv-t1');
    await createIntegerMetricValue(executor, defId, 'gen-t2', 'se-t2', 250, 'mv-t2');

    await applyRollupsForSession(executor, 'se-t1', 'gen-t1');
    await applyRollupsForSession(executor, 'se-t2', 'gen-t2');
    await executor.transaction(async (tx) => {
      await rebuildProjectPortfolioRollups(
        tx,
        PROJECT_ID,
        PORTFOLIO_ID,
        ANALYSIS_RELEASE_ID,
        'gen-t1',
      );
    });

    const series = await getSessionTrendSeries(executor, PROJECT_ID, {
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      timeRange: { start: '2026-08-23T00:00:00Z', end: '2026-08-25T23:59:59Z' },
    });

    expect(series.series.length).toBe(2);
    const costPoints = series.series.filter((p) => p.metricId === 'm-cost');
    expect(costPoints.length).toBe(2);
    expect(costPoints[0]?.value).toBe(100);
    expect(costPoints[1]?.value).toBe(250);
    expect(series.token.comparabilityGroupId).toBeDefined();
  });

  it('returns configuration timeline with context and lifecycle events', async () => {
    await createSession(executor, 'se-timeline', 'sess-timeline', BASE_TIME);
    await createGeneration(executor, 'se-timeline', 'gen-timeline');

    const componentId = await ComponentIdentityStore.insert(executor, {
      portfolioId: PORTFOLIO_ID,
      kind: 'tool',
      canonicalSourceIdentity: 'src://file',
      displayName: 'main.ts',
    });
    const versionId = await ComponentVersionStore.insert(executor, {
      componentId,
      contentHash: 'hash-1',
      sourcePointer: 'v1.0.0',
    });

    await ComponentContextEventStore.insert(executor, {
      componentId,
      environmentId: ENVIRONMENT_ID,
      sessionId: 'se-timeline',
      eventType: 'loaded',
      startTime: BASE_TIME,
      endTime: BASE_TIME,
      sourcePointer: 'v1.0.0',
    });

    await ComponentLifecycleEventStore.insert(executor, {
      componentId,
      environmentId: ENVIRONMENT_ID,
      eventType: 'updated',
      afterVersionId: versionId,
      generationId: 'gen-timeline',
      createdAt: BASE_TIME + 1000,
    });

    const timeline = await getConfigurationTimeline(executor, PROJECT_ID, {
      timeRange: { start: '2026-08-24T00:00:00Z', end: '2026-08-25T00:00:00Z' },
    });

    expect(timeline.events.length).toBe(2);
    expect(timeline.events[0].componentId).toBe(componentId);
    expect(timeline.events[1].componentId).toBe(componentId);
    const updated = timeline.events.find((e) => e.changeType === 'updated');
    expect(updated).toBeDefined();
    expect(updated?.toVersion).toBe('v1.0.0');
  });

  it('detects outlier values from precomputed distributions', async () => {
    const statPolicyId = await createStatisticalPolicy(executor);
    const defId = await createMetricDefinition(executor, {
      metricId: 'm-duration',
      statisticalPolicyId: statPolicyId,
      aggregation: 'distribution',
      valueType: 'real',
      unit: 'ms',
    });

    const values = [10, 10, 10, 10, 100];
    for (let i = 0; i < values.length; i++) {
      const sessionId = `se-out-${i}`;
      const genId = `gen-out-${i}`;
      const time = BASE_TIME + i * 1000;
      await createSession(executor, sessionId, `sess-out-${i}`, time);
      await createGeneration(executor, sessionId, genId, time);
      await createRealMetricValue(executor, defId, genId, sessionId, values[i], `mv-out-${i}`);
    }

    await rebuildProjectDistributions(executor, PROJECT_ID, ANALYSIS_RELEASE_ID, 'gen-out-0');

    const page = await getOutliers(executor, PROJECT_ID, {
      analysisReleaseId: ANALYSIS_RELEASE_ID,
    });

    expect(page.items.length).toBeGreaterThanOrEqual(1);
    const outlier = page.items.find((o) => o.value === 100);
    expect(outlier).toBeDefined();
    expect(outlier?.metricId).toBe('m-duration');
    expect(outlier?.deviation).toBeGreaterThan(0);
  });

  it('compares before/after cohorts and flags regressions', async () => {
    const statPolicyId = await createStatisticalPolicy(executor);
    const defId = await createMetricDefinition(executor, {
      metricId: 'm-duration',
      statisticalPolicyId: statPolicyId,
      aggregation: 'distribution',
      valueType: 'real',
      unit: 'ms',
    });

    const beforeTime = BASE_TIME - 86_400_000;
    const afterTime = BASE_TIME;

    for (let i = 0; i < 2; i++) {
      const sessionId = `se-before-${i}`;
      const genId = `gen-before-${i}`;
      await createSession(executor, sessionId, `sess-before-${i}`, beforeTime + i * 1000);
      await createGeneration(executor, sessionId, genId);
      await createRealMetricValue(executor, defId, genId, sessionId, 10, `mv-before-${i}`);
    }

    for (let i = 0; i < 2; i++) {
      const sessionId = `se-after-${i}`;
      const genId = `gen-after-${i}`;
      await createSession(executor, sessionId, `sess-after-${i}`, afterTime + i * 1000);
      await createGeneration(executor, sessionId, genId);
      await createRealMetricValue(executor, defId, genId, sessionId, 100, `mv-after-${i}`);
    }

    await rebuildProjectDistributions(executor, PROJECT_ID, ANALYSIS_RELEASE_ID, 'gen-before-0');

    const page = await getComparisons(executor, PROJECT_ID, {
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      timeRange: { start: beforeTime - 86_400_000, end: afterTime + 86_400_000 },
    });

    expect(page.items.length).toBe(2);
    const observed = page.items.find((i) => i.kind === 'observed');
    const matched = page.items.find((i) => i.kind === 'matched');
    expect(observed).toBeDefined();
    expect(matched).toBeDefined();

    const regressionMetric = observed?.metricValues.find((m) => m.metricId === 'regression');
    expect(regressionMetric?.value).toBe(1);
  });

  it('createProjectBehaviorView implements ProjectBehaviorView', async () => {
    const view = createProjectBehaviorView(executor);
    const summary = await view.getSummary(PROJECT_ID, { analysisReleaseId: ANALYSIS_RELEASE_ID });
    expect(summary.token).toBeDefined();
    expect(summary.headlineMetrics).toBeDefined();

    const series = await view.getSessionTrendSeries(PROJECT_ID, {
      analysisReleaseId: ANALYSIS_RELEASE_ID,
    });
    expect(series.series).toBeDefined();

    const timeline = await view.getConfigurationTimeline(PROJECT_ID, {
      timeRange: { start: '2026-08-24T00:00:00Z', end: '2026-08-25T00:00:00Z' },
    });
    expect(timeline.events).toBeDefined();

    const outliers = await view.getOutliers(PROJECT_ID, { analysisReleaseId: ANALYSIS_RELEASE_ID });
    expect(outliers.items).toBeDefined();

    const comparisons = await view.getComparisons(PROJECT_ID, {
      analysisReleaseId: ANALYSIS_RELEASE_ID,
    });
    expect(comparisons.items).toBeDefined();
  });
});
