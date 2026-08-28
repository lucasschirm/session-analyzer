import {
  ArtifactBlobStore,
  ArtifactReferenceStore,
  CommandExecutionStore,
  ComponentIdentityStore,
  ComponentInstallationStore,
  ComponentLifecycleEventStore,
  ComponentRollupStore,
  ComponentVersionStore,
  EnvironmentStore,
  FileOperationStore,
  FRESH_SCHEMA_SQL,
  IngestionSourceStore,
  InvocationStore,
  ManifestArtifactStore,
  MessageStore,
  MetricDefinitionStore,
  MetricValueStore,
  PortfolioStore,
  ProjectStore,
  SessionChartSeriesStore,
  SessionComponentStatStore,
  SessionRelationStore,
  SessionStore,
  SessionSummaryStore,
  SourceManifestStore,
  SourceProjectStore,
  SourceTombstoneStore,
  StatisticalPolicyStore,
  TenantStore,
  TurnStore,
  ValidationStore,
} from '@lucasschirm/sal-db-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { type AnalyticsDataSource, createAnalyticsDataSource } from '../../src/analytics.js';

const TENANT_ID = 'tenant-as';
const PORTFOLIO_ID = 'portfolio-as';
const SOURCE_ID = 'source-as';
const ENV_ID = 'env-as';
const PROJECT_ID = 'project-as';
const ANALYSIS_RELEASE_ID = 'ar-as';
const COMPARABILITY_GROUP_ID = 'cgrp-default';
const BASE_TIME = new Date('2026-08-24T12:00:00Z').getTime();

type Executor = WasmSqliteExecutor;

async function createExecutor(): Promise<Executor> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  return executor;
}

