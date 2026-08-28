import {
  ComparisonCohortMemberStore,
  FRESH_SCHEMA_SQL,
  IngestionSourceStore,
  MetricDefinitionStore,
  MetricValueStore,
  PortfolioDistributionStore,
  PortfolioStore,
  ProjectDistributionStore,
  ProjectStore,
  SessionStore,
  StatisticalPolicyStore,
  TenantStore,
} from '@lucasschirm/sal-db-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import {
  buildMatchedCohort,
  buildObservedBeforeAfterCohort,
  discloseConcurrentChanges,
  evaluateCohortMetric,
  rebuildAffectedDistributions,
  rebuildProjectDistributions,
  reconcileDistributionCounts,
  recordHeuristicInsight,
  recordInsightEvidence,
} from '../../src/distributions.js';

const TENANT_ID = 'tenant-distributions';
const PORTFOLIO_ID = 'portfolio-distributions';
const SOURCE_ID = 'source-distributions';
const ENVIRONMENT_ID = 'environment-distributions';
const PROJECT_ID = 'project-distributions';
const ANALYSIS_RELEASE_ID = 'ar-distributions';
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
  await executor.exec(
    'INSERT INTO environments (id, ingestion_source_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
    [ENVIRONMENT_ID, SOURCE_ID, BASE_TIME, BASE_TIME],
  );
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

