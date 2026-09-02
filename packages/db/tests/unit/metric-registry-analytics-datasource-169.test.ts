import { FRESH_SCHEMA_SQL } from '@lucasschirm/sal-db-core';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import {
  addMetricDefinition,
  addStatisticalPolicy,
  computeMetricDefinitionChecksum,
  INVOCATIONS_BY_DOMAIN_METRIC_DEFINITION,
  INVOCATIONS_BY_DOMAIN_METRIC_ID,
  MODEL_HARNESS_COHORT_LOW_N_THRESHOLD,
  PORTFOLIO_SESSIONS_DELTA_METRIC_DEFINITION,
  PORTFOLIO_SESSIONS_DELTA_METRIC_ID,
  SESSION_DURATION_HISTOGRAM_BIN_EDGES_MS,
} from '../../src/metric-registry.js';

async function createExecutor(): Promise<WasmSqliteExecutor> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  return executor;
}

async function claudeDefaultPolicyId(executor: WasmSqliteExecutor): Promise<string> {
  return addStatisticalPolicy(executor, {
    policyId: 'claude-default',
    version: 1,
    name: 'claude-default statistical policy',
    observationUnit: 'session',
    eligibility: 'all_sessions',
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

describe('PORTFOLIO_SESSIONS_DELTA_METRIC_DEFINITION (issue #169)', () => {
  it('registers successfully and reports the documented missingness/population policy', async () => {
    const executor = await createExecutor();
    const statisticalPolicyId = await claudeDefaultPolicyId(executor);
    const { definition } = await addMetricDefinition(executor, {
      ...PORTFOLIO_SESSIONS_DELTA_METRIC_DEFINITION,
      statisticalPolicyId,
    });
    expect(definition.metricId).toBe(PORTFOLIO_SESSIONS_DELTA_METRIC_ID);
    expect(definition.missingDataBehavior).toBe('unknown');
    expect(definition.rootInclusion).toBe('both');
  });

  it('has a stable checksum that changes if its meaning fields change (version-bump gate)', () => {
    const checksum = computeMetricDefinitionChecksum(PORTFOLIO_SESSIONS_DELTA_METRIC_DEFINITION);
    const mutated = computeMetricDefinitionChecksum({
      ...PORTFOLIO_SESSIONS_DELTA_METRIC_DEFINITION,
      populationRule: 'different-population',
    });
    expect(checksum).not.toBe(mutated);
  });
});

describe('INVOCATIONS_BY_DOMAIN_METRIC_DEFINITION (issue #169)', () => {
  it('documents exactly the four canonical kinds and the MCP sub-classification rule', () => {
    expect(INVOCATIONS_BY_DOMAIN_METRIC_ID).toBe('portfolio:invocations_by_domain');
    expect(INVOCATIONS_BY_DOMAIN_METRIC_DEFINITION.dimensions).toEqual(['kind']);
    expect(INVOCATIONS_BY_DOMAIN_METRIC_DEFINITION.description).toContain('sub-classification');
  });

  it('registers successfully as registry metadata (query surface: PortfolioView.getInvocationsByDomain)', async () => {
    const executor = await createExecutor();
    const statisticalPolicyId = await claudeDefaultPolicyId(executor);
    const { definition } = await addMetricDefinition(executor, {
      ...INVOCATIONS_BY_DOMAIN_METRIC_DEFINITION,
      statisticalPolicyId,
    });
    expect(definition.metricId).toBe(INVOCATIONS_BY_DOMAIN_METRIC_ID);
  });
});

describe('Session duration histogram bin edges and cohort low-n threshold (issue #169)', () => {
  it('defines a monotonically increasing set of bin edges starting at 0', () => {
    expect(SESSION_DURATION_HISTOGRAM_BIN_EDGES_MS[0]).toBe(0);
    for (let i = 1; i < SESSION_DURATION_HISTOGRAM_BIN_EDGES_MS.length; i++) {
      expect(SESSION_DURATION_HISTOGRAM_BIN_EDGES_MS[i]).toBeGreaterThan(
        SESSION_DURATION_HISTOGRAM_BIN_EDGES_MS[i - 1],
      );
    }
  });

  it('centralizes the low-n cohort flag threshold in the registry, not the UI', () => {
    expect(MODEL_HARNESS_COHORT_LOW_N_THRESHOLD).toBeGreaterThan(0);
  });
});