async function seedPortfolio(executor: Executor): Promise<void> {
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
    id: PROJECT_ID,
    portfolioId: PORTFOLIO_ID,
    name: 'alpha',
  });
  await executor.exec(
    `INSERT INTO analysis_releases
     (id, ontology_version, metric_registry_version, statistical_policy_version,
      rollup_policy_version, mapping_version, created_at, is_default)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [ANALYSIS_RELEASE_ID, '0.1.0', '0.1.0', '0.1.0', '0.1.0', '0.1.0', BASE_TIME, 0],
  );
}

async function createStatisticalPolicy(executor: Executor): Promise<string> {
  return StatisticalPolicyStore.insert(executor, {
    policyId: 'sp-as',
    version: 1,
    name: 'Default',
    observationUnit: 'session',
    eligibility: 'all',
    percentileMinimumN: 1,
    outlierPolicy: 'iqr:1.5',
  });
}

async function createMetricDefinition(
  executor: Executor,
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
  executor: Executor,
  sessionId: string,
  overrides?: { finality?: string },
): Promise<void> {
  await SessionStore.insert(executor, {
    id: sessionId,
    projectId: PROJECT_ID,
    ingestionSourceId: SOURCE_ID,
    nativeSessionId: `native-${sessionId}`,
    harness: 'claude-code',
    occurrenceTime: BASE_TIME,
    finality: overrides?.finality ?? 'final',
    mode: 'auto',
    taskCohort: 'feature',
  });
}

async function createGeneration(
  executor: Executor,
  sessionId: string,
  generationId: string,
  status = 'committed',
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
      status,
      'local',
      BASE_TIME,
    ],
  );
  await SessionStore.update(executor, PROJECT_ID, sessionId, {
    currentGenerationId: generationId,
  });
}

async function seedSessionEvidence(
  executor: Executor,
  sessionId: string,
  generationId: string,
  componentId: string,
): Promise<void> {
  await SessionSummaryStore.insert(executor, {
    sessionId,
    generationId,
    analysisReleaseId: ANALYSIS_RELEASE_ID,
    rootInclusion: 'root_only',
    headlineMetrics: JSON.stringify([
      { metricId: 'headline-tokens', value: 120, unit: 'count', label: 'Tokens' },
    ]),
    capabilityCoverage: '{}',
    sourceCompleteness: '{}',
  });

  await TurnStore.insert(executor, {
    sessionId,
    ordering: 1,
    role: 'human',
    generationId,
    sourceIdentityId: null,
  });

  const turn = (await TurnStore.listBySession(executor, sessionId))[0];
  if (!turn) throw new Error('turn not created');

  await MessageStore.insert(executor, {
    sessionId,
    turnId: turn.id,
    ordering: 1,
    role: 'user',
    messageType: 'text',
    timestamp: BASE_TIME,
    generationId,
  });

  await InvocationStore.insert(executor, {
    sessionId,
    kind: 'tool',
    componentId,
    status: 'completed',
    rootSessionId: sessionId,
    origin: 'root',
    startId: null,
    resultId: null,
    parentInvocationId: null,
    componentVersionId: null,
    generationId,
  });

  await ValidationStore.insert(executor, {
    sessionId,
    validationType: 'syntax',
    command: 'validate',
    result: 'pass',
    startTime: BASE_TIME,
    endTime: BASE_TIME,
    editCycleId: null,
    generationId,
  });

  await FileOperationStore.insert(executor, {
    sessionId,
    operation: 'write',
    normalizedPath: '/foo.txt',
    pathCategory: 'source',
    rawPath: '/foo.txt',
    retainRaw: true,
    status: 'completed',
    startTime: BASE_TIME,
    endTime: BASE_TIME,
    generationId,
  });

  await CommandExecutionStore.insert(executor, {
    sessionId,
    commandCategory: 'build',
    rawCommand: 'make',
    retainRaw: true,
    exitCode: 0,
    signal: null,
    status: 'completed',
    startTime: BASE_TIME,
    endTime: BASE_TIME,
    generationId,
  });
}

async function seedSessionCharts(
  executor: Executor,
  sessionId: string,
  generationId: string,
): Promise<void> {
  await SessionChartSeriesStore.insert(executor, {
    id: `sch-${sessionId}-total-0`,
    sessionId,
    generationId,
    seriesType: 'total_tokens',
    bucketIndex: 0,
    turnIndex: 0,
    bucketStart: BASE_TIME,
    metricValue: 100,
  });
  await SessionChartSeriesStore.insert(executor, {
    id: `sch-${sessionId}-context-0`,
    sessionId,
    generationId,
    seriesType: 'context_tokens',
    bucketIndex: 0,
    turnIndex: 0,
    bucketStart: BASE_TIME,
    metricValue: 60,
  });
  await SessionChartSeriesStore.insert(executor, {
    id: `sch-${sessionId}-generation-0`,
    sessionId,
    generationId,
    seriesType: 'generation_tokens',
    bucketIndex: 0,
    turnIndex: 0,
    bucketStart: BASE_TIME,
    metricValue: 40,
  });
}

async function createComponent(executor: Executor, id: string): Promise<string> {
  return ComponentIdentityStore.insert(executor, {
    id,
    portfolioId: PORTFOLIO_ID,
    kind: 'tool',
    canonicalSourceIdentity: `src://${id}`,
    displayName: id,
  });
}

async function createComponentVersion(
  executor: Executor,
  componentId: string,
  versionId: string,
  generationId: string,
): Promise<void> {
  await ComponentVersionStore.insert(executor, {
    id: versionId,
    componentId,
    generationId,
    contentHash: `hash-${versionId}`,
  });
}

