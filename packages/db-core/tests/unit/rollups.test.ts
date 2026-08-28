import { beforeAll, describe, expect, it } from 'vitest';
import { ComponentIdentityStore, ComponentVersionStore } from '../../src/component-ecosystem.js';
import {
  EnvironmentStore,
  IngestionSourceStore,
  PortfolioStore,
  ProjectStore,
  SourceProjectStore,
  TenantStore,
  WorkspaceStore,
} from '../../src/identity.js';
import {
  AttributionPolicyStore,
  deriveMetricComparabilityGroupId,
  type MetricComparabilityInput,
  MetricDefinitionStore,
  type MetricValueClass,
  StatisticalPolicyStore,
  type StoredMetricDefinition,
} from '../../src/metrics.js';
import {
  ComparisonCohortMemberStore,
  ComparisonCohortStore,
  ComponentRollupStore,
  InsightEvidenceStore,
  PortfolioDailyRollupStore,
  PortfolioDimensionRollupStore,
  PortfolioDistributionStore,
  ProjectDailyRollupStore,
  ProjectDimensionRollupStore,
  ProjectDistributionStore,
  RollupContributionStore,
  RollupPolicyStore,
  SessionChartSeriesStore,
  SessionComponentStatStore,
  SessionSummaryStore,
} from '../../src/rollups.js';
import { FRESH_SCHEMA_SQL } from '../../src/schema.js';
import { type InsertSessionInput, SessionStore } from '../../src/session-evidence.js';
import { getSqlite3, WasmSqliteExecutor } from '../helpers/sqlite-wasm-adapter.js';

beforeAll(async () => {
  await getSqlite3();
});

interface SeedResult {
  executor: WasmSqliteExecutor;
  portfolioId: string;
  projectId: string;
  ingestionSourceId: string;
  environmentId: string;
  workspaceId: string;
  sessionId: string;
  generationId: string;
  componentIdentityId: string;
  componentVersionId: string;
  analysisReleaseId: string;
  metricDefinitionId: string;
  comparabilityGroupId: string;
  exactComparabilityGroupId: string;
  estimatedComparabilityGroupId: string;
  rollupPolicyId: string;
}

function toComparabilityInput(
  definition: StoredMetricDefinition,
  valueClass: MetricValueClass,
): MetricComparabilityInput {
  return {
    metricId: definition.metricId,
    version: definition.version,
    unit: definition.unit,
    valueType: definition.valueType,
    grain: definition.grain,
    dimensions: definition.dimensions,
    denominator: definition.denominator,
    populationRule: definition.populationRule,
    statusRule: definition.statusRule,
    aggregation: definition.aggregation,
    allocationMethod: definition.allocationMethod,
    statisticalPolicyId: definition.statisticalPolicyId,
    attributionPolicyId: definition.attributionPolicyId,
    missingDataBehavior: definition.missingDataBehavior,
    rootInclusion: definition.rootInclusion,
    distributionPolicy: definition.distributionPolicy,
    valueClass,
  };
}

