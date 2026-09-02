import { FRESH_SCHEMA_SQL } from '@lucasschirm/sal-db-core';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import {
  addMetricDefinition,
  addStatisticalPolicy,
  computeMetricDefinitionChecksum,
  PROJECT_DURATION_TURNS_PERCENTILES_METRIC_DEFINITION,
  PROJECT_DURATION_TURNS_PERCENTILES_METRIC_ID,
  PROJECT_MODEL_HARNESS_COHORT_METRIC_DEFINITION,
  PROJECT_MODEL_HARNESS_COHORT_METRIC_ID,
  PROJECT_TOKENS_COST_PER_SESSION_METRIC_DEFINITION,
  PROJECT_TOKENS_COST_PER_SESSION_METRIC_ID,
  PROJECT_TOOL_ERROR_RATE_METRIC_DEFINITION,
  PROJECT_TOOL_ERROR_RATE_METRIC_ID,
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

const DEFINITIONS = [
  [
    PROJECT_DURATION_TURNS_PERCENTILES_METRIC_ID,
    PROJECT_DURATION_TURNS_PERCENTILES_METRIC_DEFINITION,
  ],
  [PROJECT_TOOL_ERROR_RATE_METRIC_ID, PROJECT_TOOL_ERROR_RATE_METRIC_DEFINITION],
  [PROJECT_TOKENS_COST_PER_SESSION_METRIC_ID, PROJECT_TOKENS_COST_PER_SESSION_METRIC_DEFINITION],
  [PROJECT_MODEL_HARNESS_COHORT_METRIC_ID, PROJECT_MODEL_HARNESS_COHORT_METRIC_DEFINITION],
] as const;

describe('Project Behavior metric definitions (issue #169)', () => {
  it.each(DEFINITIONS)(
    '%s registers successfully with the shared missingness policy',
    async (metricId, def) => {
      const executor = await createExecutor();
      const statisticalPolicyId = await claudeDefaultPolicyId(executor);
      const { definition } = await addMetricDefinition(executor, { ...def, statisticalPolicyId });
      expect(definition.metricId).toBe(metricId);
      expect(definition.missingDataBehavior).toBe('unknown');
      expect(definition.version).toBe(1);
    },
  );

  it.each(DEFINITIONS)(
    '%s has a checksum that changes with its population rule (version-bump gate)',
    (_id, def) => {
      const checksum = computeMetricDefinitionChecksum(def);
      const mutated = computeMetricDefinitionChecksum({
        ...def,
        populationRule: 'different-population',
      });
      expect(checksum).not.toBe(mutated);
    },
  );
});

describe('PROJECT_TOOL_ERROR_RATE_METRIC_DEFINITION (issue #169)', () => {
  it('scopes to tool-kind invocations only, per week', () => {
    expect(PROJECT_TOOL_ERROR_RATE_METRIC_DEFINITION.populationRule).toContain("kind = 'tool'");
    expect(PROJECT_TOOL_ERROR_RATE_METRIC_DEFINITION.dimensions).toEqual(['week']);
  });
});

describe('PROJECT_MODEL_HARNESS_COHORT_METRIC_DEFINITION (issue #169)', () => {
  it('documents the low-n flag reusing the shared threshold', () => {
    expect(PROJECT_MODEL_HARNESS_COHORT_METRIC_DEFINITION.description).toContain('clean rate');
    expect(PROJECT_MODEL_HARNESS_COHORT_METRIC_DEFINITION.dimensions).toEqual(['model', 'harness']);
  });
});
