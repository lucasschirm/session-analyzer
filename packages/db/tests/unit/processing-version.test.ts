import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FRESH_SCHEMA_SQL,
  SessionContextSeriesStore,
  type SqliteExecutor,
} from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createAnalyticsDataSource } from '../../src/analytics.js';
import { createSha256ContentHasher, type IngestionContext } from '../../src/ingestion.js';
import { ManualIngestionOrchestrator } from '../../src/manual-ingestion.js';
import {
  ANALYTICS_PROCESSING_VERSION,
  getStoredProcessingVersion,
  needsRebuild,
  rebuildAnalyticsDerivedData,
  setStoredProcessingVersion,
} from '../../src/processing-version.js';
import { DefaultReprocessingEngine } from '../../src/reprocessing.js';
import * as rollupReconciliation from '../../src/rollup-reconciliation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '../../../parsers/claude-session-parser/tests/fixtures');

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

function createIngestionContext(executor: SqliteExecutor, content: string): IngestionContext {
  return {
    executor,
    hasher: createSha256ContentHasher(),
    registry: createDefaultRegistry(),
    // Resolves retained/reacquirable artifacts to the fixture content so the
    // re-ingest path can re-transform the session.
    resolver: {
      resolve: async (ref) => ({ ...ref, content: new TextEncoder().encode(content) }),
    },
    analysisReleaseId: 'ar-default',
  };
}

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
    expect(progressSpy).toHaveBeenCalledTimes(7);
    expect(progressSpy).toHaveBeenNthCalledWith(1, {
      step: 'Backfilling session titles',
      completed: 1,
      total: 1,
      phase: 2,
      totalPhases: 6,
      unit: 'sessions',
    });
    expect(progressSpy).toHaveBeenNthCalledWith(2, {
      step: 'Backfilling context series',
      completed: 0,
      total: 1,
      phase: 4,
      totalPhases: 6,
      unit: 'sessions processed',
    });
    expect(progressSpy).toHaveBeenNthCalledWith(3, {
      step: 'Backfilling context series',
      completed: 1,
      total: 1,
      phase: 4,
      totalPhases: 6,
      unit: 'sessions processed',
    });
    expect(progressSpy).toHaveBeenNthCalledWith(4, {
      step: 'Rebuilding session rollups',
      completed: 0,
      total: 1,
      phase: 5,
      totalPhases: 6,
      unit: 'sessions processed',
    });
    expect(progressSpy).toHaveBeenNthCalledWith(5, {
      step: 'Rebuilding session rollups',
      completed: 1,
      total: 1,
      phase: 5,
      totalPhases: 6,
      unit: 'sessions processed',
    });
    expect(progressSpy).toHaveBeenNthCalledWith(6, {
      step: 'Recomputing project rollups',
      completed: 0,
      total: 1,
      phase: 6,
      totalPhases: 6,
      unit: 'analytics calculations',
    });
    expect(progressSpy).toHaveBeenNthCalledWith(7, {
      step: 'Recomputing project rollups',
      completed: 1,
      total: 1,
      phase: 6,
      totalPhases: 6,
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

  it('backfills session_context_series for current generations missing a series row', async () => {
    const now = Date.now();
    await executor.exec(`
      INSERT INTO tenants (id, name, created_at, updated_at) VALUES ('tenant-3', 'T3', ${now}, ${now});
      INSERT INTO portfolios (id, tenant_id, name, created_at, updated_at) VALUES ('port-3', 'tenant-3', 'P3', ${now}, ${now});
      INSERT INTO ingestion_sources (id, portfolio_id, native_source_id, display_name, type, authority, created_at, updated_at)
        VALUES ('src-3', 'port-3', 'native-3', 'Source 3', 'test', 'local', ${now}, ${now});
      INSERT INTO projects (id, portfolio_id, name, created_at, updated_at) VALUES ('proj-3', 'port-3', 'Proj 3', ${now}, ${now});
      INSERT INTO analysis_releases (id, ontology_version, metric_registry_version, statistical_policy_version, rollup_policy_version, mapping_version, created_at, is_default)
        VALUES ('rel-3', '1.0', '1.0', '1.0', '1.0', '1.0', ${now}, 0);
      INSERT INTO sessions (id, project_id, ingestion_source_id, harness, native_session_id, current_generation_id, occurrence_time, finality, created_at, updated_at)
        VALUES ('sess-3', 'proj-3', 'src-3', 'claude-code', 'native-s3', NULL, ${now}, 'final', ${now}, ${now});
      INSERT INTO transformation_generations (id, session_id, analysis_release_id, parser_version, transformer_version, ontology_version, metric_version, schema_version, status, source_availability, created_at)
        VALUES ('gen-3', 'sess-3', 'rel-3', '1.0', '1.0', '1.0', '1.0', '1.0', 'committed', 'local', ${now});
      UPDATE sessions SET current_generation_id = 'gen-3' WHERE id = 'sess-3';
    `);

    // Legacy-generation normalized events carrying full pre-skeleton payloads.
    const payload = (overrides: Record<string, unknown>) => JSON.stringify(overrides);
    await executor.exec(
      `INSERT INTO normalized_events (id, session_id, generation_id, event_type, event_version, raw_details, retain_raw, created_at, updated_at)
       VALUES (?, 'sess-3', 'gen-3', 'message', 1, ?, 1, ${now}, ${now})`,
      [
        'evt-msg-a',
        payload({
          recordId: 'evt-msg-a',
          recordType: 'message',
          sessionId: 'sess-3',
          sourceEventId: 'u-a',
          payload: { role: 'user', timestamp: '2026-08-11T10:00:00.000Z' },
        }),
      ],
    );
    await executor.exec(
      `INSERT INTO normalized_events (id, session_id, generation_id, event_type, event_version, raw_details, retain_raw, created_at, updated_at)
       VALUES (?, 'sess-3', 'gen-3', 'message', 1, ?, 1, ${now}, ${now})`,
      [
        'evt-msg-b',
        payload({
          recordId: 'evt-msg-b',
          recordType: 'message',
          sessionId: 'sess-3',
          sourceEventId: 'a-b',
          payload: { role: 'assistant', timestamp: '2026-08-11T10:00:01.000Z' },
        }),
      ],
    );
    await executor.exec(
      `INSERT INTO normalized_events (id, session_id, generation_id, event_type, event_version, raw_details, retain_raw, created_at, updated_at)
       VALUES (?, 'sess-3', 'gen-3', 'model_request', 1, ?, 1, ${now}, ${now})`,
      [
        'evt-req-b',
        payload({
          recordId: 'evt-req-b',
          recordType: 'model_request',
          sessionId: 'sess-3',
          sourceEventId: 'a-b',
          payload: {
            model: 'claude-3-7',
            inputTokens: 400,
            outputTokens: 40,
            timestamp: '2026-08-11T10:00:01.000Z',
          },
        }),
      ],
    );

    // Sanity: no series row before the rebuild.
    const before = await SessionContextSeriesStore.getBySessionAndGeneration(
      executor,
      'sess-3',
      'gen-3',
    );
    expect(before).toBeUndefined();

    await setStoredProcessingVersion(executor, 0);
    await rebuildAnalyticsDerivedData(executor, () => {});

    const row = await SessionContextSeriesStore.getBySessionAndGeneration(
      executor,
      'sess-3',
      'gen-3',
    );
    if (!row) throw new Error('session_context_series row missing after rebuild');
    expect(row.messageCount).toBe(2);
    const contextTokens = JSON.parse(row.contextTokens) as (number | null)[];
    expect(contextTokens).toEqual([400, 400]);
    const generationTokens = JSON.parse(row.generationTokens ?? '[]') as (number | null)[];
    expect(generationTokens).toEqual([null, 40]);
    const models = JSON.parse(row.models ?? '[]') as string[];
    expect(models).toEqual(['claude-3-7']);
  });

  it('drops empty-payload component_evidence_link rows during rebuild', async () => {
    const now = Date.now();
    await executor.exec(`
      INSERT INTO tenants (id, name, created_at, updated_at) VALUES ('tenant-4', 'T4', ${now}, ${now});
      INSERT INTO portfolios (id, tenant_id, name, created_at, updated_at) VALUES ('port-4', 'tenant-4', 'P4', ${now}, ${now});
      INSERT INTO ingestion_sources (id, portfolio_id, native_source_id, display_name, type, authority, created_at, updated_at)
        VALUES ('src-4', 'port-4', 'native-4', 'Source 4', 'test', 'local', ${now}, ${now});
      INSERT INTO projects (id, portfolio_id, name, created_at, updated_at) VALUES ('proj-4', 'port-4', 'Proj 4', ${now}, ${now});
      INSERT INTO analysis_releases (id, ontology_version, metric_registry_version, statistical_policy_version, rollup_policy_version, mapping_version, created_at, is_default)
        VALUES ('rel-4', '1.0', '1.0', '1.0', '1.0', '1.0', ${now}, 0);
      INSERT INTO sessions (id, project_id, ingestion_source_id, harness, native_session_id, current_generation_id, occurrence_time, finality, created_at, updated_at)
        VALUES ('sess-4', 'proj-4', 'src-4', 'claude-code', 'native-s4', NULL, ${now}, 'final', ${now}, ${now});
      INSERT INTO transformation_generations (id, session_id, analysis_release_id, parser_version, transformer_version, ontology_version, metric_version, schema_version, status, source_availability, created_at)
        VALUES ('gen-4', 'sess-4', 'rel-4', '1.0', '1.0', '1.0', '1.0', '1.0', 'committed', 'local', ${now});
      UPDATE sessions SET current_generation_id = 'gen-4' WHERE id = 'sess-4';
    `);
    await executor.exec(
      `INSERT INTO normalized_events (id, session_id, generation_id, event_type, event_version, raw_details, retain_raw, created_at, updated_at)
       VALUES
         ('evt-link-1', 'sess-4', 'gen-4', 'component_evidence_link', 1, '{}', 1, ${now}, ${now}),
         ('evt-link-2', 'sess-4', 'gen-4', 'component_evidence_link', 1, '{}', 1, ${now}, ${now}),
         ('evt-msg-1', 'sess-4', 'gen-4', 'message', 1, '{}', 1, ${now}, ${now})`,
    );

    await rebuildAnalyticsDerivedData(executor, () => {});

    const { rows } = await executor.exec(
      `SELECT event_type, COUNT(*) AS c FROM normalized_events WHERE session_id = 'sess-4' GROUP BY event_type`,
    );
    const counts = Object.fromEntries(rows.map((r) => [String(r.event_type), Number(r.c)]));
    expect(counts['component_evidence_link']).toBeUndefined();
    expect(counts['message']).toBe(1);
  });

  it('regenerates sessions whose context series carries no context signal (v15 heal)', async () => {
    const now = Date.now();
    await executor.exec(`
      INSERT INTO tenants (id, name, created_at, updated_at) VALUES ('tenant-5', 'T5', ${now}, ${now});
      INSERT INTO portfolios (id, tenant_id, name, created_at, updated_at) VALUES ('port-5', 'tenant-5', 'P5', ${now}, ${now});
      INSERT INTO ingestion_sources (id, portfolio_id, native_source_id, display_name, type, authority, created_at, updated_at)
        VALUES ('src-5', 'port-5', 'native-5', 'Source 5', 'test', 'local', ${now}, ${now});
      INSERT INTO projects (id, portfolio_id, name, created_at, updated_at) VALUES ('proj-5', 'port-5', 'Proj 5', ${now}, ${now});
      INSERT INTO analysis_releases (id, ontology_version, metric_registry_version, statistical_policy_version, rollup_policy_version, mapping_version, created_at, is_default)
        VALUES ('rel-5', '1.0', '1.0', '1.0', '1.0', '1.0', ${now}, 1);
      INSERT INTO sessions (id, project_id, ingestion_source_id, harness, native_session_id, current_generation_id, occurrence_time, finality, ai_title, created_at, updated_at)
        VALUES
          ('sess-empty', 'proj-5', 'src-5', 'devin', 'native-empty', NULL, ${now}, 'final', 'Empty session', ${now}, ${now}),
          ('sess-ok', 'proj-5', 'src-5', 'claude-code', 'native-ok', NULL, ${now}, 'final', 'Ok session', ${now}, ${now}),
          ('sess-healed', 'proj-5', 'src-5', 'devin', 'native-healed', NULL, ${now}, 'final', 'Healed session', ${now}, ${now});
      INSERT INTO transformation_generations (id, session_id, analysis_release_id, parser_version, transformer_version, ontology_version, metric_version, schema_version, status, source_availability, created_at)
        VALUES
          ('gen-empty', 'sess-empty', 'rel-5', '1.0', '0.13.0', '1.0', '1.0', '1.0', 'committed', 'local', ${now}),
          ('gen-ok', 'sess-ok', 'rel-5', '1.0', '1.0', '1.0', '1.0', '1.0', 'committed', 'local', ${now}),
          ('gen-healed', 'sess-healed', 'rel-5', '1.0', '0.14.0', '1.0', '1.0', '1.0', 'committed', 'local', ${now});
      UPDATE sessions SET current_generation_id = 'gen-empty' WHERE id = 'sess-empty';
      UPDATE sessions SET current_generation_id = 'gen-ok' WHERE id = 'sess-ok';
      UPDATE sessions SET current_generation_id = 'gen-healed' WHERE id = 'sess-healed';
      INSERT INTO session_context_series (id, session_id, generation_id, message_count, context_tokens, generation_tokens, point_meta, models, created_at, updated_at)
        VALUES
          ('scs-empty', 'sess-empty', 'gen-empty', 3, '[null,null,null]', '[null,null,null]', '[]', '[]', ${now}, ${now}),
          ('scs-ok', 'sess-ok', 'gen-ok', 3, '[400,600,-200]', '[40,null,10]', '[]', '[]', ${now}, ${now}),
          ('scs-healed', 'sess-healed', 'gen-healed', 3, '[null,null,null]', '[null,null,null]', '[]', '[]', ${now}, ${now});
    `);

    const regen = vi.fn(async (_sessionId: string) => true);
    await rebuildAnalyticsDerivedData(executor, undefined, { regenerateSession: regen });

    // Only the pre-0.14.0 devin all-null series is flagged for re-ingest:
    // sess-ok's negative-encoded compaction entry counts as a real context
    // signal (and it isn't a devin session anyway), while sess-healed's
    // all-null series under 0.14.0 genuinely has no context signal — no
    // point re-ingesting it on every future version bump.
    expect(regen).toHaveBeenCalledTimes(1);
    expect(regen).toHaveBeenCalledWith('sess-empty');
  });

  describe('stale component-data regeneration', () => {
    async function ingestFixtureSession(context: IngestionContext): Promise<string> {
      const orchestrator = new ManualIngestionOrchestrator(context);
      const receipt = await orchestrator.ingestManual({
        projectId: 'project-fixture',
        sessionId: 'sess-happy-1',
        source: { sourceId: 'default', environmentId: 'dev' },
        harness: 'claude-code',
        artifacts: [
          {
            relativePath: 'session/transcript.jsonl',
            mediaType: 'application/jsonl',
            content: readFixture('t2-happy-path.jsonl'),
          },
        ],
      });
      expect(receipt.status).toBe('committed');
      return receipt.sessionId;
    }

    async function countRows(table: string, sessionId: string): Promise<number> {
      const { rows } = await executor.exec(
        `SELECT COUNT(*) AS c FROM ${table} WHERE session_id = ?`,
        [sessionId],
      );
      return Number(rows[0]?.c ?? 0);
    }

    it('re-ingests stale sessions from retained artifacts, restoring exposures and stats', async () => {
      const context = createIngestionContext(executor, readFixture('t2-happy-path.jsonl'));
      const sessionId = await ingestFixtureSession(context);
      const { rows: before } = await executor.exec(
        'SELECT current_generation_id FROM sessions WHERE id = ?',
        [sessionId],
      );
      const originalGenerationId = String(before[0]?.current_generation_id);

      // Simulate the pre-exposures/stats contract: drop the derived rows the
      // older ingest path never wrote.
      await executor.exec(`DELETE FROM session_component_exposures WHERE session_id = ?`, [
        sessionId,
      ]);
      await executor.exec(`DELETE FROM session_component_stats WHERE session_id = ?`, [sessionId]);

      // Re-ingest under a different analysis release — the supersession path a
      // real version bump takes — which must mint a fresh generation.
      const reprocessing = new DefaultReprocessingEngine({
        ...context,
        analysisReleaseId: 'ar-v2',
      });
      await rebuildAnalyticsDerivedData(executor, undefined, {
        regenerateSession: async (id) =>
          (await reprocessing.reingestSession(id, 'ar-v2')) === 'committed',
      });

      // The re-ingest commits a fresh generation carrying the new derived rows.
      const { rows: gens } = await executor.exec(
        `SELECT current_generation_id FROM sessions WHERE id = ?`,
        [sessionId],
      );
      expect(String(gens[0]?.current_generation_id)).not.toBe(originalGenerationId);

      expect(await countRows('session_component_exposures', sessionId)).toBeGreaterThan(0);
      expect(await countRows('session_component_stats', sessionId)).toBeGreaterThan(0);

      const ds = createAnalyticsDataSource(executor);
      const report = await ds.session.getUtilizationReport(sessionId);
      expect(report.sessionDomains.tool.availableCount).toBeGreaterThan(0);
      expect(report.sessionDomains.tool.usedCount).toBeGreaterThan(0);
    });

    it('backfills exposures from snapshot_components when re-ingest is unavailable', async () => {
      const context = createIngestionContext(executor, readFixture('t2-happy-path.jsonl'));
      const sessionId = await ingestFixtureSession(context);

      await executor.exec(`DELETE FROM session_component_exposures WHERE session_id = ?`, [
        sessionId,
      ]);
      await executor.exec(`DELETE FROM session_component_stats WHERE session_id = ?`, [sessionId]);

      // No regenerateSession dep — only the snapshot_components fallback runs.
      await rebuildAnalyticsDerivedData(executor, undefined);

      const expected = await executor.exec(
        `SELECT COUNT(*) AS c FROM snapshot_components sc
         JOIN configuration_snapshots cs ON cs.id = sc.snapshot_id
         WHERE cs.session_id = ?`,
        [sessionId],
      );
      expect(await countRows('session_component_exposures', sessionId)).toBe(
        Number(expected.rows[0]?.c),
      );

      const ds = createAnalyticsDataSource(executor);
      const report = await ds.session.getUtilizationReport(sessionId);
      expect(report.sessionDomains.tool.availableCount).toBeGreaterThan(0);
    });

    it('skips regeneration for sessions already on the current contract', async () => {
      const context = createIngestionContext(executor, readFixture('t2-happy-path.jsonl'));
      const sessionId = await ingestFixtureSession(context);

      const reprocessing = new DefaultReprocessingEngine(context);
      // A same-generation re-ingest dedups instead of committing a new one.
      expect(await reprocessing.reingestSession(sessionId)).toBe('skipped');

      const regen = vi.fn(
        async (id: string) => (await reprocessing.reingestSession(id)) === 'committed',
      );
      await rebuildAnalyticsDerivedData(executor, undefined, { regenerateSession: regen });

      // Session is fully derived — never flagged stale.
      expect(regen).not.toHaveBeenCalled();
      expect(await countRows('session_component_exposures', sessionId)).toBeGreaterThan(0);
    });
  });
});