async function seedComponentEcosystem(
  executor: Executor,
  sessionId: string,
  generationId: string,
  componentId: string,
  versionId: string,
  metricDefinitionId: string,
): Promise<void> {
  await createComponentVersion(executor, componentId, versionId, generationId);

  await SessionComponentStatStore.insert(executor, {
    sessionId,
    generationId,
    componentId,
    componentVersionId: versionId,
    kind: 'tool',
    availability: '{}',
    context: '{}',
    invocationCount: 10,
    payloadCount: 1,
    payloadBytes: 256,
    statusCounts: JSON.stringify({ success: 8, failure: 1 }),
    outcomeState: 'success',
  });

  await ComponentInstallationStore.insert(executor, {
    componentId,
    environmentId: ENV_ID,
    scope: 'project',
    projectId: PROJECT_ID,
    effectiveStartAt: BASE_TIME,
  });

  await ComponentRollupStore.insert(executor, {
    portfolioId: PORTFOLIO_ID,
    projectId: PROJECT_ID,
    componentId,
    componentVersionId: versionId,
    analysisReleaseId: ANALYSIS_RELEASE_ID,
    comparabilityGroupId: COMPARABILITY_GROUP_ID,
    metricDefinitionId,
    invocationCount: 10,
    successCount: 8,
    failureCount: 1,
    cancellationCount: 0,
    totalLatencyMs: 1000,
    overheadMs: 200,
    reliabilityRatio: 0.8,
    timingP50: null,
    timingP90: null,
    outcomeDistribution: JSON.stringify({ success: 8, failure: 1 }),
    generationId,
  });

  await ComponentLifecycleEventStore.insert(executor, {
    componentId,
    environmentId: ENV_ID,
    eventType: 'added',
    beforeVersionId: null,
    afterVersionId: versionId,
    concurrentEventGroupId: null,
    snapshotId: null,
    generationId,
    source: 'test',
    createdAt: BASE_TIME,
  });
}

async function createArtifact(
  executor: Executor,
  sessionId: string,
  artifactId: string,
  sha256: string,
  content: Uint8Array,
): Promise<void> {
  const sourceProjectId = await SourceProjectStore.insert(executor, PORTFOLIO_ID, {
    id: `sp-${PROJECT_ID}`,
    projectId: PROJECT_ID,
    ingestionSourceId: SOURCE_ID,
    nativeProjectId: 'native-project',
  });

  const manifestId = await SourceManifestStore.insert(executor, PORTFOLIO_ID, {
    id: `sm-${artifactId}`,
    ingestionSourceId: SOURCE_ID,
    environmentId: ENV_ID,
    sourceProjectId,
    sessionId,
    manifestSchemaVersion: 1,
    finality: 'final',
    harness: 'claude-code',
    harnessVersion: '0.1.0',
    manifestHash: sha256,
    captureTime: BASE_TIME,
  });

  await ManifestArtifactStore.insert(executor, PORTFOLIO_ID, {
    id: artifactId,
    sourceManifestId: manifestId,
    manifestProjectId: sourceProjectId,
    manifestSessionId: sessionId,
    harness: 'claude-code',
    harnessVersion: '0.1.0',
    manifestSchemaVersion: 1,
    scope: 'session',
    relativePath: 'artifact.txt',
    sha256,
    size: content.length,
    status: 'uploaded',
    mediaType: 'text/plain',
  });

  await ArtifactBlobStore.insert(executor, {
    sha256,
    mediaType: 'text/plain',
    retentionClass: 'retained',
    content,
    size: content.length,
  });

  await ArtifactReferenceStore.insert(executor, PORTFOLIO_ID, {
    sourceManifestId: manifestId,
    manifestArtifactId: artifactId,
    blobSha256: sha256,
    observingSessionId: sessionId,
    componentId: null,
    relationship: 'contains',
  });
}

async function buildDataSource(executor: Executor): Promise<AnalyticsDataSource> {
  const ds = createAnalyticsDataSource(executor);
  return ds;
}

