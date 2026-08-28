// biome-ignore-all lint/style/noNonNullAssertion: test data is asserted before use
import { beforeAll, describe, expect, it } from 'vitest';
import { ComponentIdentityStore } from '../../src/component-ecosystem.js';
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
  deriveHeuristicMetricComparabilityGroupId,
  deriveMetricComparabilityGroupId,
  deriveNativeMetricComparabilityGroupId,
  HeuristicMetricValueStore,
  type InsertAttributionPolicyInput,
  type InsertHeuristicMetricValueInput,
  type InsertMetricDefinitionInput,
  type InsertMetricDistributionInput,
  type InsertMetricProvenanceInput,
  type InsertMetricValueInput,
  type InsertNativeMetricValueInput,
  type InsertStatisticalPolicyInput,
  type InsertTransformerMetricCapabilityInput,
  MetricDefinitionStore,
  MetricDistributionStore,
  MetricProvenanceStore,
  type MetricValueClass,
  MetricValueStore,
  NativeMetricValueStore,
  StatisticalPolicyStore,
  TransformerMetricCapabilityStore,
} from '../../src/metrics.js';
import { FRESH_SCHEMA_SQL } from '../../src/schema.js';
import {
  type InsertSessionInput,
  InvocationStore,
  SessionStore,
} from '../../src/session-evidence.js';
import { getSqlite3, WasmSqliteExecutor } from '../helpers/sqlite-wasm-adapter.js';

beforeAll(async () => {
  await getSqlite3();
});

interface SeedContext {
  executor: WasmSqliteExecutor;
  portfolioId: string;
  projectId: string;
  ingestionSourceId: string;
  environmentId: string;
  sessionId: string;
  generationId: string;
  invocationId: string;
}

