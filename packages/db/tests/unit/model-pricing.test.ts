import {
  AttributionPolicyStore,
  FRESH_SCHEMA_SQL,
  IngestionSourceStore,
  InvocationStore,
  PayloadStore,
  PortfolioStore,
  PricingVersionStore,
  ProjectStore,
  RollupPolicyStore,
  SessionStore,
  TenantStore,
} from '@lucasschirm/sal-db-core';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import {
  addAttributionPolicy,
  addRollupPolicy,
  addStatisticalPolicy,
} from '../../src/metric-registry.js';
import {
  addInvocationPayloadAttribution,
  addModelCapability,
  addPricingVersion,
  applyAttributionPolicy,
  computeCostForUsage,
  findPricingVersionEffectiveAt,
  type InvocationWindow,
  registerAttributionPolicy,
  validatePolicyRegistries,
} from '../../src/model-pricing.js';

const TENANT_ID = 'tenant-model-pricing';
const PORTFOLIO_ID = 'portfolio-model-pricing';
const SOURCE_ID = 'source-model-pricing';
const ENVIRONMENT_ID = 'environment-model-pricing';
const PROJECT_ID = 'project-model-pricing';
const ANALYSIS_RELEASE_ID = 'ar-model-pricing';
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

async function createSession(
  executor: WasmSqliteExecutor,
  sessionId: string,
  nativeSessionId: string,
): Promise<void> {
  await SessionStore.insert(executor, {
    id: sessionId,
    projectId: PROJECT_ID,
    ingestionSourceId: SOURCE_ID,
    nativeSessionId,
    harness: 'claude-code',
    occurrenceTime: BASE_TIME,
    model: 'claude-sonnet',
    mode: 'auto',
    taskCohort: 'feature',
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

async function createInvocation(
  executor: WasmSqliteExecutor,
  sessionId: string,
  generationId: string,
  invocationId: string,
  startId: string,
): Promise<void> {
  await InvocationStore.insert(executor, {
    id: invocationId,
    sessionId,
    generationId,
    kind: 'tool',
    rootSessionId: sessionId,
    startId,
    status: 'completed',
  });
}

async function createPayload(
  executor: WasmSqliteExecutor,
  sessionId: string,
  generationId: string,
  payloadId: string,
  payloadType: 'input' | 'result' | 'context',
  overrides?: { exactTokens?: number; estimatedTokens?: number },
): Promise<void> {
  await PayloadStore.insert(executor, {
    id: payloadId,
    sessionId,
    generationId,
    payloadType,
    exactTokens: overrides?.exactTokens ?? null,
    estimatedTokens: overrides?.estimatedTokens ?? null,
  });
}

async function seedPolicyRegistries(executor: WasmSqliteExecutor): Promise<void> {
  await addStatisticalPolicy(executor, {
    policyId: 'sp-model-pricing',
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
  await addAttributionPolicy(executor, {
    policyId: 'ap-model-pricing',
    version: 1,
    name: 'Default attribution policy',
    windowBoundaries: 'session',
    overlapHandling: 'prorate',
    allocation: 'proportional',
  });
  await addRollupPolicy(executor, {
    policyId: 'rp-model-pricing',
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

describe('model/pricing registries', () => {
  it('versions model capabilities with provider metadata', async () => {
    const executor = await createExecutor();
    await seedIdentity(executor);

    const first = await addModelCapability(executor, {
      model: 'claude-sonnet',
      provider: 'anthropic',
      version: '2025-01',
      contextLimitTokens: 200_000,
      maxOutputTokens: 8192,
      providerMetadata: JSON.stringify({ apiFamily: 'messages' }),
    });
    expect(first.model).toBe('claude-sonnet');
    expect(first.provider).toBe('anthropic');
    expect(first.version).toBe('2025-01');
    expect(first.contextLimitTokens).toBe(200_000);

    const second = await addModelCapability(executor, {
      model: 'claude-sonnet',
      provider: 'anthropic',
      version: '2025-02',
      contextLimitTokens: 250_000,
      maxOutputTokens: 16_384,
      providerMetadata: JSON.stringify({ apiFamily: 'messages' }),
    });
    expect(second.version).toBe('2025-02');

    await expect(
      addModelCapability(executor, {
        model: 'claude-sonnet',
        provider: 'anthropic',
        version: '2025-02',
        contextLimitTokens: 250_000,
        maxOutputTokens: 16_384,
      }),
    ).rejects.toThrow('already exists');

    await expect(
      addModelCapability(executor, {
        model: '',
        provider: 'anthropic',
        version: '2025-03',
        contextLimitTokens: 100_000,
      }),
    ).rejects.toThrow('model is required');
  });

  it('versions pricing versions by effective date', async () => {
    const executor = await createExecutor();
    await seedIdentity(executor);

    const first = await addPricingVersion(executor, {
      provider: 'anthropic',
      model: 'claude-sonnet',
      currency: 'USD',
      effectiveDate: '2026-08-01',
      inputPricePerToken: 0.01,
      outputPricePerToken: 0.03,
      cacheCreationPricePerToken: 0.001,
      cacheReadPricePerToken: 0.0005,
    });
    expect(first.effectiveDate).toBe('2026-08-01');
    expect(first.inputPricePerToken).toBe(0.01);

    const second = await addPricingVersion(executor, {
      provider: 'anthropic',
      model: 'claude-sonnet',
      currency: 'USD',
      effectiveDate: '2026-08-20',
      inputPricePerToken: 0.015,
      outputPricePerToken: 0.035,
      cacheCreationPricePerToken: 0.0015,
      cacheReadPricePerToken: 0.0008,
    });
    expect(second.effectiveDate).toBe('2026-08-20');

    await expect(
      addPricingVersion(executor, {
        provider: 'anthropic',
        model: 'claude-sonnet',
        currency: 'USD',
        effectiveDate: '2026-08-01',
        inputPricePerToken: 0.02,
      }),
    ).rejects.toThrow('already exists');

    const found = await findPricingVersionEffectiveAt(
      executor,
      'anthropic',
      'claude-sonnet',
      'USD',
      '2026-08-15',
    );
    expect(found?.id).toBe(first.id);

    const foundLater = await findPricingVersionEffectiveAt(
      executor,
      'anthropic',
      'claude-sonnet',
      'USD',
      '2026-08-25',
    );
    expect(foundLater?.id).toBe(second.id);

    const missing = await findPricingVersionEffectiveAt(
      executor,
      'anthropic',
      'claude-sonnet',
      'USD',
      '2026-07-15',
    );
    expect(missing).toBeUndefined();
  });
});

describe('attribution policies', () => {
  it('applies window boundaries and allocation', async () => {
    const executor = await createExecutor();
    await seedIdentity(executor);

    const policy = await registerAttributionPolicy(executor, {
      policyId: 'ap-apply',
      version: 1,
      name: 'Apply attribution',
      windowBoundaries: 'session',
      overlapHandling: 'prorate',
      allocation: 'proportional',
      confidence: 'exact',
      additive: false,
    });
    expect(policy.overlapHandling).toBe('prorate');
    expect(policy.confidence).toBe('exact');

    const windows: InvocationWindow[] = [
      {
        invocationId: 'inv-1',
        sessionId: 'se-1',
        generationId: 'gen-1',
        startTime: BASE_TIME,
        endTime: BASE_TIME + 100,
        payloads: [
          {
            payloadId: 'pay-input',
            isInput: true,
            isResult: false,
            isContext: false,
            exactTokens: 100,
            estimatedTokens: 0,
          },
          {
            payloadId: 'pay-result',
            isInput: false,
            isResult: true,
            isContext: false,
            exactTokens: 50,
            estimatedTokens: 0,
          },
        ],
      },
    ];

    const allocations = applyAttributionPolicy(policy, windows);
    expect(allocations).toHaveLength(2);

    const inputShare = allocations.find((a) => a.payloadId === 'pay-input')?.attributionShare ?? 0;
    const resultShare =
      allocations.find((a) => a.payloadId === 'pay-result')?.attributionShare ?? 0;
    expect(inputShare).toBeCloseTo(100 / 150, 6);
    expect(resultShare).toBeCloseTo(50 / 150, 6);
    expect(inputShare + resultShare).toBeCloseTo(1, 6);

    const inputAllocation = allocations.find((a) => a.payloadId === 'pay-input');
    expect(inputAllocation?.attributionType).toBe('exact');
    expect(inputAllocation?.isInput).toBe(true);
  });

  it('handles overlapping invocations non-additively', async () => {
    const executor = await createExecutor();
    await seedIdentity(executor);

    const prorate = await registerAttributionPolicy(executor, {
      policyId: 'ap-overlap-prorate',
      version: 1,
      name: 'Prorate overlap',
      windowBoundaries: 'session',
      overlapHandling: 'prorate',
      allocation: 'proportional',
      additive: false,
    });

    const windows: InvocationWindow[] = [
      {
        invocationId: 'inv-a',
        sessionId: 'se-1',
        generationId: 'gen-1',
        startTime: BASE_TIME,
        endTime: BASE_TIME + 100,
        payloads: [
          {
            payloadId: 'pay-a',
            isInput: true,
            isResult: false,
            isContext: false,
            exactTokens: 100,
            estimatedTokens: 0,
          },
        ],
      },
      {
        invocationId: 'inv-b',
        sessionId: 'se-1',
        generationId: 'gen-1',
        startTime: BASE_TIME + 50,
        endTime: BASE_TIME + 90,
        payloads: [
          {
            payloadId: 'pay-b',
            isInput: true,
            isResult: false,
            isContext: false,
            exactTokens: 50,
            estimatedTokens: 0,
          },
        ],
      },
    ];

    const allocations = applyAttributionPolicy(prorate, windows);
    const shareA = allocations.find((a) => a.payloadId === 'pay-a')?.attributionShare ?? 0;
    const shareB = allocations.find((a) => a.payloadId === 'pay-b')?.attributionShare ?? 0;
    expect(shareA + shareB).toBeCloseTo(1, 6);
    expect(shareA).toBeGreaterThan(shareB);

    const firstWins = await registerAttributionPolicy(executor, {
      policyId: 'ap-overlap-first',
      version: 1,
      name: 'First wins',
      windowBoundaries: 'session',
      overlapHandling: 'first-wins',
      allocation: 'proportional',
      additive: false,
    });
    const firstAllocations = applyAttributionPolicy(firstWins, windows);
    const firstShareA =
      firstAllocations.find((a) => a.payloadId === 'pay-a')?.attributionShare ?? 0;
    const firstShareB =
      firstAllocations.find((a) => a.payloadId === 'pay-b')?.attributionShare ?? 0;
    expect(firstShareA).toBe(1);
    expect(firstShareB).toBe(0);

    const partitioned = await registerAttributionPolicy(executor, {
      policyId: 'ap-overlap-partitioned',
      version: 1,
      name: 'Partitioned',
      windowBoundaries: 'session',
      overlapHandling: 'partitioned',
      allocation: 'proportional',
      additive: false,
    });
    const partitionedAllocations = applyAttributionPolicy(partitioned, windows);
    const partitionedA =
      partitionedAllocations.find((a) => a.payloadId === 'pay-a')?.attributionShare ?? 0;
    const partitionedB =
      partitionedAllocations.find((a) => a.payloadId === 'pay-b')?.attributionShare ?? 0;
    expect(partitionedA).toBe(1);
    expect(partitionedB).toBe(1);
  });
});

describe('cost computation', () => {
  it('uses the pricing version effective at request time', async () => {
    const executor = await createExecutor();
    await seedIdentity(executor);

    await addPricingVersion(executor, {
      provider: 'anthropic',
      model: 'claude-sonnet',
      currency: 'USD',
      effectiveDate: '2026-08-01',
      inputPricePerToken: 0.01,
      outputPricePerToken: 0.03,
    });
    await addPricingVersion(executor, {
      provider: 'anthropic',
      model: 'claude-sonnet',
      currency: 'USD',
      effectiveDate: '2026-08-20',
      inputPricePerToken: 0.015,
      outputPricePerToken: 0.035,
    });

    const pricing = await findPricingVersionEffectiveAt(
      executor,
      'anthropic',
      'claude-sonnet',
      'USD',
      '2026-08-25',
    );
    expect(pricing).toBeDefined();
    if (!pricing) {
      throw new Error('Pricing version not found');
    }

    const cost = computeCostForUsage(pricing, [
      { tokenClass: 'input', exactTokens: 1000, estimatedTokens: 0 },
      { tokenClass: 'output', exactTokens: 200, estimatedTokens: 0 },
    ]);

    expect(cost.currency).toBe('USD');
    expect(cost.exactCost).toBeCloseTo(1000 * 0.015 + 200 * 0.035, 6);
    expect(cost.totalCost).toBe(cost.exactCost);
  });

  it('never combines exact and estimated token values silently', async () => {
    const executor = await createExecutor();
    await seedIdentity(executor);

    const pricing = await addPricingVersion(executor, {
      provider: 'anthropic',
      model: 'claude-sonnet',
      currency: 'USD',
      effectiveDate: '2026-08-01',
      inputPricePerToken: 0.01,
      outputPricePerToken: 0.03,
      cacheCreationPricePerToken: 0.001,
      cacheReadPricePerToken: 0.0005,
    });

    const cost = computeCostForUsage(pricing, [
      { tokenClass: 'input', exactTokens: 1000, estimatedTokens: 500 },
      { tokenClass: 'output', exactTokens: 200, estimatedTokens: 100 },
      { tokenClass: 'cache_read', exactTokens: 300, estimatedTokens: 0 },
      { tokenClass: 'total', exactTokens: 1600, estimatedTokens: 600 },
    ]);

    const input = cost.byTokenClass.find((c) => c.tokenClass === 'input');
    const output = cost.byTokenClass.find((c) => c.tokenClass === 'output');
    const cacheRead = cost.byTokenClass.find((c) => c.tokenClass === 'cache_read');
    const total = cost.byTokenClass.find((c) => c.tokenClass === 'total');

    expect(input?.exactCost).toBe(1000 * 0.01);
    expect(input?.estimatedCost).toBe(500 * 0.01);
    expect(input?.isAvailable).toBe(true);

    expect(output?.exactCost).toBe(200 * 0.03);
    expect(output?.estimatedCost).toBe(100 * 0.03);

    expect(cacheRead?.exactCost).toBe(300 * 0.0005);
    expect(cacheRead?.estimatedCost).toBe(0);
    expect(cacheRead?.isAvailable).toBe(true);

    expect(total?.isAvailable).toBe(false);
    expect(total?.exactCost).toBe(0);
    expect(total?.estimatedCost).toBe(0);

    expect(cost.exactCost).toBeCloseTo(1000 * 0.01 + 200 * 0.03 + 300 * 0.0005, 6);
    expect(cost.estimatedCost).toBeCloseTo(500 * 0.01 + 100 * 0.03, 6);
    expect(cost.totalCost).toBeCloseTo(cost.exactCost + cost.estimatedCost, 6);
  });
});

describe('invocation payload attribution', () => {
  it('correlates input/result/context payloads with non-additive metadata', async () => {
    const executor = await createExecutor();
    await seedIdentity(executor);

    const sessionId = 'se-payload';
    const generationId = 'gen-payload';
    const invocationId = 'inv-payload';
    const inputPayloadId = 'pay-input';
    const resultPayloadId = 'pay-result';
    const contextPayloadId = 'pay-context';

    await createSession(executor, sessionId, 'native-payload');
    await createGeneration(executor, sessionId, generationId);
    await createInvocation(executor, sessionId, generationId, invocationId, 'start-1');
    await createPayload(executor, sessionId, generationId, inputPayloadId, 'input', {
      exactTokens: 100,
    });
    await createPayload(executor, sessionId, generationId, resultPayloadId, 'result', {
      exactTokens: 50,
    });
    await createPayload(executor, sessionId, generationId, contextPayloadId, 'context', {
      exactTokens: 200,
    });

    const inputAttribution = await addInvocationPayloadAttribution(executor, {
      invocationId,
      payloadId: inputPayloadId,
      sessionId,
      generationId,
      attributionType: 'exact',
      isInput: true,
      isResult: false,
      isContext: false,
      attributionShare: 0.5,
    });
    expect(inputAttribution.isInput).toBe(true);
    expect(inputAttribution.attributionShare).toBe(0.5);

    const resultAttribution = await addInvocationPayloadAttribution(executor, {
      invocationId,
      payloadId: resultPayloadId,
      sessionId,
      generationId,
      attributionType: 'exact',
      isInput: false,
      isResult: true,
      isContext: false,
      attributionShare: 0.5,
    });
    expect(resultAttribution.isResult).toBe(true);

    const contextAttribution = await addInvocationPayloadAttribution(executor, {
      invocationId,
      payloadId: contextPayloadId,
      sessionId,
      generationId,
      attributionType: 'exact',
      isInput: false,
      isResult: false,
      isContext: true,
      attributionShare: 0,
    });
    expect(contextAttribution.isContext).toBe(true);

    await expect(
      addInvocationPayloadAttribution(executor, {
        invocationId,
        payloadId: inputPayloadId,
        sessionId,
        generationId,
        attributionType: 'exact',
        isInput: true,
        isResult: false,
        isContext: false,
        attributionShare: 0.5,
      }),
    ).rejects.toThrow('already exists');

    const all = await executor.exec('SELECT * FROM invocation_payloads WHERE invocation_id = ?', [
      invocationId,
    ]);
    expect(all.rows).toHaveLength(3);
  });
});

describe('CI gates', () => {
  it('verifies statistical/attribution/rollup policies are versioned and complete', async () => {
    const executor = await createExecutor();
    await seedIdentity(executor);
    await seedPolicyRegistries(executor);

    await addModelCapability(executor, {
      model: 'claude-sonnet',
      provider: 'anthropic',
      version: '2025-01',
      contextLimitTokens: 200_000,
    });
    await addPricingVersion(executor, {
      provider: 'anthropic',
      model: 'claude-sonnet',
      currency: 'USD',
      effectiveDate: '2026-08-01',
      inputPricePerToken: 0.01,
    });

    const valid = await validatePolicyRegistries(executor);
    expect(valid.valid).toBe(true);
    expect(valid.issues).toEqual([]);

    await AttributionPolicyStore.insert(executor, {
      policyId: 'ap-incomplete',
      version: 1,
      name: 'Incomplete',
      windowBoundaries: 'session',
      overlapHandling: 'unknown',
      allocation: 'proportional',
      additive: false,
    });

    const invalid = await validatePolicyRegistries(executor);
    expect(invalid.valid).toBe(false);
    expect(invalid.issues.some((i) => i.code === 'unknown_overlap_handling')).toBe(true);

    await PricingVersionStore.insert(executor, {
      provider: '',
      model: 'claude-sonnet',
      currency: 'USD',
      effectiveDate: '2026-08-02',
    });

    const incompletePricing = await validatePolicyRegistries(executor);
    expect(incompletePricing.valid).toBe(false);
    expect(incompletePricing.issues.some((i) => i.code === 'incomplete_pricing_version')).toBe(
      true,
    );
  });

  it('rejects unversioned policies', async () => {
    const executor = await createExecutor();
    await seedIdentity(executor);
    await seedPolicyRegistries(executor);

    await RollupPolicyStore.insert(executor, {
      policyId: 'rp-unversioned',
      version: 0,
      name: 'Unversioned',
      supportedDimensions: JSON.stringify(['model']),
      cardinalityCaps: JSON.stringify({}),
      topNBehavior: 'cap',
      otherBucketLabel: 'Other',
      unknownBucketLabel: 'Unknown',
      bucketTimezone: 'UTC',
      analysisReleaseId: ANALYSIS_RELEASE_ID,
    });

    const result = await validatePolicyRegistries(executor);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'unversioned_rollup_policy')).toBe(true);
  });
});