describe('AnalyticsDataSource session, component, search and artifact views', () => {
  let executor: Executor;
  let ds: AnalyticsDataSource;
  const sessionId = 'se-as-1';
  const childId = 'se-as-child';
  const generationId = 'gen-as-1';
  const componentId = 'comp-as-1';
  const versionId = 'cv-as-1';

  beforeEach(async () => {
    executor = await createExecutor();
    await seedPortfolio(executor);
    ds = await buildDataSource(executor);

    const statisticalPolicyId = await createStatisticalPolicy(executor);
    const metricDefinitionId = await createMetricDefinition(executor, {
      metricId: 'm-cost',
      statisticalPolicyId,
      aggregation: 'sum',
      valueType: 'integer',
      unit: 'cents',
    });

    await createComponent(executor, componentId);
    await createSession(executor, sessionId);
    await createSession(executor, childId);
    await createGeneration(executor, sessionId, generationId);

    await seedSessionEvidence(executor, sessionId, generationId, componentId);
    await seedSessionCharts(executor, sessionId, generationId);
    await seedComponentEcosystem(
      executor,
      sessionId,
      generationId,
      componentId,
      versionId,
      metricDefinitionId,
    );
    await createArtifact(
      executor,
      sessionId,
      'artifact-as-1',
      'sha-as-1',
      new TextEncoder().encode('hello world'),
    );

    await SessionRelationStore.insert(executor, {
      sessionId: childId,
      parentSessionId: sessionId,
      rootSessionId: sessionId,
      depth: 1,
      inclusionSemantics: 'native',
      generationId,
    });

    await MetricValueStore.insert(executor, {
      metricDefinitionId,
      generationId,
      sessionId,
      valueType: 'integer',
      numericValue: 42,
      valueClass: 'exact',
      rootInclusion: 'root_only',
    });
  });

  it('returns session evidence summary with headline metrics and root/child ids', async () => {
    const summary = await ds.session.getSummary(sessionId);
    expect(summary.sessionId).toBe(sessionId);
    expect(summary.rootSessionId).toBe(sessionId);
    expect(summary.headlineMetrics.length).toBeGreaterThanOrEqual(1);
    expect(summary.headlineMetrics[0]?.metricId).toBe('headline-tokens');
  });

  it('returns context timing series from chart series', async () => {
    const series = await ds.session.getContextTimingSeries(sessionId);
    expect(series.points.length).toBe(1);
    expect(series.points[0]?.totalTokens).toBe(100);
    expect(series.points[0]?.contextTokens).toBe(60);
    expect(series.points[0]?.generationTokens).toBe(40);
  });

  it('returns root child breakdown with session tree', async () => {
    const breakdown = await ds.session.getRootChildBreakdown(sessionId);
    expect(breakdown.root.sessionId).toBe(sessionId);
    expect(breakdown.root.isRoot).toBe(true);
    expect(breakdown.children.length).toBe(1);
    expect(breakdown.children[0]?.sessionId).toBe(childId);
  });

  it('returns component facts for a session', async () => {
    const page = await ds.session.getComponentFacts(sessionId);
    expect(page.items.length).toBe(1);
    const fact = page.items[0];
    expect(fact?.componentId).toBe(componentId);
    expect(fact?.invocationCount).toBe(10);
    expect(fact?.outcome).toBe('success');
  });

  it('returns validation summary', async () => {
    const summary = await ds.session.getValidationSummary(sessionId);
    expect(summary.validations.length).toBe(1);
    expect(summary.validations[0]?.validationType).toBe('syntax');
    expect(summary.validations[0]?.status).toBe('passed');
  });

  it('returns paginated evidence from all evidence tables', async () => {
    const page = await ds.session.getEvidencePages(sessionId);
    expect(page.items.length).toBeGreaterThanOrEqual(5);
    const types = new Set(page.items.map((item) => item.entityType));
    expect(types.has('message')).toBe(true);
    expect(types.has('invocation')).toBe(true);
    expect(types.has('validation')).toBe(true);
    expect(types.has('file_operation')).toBe(true);
    expect(types.has('command_execution')).toBe(true);
  });

  it('returns paginated transcript from messages only', async () => {
    const page = await ds.session.getTranscriptPages(sessionId);
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.entityType).toBe('message');
  });

  it('returns component ecosystem summary', async () => {
    const summary = await ds.component.getSummary({
      portfolioId: PORTFOLIO_ID,
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      comparabilityGroupId: COMPARABILITY_GROUP_ID,
    });
    expect(summary.countsByKind.tool).toBe(1);
    expect(summary.topByUtilization.length).toBeGreaterThanOrEqual(1);
  });

  it('returns component versions, scopes, utilization and distributions', async () => {
    const versions = await ds.component.getVersions(componentId, {});
    expect(versions.items.length).toBe(1);
    expect(versions.items[0]?.version).toBe(versionId);

    const scopes = await ds.component.getScopes(componentId, {});
    expect(scopes.items.length).toBe(1);
    expect(scopes.items[0]?.scope).toBe('project');

    const utilization = await ds.component.getUtilization(componentId, {
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      comparabilityGroupId: COMPARABILITY_GROUP_ID,
      generationId,
    });
    expect(utilization.loadRate.value).toBe(0.8);

    const distributions = await ds.component.getDistributions(componentId, {
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      comparabilityGroupId: COMPARABILITY_GROUP_ID,
      generationId,
    });
    expect(distributions.items.length).toBe(1);
    expect(distributions.items[0]?.metricId).toBe('m-cost');
  });

  it('returns project-sessions and lifecycle comparisons', async () => {
    const projectSessions = await ds.component.getProjectsSessions(componentId, {});
    expect(projectSessions.items.length).toBe(1);
    expect(projectSessions.items[0]?.sessionId).toBe(sessionId);

    const lifecycle = await ds.component.getLifecycleComparisons(componentId, {});
    expect(lifecycle.items.length).toBe(1);
    expect(lifecycle.items[0]?.changeType).toBe('added');
  });

  it('returns project session list and session trees', async () => {
    const list = await ds.search.getProjectSessionList(PROJECT_ID, {
      portfolioId: PORTFOLIO_ID,
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      comparabilityGroupId: COMPARABILITY_GROUP_ID,
    });
    expect(list.items.length).toBe(2);

    const rootTree = await ds.search.getRootSessionTree(childId);
    expect(rootTree.rootSessionId).toBe(sessionId);
    expect(rootTree.nodes[0]?.children[0]?.sessionId).toBe(childId);

    const childTree = await ds.search.getChildSessionTree(sessionId);
    expect(childTree.rootSessionId).toBe(sessionId);
    expect(childTree.nodes[0]?.children.length).toBe(1);
  });

  it('returns artifact metadata and diff', async () => {
    const metadata = await ds.artifact.getMetadata('artifact-as-1');
    expect(metadata.artifactId).toBe('artifact-as-1');
    expect(metadata.sessionIds).toContain(sessionId);

    const diff = await ds.artifact.getDiff('artifact-as-1', 'artifact-as-1');
    expect(diff.artifactId).toBe('artifact.txt');
    expect(diff.leftVersion).toBeDefined();
    expect(diff.rightVersion).toBeDefined();
  });

  it('returns filter metadata and coverage explanation', async () => {
    const filterMeta = await ds.metadata.getFilterMetadata({
      portfolioId: PORTFOLIO_ID,
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      comparabilityGroupId: COMPARABILITY_GROUP_ID,
    });
    expect(filterMeta.availableFields.length).toBeGreaterThanOrEqual(1);
    expect(filterMeta.availableComparabilityGroups.length).toBeGreaterThanOrEqual(1);

    const coverage = await ds.metadata.getCoverageExplanation('m-cost', {
      projectId: PROJECT_ID,
      portfolioId: PORTFOLIO_ID,
      generationId,
    });
    expect(coverage.metricId).toBe('m-cost');
    expect(coverage.knownN).toBeGreaterThanOrEqual(1);
  });

  it('resolves superseded evidence to a tombstone', async () => {
    const supersededGen = 'gen-as-superseded';
    await createGeneration(executor, sessionId, supersededGen);
    await executor.exec(
      `UPDATE transformation_generations SET status = 'superseded', superseded_by_id = ? WHERE id = ?`,
      [generationId, supersededGen],
    );

    const page = await ds.session.getEvidencePages(sessionId, { generationId: supersededGen });
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.entityType).toBe('tombstone');
    expect(page.items[0]?.summary).toMatch(/superseded/i);
  });

  it('resolves deleted source to a tombstone', async () => {
    await SourceTombstoneStore.recordTombstone(executor, PORTFOLIO_ID, {
      ingestionSourceId: SOURCE_ID,
      sourceType: 'session',
      sourceId: `native-${sessionId}`,
      tombstoneAuthority: 'source',
    });

    const page = await ds.session.getEvidencePages(sessionId);
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.entityType).toBe('tombstone');
  });
});
