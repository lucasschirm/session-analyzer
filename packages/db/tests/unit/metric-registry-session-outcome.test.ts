import { FRESH_SCHEMA_SQL } from '@lucasschirm/sal-db-core';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import {
  addMetricDefinition,
  addStatisticalPolicy,
  deriveComparabilityGroupIdForDefinition,
  SESSION_OUTCOME_METRIC_DEFINITION,
  SESSION_OUTCOME_METRIC_ID,
  SESSION_OUTCOME_METRIC_VERSION,
} from '../../src/metric-registry.js';

/**
 * Proves `SESSION_OUTCOME_METRIC_DEFINITION` (issue #178) is coherent,
 * resolvable registry metadata — not dead code — even though it is
 * deliberately not auto-inserted by `DefaultIngestionOrchestrator` (outcome
 * is stored on the `sessions.outcome` column, not emitted as a
 * `TransformResult.metricValues[]` entry; see the doc comment on the
 * constant in `packages/db/src/metric-registry.ts`).
 */

async function createExecutor(): Promise<WasmSqliteExecutor> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  return executor;
}

describe('SESSION_OUTCOME_METRIC_DEFINITION', () => {
  it('registers successfully once its symbolic statisticalPolicyId is resolved', async () => {
    const executor = await createExecutor();

    // Same resolution DefaultIngestionOrchestrator.ensureStatisticalPolicyFor
    // performs for the symbolic 'claude-default' policy id used by
    // transformer-emitted metric definitions.
    const statisticalPolicyId = await addStatisticalPolicy(executor, {
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

    const { definition, comparabilityGroupId } = await addMetricDefinition(executor, {
      ...SESSION_OUTCOME_METRIC_DEFINITION,
      statisticalPolicyId,
    });

    expect(definition.metricId).toBe(SESSION_OUTCOME_METRIC_ID);
    expect(definition.version).toBe(SESSION_OUTCOME_METRIC_VERSION);
    expect(definition.missingDataBehavior).toBe('unknown');
    expect(definition.populationRule).toBe("finality = 'final'");
    expect(definition.rootInclusion).toBe('root_only');
    expect(comparabilityGroupId).toBe(definition.comparabilityGroupId);
    expect(comparabilityGroupId).toBe(
      deriveComparabilityGroupIdForDefinition({
        ...SESSION_OUTCOME_METRIC_DEFINITION,
        statisticalPolicyId,
      }),
    );
  });
});