async function createSeededExecutor(): Promise<SeedContext> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);

  const tenantId = 'tenant-metrics';
  const portfolioId = 'portfolio-metrics';
  const ingestionSourceId = 'ingestion-metrics';
  const environmentId = 'environment-metrics';
  const projectId = 'project-metrics';
  const workspaceId = 'workspace-metrics';

  await TenantStore.insert(executor, {
    id: tenantId,
    name: 'Metrics Tenant',
    createdAt: 1,
    updatedAt: 1,
  });
  await PortfolioStore.insert(executor, {
    id: portfolioId,
    tenantId,
    name: 'Metrics Portfolio',
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
    nativeEnvironmentId: 'env-metrics',
    createdAt: 1,
    updatedAt: 1,
  });
  await ProjectStore.insert(executor, {
    id: projectId,
    portfolioId,
    name: 'metrics-project',
    createdAt: 1,
    updatedAt: 1,
  });
  await SourceProjectStore.insert(executor, portfolioId, {
    projectId,
    ingestionSourceId,
    nativeProjectId: 'native-metrics-project',
    createdAt: 1,
    updatedAt: 1,
  });
  await WorkspaceStore.insert(executor, portfolioId, {
    id: workspaceId,
    projectId,
    nativeWorkspaceId: 'ws-metrics',
    createdAt: 1,
    updatedAt: 1,
  });

  const analysisReleaseId = 'ar-metrics';
  await executor.exec(
    `INSERT INTO analysis_releases (
      id, ontology_version, metric_registry_version, statistical_policy_version,
      rollup_policy_version, mapping_version, created_at, is_default
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [analysisReleaseId, '1', '1', '1', '1', '1', 1, 0],
  );

  const generationId = 'gen-metrics-1';
  await executor.exec(
    `INSERT INTO transformation_generations (
      id, session_id, analysis_release_id, parser_version, transformer_version,
      ontology_version, metric_version, schema_version, status,
      source_availability, created_at, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      generationId,
      'session-metrics',
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

  const sessionInput: InsertSessionInput = {
    id: 'session-metrics',
    projectId,
    ingestionSourceId,
    environmentId,
    harness: 'claude_code',
    nativeSessionId: 'native-session-metrics',
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
  await SessionStore.update(executor, projectId, 'session-metrics', {
    currentGenerationId: generationId,
  });

  const toolComponentId = await ComponentIdentityStore.insert(executor, {
    portfolioId,
    kind: 'tool',
    canonicalSourceIdentity: 'tool-1',
    displayName: 'Test Tool',
    createdAt: 1,
    updatedAt: 1,
  });

  const invocationId = await InvocationStore.insert(executor, {
    sessionId: 'session-metrics',
    generationId,
    kind: 'tool',
    componentId: toolComponentId,
    rootSessionId: 'session-metrics',
    origin: 'root',
    status: 'completed',
    createdAt: 1,
    updatedAt: 1,
  });

  return {
    executor,
    portfolioId,
    projectId,
    ingestionSourceId,
    environmentId,
    sessionId: 'session-metrics',
    generationId,
    invocationId,
  };
}

async function seedPolicies(
  executor: WasmSqliteExecutor,
): Promise<{ statisticalPolicyId: string; attributionPolicyId: string }> {
  let statisticalPolicy = await StatisticalPolicyStore.getByPolicyIdAndVersion(
    executor,
    'stats-policy-1',
    1,
  );
  if (!statisticalPolicy) {
    statisticalPolicy = await StatisticalPolicyStore.getById(
      executor,
      await StatisticalPolicyStore.insert(executor, {
        policyId: 'stats-policy-1',
        version: 1,
        name: 'Default Statistical Policy',
        observationUnit: 'session',
        eligibility: 'all_sessions',
        percentileAlgorithm: 'nearest_rank',
        percentileMinimumN: 5,
        createdAt: 1,
        updatedAt: 1,
      } as InsertStatisticalPolicyInput),
    );
  }

  let attributionPolicy = await AttributionPolicyStore.getByPolicyIdAndVersion(
    executor,
    'attr-policy-1',
    1,
  );
  if (!attributionPolicy) {
    attributionPolicy = await AttributionPolicyStore.getById(
      executor,
      await AttributionPolicyStore.insert(executor, {
        policyId: 'attr-policy-1',
        version: 1,
        name: 'Default Attribution Policy',
        windowBoundaries: 'request_to_request',
        overlapHandling: 'proportional',
        allocation: 'proportional',
        additive: true,
        createdAt: 1,
        updatedAt: 1,
      } as InsertAttributionPolicyInput),
    );
  }

  return { statisticalPolicyId: statisticalPolicy!.id, attributionPolicyId: attributionPolicy!.id };
}

async function seedDefinition(
  executor: WasmSqliteExecutor,
  overrides?: Partial<InsertMetricDefinitionInput>,
): Promise<string> {
  const { statisticalPolicyId, attributionPolicyId } = await seedPolicies(executor);
  const input: InsertMetricDefinitionInput = {
    metricId: 'input_tokens',
    version: 1,
    label: 'Input Tokens',
    description: 'Tokens in the model request',
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
    comparabilityGroupInputs: [
      'metricId',
      'version',
      'unit',
      'valueType',
      'grain',
      'dimensions',
      'populationRule',
      'aggregation',
      'statisticalPolicyId',
    ],
    missingDataBehavior: 'unknown',
    rootInclusion: 'root_only',
    provenanceRequirement: 'model_request_event',
    ...overrides,
  };
  return MetricDefinitionStore.insert(executor, input);
}

describe('metrics schema and stores', () => {
  it('creates all nine metric registry and values tables', async () => {
    const { executor } = await createSeededExecutor();
    const { rows } = await executor.exec(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const names = rows.map((r) => String(r.name));
    expect(names).toContain('metric_definitions');
    expect(names).toContain('transformer_metric_capabilities');
    expect(names).toContain('metric_values');
    expect(names).toContain('metric_distributions');
    expect(names).toContain('metric_provenance');
    expect(names).toContain('statistical_policies');
    expect(names).toContain('attribution_policies');
    expect(names).toContain('native_metric_values');
    expect(names).toContain('heuristic_metric_values');
  });

  it('versions metric definitions and retains historical comparability groups', async () => {
    const { executor } = await createSeededExecutor();
    const v1Id = await seedDefinition(executor, { version: 1 });
    const v2Id = await seedDefinition(executor, {
      version: 2,
      denominator: 'per_request',
    });

    const v1 = await MetricDefinitionStore.getById(executor, v1Id);
    const v2 = await MetricDefinitionStore.getById(executor, v2Id);

    expect(v1).toBeDefined();
    expect(v2).toBeDefined();
    expect(v1!.version).toBe(1);
    expect(v2!.version).toBe(2);
    expect(v1!.comparabilityGroupId).not.toBe(v2!.comparabilityGroupId);
  });

  it('derives comparability group from the comparability property set', async () => {
    const { executor } = await createSeededExecutor();
    const { statisticalPolicyId, attributionPolicyId } = await seedPolicies(executor);

    const input: InsertMetricDefinitionInput = {
      metricId: 'output_tokens',
      version: 1,
      label: 'Output Tokens',
      description: 'Tokens in the model response',
      family: 'token_usage',
      measurementClass: 'observed',
      unit: 'tokens',
      valueType: 'integer',
      grain: 'request',
      dimensions: ['model'],
      populationRule: 'all_requests',
      statusRule: 'completed_requests',
      aggregation: 'sum',
      statisticalPolicyId,
      attributionPolicyId,
      comparabilityGroupInputs: ['metricId', 'version', 'unit', 'valueType'],
      missingDataBehavior: 'unknown',
      rootInclusion: 'root_only',
      provenanceRequirement: 'model_request_event',
    };

    const expectedGroup = deriveMetricComparabilityGroupId({
      metricId: input.metricId,
      version: input.version,
      unit: input.unit,
      valueType: input.valueType,
      grain: input.grain,
      dimensions: input.dimensions,
      populationRule: input.populationRule,
      statusRule: input.statusRule,
      aggregation: input.aggregation,
      allocationMethod: input.allocationMethod,
      statisticalPolicyId: input.statisticalPolicyId,
      attributionPolicyId: input.attributionPolicyId,
      missingDataBehavior: input.missingDataBehavior,
      rootInclusion: input.rootInclusion,
      distributionPolicy: input.distributionPolicy,
    });

    const id = await MetricDefinitionStore.insert(executor, input);
    const stored = await MetricDefinitionStore.getById(executor, id);

    expect(stored!.comparabilityGroupId).toBe(expectedGroup);
    expect(stored!.comparabilityGroupInputs).toEqual(['metricId', 'version', 'unit', 'valueType']);
  });

  it('distinguishes unavailable and not_applicable from zero with explicit reasons', async () => {
    const { executor, sessionId, generationId } = await createSeededExecutor();
    const definitionId = await seedDefinition(executor);
    const definition = await MetricDefinitionStore.getById(executor, definitionId);

    const unavailableValue: InsertMetricValueInput = {
      metricDefinitionId: definitionId,
      comparabilityGroupId: deriveMetricComparabilityGroupId({
        metricId: definition!.metricId,
        version: definition!.version,
        unit: definition!.unit,
        valueType: definition!.valueType,
        grain: definition!.grain,
        dimensions: definition!.dimensions,
        populationRule: definition!.populationRule,
        statusRule: definition!.statusRule,
        aggregation: definition!.aggregation,
        allocationMethod: definition!.allocationMethod,
        statisticalPolicyId: definition!.statisticalPolicyId,
        attributionPolicyId: definition!.attributionPolicyId,
        missingDataBehavior: definition!.missingDataBehavior,
        rootInclusion: definition!.rootInclusion,
        distributionPolicy: definition!.distributionPolicy,
        valueClass: 'exact',
      }),
      generationId,
      sessionId,
      valueType: 'integer',
      valueClass: 'exact',
      rootInclusion: 'root_only',
      isUnavailable: true,
      unavailableReason: 'model usage event missing',
      createdAt: 1,
      updatedAt: 1,
    };

    const valueId = await MetricValueStore.insert(executor, unavailableValue);
    const stored = await MetricValueStore.getById(executor, valueId);
    expect(stored!.isUnavailable).toBe(true);
    expect(stored!.unavailableReason).toBe('model usage event missing');
    expect(stored!.integerValue).toBeNull();
    expect(stored!.numericValue).toBeNull();

    expect(() =>
      executor.exec(
        `INSERT INTO metric_values (
          id, metric_definition_id, comparability_group_id, generation_id, session_id, value_type,
          value_class, root_inclusion, is_unavailable, unavailable_reason, is_not_applicable,
          not_applicable_reason, integer_value, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'bad-value',
          definitionId,
          stored!.comparabilityGroupId,
          generationId,
          sessionId,
          'integer',
          'exact',
          'root_only',
          1,
          'reason',
          0,
          null,
          42,
          1,
          1,
        ],
      ),
    ).toThrow();
  });

  it('separates exact and estimated values into different comparability groups', async () => {
    const { executor, sessionId, generationId } = await createSeededExecutor();
    const definitionId = await seedDefinition(executor);
    const definition = await MetricDefinitionStore.getById(executor, definitionId);
    const base = {
      metricDefinitionId: definitionId,
      generationId,
      sessionId,
      valueType: 'integer',
      integerValue: 100,
      rootInclusion: 'root_only',
      createdAt: 1,
      updatedAt: 1,
    } as const;

    const exactGroup = deriveMetricComparabilityGroupId({
      ...MetricDefinitionStoreToComparability(definition!),
      valueClass: 'exact',
    });

    const estimatedGroup = deriveMetricComparabilityGroupId({
      ...MetricDefinitionStoreToComparability(definition!),
      valueClass: 'estimated',
    });

    expect(exactGroup).not.toBe(estimatedGroup);

    const exactId = await MetricValueStore.insert(executor, {
      ...base,
      comparabilityGroupId: exactGroup,
      valueClass: 'exact',
    });
    const estimatedId = await MetricValueStore.insert(executor, {
      ...base,
      comparabilityGroupId: estimatedGroup,
      valueClass: 'estimated',
    });

    const exact = await MetricValueStore.getByIdAndGroup(executor, exactId, exactGroup);
    const estimated = await MetricValueStore.getByIdAndGroup(executor, estimatedId, estimatedGroup);

    expect(exact!.valueClass).toBe('exact');
    expect(estimated!.valueClass).toBe('estimated');
    expect(exact!.comparabilityGroupId).not.toBe(estimated!.comparabilityGroupId);

    await expect(
      MetricValueStore.insert(executor, {
        ...base,
        comparabilityGroupId: exactGroup,
        valueClass: 'estimated',
      }),
    ).rejects.toThrow('Comparability group mismatch');
  });

  it('stores native namespaced metric values separately from canonical metrics', async () => {
    const { executor, sessionId } = await createSeededExecutor();
    const nativeId = 'native.claude_code.input_tokens';
    const input: InsertNativeMetricValueInput = {
      nativeMetricId: nativeId,
      valueType: 'integer',
      integerValue: 250,
      valueClass: 'exact',
      sessionId,
      createdAt: 1,
      updatedAt: 1,
    };

    const valueId = await NativeMetricValueStore.insert(executor, input);
    const stored = await NativeMetricValueStore.getById(executor, valueId);

    expect(stored!.nativeMetricId).toBe(nativeId);
    expect(stored!.namespace).toBe('native.claude_code');
    expect(stored!.comparabilityGroupId).toBe(
      deriveNativeMetricComparabilityGroupId({
        nativeMetricId: nativeId,
        valueClass: 'exact',
      }),
    );
  });

  it('stores metric distributions with eligible N, known n, unknown count, and percentiles', async () => {
    const { executor, generationId } = await createSeededExecutor();
    const definitionId = await seedDefinition(executor);
    const definition = await MetricDefinitionStore.getById(executor, definitionId);

    const input: InsertMetricDistributionInput = {
      metricDefinitionId: definitionId,
      comparabilityGroupId: definition!.comparabilityGroupId,
      statisticalPolicyId: definition!.statisticalPolicyId,
      attributionPolicyId: definition!.attributionPolicyId,
      generationId,
      eligibleN: 10,
      knownN: 8,
      unknownCount: 2,
      sum: 800,
      min: 10,
      max: 200,
      mean: 100,
      p50: 95,
      p75: 120,
      p90: 170,
      p95: 190,
      dispersion: 45,
      coverage: 0.8,
      outlierRule: 'iqr_1.5',
      createdAt: 1,
      updatedAt: 1,
    };

    const id = await MetricDistributionStore.insert(executor, input);
    const stored = await MetricDistributionStore.getById(executor, id);

    expect(stored!.eligibleN).toBe(10);
    expect(stored!.knownN).toBe(8);
    expect(stored!.unknownCount).toBe(2);
    expect(stored!.p50).toBe(95);
    expect(stored!.p75).toBe(120);
    expect(stored!.p90).toBe(170);
    expect(stored!.p95).toBe(190);
    expect(stored!.coverage).toBe(0.8);
  });

  it('records metric provenance for a value or distribution', async () => {
    const { executor, sessionId, generationId } = await createSeededExecutor();
    const definitionId = await seedDefinition(executor);
    const valueInput: InsertMetricValueInput = {
      metricDefinitionId: definitionId,
      generationId,
      sessionId,
      valueType: 'integer',
      integerValue: 42,
      valueClass: 'exact',
      rootInclusion: 'root_only',
      createdAt: 1,
      updatedAt: 1,
    };
    const valueId = await MetricValueStore.insert(executor, valueInput);

    const provenance: InsertMetricProvenanceInput = {
      metricValueId: valueId,
      sourceArtifactId: 'artifact-1',
      sourceEventId: 'event-1',
      sourceField: 'usage.input_tokens',
      estimationMethod: 'provider_observed',
      generationId,
      createdAt: 1,
    };

    const provenanceId = await MetricProvenanceStore.insert(executor, provenance);
    const stored = await MetricProvenanceStore.getById(executor, provenanceId);

    expect(stored!.metricValueId).toBe(valueId);
    expect(stored!.sourceField).toBe('usage.input_tokens');
    expect(stored!.estimationMethod).toBe('provider_observed');
  });

  it('declares transformer metric capabilities with support and reason', async () => {
    const { executor } = await createSeededExecutor();
    const definitionId = await seedDefinition(executor);
    const input: InsertTransformerMetricCapabilityInput = {
      transformerId: 'claude-transformer',
      harness: 'claude_code',
      transformerVersion: '1.0.0',
      ontologyVersion: '1.0.0',
      metricDefinitionId: definitionId,
      capability: 'available',
      createdAt: 1,
      updatedAt: 1,
    };

    const id = await TransformerMetricCapabilityStore.insert(executor, input);
    const stored = await TransformerMetricCapabilityStore.getById(executor, id);

    expect(stored!.capability).toBe('available');
    expect(stored!.harness).toBe('claude_code');

    const byMetric = await TransformerMetricCapabilityStore.listByMetricDefinition(
      executor,
      definitionId,
    );
    expect(byMetric).toHaveLength(1);
  });

  it('enforces foreign key behavior and prevents orphan metric values', async () => {
    const { executor, sessionId, generationId } = await createSeededExecutor();
    const definitionId = await seedDefinition(executor);

    await expect(
      MetricValueStore.insert(executor, {
        metricDefinitionId: 'missing-definition',
        comparabilityGroupId: 'cg-missing',
        generationId,
        sessionId,
        valueType: 'integer',
        valueClass: 'exact',
        rootInclusion: 'root_only',
        createdAt: 1,
        updatedAt: 1,
      }),
    ).rejects.toThrow();

    const valueId = await MetricValueStore.insert(executor, {
      metricDefinitionId: definitionId,
      generationId,
      sessionId,
      valueType: 'integer',
      valueClass: 'exact',
      rootInclusion: 'root_only',
      createdAt: 1,
      updatedAt: 1,
    });

    await MetricDefinitionStore.delete(executor, definitionId);
    const afterDelete = await MetricValueStore.getById(executor, valueId);
    expect(afterDelete).toBeUndefined();
  });

  it('cascades deletion from metric definitions to related rows', async () => {
    const { executor, sessionId, generationId } = await createSeededExecutor();
    const definitionId = await seedDefinition(executor);
    const definition = await MetricDefinitionStore.getById(executor, definitionId);

    const valueId = await MetricValueStore.insert(executor, {
      metricDefinitionId: definitionId,
      generationId,
      sessionId,
      valueType: 'integer',
      valueClass: 'exact',
      rootInclusion: 'root_only',
      createdAt: 1,
      updatedAt: 1,
    });

    const distributionId = await MetricDistributionStore.insert(executor, {
      metricDefinitionId: definitionId,
      comparabilityGroupId: definition!.comparabilityGroupId,
      statisticalPolicyId: definition!.statisticalPolicyId,
      generationId,
      eligibleN: 1,
      knownN: 1,
      unknownCount: 0,
      createdAt: 1,
      updatedAt: 1,
    });

    const capabilityId = await TransformerMetricCapabilityStore.insert(executor, {
      transformerId: 'claude-transformer',
      harness: 'claude_code',
      transformerVersion: '1.0.0',
      ontologyVersion: '1.0.0',
      metricDefinitionId: definitionId,
      capability: 'available',
      createdAt: 1,
      updatedAt: 1,
    });

    const provenanceId = await MetricProvenanceStore.insert(executor, {
      metricValueId: valueId,
      sourceField: 'usage.input_tokens',
      generationId,
      createdAt: 1,
    });

    await MetricDefinitionStore.delete(executor, definitionId);

    expect(await MetricValueStore.getById(executor, valueId)).toBeUndefined();
    expect(await MetricDistributionStore.getById(executor, distributionId)).toBeUndefined();
    expect(await TransformerMetricCapabilityStore.getById(executor, capabilityId)).toBeUndefined();
    expect(await MetricProvenanceStore.getById(executor, provenanceId)).toBeUndefined();
  });

  it('stores heuristic metric values with separate versioning and evidence', async () => {
    const { executor, sessionId } = await createSeededExecutor();
    const input: InsertHeuristicMetricValueInput = {
      heuristicId: 'heuristic-cost-quality',
      version: 1,
      label: 'Cost Quality Score',
      valueType: 'real',
      numericValue: 0.85,
      valueClass: 'estimated',
      sessionId,
      evidenceJson: '{"turns":5}',
      createdAt: 1,
      updatedAt: 1,
    };

    const valueId = await HeuristicMetricValueStore.insert(executor, input);
    const stored = await HeuristicMetricValueStore.getById(executor, valueId);

    expect(stored!.heuristicId).toBe('heuristic-cost-quality');
    expect(stored!.version).toBe(1);
    expect(stored!.evidenceJson).toBe('{"turns":5}');
    expect(stored!.comparabilityGroupId).toBe(
      deriveHeuristicMetricComparabilityGroupId({
        heuristicId: input.heuristicId,
        version: input.version,
        valueClass: input.valueClass,
      }),
    );
  });

  it('parameterized queries cover metric tables and respect comparability group filters', async () => {
    const { executor, sessionId, generationId } = await createSeededExecutor();
    const definitionId = await seedDefinition(executor);
    const definition = await MetricDefinitionStore.getById(executor, definitionId);

    const groupId = valueGroup(definition!, 'exact');
    await MetricValueStore.insert(executor, {
      metricDefinitionId: definitionId,
      comparabilityGroupId: groupId,
      generationId,
      sessionId,
      valueType: 'integer',
      integerValue: 10,
      valueClass: 'exact',
      rootInclusion: 'root_only',
      createdAt: 1,
      updatedAt: 1,
    });

    const byDefinition = await MetricValueStore.listByMetricDefinition(executor, definitionId);
    const byGroup = await MetricValueStore.listByComparabilityGroup(executor, groupId);
    const bySession = await MetricValueStore.listBySession(executor, sessionId);

    expect(byDefinition).toHaveLength(1);
    expect(byGroup).toHaveLength(1);
    expect(bySession).toHaveLength(1);
  });
});

function valueGroup(
  definition: Awaited<ReturnType<typeof MetricDefinitionStore.getById>>,
  valueClass: MetricValueClass = 'exact',
): string {
  return deriveMetricComparabilityGroupId({
    ...MetricDefinitionStoreToComparability(definition),
    valueClass,
  });
}

function MetricDefinitionStoreToComparability(
  definition: Awaited<ReturnType<typeof MetricDefinitionStore.getById>>,
): Omit<MetricComparabilityInput, 'valueClass'> {
  if (!definition) throw new Error('Definition not found');
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
  };
}