async function createStatisticalPolicy(
  executor: WasmSqliteExecutor,
  overrides?: { percentileMinimumN?: number },
): Promise<string> {
  return StatisticalPolicyStore.insert(executor, {
    policyId: 'sp-distributions',
    version: 1,
    name: 'Default',
    observationUnit: 'session',
    eligibility: 'all',
    percentileMinimumN: overrides?.percentileMinimumN ?? 1,
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
    unit?: string;
  },
): Promise<string> {
  return MetricDefinitionStore.insert(executor, {
    metricId: params.metricId,
    version: 1,
    label: params.metricId,
    description: 'test metric',
    family: 'test',
    measurementClass: 'observed',
    unit: params.unit ?? (params.valueType === 'real' ? 'ms' : 'count'),
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
  overrides?: { mode?: string; taskCohort?: string; harness?: string },
): Promise<void> {
  await SessionStore.insert(executor, {
    id: sessionId,
    projectId: PROJECT_ID,
    ingestionSourceId: SOURCE_ID,
    nativeSessionId,
    harness: overrides?.harness ?? 'claude-code',
    occurrenceTime,
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
  await SessionStore.update(executor, PROJECT_ID, sessionId, { currentGenerationId: generationId });
}

async function createDistributionMetricValue(
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
    entityType: 'observation',
    entityId: valueId,
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

function expectCloseTo(actual: number | null, expected: number): void {
  expect(actual).not.toBeNull();
  expect(Math.abs((actual as number) - expected)).toBeLessThan(1e-6);
}

describe('distributions', () => {
  let executor: WasmSqliteExecutor;

  beforeEach(async () => {
    executor = await createExecutor();
    await seedIdentity(executor);
  });

  it('rebuilds affected project and portfolio distribution buckets at write time', async () => {
    const policyId = await createStatisticalPolicy(executor);
    const metricId = await createMetricDefinition(executor, {
      metricId: 'm-duration',
      statisticalPolicyId: policyId,
      aggregation: 'distribution',
      valueType: 'real',
    });
    const sessionId = 'se-dist-1';
    const generationId = 'gen-dist-1';
    await createSession(executor, sessionId, 'native-1', BASE_TIME);
    await createGeneration(executor, sessionId, generationId);

    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    for (const value of values) {
      await createDistributionMetricValue(
        executor,
        metricId,
        generationId,
        sessionId,
        value,
        `${sessionId}-value-${value}`,
      );
    }

    const result = await rebuildAffectedDistributions(executor, {
      sessionId,
      generationId,
      analysisReleaseId: ANALYSIS_RELEASE_ID,
    });
    expect(result.projectBucketsRebuilt).toBe(1);
    expect(result.portfolioBucketsRebuilt).toBe(1);

    const projectDistributions = await ProjectDistributionStore.listByProject(executor, PROJECT_ID);
    expect(projectDistributions.length).toBe(1);
    const pd = projectDistributions[0];
    expect(pd.eligibleN).toBe(10);
    expect(pd.knownN).toBe(10);
    expect(pd.unknownCount).toBe(0);
    expectCloseTo(pd.sum, 55);
    expectCloseTo(pd.min, 1);
    expectCloseTo(pd.max, 10);
    expectCloseTo(pd.mean, 5.5);
    expectCloseTo(pd.p50, 5.5);
    expectCloseTo(pd.p75, 7.75);
    expectCloseTo(pd.p90, 9.1);
    expectCloseTo(pd.p95, 9.55);
    expect(pd.outlierRule).toBe('iqr:1.5');
    expect(pd.coverage).toBe(1);

    const portfolioDistributions = await PortfolioDistributionStore.listByPortfolio(
      executor,
      PORTFOLIO_ID,
    );
    expect(portfolioDistributions.length).toBe(1);
    expect(portfolioDistributions[0].knownN).toBe(10);
  });

  it('rebuilds all project distributions with full rebuild', async () => {
    const policyId = await createStatisticalPolicy(executor);
    const metricId = await createMetricDefinition(executor, {
      metricId: 'm-full',
      statisticalPolicyId: policyId,
      aggregation: 'distribution',
      valueType: 'real',
    });
    const sessionId = 'se-full';
    const generationId = 'gen-full';
    await createSession(executor, sessionId, 'native-full', BASE_TIME);
    await createGeneration(executor, sessionId, generationId);
    await createDistributionMetricValue(
      executor,
      metricId,
      generationId,
      sessionId,
      42,
      `${sessionId}-value-42`,
    );

    await rebuildAffectedDistributions(executor, {
      sessionId,
      generationId,
      analysisReleaseId: ANALYSIS_RELEASE_ID,
    });

    const rebuilt = await rebuildProjectDistributions(
      executor,
      PROJECT_ID,
      ANALYSIS_RELEASE_ID,
      generationId,
    );
    expect(rebuilt).toBe(1);
    const distributions = await ProjectDistributionStore.listByProject(executor, PROJECT_ID);
    expect(distributions.length).toBe(1);
    expectCloseTo(distributions[0].mean, 42);
  });

  it('tracks unknown and not-applicable values in distributions', async () => {
    const policyId = await createStatisticalPolicy(executor);
    const metricId = await createMetricDefinition(executor, {
      metricId: 'm-unknown',
      statisticalPolicyId: policyId,
      aggregation: 'distribution',
      valueType: 'real',
    });
    const sessionId = 'se-unknown';
    const generationId = 'gen-unknown';
    await createSession(executor, sessionId, 'native-unknown', BASE_TIME);
    await createGeneration(executor, sessionId, generationId);
    await createDistributionMetricValue(
      executor,
      metricId,
      generationId,
      sessionId,
      10,
      `${sessionId}-value-10`,
    );
    await createDistributionMetricValue(
      executor,
      metricId,
      generationId,
      sessionId,
      20,
      `${sessionId}-value-20`,
    );
    await MetricValueStore.insert(executor, {
      id: `${sessionId}-unknown`,
      metricDefinitionId: metricId,
      generationId,
      sessionId,
      entityType: 'observation',
      entityId: `${sessionId}-unknown`,
      valueType: 'real',
      valueClass: 'exact',
      rootInclusion: 'root_only',
      isUnavailable: true,
      unavailableReason: 'missing',
    });

    await rebuildAffectedDistributions(executor, {
      sessionId,
      generationId,
      analysisReleaseId: ANALYSIS_RELEASE_ID,
    });

    const distributions = await ProjectDistributionStore.listByProject(executor, PROJECT_ID);
    const pd = distributions[0];
    expect(pd.eligibleN).toBe(3);
    expect(pd.knownN).toBe(2);
    expect(pd.unknownCount).toBe(1);
    expectCloseTo(pd.coverage, 2 / 3);
  });

  it('reconciles distribution counts with current session contributions', async () => {
    const policyId = await createStatisticalPolicy(executor);
    const metricId = await createMetricDefinition(executor, {
      metricId: 'm-reconcile',
      statisticalPolicyId: policyId,
      aggregation: 'distribution',
      valueType: 'real',
    });
    const sessionId = 'se-reconcile';
    const generationId = 'gen-reconcile';
    await createSession(executor, sessionId, 'native-reconcile', BASE_TIME);
    await createGeneration(executor, sessionId, generationId);
    await createDistributionMetricValue(
      executor,
      metricId,
      generationId,
      sessionId,
      1,
      `${sessionId}-value-1`,
    );
    await createDistributionMetricValue(
      executor,
      metricId,
      generationId,
      sessionId,
      2,
      `${sessionId}-value-2`,
    );
    await createDistributionMetricValue(
      executor,
      metricId,
      generationId,
      sessionId,
      3,
      `${sessionId}-value-3`,
    );

    await rebuildAffectedDistributions(executor, {
      sessionId,
      generationId,
      analysisReleaseId: ANALYSIS_RELEASE_ID,
    });

    const reconciliation = await reconcileDistributionCounts(
      executor,
      PROJECT_ID,
      PORTFOLIO_ID,
      ANALYSIS_RELEASE_ID,
    );
    expect(reconciliation.projectMismatches.length).toBe(0);
    expect(reconciliation.portfolioMismatches.length).toBe(0);
  });

  it('builds an observed before/after cohort', async () => {
    const policyId = await createStatisticalPolicy(executor);
    const metricId = await createMetricDefinition(executor, {
      metricId: 'm-cohort',
      statisticalPolicyId: policyId,
      aggregation: 'sum',
      valueType: 'integer',
    });
    const beforeSessionId = 'se-before';
    const afterSessionId = 'se-after';
    const beforeGenerationId = 'gen-before';
    const afterGenerationId = 'gen-after';
    await createSession(executor, beforeSessionId, 'native-before', BASE_TIME - 100);
    await createGeneration(executor, beforeSessionId, beforeGenerationId);
    await createSession(executor, afterSessionId, 'native-after', BASE_TIME + 100);
    await createGeneration(executor, afterSessionId, afterGenerationId);
    await createIntegerMetricValue(
      executor,
      metricId,
      beforeGenerationId,
      beforeSessionId,
      10,
      `${beforeSessionId}-value-10`,
    );
    await createIntegerMetricValue(
      executor,
      metricId,
      afterGenerationId,
      afterSessionId,
      20,
      `${afterSessionId}-value-20`,
    );

    const result = await buildObservedBeforeAfterCohort(executor, {
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      recipeId: 'observed',
      recipeVersion: 1,
      scope: 'project',
      scopeId: PROJECT_ID,
      referenceTime: BASE_TIME,
      startTime: BASE_TIME - 1000,
      endTime: BASE_TIME + 1000,
      generationToken: beforeGenerationId,
    });

    expect(result.beforeN).toBe(1);
    expect(result.afterN).toBe(1);
    expect(result.matchedPairs).toBe(0);
    expect(result.members.length).toBe(2);
  });

  it('builds a matched cohort with control/treatment pairs', async () => {
    const beforeSession = 'se-matched-before';
    const afterMatched = 'se-matched-after';
    const afterUnmatched = 'se-unmatched-after';
    const genBefore = 'gen-matched-before';
    const genAfterMatched = 'gen-matched-after';
    const genAfterUnmatched = 'gen-unmatched-after';
    await createSession(executor, beforeSession, 'native-mb', BASE_TIME - 100, {
      taskCohort: 'feature',
    });
    await createGeneration(executor, beforeSession, genBefore);
    await createSession(executor, afterMatched, 'native-ma', BASE_TIME + 100, {
      taskCohort: 'feature',
    });
    await createGeneration(executor, afterMatched, genAfterMatched);
    await createSession(executor, afterUnmatched, 'native-mu', BASE_TIME + 200, {
      taskCohort: 'other',
    });
    await createGeneration(executor, afterUnmatched, genAfterUnmatched);

    const result = await buildMatchedCohort(executor, {
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      recipeId: 'matched',
      recipeVersion: 1,
      scope: 'project',
      scopeId: PROJECT_ID,
      referenceTime: BASE_TIME,
      startTime: BASE_TIME - 1000,
      endTime: BASE_TIME + 1000,
      matchingDimension: 'taskCohort',
      generationToken: genBefore,
    });

    expect(result.beforeN).toBe(1);
    expect(result.afterN).toBe(2);
    expect(result.matchedPairs).toBe(1);
    expect(result.members.length).toBe(2);
    expect(result.members.map((m) => m.groupLabel).sort()).toEqual(['control', 'treatment']);
  });

  it('discloses concurrent configuration changes to cohort members', async () => {
    const beforeSession = 'se-concurrent';
    const genId = 'gen-concurrent';
    await createSession(executor, beforeSession, 'native-concurrent', BASE_TIME - 100);
    await createGeneration(executor, beforeSession, genId);

    const cohort = await buildObservedBeforeAfterCohort(executor, {
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      recipeId: 'concurrent',
      recipeVersion: 1,
      scope: 'project',
      scopeId: PROJECT_ID,
      referenceTime: BASE_TIME,
      startTime: BASE_TIME - 1000,
      endTime: BASE_TIME + 1000,
      generationToken: genId,
    });

    await executor.exec(
      'INSERT INTO component_identities (id, portfolio_id, kind, canonical_source_identity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['comp-1', PORTFOLIO_ID, 'tool', 'canonical-1', BASE_TIME, BASE_TIME],
    );

    const lifecycleId = 'lifecycle-1';
    const groupId = 'concurrent-group-1';
    await executor.exec(
      `INSERT INTO component_lifecycle_events
       (id, component_id, environment_id, event_type, concurrent_event_group_id, generation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [lifecycleId, 'comp-1', ENVIRONMENT_ID, 'added', groupId, genId, BASE_TIME - 50],
    );

    const updated = await discloseConcurrentChanges(executor, cohort.cohort.id);
    expect(updated).toBe(1);

    const members = await ComparisonCohortMemberStore.listByCohort(executor, cohort.cohort.id);
    expect(members[0].concurrentEventId).toBe(groupId);
  });

  it('enforces versioned small-cohort policy while showing coverage and raw evidence', async () => {
    const policyId = await createStatisticalPolicy(executor, { percentileMinimumN: 10 });
    const cohortMetricId = await createMetricDefinition(executor, {
      metricId: 'm-small-cohort',
      statisticalPolicyId: policyId,
      aggregation: 'sum',
      valueType: 'integer',
    });
    const beforeSession = 'se-small-before';
    const afterSession = 'se-small-after';
    const genBefore = 'gen-small-before';
    const genAfter = 'gen-small-after';
    await createSession(executor, beforeSession, 'native-small-before', BASE_TIME - 100);
    await createGeneration(executor, beforeSession, genBefore);
    await createSession(executor, afterSession, 'native-small-after', BASE_TIME + 100);
    await createGeneration(executor, afterSession, genAfter);
    await createIntegerMetricValue(
      executor,
      cohortMetricId,
      genBefore,
      beforeSession,
      1,
      `${beforeSession}-value-1`,
    );
    await createIntegerMetricValue(
      executor,
      cohortMetricId,
      genAfter,
      afterSession,
      2,
      `${afterSession}-value-2`,
    );

    const cohort = await buildObservedBeforeAfterCohort(executor, {
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      recipeId: 'small',
      recipeVersion: 1,
      scope: 'project',
      scopeId: PROJECT_ID,
      referenceTime: BASE_TIME,
      startTime: BASE_TIME - 1000,
      endTime: BASE_TIME + 1000,
      generationToken: genBefore,
    });

    const values = await MetricValueStore.listBySession(executor, beforeSession);
    const groupId = values[0].comparabilityGroupId;

    const summary = await evaluateCohortMetric(
      executor,
      cohort.cohort.id,
      cohortMetricId,
      groupId,
      {
        statisticalPolicyId: policyId,
      },
    );

    expect(summary.before.knownN).toBe(1);
    expect(summary.after.knownN).toBe(1);
    expect(summary.before.coverage).toBe(1);
    expect(summary.after.coverage).toBe(1);
    expect(summary.claimsSuppressed).toBe(true);
    expect(summary.suppressionReason).toContain('small cohort');
    expect(summary.absoluteDelta).toBe(1);
    expect(summary.relativeDelta).toBeNull();
  });

  it('stores absolute delta and undefined relative delta for zero denominator', async () => {
    const policyId = await createStatisticalPolicy(executor);
    const cohortMetricId = await createMetricDefinition(executor, {
      metricId: 'm-zero',
      statisticalPolicyId: policyId,
      aggregation: 'sum',
      valueType: 'integer',
    });
    const beforeSession = 'se-zero-before';
    const afterSession = 'se-zero-after';
    const genBefore = 'gen-zero-before';
    const genAfter = 'gen-zero-after';
    await createSession(executor, beforeSession, 'native-zero-before', BASE_TIME - 100);
    await createGeneration(executor, beforeSession, genBefore);
    await createSession(executor, afterSession, 'native-zero-after', BASE_TIME + 100);
    await createGeneration(executor, afterSession, genAfter);
    await createIntegerMetricValue(
      executor,
      cohortMetricId,
      genBefore,
      beforeSession,
      0,
      `${beforeSession}-value-0`,
    );
    await createIntegerMetricValue(
      executor,
      cohortMetricId,
      genAfter,
      afterSession,
      5,
      `${afterSession}-value-5`,
    );

    const cohort = await buildObservedBeforeAfterCohort(executor, {
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      recipeId: 'zero',
      recipeVersion: 1,
      scope: 'project',
      scopeId: PROJECT_ID,
      referenceTime: BASE_TIME,
      startTime: BASE_TIME - 1000,
      endTime: BASE_TIME + 1000,
      generationToken: genBefore,
    });

    const values = await MetricValueStore.listBySession(executor, beforeSession);
    const groupId = values[0].comparabilityGroupId;

    const summary = await evaluateCohortMetric(executor, cohort.cohort.id, cohortMetricId, groupId);
    expect(summary.before.sum).toBe(0);
    expect(summary.after.sum).toBe(5);
    expect(summary.absoluteDelta).toBe(5);
    expect(summary.relativeDelta).toBeNull();
    expect(summary.relativeDeltaUndefined).toBe(true);
  });

  it('records deterministic insight evidence with a stable recipe id', async () => {
    const sessionId = 'se-insight';
    const generationId = 'gen-insight';
    await createSession(executor, sessionId, 'native-insight', BASE_TIME);
    await createGeneration(executor, sessionId, generationId);

    const deterministicId = await recordInsightEvidence(executor, {
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      recipeId: 'insight-recipe',
      recipeVersion: 1,
      insightKind: 'trend',
      wordingInputs: { metric: 'duration', direction: 'up' },
      evidenceIds: ['ev-1', 'ev-2'],
      confidence: 0.95,
      confidenceReason: 'strong evidence',
      determinismVersion: 'deterministic-v1',
      generationId,
    });

    const second = await recordInsightEvidence(executor, {
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      recipeId: 'insight-recipe',
      recipeVersion: 1,
      insightKind: 'trend',
      wordingInputs: { metric: 'duration', direction: 'up' },
      evidenceIds: ['ev-1', 'ev-2'],
      confidence: 0.95,
      confidenceReason: 'strong evidence',
      determinismVersion: 'deterministic-v1',
      generationId,
    });

    expect(second).toBe(deterministicId);
  });

  it('requires a deterministic insight before recording a heuristic variant', async () => {
    const sessionId = 'se-heuristic';
    const generationId = 'gen-heuristic';
    await createSession(executor, sessionId, 'native-heuristic', BASE_TIME);
    await createGeneration(executor, sessionId, generationId);

    await recordInsightEvidence(executor, {
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      recipeId: 'has-deterministic',
      recipeVersion: 1,
      insightKind: 'anomaly',
      wordingInputs: { feature: 'x' },
      evidenceIds: ['ev-1'],
      confidence: 0.9,
      determinismVersion: 'deterministic-v1',
      generationId,
    });

    await expect(
      recordHeuristicInsight(executor, {
        analysisReleaseId: ANALYSIS_RELEASE_ID,
        recipeId: 'no-deterministic',
        recipeVersion: 1,
        insightKind: 'anomaly',
        wordingInputs: {},
        evidenceIds: [],
        confidence: 0.5,
        determinismVersion: 'heuristic-v1',
        generationId,
      }),
    ).rejects.toThrow(/Deterministic insight must exist/);
  });
});
