import {
  ComponentIdentityStore,
  ComponentRollupStore,
  EnvironmentStore,
  FRESH_SCHEMA_SQL,
  IngestionSourceStore,
  ManifestCoverageStore,
  MetricDefinitionStore,
  MetricValueStore,
  PortfolioDailyRollupStore,
  PortfolioDimensionRollupStore,
  PortfolioDistributionStore,
  PortfolioStore,
  ProjectStore,
  SessionComponentExposureStore,
  SessionStore,
  SourceManifestStore,
  SourceProjectStore,
  StatisticalPolicyStore,
  TenantStore,
} from '@lucasschirm/sal-db-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import {
  createPortfolioView,
  getComponentUtilization,
  getModelHarnessCohorts,
  getPortfolioOverview,
  getPortfolioTrends,
  getProjectList,
} from '../../src/analytics-portfolio.js';
import { rebuildProjectDistributions } from '../../src/distributions.js';
import { createProjectBehaviorView } from '../../src/project-behavior.js';

const TENANT_ID = 'tenant-ap';
const PORTFOLIO_ID = 'portfolio-ap';
const SOURCE_ID = 'source-ap';
const ENV_ID = 'env-ap';
const PROJECT1_ID = 'project-ap-1';
const PROJECT2_ID = 'project-ap-2';
const ANALYSIS_RELEASE_ID = 'ar-ap';
const COMPARABILITY_GROUP_ID = 'cgrp-default';
const BASE_TIME = new Date('2026-08-24T12:00:00Z').getTime();

async function createExecutor(): Promise<WasmSqliteExecutor> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  return executor;
}

