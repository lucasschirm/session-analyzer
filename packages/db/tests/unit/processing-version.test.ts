import { FRESH_SCHEMA_SQL } from '@lucasschirm/sal-db-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import {
  ANALYTICS_PROCESSING_VERSION,
  getStoredProcessingVersion,
  needsRebuild,
  rebuildAnalyticsDerivedData,
  setStoredProcessingVersion,
} from '../../src/processing-version.js';
import * as rollupReconciliation from '../../src/rollup-reconciliation.js';

describe('processing-version', () => {
  let executor: WasmSqliteExecutor;

  beforeEach(async () => {
    executor = await WasmSqliteExecutor.create();
    await executor.exec(FRESH_SCHEMA_SQL);
  });

  it('reports version 0 and needsRebuild true for an uninitialized database', async () => {
    const version = await getStoredProcessingVersion(executor);
    expect(version).toBe(0);

    const rebuild = await needsRebuild(executor);
    expect(rebuild).toBe(true);
  });

  it('updates and persists the stored processing version', async () => {
    await setStoredProcessingVersion(executor, 1);
    expect(await getStoredProcessingVersion(executor)).toBe(1);
    expect(await needsRebuild(executor)).toBe(true);

    // Update existing row
    await setStoredProcessingVersion(executor, ANALYTICS_PROCESSING_VERSION);
    expect(await getStoredProcessingVersion(executor)).toBe(ANALYTICS_PROCESSING_VERSION);
    expect(await needsRebuild(executor)).toBe(false);
  });

  it('rebuilds derived data and sets the current version when sessions table is empty', async () => {
    const progressSpy = vi.fn();
    expect(await needsRebuild(executor)).toBe(true);

    await rebuildAnalyticsDerivedData(executor, progressSpy);

    expect(await getStoredProcessingVersion(executor)).toBe(ANALYTICS_PROCESSING_VERSION);
    expect(await needsRebuild(executor)).toBe(false);
    expect(progressSpy).not.toHaveBeenCalled();
  });

  it('rebuilds derived data and reports progress when sessions exist', async () => {
    const progressSpy = vi.fn();
    const now = Date.now();
    await executor.exec(`
      INSERT INTO tenants (id, name, created_at, updated_at) VALUES ('tenant-1', 'T1', ${now}, ${now});
      INSERT INTO portfolios (id, tenant_id, name, created_at, updated_at) VALUES ('port-1', 'tenant-1', 'P1', ${now}, ${now});
      INSERT INTO ingestion_sources (id, portfolio_id, native_source_id, display_name, type, authority, created_at, updated_at)
        VALUES ('src-1', 'port-1', 'native-1', 'Source 1', 'test', 'local', ${now}, ${now});
      INSERT INTO projects (id, portfolio_id, name, created_at, updated_at) VALUES ('proj-1', 'port-1', 'Proj 1', ${now}, ${now});
      INSERT INTO analysis_releases (id, ontology_version, metric_registry_version, statistical_policy_version, rollup_policy_version, mapping_version, created_at, is_default)
        VALUES ('rel-1', '1.0', '1.0', '1.0', '1.0', '1.0', ${now}, 1);
      INSERT INTO statistical_policies (id, policy_id, version, name, observation_unit, eligibility, created_at, updated_at)
        VALUES ('sp-1', 'sp-default', 1, 'Default', 'session', 'all', ${now}, ${now});
      INSERT INTO metric_definitions (id, metric_id, version, label, description, family, measurement_class, unit, value_type, grain, dimensions, population_rule, status_rule, aggregation, statistical_policy_id, missing_data_behavior, root_inclusion, provenance_requirement, comparability_group_id, created_at, updated_at)
        VALUES ('md-1', 'input_tokens', 1, 'Input Tokens', 'desc', 'tokens', 'observed', 'count', 'integer', 'session', '[]', 'all', 'none', 'sum', 'sp-1', 'unknown', 'root_only', 'none', 'cg-1', ${now}, ${now});
      INSERT INTO sessions (id, project_id, ingestion_source_id, harness, native_session_id, current_generation_id, occurrence_time, finality, created_at, updated_at)
        VALUES ('sess-1', 'proj-1', 'src-1', 'claude-code', 'native-s1', NULL, ${now}, 'final', ${now}, ${now});
      INSERT INTO transformation_generations (id, session_id, analysis_release_id, parser_version, transformer_version, ontology_version, metric_version, schema_version, status, source_availability, created_at)
        VALUES ('gen-1', 'sess-1', 'rel-1', '1.0', '1.0', '1.0', '1.0', '1.0', 'committed', 'local', ${now});
      UPDATE sessions SET current_generation_id = 'gen-1' WHERE id = 'sess-1';
      INSERT INTO metric_values (id, metric_definition_id, comparability_group_id, generation_id, session_id, value_type, integer_value, value_class, root_inclusion, is_unavailable, is_not_applicable, created_at, updated_at)
        VALUES ('mv-1', 'md-1', 'cg-1', 'gen-1', 'sess-1', 'integer', 500, 'exact', 'root_only', 0, 0, ${now}, ${now});
    `);

    await rebuildAnalyticsDerivedData(executor, progressSpy);

    expect(await getStoredProcessingVersion(executor)).toBe(ANALYTICS_PROCESSING_VERSION);
    expect(await needsRebuild(executor)).toBe(false);
    expect(progressSpy).toHaveBeenCalledTimes(4);
    expect(progressSpy).toHaveBeenNthCalledWith(1, {
      step: 'Rebuilding session rollups',
      completed: 0,
      total: 1,
      phase: 1,
      totalPhases: 2,
      unit: 'sessions parsing',
    });
    expect(progressSpy).toHaveBeenNthCalledWith(2, {
      step: 'Rebuilding session rollups',
      completed: 1,
      total: 1,
      phase: 1,
      totalPhases: 2,
      unit: 'sessions parsing',
    });
    expect(progressSpy).toHaveBeenNthCalledWith(3, {
      step: 'Recomputing project rollups',
      completed: 0,
      total: 1,
      phase: 2,
      totalPhases: 2,
      unit: 'analytics calculations',
    });
    expect(progressSpy).toHaveBeenNthCalledWith(4, {
      step: 'Recomputing project rollups',
      completed: 1,
      total: 1,
      phase: 2,
      totalPhases: 2,
      unit: 'analytics calculations',
    });
  });

  it('isolates individual session failure during rebuild and completes derived data', async () => {
    const progressSpy = vi.fn();
    const now = Date.now();
    await executor.exec(`
      INSERT INTO tenants (id, name, created_at, updated_at) VALUES ('tenant-2', 'T2', ${now}, ${now});
      INSERT INTO portfolios (id, tenant_id, name, created_at, updated_at) VALUES ('port-2', 'tenant-2', 'P2', ${now}, ${now});
      INSERT INTO ingestion_sources (id, portfolio_id, native_source_id, display_name, type, authority, created_at, updated_at)
        VALUES ('src-2', 'port-2', 'native-2', 'Source 2', 'test', 'local', ${now}, ${now});
      INSERT INTO projects (id, portfolio_id, name, created_at, updated_at) VALUES ('proj-2', 'port-2', 'Proj 2', ${now}, ${now});
      INSERT INTO analysis_releases (id, ontology_version, metric_registry_version, statistical_policy_version, rollup_policy_version, mapping_version, created_at, is_default)
        VALUES ('rel-2', '1.0', '1.0', '1.0', '1.0', '1.0', ${now}, 0);
      INSERT INTO sessions (id, project_id, ingestion_source_id, harness, native_session_id, current_generation_id, occurrence_time, finality, created_at, updated_at)
        VALUES ('sess-bad', 'proj-2', 'src-2', 'claude-code', 'native-bad', NULL, ${now}, 'final', ${now}, ${now});
      INSERT INTO transformation_generations (id, session_id, analysis_release_id, parser_version, transformer_version, ontology_version, metric_version, schema_version, status, source_availability, created_at)
        VALUES ('gen-bad', 'sess-bad', 'rel-2', '1.0', '1.0', '1.0', '1.0', '1.0', 'committed', 'local', ${now});
      UPDATE sessions SET current_generation_id = 'gen-bad' WHERE id = 'sess-bad';
    `);

    // Reset processing version to force rebuild
    await setStoredProcessingVersion(executor, 0);
    expect(await needsRebuild(executor)).toBe(true);

    const applySpy = vi
      .spyOn(rollupReconciliation, 'applySessionRollupContributions')
      .mockRejectedValueOnce(new Error('Simulated database corruption on session'));

    // Rebuild should not throw even though sess-bad fails
    await expect(rebuildAnalyticsDerivedData(executor, progressSpy)).resolves.toBeUndefined();

    expect(await getStoredProcessingVersion(executor)).toBe(ANALYTICS_PROCESSING_VERSION);
    expect(await needsRebuild(executor)).toBe(false);

    applySpy.mockRestore();
  });
});
