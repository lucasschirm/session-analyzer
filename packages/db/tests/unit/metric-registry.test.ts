import { FRESH_SCHEMA_SQL, type InsertMetricDefinitionInput } from '@lucasschirm/sal-db-core';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import {
  addAttributionPolicy,
  addMetricDefinition,
  addRollupPolicy,
  addStatisticalPolicy,
  deriveComparabilityGroupIdForDefinition,
  generateMetricRegistryReference,
  getDefaultPortfolioHeadlineStrata,
  getMetricReleaseMatrix,
  updateMetricDocumentation,
  validateMetricRegistry,
  validateMetricRegistryAgainstReference,
} from '../../src/metric-registry.js';

const ANALYSIS_RELEASE_ID = 'ar-metric-registry-test';
const BASE_TIME = new Date('2026-08-24T12:00:00Z').getTime();

async function createExecutor(): Promise<WasmSqliteExecutor> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  return executor;
}

async function seedAnalysisRelease(executor: WasmSqliteExecutor): Promise<void> {
  await executor.exec(
    `INSERT INTO analysis_releases
     (id, ontology_version, metric_registry_version, statistical_policy_version,
      rollup_policy_version, mapping_version, created_at, is_default)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [ANALYSIS_RELEASE_ID, '0.1.0', '0.1.0', '0.1.0', '0.1.0', '0.1.0', BASE_TIME, 0],
  );
}

async function createStatisticalPolicy(executor: WasmSqliteExecutor, suffix = ''): Promise<string> {
  return addStatisticalPolicy(executor, {
    policyId: `sp-test${suffix}`,
    version: 1,
    name: 'Default statistical policy',
    observationUnit: 'session',
    eligibility: 'all',
    microWeighting: 'none',
    macroWeighting: 'none',
    percentileAlgorithm: 'nearest-rank',
    percentileMinimumN: 1,
    ratioPolicy: 'pairwise',
    censoring: 'none',
    outlierPolicy: 'iqr:1.5',
    uncertainty: 'none',
    timezone: 'UTC',
    dayBoundary: '00:00:00',
    matching: 'none',
    coverage: 'all-known',
    insightSuppression: 'small-cohort',
  });
}

async function createAttributionPolicy(executor: WasmSqliteExecutor, suffix = ''): Promise<string> {
  return addAttributionPolicy(executor, {
    policyId: `ap-test${suffix}`,
    version: 1,
    name: 'Default attribution policy',
    windowBoundaries: 'session',
    overlapHandling: 'prorate',
    allocation: 'direct',
  });
}

async function createRollupPolicy(executor: WasmSqliteExecutor, suffix = ''): Promise<string> {
  return addRollupPolicy(executor, {
    policyId: `rp-test${suffix}`,
    version: 1,
    name: 'Default rollup policy',
    supportedDimensions: JSON.stringify(['model', 'harness']),
    cardinalityCaps: JSON.stringify({ model: 4, harness: 4 }),
    topNBehavior: 'cap',
    otherBucketLabel: 'Other',
    unknownBucketLabel: 'Unknown',
    bucketTimezone: 'UTC',
    analysisReleaseId: ANALYSIS_RELEASE_ID,
  });
}

function baseMetricDefinition(
  statisticalPolicyId: string,
  overrides: Partial<InsertMetricDefinitionInput> = {},
): InsertMetricDefinitionInput {
  return {
    metricId: 'test:metric',
    version: 1,
    label: 'Test metric',
    description: 'A test metric definition.',
    family: 'test',
    measurementClass: 'observed',
    unit: 'count',
    valueType: 'integer',
    grain: 'session',
    dimensions: [],
    populationRule: 'all',
    statusRule: 'none',
    aggregation: 'sum',
    statisticalPolicyId,
    comparabilityGroupInputs: [],
    missingDataBehavior: 'unknown',
    rootInclusion: 'root_only',
    provenanceRequirement: 'test-evidence',
    ...overrides,
  };
}

async function createMetricDefinition(
  executor: WasmSqliteExecutor,
  statisticalPolicyId: string,
  overrides: Partial<InsertMetricDefinitionInput> = {},
): Promise<string> {
  const result = await addMetricDefinition(
    executor,
    baseMetricDefinition(statisticalPolicyId, overrides),
  );
  return result.definition.id;
}

describe('metric registry', () => {
  it('versions a metric when its meaning changes', async () => {
    const executor = await createExecutor();
    await seedAnalysisRelease(executor);
    const statisticalPolicyId = await createStatisticalPolicy(executor);

    const first = await addMetricDefinition(
      executor,
      baseMetricDefinition(statisticalPolicyId, { metricId: 'test:versioning', version: 1 }),
    );
    expect(first.definition.version).toBe(1);
    expect(first.comparabilityGroupId).toMatch(/^cg-/);

    await expect(
      addMetricDefinition(
        executor,
        baseMetricDefinition(statisticalPolicyId, { metricId: 'test:versioning', version: 2 }),
      ),
    ).rejects.toThrow('meaning is unchanged');

    const second = await addMetricDefinition(
      executor,
      baseMetricDefinition(statisticalPolicyId, {
        metricId: 'test:versioning',
        version: 2,
        aggregation: 'count',
      }),
    );
    expect(second.definition.version).toBe(2);
    expect(second.comparabilityGroupId).not.toBe(first.comparabilityGroupId);

    await expect(
      addMetricDefinition(
        executor,
        baseMetricDefinition(statisticalPolicyId, { metricId: 'test:versioning', version: 1 }),
      ),
    ).rejects.toThrow('already exists');

    await expect(
      addMetricDefinition(
        executor,
        baseMetricDefinition(statisticalPolicyId, {
          metricId: 'test:versioning',
          version: 0,
        }),
      ),
    ).rejects.toThrow('version must be greater than 0');
  });

  it('updates metric documentation without creating a new version', async () => {
    const executor = await createExecutor();
    await seedAnalysisRelease(executor);
    const statisticalPolicyId = await createStatisticalPolicy(executor);

    const { definition } = await addMetricDefinition(
      executor,
      baseMetricDefinition(statisticalPolicyId, { metricId: 'test:documentation' }),
    );
    const updated = await updateMetricDocumentation(
      executor,
      definition.id,
      'Updated label',
      'Updated description.',
    );
    expect(updated.label).toBe('Updated label');
    expect(updated.description).toBe('Updated description.');
    expect(updated.version).toBe(definition.version);
  });

  it('derives deterministic comparability group ids from the comparability property set', async () => {
    const executor = await createExecutor();
    await seedAnalysisRelease(executor);
    const statisticalPolicyId = await createStatisticalPolicy(executor);

    const inputA = baseMetricDefinition(statisticalPolicyId, {
      metricId: 'test:comparability-a',
      valueType: 'integer',
    });
    const inputB = baseMetricDefinition(statisticalPolicyId, {
      metricId: 'test:comparability-a',
      valueType: 'real',
    });

    const groupA = deriveComparabilityGroupIdForDefinition(inputA);
    const groupB = deriveComparabilityGroupIdForDefinition(inputB);
    expect(groupA).toMatch(/^cg-/);
    expect(groupB).toMatch(/^cg-/);
    expect(groupA).not.toBe(groupB);

    const storedA = await addMetricDefinition(executor, inputA);
    expect(storedA.comparabilityGroupId).toBe(groupA);

    const storedB = await addMetricDefinition(executor, {
      ...inputA,
      metricId: 'test:comparability-a',
      version: 2,
      aggregation: 'count',
    });
    expect(storedB.comparabilityGroupId).not.toBe(groupA);
  });

  it('prevents mixed comparability groups', async () => {
    const executor = await createExecutor();
    await seedAnalysisRelease(executor);
    const statisticalPolicyId = await createStatisticalPolicy(executor);

    const a = await addMetricDefinition(
      executor,
      baseMetricDefinition(statisticalPolicyId, { metricId: 'test:mixed-a' }),
    );
    const b = await addMetricDefinition(
      executor,
      baseMetricDefinition(statisticalPolicyId, { metricId: 'test:mixed-b' }),
    );

    await executor.exec('UPDATE metric_definitions SET comparability_group_id = ? WHERE id = ?', [
      a.comparabilityGroupId,
      b.definition.id,
    ]);

    const validation = await validateMetricRegistry(executor);
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((i) => i.code === 'mixed_comparability_group')).toBe(true);
  });

  it('validates policies are versioned and complete', async () => {
    const executor = await createExecutor();
    await seedAnalysisRelease(executor);

    const statisticalId = await createStatisticalPolicy(executor);
    await expect(
      addStatisticalPolicy(executor, {
        policyId: 'sp-test',
        version: 1,
        name: 'Duplicate',
        observationUnit: 'session',
        eligibility: 'all',
        microWeighting: 'none',
        macroWeighting: 'none',
        percentileAlgorithm: 'nearest-rank',
        percentileMinimumN: 1,
        ratioPolicy: 'pairwise',
        censoring: 'none',
        outlierPolicy: 'iqr:1.5',
        uncertainty: 'none',
        timezone: 'UTC',
        dayBoundary: '00:00:00',
        matching: 'none',
        coverage: 'all-known',
        insightSuppression: 'small-cohort',
      }),
    ).rejects.toThrow('already exists');

    const attributionId = await createAttributionPolicy(executor);
    await expect(
      addAttributionPolicy(executor, {
        policyId: 'ap-test',
        version: 1,
        name: 'Duplicate attribution',
        windowBoundaries: 'session',
        overlapHandling: 'prorate',
        allocation: 'direct',
      }),
    ).rejects.toThrow('already exists');

    const rollupId = await createRollupPolicy(executor);
    await expect(
      addRollupPolicy(executor, {
        policyId: 'rp-test',
        version: 1,
        name: 'Duplicate rollup',
        supportedDimensions: JSON.stringify(['model']),
        cardinalityCaps: JSON.stringify({ model: 4 }),
        topNBehavior: 'cap',
        otherBucketLabel: 'Other',
        unknownBucketLabel: 'Unknown',
        bucketTimezone: 'UTC',
        analysisReleaseId: ANALYSIS_RELEASE_ID,
      }),
    ).rejects.toThrow('already exists');

    const validation = await validateMetricRegistry(executor);
    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);

    const metricId = await createMetricDefinition(executor, statisticalId, {
      attributionPolicyId: attributionId,
      allocationMethod: 'direct',
    });
    const metricValidation = await validateMetricRegistry(executor);
    expect(metricValidation.valid).toBe(true);
    expect(metricId).toMatch(/^md-/);

    const percentileDefinitionId = await createMetricDefinition(executor, statisticalId, {
      metricId: 'test:percentile',
      aggregation: 'percentile',
      valueType: 'real',
      distributionPolicy: rollupId,
    });
    const matrix = await getMetricReleaseMatrix(executor);
    const percentileRow = matrix.find((r) => r.metricId === 'test:percentile');
    expect(percentileRow).toBeDefined();
    expect(percentileRow?.rollupPolicyId).toBe(rollupId);
    expect(percentileDefinitionId).toMatch(/^md-/);
  });

  it('produces a release matrix for every phase 1-3 metric', async () => {
    const executor = await createExecutor();
    await seedAnalysisRelease(executor);
    const statisticalPolicyId = await createStatisticalPolicy(executor);
    const rollupPolicyId = await createRollupPolicy(executor);

    await createMetricDefinition(executor, statisticalPolicyId, {
      metricId: 'test:observed',
      family: 'tokens',
      measurementClass: 'observed',
      aggregation: 'sum',
      provenanceRequirement: 'model_usage event',
    });
    await createMetricDefinition(executor, statisticalPolicyId, {
      metricId: 'test:derived',
      family: 'context',
      measurementClass: 'derived',
      aggregation: 'mean',
      valueType: 'real',
      provenanceRequirement: 'context payload events',
    });
    await createMetricDefinition(executor, statisticalPolicyId, {
      metricId: 'test:heuristic',
      family: 'attribution',
      measurementClass: 'heuristic',
      aggregation: 'max',
      provenanceRequirement: 'subagent launch/complete events',
    });
    await createMetricDefinition(executor, statisticalPolicyId, {
      metricId: 'test:percentile',
      family: 'latency',
      measurementClass: 'derived',
      aggregation: 'percentile',
      valueType: 'real',
      distributionPolicy: rollupPolicyId,
      provenanceRequirement: 'invocation start/result timestamps',
    });

    const matrix = await getMetricReleaseMatrix(executor);
    const observed = matrix.find((r) => r.metricId === 'test:observed');
    const derived = matrix.find((r) => r.metricId === 'test:derived');
    const heuristic = matrix.find((r) => r.metricId === 'test:heuristic');
    const percentile = matrix.find((r) => r.metricId === 'test:percentile');

    expect(observed?.releaseReadiness).toBe('ready');
    expect(observed?.additive).toBe(true);
    expect(observed?.phase).toBe('phase1');
    expect(observed?.requiredEvidence).toContain('model_usage event');

    expect(derived?.releaseReadiness).toBe('partial');
    expect(derived?.additive).toBe(false);
    expect(derived?.phase).toBe('phase2');

    expect(heuristic?.releaseReadiness).toBe('blocked');
    expect(heuristic?.phase).toBe('phase3');

    expect(percentile?.releaseReadiness).toBe('partial');
    expect(percentile?.rollupPolicyId).toBe(rollupPolicyId);

    const planned = matrix.filter((r) => r.metricId.startsWith('insight:'));
    expect(planned.length).toBeGreaterThan(0);

    const withoutRecipes = await getMetricReleaseMatrix(executor, { includePlannedRecipes: false });
    expect(withoutRecipes.some((r) => r.metricId.startsWith('insight:'))).toBe(false);
  });

  it('validates the registry against a generated reference', async () => {
    const executor = await createExecutor();
    await seedAnalysisRelease(executor);
    const statisticalPolicyId = await createStatisticalPolicy(executor);

    const { definition } = await addMetricDefinition(
      executor,
      baseMetricDefinition(statisticalPolicyId, { metricId: 'test:reference' }),
    );

    const reference = generateMetricRegistryReference([definition]);
    const match = await validateMetricRegistryAgainstReference(executor, reference.definitions);
    expect(match.valid).toBe(true);

    const extra = await createMetricDefinition(executor, statisticalPolicyId, {
      metricId: 'test:extra',
    });
    const extraValidation = await validateMetricRegistryAgainstReference(
      executor,
      reference.definitions,
    );
    expect(extraValidation.valid).toBe(false);
    expect(
      extraValidation.issues.some(
        (i) => i.code === 'registry_extra_definition' && i.message.includes('test:extra'),
      ),
    ).toBe(true);

    await updateMetricDocumentation(executor, definition.id, 'Changed', 'Changed description.');
    const drift = await validateMetricRegistryAgainstReference(executor, reference.definitions);
    expect(drift.valid).toBe(false);
    expect(drift.issues.some((i) => i.code === 'reference_checksum_mismatch')).toBe(true);

    expect(extra).toMatch(/^md-/);
  });

  it('stratifies portfolio headlines by comparability group', async () => {
    const metrics = [
      {
        metricId: 'test:a',
        metricVersion: '1',
        comparabilityGroupId: 'cg-a',
        value: 10,
        unit: 'count',
        label: 'A',
      },
      {
        metricId: 'test:a',
        metricVersion: '1',
        comparabilityGroupId: 'cg-a',
        value: 20,
        unit: 'count',
        label: 'A duplicate',
      },
      {
        metricId: 'test:b',
        metricVersion: '2',
        comparabilityGroupId: 'cg-b',
        value: 30,
        unit: 'ms',
        label: 'B',
      },
    ];

    const strata = getDefaultPortfolioHeadlineStrata(metrics);
    expect(strata).toHaveLength(2);
    expect(strata[0]?.metricId).toBe('test:a');
    expect(strata[1]?.metricId).toBe('test:b');
  });
});