async function seedPortfolio(executor: WasmSqliteExecutor): Promise<void> {
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
    id: ENV_ID,
    ingestionSourceId: SOURCE_ID,
    nativeEnvironmentId: 'env-native',
  });
  await ProjectStore.insert(executor, {
    id: PROJECT1_ID,
    portfolioId: PORTFOLIO_ID,
    name: 'alpha',
  });
  await ProjectStore.insert(executor, {
    id: PROJECT2_ID,
    portfolioId: PORTFOLIO_ID,
    name: 'beta',
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
    policyId: 'sp-ap',
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
    dimensions?: readonly string[];
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
    dimensions: params.dimensions ?? [],
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
  projectId: string,
  nativeSessionId: string,
  occurrenceTime: number,
  overrides?: { harness?: string; finality?: string },
): Promise<void> {
  await SessionStore.insert(executor, {
    id: sessionId,
    projectId,
    ingestionSourceId: SOURCE_ID,
    nativeSessionId,
    harness: overrides?.harness ?? 'claude-code',
    occurrenceTime,
    finality: overrides?.finality ?? 'final',
    mode: 'auto',
    taskCohort: 'feature',
  });
}

async function createGeneration(
  executor: WasmSqliteExecutor,
  sessionId: string,
  generationId: string,
  createdAt = BASE_TIME,
): Promise<void> {
  const { rows } = await executor.exec('SELECT project_id FROM sessions WHERE id = ?', [sessionId]);
  const projectId = rows.length > 0 ? String(rows[0].project_id) : PROJECT1_ID;
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
  await SessionStore.update(executor, projectId, sessionId, {
    currentGenerationId: generationId,
  });
}

async function createRealMetricValue(
  executor: WasmSqliteExecutor,
  metricDefinitionId: string,
  generationId: string,
  sessionId: string,
  value: number,
): Promise<string> {
  return MetricValueStore.insert(executor, {
    id: `mv-${sessionId}-${metricDefinitionId}`,
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
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
  });
}

async function createIngestionIssue(
  executor: WasmSqliteExecutor,
  generationId: string,
  severity: 'fatal' | 'recoverable',
  issueCode: string,
  entityId: string,
): Promise<void> {
  await executor.exec(
    `INSERT INTO ingestion_issues
     (id, generation_id, severity, issue_code, entity_type, entity_id, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `ii-${generationId}-${issueCode}`,
      generationId,
      severity,
      issueCode,
      'session',
      entityId,
      '{}',
      BASE_TIME,
    ],
  );
}

async function createSourceProjectAndManifest(
  executor: WasmSqliteExecutor,
  projectId: string,
  sessionId: string,
  overrides?: { reprocessingStatus?: string; finality?: string; coverage?: string },
): Promise<void> {
  const sourceProjectId = `sp-${projectId}`;
  await SourceProjectStore.insert(executor, PORTFOLIO_ID, {
    id: sourceProjectId,
    projectId,
    ingestionSourceId: SOURCE_ID,
    nativeProjectId: `native-${projectId}`,
  });
  const manifestId = await SourceManifestStore.insert(executor, PORTFOLIO_ID, {
    id: `sm-${projectId}`,
    ingestionSourceId: SOURCE_ID,
    sourceProjectId,
    sessionId,
    manifestSchemaVersion: 1,
    finality: overrides?.finality ?? 'final',
    harness: 'claude-code',
    harnessVersion: '1',
    manifestHash: 'hash',
    reprocessingStatus: overrides?.reprocessingStatus ?? 'local',
    captureTime: BASE_TIME,
  });
  await ManifestCoverageStore.insert(executor, PORTFOLIO_ID, {
    sourceManifestId: manifestId,
    category: 'transcripts',
    discoveryCompleteness: (overrides?.coverage ?? 'complete') as
      | 'complete'
      | 'partial'
      | 'unsupported'
      | 'unknown',
  });
}

describe('analytics-portfolio', () => {
  let executor: WasmSqliteExecutor;

  beforeEach(async () => {
    executor = await createExecutor();
    await seedPortfolio(executor);
  });

  it('returns portfolio overview with headline metrics and tokens', async () => {
    const statPolicyId = await createStatisticalPolicy(executor);
    const defId = await createMetricDefinition(executor, {
      metricId: 'm-duration',
      statisticalPolicyId: statPolicyId,
      aggregation: 'distribution',
      valueType: 'real',
      unit: 'ms',
    });

    await createSession(executor, 'se-overview', PROJECT1_ID, 'sess-overview', BASE_TIME);
    await createGeneration(executor, 'se-overview', 'gen-overview');

    await PortfolioDistributionStore.insert(executor, {
      portfolioId: PORTFOLIO_ID,
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      comparabilityGroupId: COMPARABILITY_GROUP_ID,
      metricDefinitionId: defId,
      dimensionsKey: null,
      eligibleN: 2,
      knownN: 2,
      unknownCount: 0,
      sum: 220,
      min: 100,
      max: 120,
      mean: 110,
      p50: 110,
      p75: 115,
      p90: 118,
      p95: 119,
      dispersion: 10,
      outlierRule: null,
      coverage: 1,
      generationId: 'gen-overview',
    });

    const usedComponentId = await ComponentIdentityStore.insert(executor, {
      portfolioId: PORTFOLIO_ID,
      kind: 'tool',
      canonicalSourceIdentity: 'src://used',
      displayName: 'UsedTool',
    });
    await ComponentIdentityStore.insert(executor, {
      portfolioId: PORTFOLIO_ID,
      kind: 'skill',
      canonicalSourceIdentity: 'src://unused',
      displayName: 'UnusedSkill',
    });
    await ComponentRollupStore.insert(executor, {
      portfolioId: PORTFOLIO_ID,
      projectId: PROJECT1_ID,
      componentId: usedComponentId,
      componentVersionId: null,
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      comparabilityGroupId: COMPARABILITY_GROUP_ID,
      metricDefinitionId: defId,
      invocationCount: 10,
      successCount: 8,
      failureCount: 2,
      cancellationCount: 0,
      totalLatencyMs: null,
      overheadMs: null,
      reliabilityRatio: 0.8,
      timingP50: null,
      timingP90: null,
      outcomeDistribution: '{}',
      generationId: 'gen-overview',
    });
    // Mark the "used" component as exposed in a session so
    // findUnusedOfferedComponents (which now reads from
    // session_component_exposures) treats it as used.
    await SessionComponentExposureStore.insert(executor, {
      sessionId: 'se-overview',
      componentId: usedComponentId,
      environmentId: ENV_ID,
      status: 'loaded',
      startSequence: 0,
      startTime: BASE_TIME,
      generationId: 'gen-overview',
    });

    const overview = await getPortfolioOverview(executor, {
      portfolioId: PORTFOLIO_ID,
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      comparabilityGroupId: COMPARABILITY_GROUP_ID,
      generationId: 'gen-overview',
    });

    expect(overview.token.analysisReleaseId).toBe(ANALYSIS_RELEASE_ID);
    expect(overview.token.generationId).toBe('gen-overview');
    expect(overview.token.comparabilityGroupId).toBe(COMPARABILITY_GROUP_ID);
    expect(overview.projectCount).toBe(2);
    expect(overview.sessionCount).toBe(1);
    expect(overview.componentCounts.tool).toBe(1);
    expect(overview.componentCounts.skill).toBe(1);
    expect(overview.unusedOfferedComponents.length).toBe(1);

    const durationMetric = overview.headlineMetrics.find((m) => m.metricId === 'm-duration');
    expect(durationMetric).toBeDefined();
    expect(durationMetric?.value).toBe(110);
    expect(durationMetric?.unit).toBe('ms');
    expect(durationMetric?.comparabilityGroupId).toBe(COMPARABILITY_GROUP_ID);

    const countMetric = overview.headlineMetrics.find(
      (m) => m.metricId === 'portfolio-project-count',
    );
    expect(countMetric?.value).toBe(2);
  });

  it('returns additive trend series from portfolio daily rollups', async () => {
    const statPolicyId = await createStatisticalPolicy(executor);
    const defId = await createMetricDefinition(executor, {
      metricId: 'm-cost',
      statisticalPolicyId: statPolicyId,
      aggregation: 'sum',
      valueType: 'integer',
      unit: 'cents',
    });

    await createSession(executor, 'se-trend', PROJECT1_ID, 'sess-trend', BASE_TIME);
    await createGeneration(executor, 'se-trend', 'gen-trend');

    await PortfolioDailyRollupStore.insert(executor, {
      portfolioId: PORTFOLIO_ID,
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      comparabilityGroupId: COMPARABILITY_GROUP_ID,
      metricDefinitionId: defId,
      dayBucket: '2026-08-23',
      valueCount: 1,
      valueSum: 100,
      valueMin: 100,
      valueMax: 100,
      valueMean: 100,
      generationId: 'gen-trend',
    });
    await PortfolioDailyRollupStore.insert(executor, {
      portfolioId: PORTFOLIO_ID,
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      comparabilityGroupId: COMPARABILITY_GROUP_ID,
      metricDefinitionId: defId,
      dayBucket: '2026-08-24',
      valueCount: 1,
      valueSum: 250,
      valueMin: 250,
      valueMax: 250,
      valueMean: 250,
      generationId: 'gen-trend',
    });

    const series = await getPortfolioTrends(executor, {
      portfolioId: PORTFOLIO_ID,
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      comparabilityGroupId: COMPARABILITY_GROUP_ID,
      timeRange: { start: '2026-08-23T00:00:00Z', end: '2026-08-25T00:00:00Z' },
    });

    expect(series.series.length).toBe(2);
    expect(series.series[0]?.time).toBe('2026-08-23');
    expect(series.series[0]?.value).toBe(100);
    expect(series.series[1]?.time).toBe('2026-08-24');
    expect(series.series[1]?.value).toBe(250);
    expect(series.token.comparabilityGroupId).toBe(COMPARABILITY_GROUP_ID);
  });

  it('returns component utilization with load rate and token', async () => {
    const statPolicyId = await createStatisticalPolicy(executor);
    const defId = await createMetricDefinition(executor, {
      metricId: 'm-cost',
      statisticalPolicyId: statPolicyId,
      aggregation: 'sum',
      valueType: 'integer',
      unit: 'cents',
    });

    await createSession(executor, 'se-comp', PROJECT1_ID, 'sess-comp', BASE_TIME);
    await createGeneration(executor, 'se-comp', 'gen-comp');

    const componentId = await ComponentIdentityStore.insert(executor, {
      portfolioId: PORTFOLIO_ID,
      kind: 'tool',
      canonicalSourceIdentity: 'src://tool',
      displayName: 'Tool',
    });
    await ComponentRollupStore.insert(executor, {
      portfolioId: PORTFOLIO_ID,
      projectId: PROJECT1_ID,
      componentId,
      componentVersionId: null,
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      comparabilityGroupId: COMPARABILITY_GROUP_ID,
      metricDefinitionId: defId,
      invocationCount: 10,
      successCount: 8,
      failureCount: 2,
      cancellationCount: 0,
      totalLatencyMs: null,
      overheadMs: null,
      reliabilityRatio: 0.8,
      timingP50: null,
      timingP90: null,
      outcomeDistribution: '{}',
      generationId: 'gen-comp',
    });
    await SessionComponentExposureStore.insert(executor, {
      sessionId: 'se-comp',
      componentId,
      environmentId: ENV_ID,
      status: 'loaded',
      startSequence: 0,
      startTime: BASE_TIME,
      generationId: 'gen-comp',
    });

    const page = await getComponentUtilization(executor, {
      portfolioId: PORTFOLIO_ID,
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      comparabilityGroupId: COMPARABILITY_GROUP_ID,
      generationId: 'gen-comp',
    });

    expect(page.items.length).toBe(1);
    const row = page.items[0];
    expect(row?.componentId).toBe(componentId);
    expect(row?.kind).toBe('tool');
    expect(row?.projectCount).toBe(1);
    expect(row?.sessionCount).toBe(1);
    // loadRate is null because session_component_exposures does not carry
    // invocation/success counts (no rollup pipeline populates them yet).
    expect(row?.loadRate?.value).toBeNull();
    expect(row?.loadRate?.comparabilityGroupId).toBe(COMPARABILITY_GROUP_ID);
    expect(row?.token.generationId).toBe('gen-comp');
    expect(row?.token.comparabilityGroupId).toBe(COMPARABILITY_GROUP_ID);
  });

  it('returns model and harness cohorts from dimension rollups', async () => {
    const statPolicyId = await createStatisticalPolicy(executor);
    const defId = await createMetricDefinition(executor, {
      metricId: 'm-cost',
      statisticalPolicyId: statPolicyId,
      aggregation: 'sum',
      valueType: 'integer',
      unit: 'cents',
    });

    await createSession(executor, 'se-cohort', PROJECT1_ID, 'sess-cohort', BASE_TIME);
    await createGeneration(executor, 'se-cohort', 'gen-cohort');

    await PortfolioDimensionRollupStore.insert(executor, {
      portfolioId: PORTFOLIO_ID,
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      comparabilityGroupId: COMPARABILITY_GROUP_ID,
      metricDefinitionId: defId,
      dimensionName: 'harness',
      dimensionValue: 'claude-code',
      isOther: false,
      isUnknown: false,
      valueCount: 2,
      valueSum: 100,
      valueMin: 50,
      valueMax: 50,
      valueMean: 50,
      topNRank: 1,
      generationId: 'gen-cohort',
    });
    await PortfolioDimensionRollupStore.insert(executor, {
      portfolioId: PORTFOLIO_ID,
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      comparabilityGroupId: COMPARABILITY_GROUP_ID,
      metricDefinitionId: defId,
      dimensionName: 'model',
      dimensionValue: 'claude-sonnet',
      isOther: false,
      isUnknown: false,
      valueCount: 1,
      valueSum: 50,
      valueMin: 50,
      valueMax: 50,
      valueMean: 50,
      topNRank: 1,
      generationId: 'gen-cohort',
    });

    const page = await getModelHarnessCohorts(executor, {
      portfolioId: PORTFOLIO_ID,
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      comparabilityGroupId: COMPARABILITY_GROUP_ID,
      generationId: 'gen-cohort',
    });

    expect(page.items.length).toBe(2);
    const harnessCohort = page.items.find((c) => c.harness === 'claude-code');
    const modelCohort = page.items.find((c) => c.model === 'claude-sonnet');
    expect(harnessCohort).toBeDefined();
    expect(harnessCohort?.model).toBe('unknown');
    expect(harnessCohort?.sessionCount).toBe(2);
    expect(modelCohort).toBeDefined();
    expect(modelCohort?.harness).toBe('unknown');
    expect(modelCohort?.sessionCount).toBe(1);
    expect(harnessCohort?.metricValues[0]?.comparabilityGroupId).toBe(COMPARABILITY_GROUP_ID);
    expect(harnessCohort?.token.comparabilityGroupId).toBe(COMPARABILITY_GROUP_ID);
  });

  it('returns project list with source, harness, completeness, finality, reprocessing and issue state', async () => {
    await createSession(executor, 'se-a', PROJECT1_ID, 'sess-a', BASE_TIME, {
      harness: 'claude-code',
      finality: 'final',
    });
    await createGeneration(executor, 'se-a', 'gen-a');
    await createSession(executor, 'se-b', PROJECT2_ID, 'sess-b', BASE_TIME + 1000, {
      harness: 'claude-code',
      finality: 'final',
    });
    await createGeneration(executor, 'se-b', 'gen-b');

    await createSourceProjectAndManifest(executor, PROJECT1_ID, 'se-a');
    await createSourceProjectAndManifest(executor, PROJECT2_ID, 'se-b', { coverage: 'partial' });
    await createIngestionIssue(executor, 'gen-b', 'fatal', 'fatal-1', 'se-b');

    const page = await getProjectList(executor, {
      portfolioId: PORTFOLIO_ID,
      analysisReleaseId: ANALYSIS_RELEASE_ID,
    });

    expect(page.items.length).toBe(2);
    expect(page.generationToken).toBe('unknown');
    expect(page.analysisReleaseToken).toBe(ANALYSIS_RELEASE_ID);

    const alpha = page.items.find((p) => p.name === 'alpha');
    const beta = page.items.find((p) => p.name === 'beta');
    expect(alpha).toBeDefined();
    expect(alpha?.source).toBe(SOURCE_ID);
    expect(alpha?.harness).toBe('claude-code');
    expect(alpha?.completeness).toBe('complete');
    expect(alpha?.finality).toBe('final');
    expect(alpha?.reprocessing).toBe('local');
    expect(alpha?.issueState).toBe('clean');
    expect(alpha?.token.comparabilityGroupId).toBe('project-list');

    expect(beta).toBeDefined();
    expect(beta?.completeness).toBe('partial');
    expect(beta?.issueState).toBe('fatal');
  });

  it('paginates project list with stable cursors', async () => {
    await createSession(executor, 'se-a', PROJECT1_ID, 'sess-a', BASE_TIME);
    await createGeneration(executor, 'se-a', 'gen-a');
    await createSession(executor, 'se-b', PROJECT2_ID, 'sess-b', BASE_TIME);
    await createGeneration(executor, 'se-b', 'gen-b');
    await createSourceProjectAndManifest(executor, PROJECT1_ID, 'se-a');
    await createSourceProjectAndManifest(executor, PROJECT2_ID, 'se-b');

    const first = await getProjectList(executor, {
      portfolioId: PORTFOLIO_ID,
      limit: 1,
      cursor: '0',
    });
    expect(first.items.length).toBe(1);
    expect(first.nextCursor).toBe('1');
    expect(first.previousCursor).toBeUndefined();

    const second = await getProjectList(executor, {
      portfolioId: PORTFOLIO_ID,
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items.length).toBe(1);
    expect(second.previousCursor).toBe('0');
    expect(second.nextCursor).toBeUndefined();
    expect(second.items[0]?.name).not.toBe(first.items[0]?.name);
    expect(second.generationToken).toBe(first.generationToken);
  });

  it('uses indexes for analytics queries', async () => {
    const { rows: distributionPlan } = await executor.exec(
      'EXPLAIN QUERY PLAN SELECT * FROM portfolio_distributions WHERE portfolio_id = ?',
      [PORTFOLIO_ID],
    );
    const distributionDetail = distributionPlan.map((r) => String(r.detail)).join(' ');
    expect(distributionDetail).toMatch(/USING INDEX idx_portfolio_distributions_portfolio/);

    const { rows: dailyPlan } = await executor.exec(
      'EXPLAIN QUERY PLAN SELECT * FROM portfolio_daily_rollups WHERE portfolio_id = ?',
      [PORTFOLIO_ID],
    );
    expect(dailyPlan.map((r) => String(r.detail)).join(' ')).toMatch(
      /USING INDEX idx_portfolio_daily_rollups_day/,
    );

    const { rows: dimensionPlan } = await executor.exec(
      'EXPLAIN QUERY PLAN SELECT * FROM portfolio_dimension_rollups WHERE portfolio_id = ?',
      [PORTFOLIO_ID],
    );
    expect(dimensionPlan.map((r) => String(r.detail)).join(' ')).toMatch(
      /USING INDEX idx_portfolio_dimension_rollups_portfolio/,
    );

    const { rows: componentPlan } = await executor.exec(
      `EXPLAIN QUERY PLAN
       SELECT cr.component_id, ci.kind, COUNT(DISTINCT cr.project_id) AS project_count
       FROM component_rollups cr
       JOIN component_identities ci ON ci.id = cr.component_id
       WHERE cr.portfolio_id = ?
       GROUP BY cr.component_id, ci.kind`,
      [PORTFOLIO_ID],
    );
    expect(componentPlan.map((r) => String(r.detail)).join(' ')).toMatch(
      /USING INDEX idx_component_rollups_portfolio/,
    );

    const { rows: sessionPlan } = await executor.exec(
      `EXPLAIN QUERY PLAN
       SELECT s.project_id, s.occurrence_time
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE p.portfolio_id = ?`,
      [PORTFOLIO_ID],
    );
    const sessionDetail = sessionPlan.map((r) => String(r.detail)).join(' ');
    expect(sessionDetail).toMatch(/USING INDEX/);
  });

  it('project behavior summary uses precomputed distributions', async () => {
    const statPolicyId = await createStatisticalPolicy(executor);
    const defId = await createMetricDefinition(executor, {
      metricId: 'm-duration',
      statisticalPolicyId: statPolicyId,
      aggregation: 'distribution',
      valueType: 'real',
      unit: 'ms',
    });

    await createSession(executor, 'se-pb-1', PROJECT1_ID, 'sess-pb-1', BASE_TIME);
    await createGeneration(executor, 'se-pb-1', 'gen-pb-1');
    await createSession(executor, 'se-pb-2', PROJECT1_ID, 'sess-pb-2', BASE_TIME + 1000);
    await createGeneration(executor, 'se-pb-2', 'gen-pb-2');
    await createRealMetricValue(executor, defId, 'gen-pb-1', 'se-pb-1', 100);
    await createRealMetricValue(executor, defId, 'gen-pb-2', 'se-pb-2', 120);

    await rebuildProjectDistributions(executor, PROJECT1_ID, ANALYSIS_RELEASE_ID, 'gen-pb-1');

    const view = createProjectBehaviorView(executor);
    const summary = await view.getSummary(PROJECT1_ID, {
      analysisReleaseId: ANALYSIS_RELEASE_ID,
    });

    expect(summary.token).toBeDefined();
    expect(summary.headlineMetrics.length).toBeGreaterThan(0);
    const durationMetric = summary.headlineMetrics.find((m) => m.metricId === 'm-duration');
    expect(durationMetric).toBeDefined();
    expect(durationMetric?.unit).toBe('ms');
  });

  it('createPortfolioView implements PortfolioView', async () => {
    const view = createPortfolioView(executor);
    const overview = await view.getOverview({ portfolioId: PORTFOLIO_ID });
    expect(overview.token).toBeDefined();
    expect(overview.headlineMetrics).toBeDefined();

    const trends = await view.getTrends({ portfolioId: PORTFOLIO_ID });
    expect(trends.series).toBeDefined();

    const utilization = await view.getComponentUtilization({ portfolioId: PORTFOLIO_ID });
    expect(utilization.items).toBeDefined();

    const cohorts = await view.getModelHarnessCohorts({ portfolioId: PORTFOLIO_ID });
    expect(cohorts.items).toBeDefined();

    const list = await view.getProjectList({ portfolioId: PORTFOLIO_ID });
    expect(list.items).toBeDefined();
  });
});