async function createSeededExecutor(): Promise<SeedResult> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);

  const tenantId = 'tenant-rollups';
  const portfolioId = 'portfolio-rollups';
  const ingestionSourceId = 'ingestion-rollups';
  const environmentId = 'environment-rollups';
  const projectId = 'project-rollups';
  const workspaceId = 'workspace-rollups';

  await TenantStore.insert(executor, {
    id: tenantId,
    name: 'Rollups Tenant',
    createdAt: 1,
    updatedAt: 1,
  });
  await PortfolioStore.insert(executor, {
    id: portfolioId,
    tenantId,
    name: 'Rollups Portfolio',
    createdAt: 1,
    updatedAt: 1,
  });
  await IngestionSourceStore.insert(executor, {
    id: ingestionSourceId,
    portfolioId,
    nativeSourceId: 'claude-local',
    displayName: 'Claude Local',
    type: 'claude_code',
    authority: 'local',
    createdAt: 1,
    updatedAt: 1,
  });
  await EnvironmentStore.insert(executor, portfolioId, {
    id: environmentId,
    ingestionSourceId,
    nativeEnvironmentId: 'env-rollups',
    createdAt: 1,
    updatedAt: 1,
  });
  await ProjectStore.insert(executor, {
    id: projectId,
    portfolioId,
    name: 'rollups-project',
    createdAt: 1,
    updatedAt: 1,
  });
  await SourceProjectStore.insert(executor, portfolioId, {
    projectId,
    ingestionSourceId,
    nativeProjectId: 'native-rollups-project',
    createdAt: 1,
    updatedAt: 1,
  });
  await WorkspaceStore.insert(executor, portfolioId, {
    id: workspaceId,
    projectId,
    nativeWorkspaceId: 'ws-rollups',
    createdAt: 1,
    updatedAt: 1,
  });

  const analysisReleaseId = 'ar-rollups';
  await executor.exec(
    `INSERT INTO analysis_releases (
      id, ontology_version, metric_registry_version, statistical_policy_version,
      rollup_policy_version, mapping_version, created_at, is_default
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [analysisReleaseId, '1', '1', '1', '1', '1', 1, 0],
  );

  const sessionInput: InsertSessionInput = {
    id: 'session-rollups',
    projectId,
    ingestionSourceId,
    environmentId,
    harness: 'claude_code',
    nativeSessionId: 'native-session-rollups',
    currentGenerationId: null,
    occurrenceTime: 1,
    finality: 'open',
    mode: null,
    taskCohort: null,
    startTime: 1,
    endTime: null,
    aiTitle: null,
    slug: null,
    agentName: null,
    cwd: null,
    gitBranch: null,
    cliVersions: null,
    isSidechain: false,
    agentId: null,
    createdAt: 1,
    updatedAt: 1,
  };
  await SessionStore.insert(executor, sessionInput);

  const generationId = 'gen-rollups';
  await executor.exec(
    `INSERT INTO transformation_generations (
      id, session_id, analysis_release_id, parser_version, transformer_version,
      ontology_version, metric_version, schema_version, status,
      source_availability, created_at, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      generationId,
      'session-rollups',
      analysisReleaseId,
      'p1',
      't1',
      'o1',
      'm1',
      's1',
      'committed',
      'local',
      1,
      1,
    ],
  );
  await SessionStore.update(executor, projectId, 'session-rollups', {
    currentGenerationId: generationId,
  });

  const statisticalPolicyId = await StatisticalPolicyStore.insert(executor, {
    policyId: 'stats-rollups',
    version: 1,
    name: 'Rollups Stats Policy',
    observationUnit: 'session',
    eligibility: 'all_sessions',
    createdAt: 1,
    updatedAt: 1,
  });
  const attributionPolicyId = await AttributionPolicyStore.insert(executor, {
    policyId: 'attr-rollups',
    version: 1,
    name: 'Rollups Attr Policy',
    windowBoundaries: 'request_to_request',
    overlapHandling: 'proportional',
    allocation: 'proportional',
    createdAt: 1,
    updatedAt: 1,
  });

  const metricDefinitionId = await MetricDefinitionStore.insert(executor, {
    metricId: 'input_tokens',
    version: 1,
    label: 'Input Tokens',
    description: 'Tokens in model request',
    family: 'token_usage',
    measurementClass: 'observed',
    unit: 'tokens',
    valueType: 'integer',
    grain: 'request',
    dimensions: ['model', 'token_class'],
    populationRule: 'all_requests',
    statusRule: 'completed_requests',
    aggregation: 'sum',
    statisticalPolicyId,
    attributionPolicyId,
    comparabilityGroupInputs: ['metricId', 'version', 'unit', 'valueType'],
    missingDataBehavior: 'unknown',
    rootInclusion: 'root_only',
    provenanceRequirement: 'model_request_event',
    createdAt: 1,
    updatedAt: 1,
  });

  const definition = await MetricDefinitionStore.getById(executor, metricDefinitionId);
  if (!definition) throw new Error('Metric definition not found');
  const comparabilityGroupId = definition.comparabilityGroupId;
  const exactComparabilityGroupId = deriveMetricComparabilityGroupId(
    toComparabilityInput(definition, 'exact'),
  );
  const estimatedComparabilityGroupId = deriveMetricComparabilityGroupId(
    toComparabilityInput(definition, 'estimated'),
  );

  const componentIdentityId = await ComponentIdentityStore.insert(executor, {
    portfolioId,
    kind: 'tool',
    canonicalSourceIdentity: 'tool-rollups',
    displayName: 'Rollups Tool',
    createdAt: 1,
    updatedAt: 1,
  });
  const componentVersionId = await ComponentVersionStore.insert(executor, {
    componentId: componentIdentityId,
    generationId,
    contentHash: 'hash-rollups',
    createdAt: 1,
  });

  const rollupPolicyId = await RollupPolicyStore.insert(executor, {
    policyId: 'rollups-policy',
    version: 1,
    name: 'Rollups Policy',
    supportedDimensions: JSON.stringify(['model', 'harness', 'mode']),
    cardinalityCaps: JSON.stringify({ model: 10, harness: 5, mode: 5 }),
    topNBehavior: 'top_10_other_bucket',
    otherBucketLabel: 'Other',
    unknownBucketLabel: 'Unknown',
    bucketTimezone: 'UTC',
    analysisReleaseId,
    createdAt: 1,
    updatedAt: 1,
  });

  return {
    executor,
    portfolioId,
    projectId,
    ingestionSourceId,
    environmentId,
    workspaceId,
    sessionId: 'session-rollups',
    generationId,
    componentIdentityId,
    componentVersionId,
    analysisReleaseId,
    metricDefinitionId,
    comparabilityGroupId,
    exactComparabilityGroupId,
    estimatedComparabilityGroupId,
    rollupPolicyId,
  };
}

describe('rollups schema and stores', () => {
  it('creates all rollup tables', async () => {
    const { executor } = await createSeededExecutor();
    const { rows } = await executor.exec(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const names = rows.map((r) => String(r.name));
    expect(names).toContain('rollup_policies');
    expect(names).toContain('session_summaries');
    expect(names).toContain('session_component_stats');
    expect(names).toContain('session_chart_series');
    expect(names).toContain('rollup_contributions');
    expect(names).toContain('project_daily_rollups');
    expect(names).toContain('portfolio_daily_rollups');
    expect(names).toContain('project_dimension_rollups');
    expect(names).toContain('portfolio_dimension_rollups');
    expect(names).toContain('project_distributions');
    expect(names).toContain('portfolio_distributions');
    expect(names).toContain('component_rollups');
    expect(names).toContain('comparison_cohorts');
    expect(names).toContain('comparison_cohort_members');
    expect(names).toContain('insight_evidence');
  });

  it('round-trips session summaries with root-only and inclusive separation', async () => {
    const { executor, sessionId, generationId, analysisReleaseId } = await createSeededExecutor();

    const rootOnlyId = await SessionSummaryStore.insert(executor, {
      sessionId,
      generationId,
      analysisReleaseId,
      rootInclusion: 'root_only',
      headlineMetrics: JSON.stringify([{ metricId: 'input_tokens', value: 100 }]),
      capabilityCoverage: JSON.stringify(['model_requests']),
      sourceCompleteness: JSON.stringify({ transcript: 1, manifest: 0 }),
      createdAt: 1,
      updatedAt: 1,
    });

    const inclusiveId = await SessionSummaryStore.insert(executor, {
      sessionId,
      generationId,
      analysisReleaseId,
      rootInclusion: 'inclusive',
      headlineMetrics: JSON.stringify([{ metricId: 'input_tokens', value: 150 }]),
      capabilityCoverage: JSON.stringify(['model_requests']),
      sourceCompleteness: JSON.stringify({ transcript: 1, manifest: 0 }),
      createdAt: 1,
      updatedAt: 1,
    });

    const rootOnly = await SessionSummaryStore.getById(executor, rootOnlyId);
    const inclusive = await SessionSummaryStore.getById(executor, inclusiveId);

    expect(rootOnly?.rootInclusion).toBe('root_only');
    expect(inclusive?.rootInclusion).toBe('inclusive');
    expect(rootOnly?.headlineMetrics).toContain('100');
    expect(inclusive?.headlineMetrics).toContain('150');

    const bySession = await SessionSummaryStore.listBySession(executor, sessionId);
    expect(bySession.length).toBe(2);

    await expect(
      SessionSummaryStore.insert(executor, {
        sessionId,
        generationId,
        analysisReleaseId,
        rootInclusion: 'root_only',
        createdAt: 1,
        updatedAt: 1,
      }),
    ).rejects.toThrow();
  });

  it('round-trips session component stats', async () => {
    const { executor, sessionId, generationId, componentIdentityId } = await createSeededExecutor();

    const id = await SessionComponentStatStore.insert(executor, {
      sessionId,
      generationId,
      componentId: componentIdentityId,
      kind: 'tool',
      availability: JSON.stringify({ offered: true, loaded: true }),
      context: JSON.stringify({ scope: 'workspace' }),
      invocationCount: 5,
      payloadCount: 3,
      payloadBytes: 1024,
      statusCounts: JSON.stringify({ completed: 4, failed: 1 }),
      outcomeState: 'completed',
      createdAt: 1,
      updatedAt: 1,
    });

    const stat = await SessionComponentStatStore.getById(executor, id);
    expect(stat?.invocationCount).toBe(5);
    expect(stat?.payloadBytes).toBe(1024);
    expect(stat?.kind).toBe('tool');

    const bySession = await SessionComponentStatStore.listBySession(executor, sessionId);
    expect(bySession.length).toBe(1);
  });

  it('round-trips session chart series', async () => {
    const { executor, sessionId, generationId, metricDefinitionId, comparabilityGroupId } =
      await createSeededExecutor();

    const id = await SessionChartSeriesStore.insert(executor, {
      sessionId,
      generationId,
      seriesType: 'token_usage_by_turn',
      bucketIndex: 0,
      turnIndex: 0,
      bucketStart: 1,
      bucketEnd: 2,
      annotation: 'first turn',
      metricDefinitionId,
      comparabilityGroupId,
      metricValue: 100,
      createdAt: 1,
      updatedAt: 1,
    });

    const series = await SessionChartSeriesStore.getById(executor, id);
    expect(series?.metricValue).toBe(100);
    expect(series?.seriesType).toBe('token_usage_by_turn');

    const byType = await SessionChartSeriesStore.listBySessionAndType(
      executor,
      sessionId,
      'token_usage_by_turn',
    );
    expect(byType.length).toBe(1);
  });

  it('namespaces rollup contributions as root-only and inclusive', async () => {
    const {
      executor,
      sessionId,
      generationId,
      analysisReleaseId,
      projectId,
      metricDefinitionId,
      exactComparabilityGroupId,
    } = await createSeededExecutor();

    const rootOnly = await RollupContributionStore.insert(executor, {
      sessionId,
      generationId,
      projectId,
      analysisReleaseId,
      comparabilityGroupId: exactComparabilityGroupId,
      metricDefinitionId,
      contributionScope: 'root_only',
      bucketType: 'daily',
      bucketValue: '2026-08-24',
      additiveValue: 100,
      valueCount: 1,
      createdAt: 1,
      updatedAt: 1,
    });

    const inclusive = await RollupContributionStore.insert(executor, {
      sessionId,
      generationId,
      projectId,
      analysisReleaseId,
      comparabilityGroupId: exactComparabilityGroupId,
      metricDefinitionId,
      contributionScope: 'inclusive',
      bucketType: 'daily',
      bucketValue: '2026-08-24',
      additiveValue: 150,
      valueCount: 1,
      createdAt: 1,
      updatedAt: 1,
    });

    const rootOnlyStored = await RollupContributionStore.getById(executor, rootOnly);
    const inclusiveStored = await RollupContributionStore.getById(executor, inclusive);

    expect(rootOnlyStored?.contributionScope).toBe('root_only');
    expect(inclusiveStored?.contributionScope).toBe('inclusive');
    expect(rootOnlyStored?.additiveValue).toBe(100);
    expect(inclusiveStored?.additiveValue).toBe(150);

    const byProject = await RollupContributionStore.listByProject(executor, projectId);
    expect(byProject.length).toBe(2);

    await expect(
      RollupContributionStore.insert(executor, {
        sessionId,
        generationId,
        projectId,
        analysisReleaseId,
        comparabilityGroupId: exactComparabilityGroupId,
        metricDefinitionId,
        contributionScope: 'root_only',
        bucketType: 'daily',
        bucketValue: '2026-08-24',
        additiveValue: 999,
        valueCount: 1,
        createdAt: 1,
        updatedAt: 1,
      }),
    ).rejects.toThrow();
  });

  it('resolves rollup policies with dimension caps and bucket labels', async () => {
    const { executor, analysisReleaseId, rollupPolicyId } = await createSeededExecutor();

    const policy = await RollupPolicyStore.getById(executor, rollupPolicyId);
    expect(policy?.topNBehavior).toBe('top_10_other_bucket');
    expect(JSON.parse(policy?.supportedDimensions ?? '[]')).toEqual(['model', 'harness', 'mode']);
    expect(JSON.parse(policy?.cardinalityCaps ?? '{}')).toEqual({ model: 10, harness: 5, mode: 5 });
    expect(policy?.otherBucketLabel).toBe('Other');
    expect(policy?.unknownBucketLabel).toBe('Unknown');
    expect(policy?.analysisReleaseId).toBe(analysisReleaseId);

    const byVersion = await RollupPolicyStore.getByPolicyIdAndVersion(
      executor,
      'rollups-policy',
      1,
    );
    expect(byVersion?.id).toBe(rollupPolicyId);

    const byRelease = await RollupPolicyStore.listByAnalysisRelease(executor, analysisReleaseId);
    expect(byRelease.length).toBe(1);
  });

  it('partitions project and portfolio daily rollups by analysis release and comparability group', async () => {
    const {
      executor,
      projectId,
      portfolioId,
      analysisReleaseId,
      metricDefinitionId,
      exactComparabilityGroupId,
      estimatedComparabilityGroupId,
      generationId,
    } = await createSeededExecutor();

    await ProjectDailyRollupStore.insert(executor, {
      projectId,
      analysisReleaseId,
      comparabilityGroupId: exactComparabilityGroupId,
      metricDefinitionId,
      dayBucket: '2026-08-24',
      valueCount: 2,
      valueSum: 200,
      valueMin: 50,
      valueMax: 150,
      valueMean: 100,
      generationId,
      createdAt: 1,
      updatedAt: 1,
    });

    await ProjectDailyRollupStore.insert(executor, {
      projectId,
      analysisReleaseId,
      comparabilityGroupId: estimatedComparabilityGroupId,
      metricDefinitionId,
      dayBucket: '2026-08-24',
      valueCount: 2,
      valueSum: 220,
      generationId,
      createdAt: 1,
      updatedAt: 1,
    });

    await PortfolioDailyRollupStore.insert(executor, {
      portfolioId,
      analysisReleaseId,
      comparabilityGroupId: exactComparabilityGroupId,
      metricDefinitionId,
      dayBucket: '2026-08-24',
      valueCount: 3,
      valueSum: 300,
      generationId,
      createdAt: 1,
      updatedAt: 1,
    });

    const projectExact = await ProjectDailyRollupStore.getByProjectDayAndGroup(
      executor,
      projectId,
      analysisReleaseId,
      exactComparabilityGroupId,
      '2026-08-24',
    );
    expect(projectExact?.valueSum).toBe(200);

    const projectEstimated = await ProjectDailyRollupStore.getByProjectDayAndGroup(
      executor,
      projectId,
      analysisReleaseId,
      estimatedComparabilityGroupId,
      '2026-08-24',
    );
    expect(projectEstimated?.valueSum).toBe(220);
    expect(projectEstimated?.valueMin).toBeNull();

    const portfolio = await PortfolioDailyRollupStore.getByPortfolioDayAndGroup(
      executor,
      portfolioId,
      analysisReleaseId,
      exactComparabilityGroupId,
      '2026-08-24',
    );
    expect(portfolio?.valueSum).toBe(300);
  });

  it('materializes project and portfolio dimension rollups with top-N and unknown buckets', async () => {
    const {
      executor,
      projectId,
      portfolioId,
      analysisReleaseId,
      metricDefinitionId,
      exactComparabilityGroupId,
      generationId,
    } = await createSeededExecutor();

    await ProjectDimensionRollupStore.insert(executor, {
      projectId,
      analysisReleaseId,
      comparabilityGroupId: exactComparabilityGroupId,
      metricDefinitionId,
      dimensionName: 'model',
      dimensionValue: 'claude-4',
      isOther: false,
      isUnknown: false,
      valueCount: 10,
      valueSum: 1000,
      topNRank: 1,
      generationId,
      createdAt: 1,
      updatedAt: 1,
    });

    await ProjectDimensionRollupStore.insert(executor, {
      projectId,
      analysisReleaseId,
      comparabilityGroupId: exactComparabilityGroupId,
      metricDefinitionId,
      dimensionName: 'model',
      dimensionValue: 'Other',
      isOther: true,
      isUnknown: false,
      valueCount: 5,
      valueSum: 300,
      topNRank: null,
      generationId,
      createdAt: 1,
      updatedAt: 1,
    });

    await PortfolioDimensionRollupStore.insert(executor, {
      portfolioId,
      analysisReleaseId,
      comparabilityGroupId: exactComparabilityGroupId,
      metricDefinitionId,
      dimensionName: 'model',
      dimensionValue: 'Unknown',
      isOther: false,
      isUnknown: true,
      valueCount: 0,
      valueSum: 0,
      topNRank: null,
      generationId,
      createdAt: 1,
      updatedAt: 1,
    });

    const byDimension = await ProjectDimensionRollupStore.listByProjectAndDimension(
      executor,
      projectId,
      'model',
    );
    expect(byDimension.length).toBe(2);
    expect(byDimension.some((r) => r.isOther)).toBe(true);

    const portfolioUnknown = await PortfolioDimensionRollupStore.listByPortfolioAndDimension(
      executor,
      portfolioId,
      'model',
    );
    expect(portfolioUnknown.length).toBe(1);
    expect(portfolioUnknown[0]?.isUnknown).toBe(true);
  });

  it('stores distribution percentiles for projects and portfolios', async () => {
    const {
      executor,
      projectId,
      portfolioId,
      analysisReleaseId,
      metricDefinitionId,
      exactComparabilityGroupId,
      generationId,
    } = await createSeededExecutor();

    await ProjectDistributionStore.insert(executor, {
      projectId,
      analysisReleaseId,
      comparabilityGroupId: exactComparabilityGroupId,
      metricDefinitionId,
      dimensionsKey: 'model:claude-4',
      eligibleN: 100,
      knownN: 95,
      unknownCount: 5,
      sum: 9500,
      min: 10,
      max: 200,
      mean: 100,
      p50: 95,
      p75: 120,
      p90: 170,
      p95: 190,
      dispersion: 45,
      outlierRule: 'iqr_1.5',
      coverage: 0.95,
      generationId,
      createdAt: 1,
      updatedAt: 1,
    });

    await PortfolioDistributionStore.insert(executor, {
      portfolioId,
      analysisReleaseId,
      comparabilityGroupId: exactComparabilityGroupId,
      metricDefinitionId,
      dimensionsKey: null,
      eligibleN: 50,
      knownN: 48,
      unknownCount: 2,
      p50: 90,
      p75: 110,
      p90: 150,
      p95: 180,
      coverage: 0.96,
      generationId,
      createdAt: 1,
      updatedAt: 1,
    });

    const project = await ProjectDistributionStore.getByProjectGroupAndKey(
      executor,
      projectId,
      analysisReleaseId,
      exactComparabilityGroupId,
      'model:claude-4',
    );
    expect(project?.p50).toBe(95);
    expect(project?.p95).toBe(190);
    expect(project?.coverage).toBe(0.95);
    expect(project?.eligibleN).toBe(100);

    const portfolio = await PortfolioDistributionStore.getByPortfolioGroupAndKey(
      executor,
      portfolioId,
      analysisReleaseId,
      exactComparabilityGroupId,
      null,
    );
    expect(portfolio?.p90).toBe(150);
    expect(portfolio?.knownN).toBe(48);
  });

  it('round-trips component rollups', async () => {
    const {
      executor,
      projectId,
      componentIdentityId,
      componentVersionId,
      analysisReleaseId,
      metricDefinitionId,
      exactComparabilityGroupId,
      generationId,
    } = await createSeededExecutor();

    const id = await ComponentRollupStore.insert(executor, {
      projectId,
      componentId: componentIdentityId,
      componentVersionId,
      analysisReleaseId,
      comparabilityGroupId: exactComparabilityGroupId,
      metricDefinitionId,
      invocationCount: 20,
      successCount: 18,
      failureCount: 2,
      cancellationCount: 0,
      totalLatencyMs: 5000,
      overheadMs: 200,
      reliabilityRatio: 0.9,
      timingP50: 150,
      timingP90: 300,
      outcomeDistribution: JSON.stringify({ success: 18, failure: 2 }),
      generationId,
      createdAt: 1,
      updatedAt: 1,
    });

    const rollup = await ComponentRollupStore.getById(executor, id);
    expect(rollup?.reliabilityRatio).toBe(0.9);
    expect(rollup?.invocationCount).toBe(20);
    expect(rollup?.timingP50).toBe(150);

    const byComponent = await ComponentRollupStore.listByComponent(executor, componentIdentityId);
    expect(byComponent.length).toBe(1);
  });

  it('round-trips comparison cohorts and members', async () => {
    const { executor, sessionId, generationId, analysisReleaseId } = await createSeededExecutor();

    const cohortId = await ComparisonCohortStore.insert(executor, {
      analysisReleaseId,
      cohortType: 'before_after',
      recipeId: 'recipe-1',
      recipeVersion: 1,
      dimensionName: 'model',
      dimensionValue: 'claude-4',
      referenceTime: 1,
      startTime: 1,
      endTime: 2,
      metadata: JSON.stringify({ reason: 'model launch' }),
      createdAt: 1,
      updatedAt: 1,
    });

    const beforeMember = await ComparisonCohortMemberStore.insert(executor, {
      cohortId,
      sessionId,
      generationId,
      groupLabel: 'before',
      concurrentEventId: null,
      createdAt: 1,
      updatedAt: 1,
    });

    const afterMember = await ComparisonCohortMemberStore.insert(executor, {
      cohortId,
      sessionId,
      generationId,
      groupLabel: 'after',
      concurrentEventId: null,
      createdAt: 1,
      updatedAt: 1,
    });

    const cohort = await ComparisonCohortStore.getById(executor, cohortId);
    expect(cohort?.cohortType).toBe('before_after');

    const members = await ComparisonCohortMemberStore.listByCohort(executor, cohortId);
    expect(members.length).toBe(2);
    expect(members.map((m) => m.groupLabel).sort()).toEqual(['after', 'before']);

    const before = await ComparisonCohortMemberStore.getById(executor, beforeMember);
    expect(before?.groupLabel).toBe('before');

    const after = await ComparisonCohortMemberStore.getById(executor, afterMember);
    expect(after?.groupLabel).toBe('after');

    await expect(
      ComparisonCohortMemberStore.insert(executor, {
        cohortId,
        sessionId,
        generationId,
        groupLabel: 'before',
        createdAt: 1,
        updatedAt: 1,
      }),
    ).rejects.toThrow();
  });

  it('round-trips insight evidence with confidence and determinism', async () => {
    const { executor, analysisReleaseId, generationId } = await createSeededExecutor();

    const id = await InsightEvidenceStore.insert(executor, {
      analysisReleaseId,
      recipeId: 'recipe-1',
      recipeVersion: 1,
      insightKind: 'trend',
      wordingInputs: JSON.stringify({ title: 'Token usage trend', body: '...' }),
      evidenceIds: JSON.stringify(['ev-1', 'ev-2']),
      confidence: 0.92,
      confidenceReason: 'high sample coverage',
      determinismVersion: '1.0.0',
      generationId,
      createdAt: 1,
      updatedAt: 1,
    });

    const insight = await InsightEvidenceStore.getById(executor, id);
    expect(insight?.insightKind).toBe('trend');
    expect(insight?.confidence).toBe(0.92);
    expect(insight?.determinismVersion).toBe('1.0.0');
    expect(JSON.parse(insight?.evidenceIds ?? '[]')).toEqual(['ev-1', 'ev-2']);

    const byRelease = await InsightEvidenceStore.listByAnalysisRelease(executor, analysisReleaseId);
    expect(byRelease.length).toBe(1);
  });

  it('enforces foreign key and cascade behavior for rollup rows', async () => {
    const { executor, sessionId, projectId, metricDefinitionId, exactComparabilityGroupId } =
      await createSeededExecutor();

    await executor.exec('PRAGMA foreign_keys = ON');

    await expect(
      RollupContributionStore.insert(executor, {
        sessionId,
        generationId: 'missing-generation',
        projectId,
        analysisReleaseId: 'ar-rollups',
        comparabilityGroupId: exactComparabilityGroupId,
        metricDefinitionId,
        contributionScope: 'root_only',
        bucketType: 'daily',
        additiveValue: 1,
        valueCount: 1,
        createdAt: 1,
        updatedAt: 1,
      }),
    ).rejects.toThrow();

    const countBefore = await executor.exec(
      'SELECT COUNT(*) AS n FROM session_summaries WHERE session_id = ?',
      [sessionId],
    );
    expect(Number(countBefore.rows[0]?.n ?? 0)).toBe(0);

    await SessionSummaryStore.insert(executor, {
      sessionId,
      generationId: 'gen-rollups',
      analysisReleaseId: 'ar-rollups',
      rootInclusion: 'root_only',
      createdAt: 1,
      updatedAt: 1,
    });

    await executor.exec('DELETE FROM sessions WHERE id = ?', [sessionId]);

    const countAfter = await executor.exec(
      'SELECT COUNT(*) AS n FROM session_summaries WHERE session_id = ?',
      [sessionId],
    );
    expect(Number(countAfter.rows[0]?.n ?? 0)).toBe(0);
  });

  it('parameterizes inserts and updates through stores', async () => {
    const { executor, projectId, analysisReleaseId, metricDefinitionId, generationId } =
      await createSeededExecutor();

    const id = await ProjectDailyRollupStore.insert(executor, {
      projectId,
      analysisReleaseId,
      comparabilityGroupId: 'cg-param',
      metricDefinitionId,
      dayBucket: '2026-08-25',
      valueCount: 1,
      valueSum: 42,
      generationId,
      createdAt: 1,
      updatedAt: 1,
    });

    await ProjectDailyRollupStore.update(executor, id, {
      valueCount: 2,
      valueSum: 84,
      valueMean: 42,
    });

    const updated = await ProjectDailyRollupStore.getById(executor, id);
    expect(updated?.valueCount).toBe(2);
    expect(updated?.valueSum).toBe(84);
    expect(updated?.valueMean).toBe(42);
  });
});
