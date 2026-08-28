import { FRESH_SCHEMA_SQL } from '@lucasschirm/sal-db-core';
import type { ManifestArtifact, SyncManifest } from '@lucasschirm/sal-sync-core';
import { sha256Hex } from '@lucasschirm/sal-sync-core';
import {
  type ArtifactClassificationResult,
  type ClassifiedArtifact,
  type ConfigurationSnapshot,
  type DetectionResult,
  type MetricCapability,
  type Provenance,
  type ScalarMetricValue,
  type SessionSummary,
  type SessionTransformer,
  type TransformContext,
  TransformerRegistry,
  type TransformResult,
  type UnknownArtifactBundle,
} from '@lucasschirm/sal-transformer';
import { beforeEach, describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import type { ArtifactResolver, ResolvedArtifact } from '../../src/ports.js';
import { RebuildFrontierEngine } from '../../src/rebuild-frontiers.js';
import type { RebuildFrontier } from '../../src/reprocessing.js';

function requireFrontier(frontier: RebuildFrontier | undefined): RebuildFrontier {
  if (!frontier) throw new Error('Frontier expected to be defined');
  return frontier;
}

const ANALYSIS_RELEASE_ID = 'release-1';

function makeMetricDefinition(metricId: string): {
  metricId: string;
  version: number;
  label: string;
  description: string;
  family: string;
  measurementClass: 'observed';
  unit: string;
  valueType: 'integer';
  grain: string;
  dimensions: readonly string[];
  populationRule: string;
  statusRule: string;
  aggregation: string;
  statisticalPolicyId: string;
  comparabilityGroupInputs: readonly string[];
  missingDataBehavior: 'unknown';
  rootInclusion: 'root_only';
  provenanceRequirement: string;
} {
  return {
    metricId,
    version: 1,
    label: metricId,
    description: metricId,
    family: 'test',
    measurementClass: 'observed',
    unit: 'count',
    valueType: 'integer',
    grain: 'session',
    dimensions: [],
    populationRule: 'all',
    statusRule: 'none',
    aggregation: 'sum',
    statisticalPolicyId: 'claude-default',
    comparabilityGroupInputs: [],
    missingDataBehavior: 'unknown',
    rootInclusion: 'root_only',
    provenanceRequirement: 'optional',
  };
}

function makeMetricValue(
  metricId: string,
  value: number,
  scope: 'root_only' | 'inclusive',
): ScalarMetricValue & {
  grain: string;
  dimensions: Record<string, string>;
  class: 'observed';
  confidence: number;
  rootScope: 'root_only' | 'inclusive';
  evidenceRecordIds: readonly string[];
  provenance: readonly Provenance[];
  definition: ReturnType<typeof makeMetricDefinition>;
} {
  return {
    metricId,
    definitionVersion: '1',
    value,
    exact: true,
    unit: 'count',
    comparabilityGroupId: 'cgrp-default',
    grain: 'session',
    dimensions: {},
    class: 'observed',
    confidence: 1,
    rootScope: scope,
    evidenceRecordIds: [],
    provenance: [],
    definition: makeMetricDefinition(metricId),
  };
}

function stubTransformResult(sessionId: string, harness: string, value: number): TransformResult {
  const sessionSummary: SessionSummary = {
    sessionId,
    rootSessionId: sessionId,
    harness,
    finality: 'final',
    startTime: new Date().toISOString(),
  };
  return {
    bundleHash: '',
    parserId: 'stub-parser',
    parserVersion: '0.1.0',
    transformerId: 'stub',
    transformerVersion: '0.1.0',
    ontologyVersion: '0.1.0',
    metricDefinitionVersion: '0.1.0',
    evidence: [],
    sessionSummaries: [sessionSummary],
    componentSummaries: [],
    metricValues: [makeMetricValue('input_tokens', value, 'root_only')],
    distributions: [],
    configurationSnapshot: {
      completeness: {},
      components: [],
    } as ConfigurationSnapshot,
    capabilities: [],
    unavailableReasons: [],
    provenance: [],
    warnings: [],
    errors: [],
  };
}

class StubTransformer implements SessionTransformer<UnknownArtifactBundle> {
  readonly id = 'stub';
  readonly harnesses = ['test-harness'] as const;
  readonly transformerVersion = '0.1.0';
  readonly ontologyVersion = '0.1.0';

  private readonly valueBySession: Map<string, number> = new Map();

  setSessionValue(sessionId: string, value: number): void {
    this.valueBySession.set(sessionId, value);
  }

  detect(): DetectionResult {
    return { kind: 'matched', harness: 'test-harness', confidence: 1 };
  }

  classifyArtifacts(bundle: UnknownArtifactBundle): ArtifactClassificationResult {
    const classified: ClassifiedArtifact[] = bundle.artifacts.map((artifact) => ({
      relativePath: artifact.relativePath,
      kind: 'transcript',
      scope: 'session',
      mediaType: artifact.mediaType ?? 'application/octet-stream',
      sha256: artifact.sha256,
      confidence: 'exact',
    }));
    return {
      artifacts: classified,
      configurationSnapshot: { completeness: {}, components: [] },
      components: [],
    };
  }

  getCapabilities(): MetricCapability[] {
    return [];
  }

  transform(bundle: UnknownArtifactBundle, _context: TransformContext): TransformResult {
    const sessionId = bundle.sourceIdentity?.sessionId ?? 'session-1';
    const value = this.valueBySession.get(sessionId) ?? 42;
    return stubTransformResult(sessionId, 'test-harness', value);
  }
}

function makeTranscriptContent(sessionId: string): string {
  return JSON.stringify({ session: sessionId, events: [] });
}

async function makeArtifact(
  projectId: string,
  sessionId: string,
  relativePath: string,
  content: string,
): Promise<{ artifact: ManifestArtifact; resolved: ResolvedArtifact }> {
  const bytes = new TextEncoder().encode(content) as Uint8Array<ArrayBuffer>;
  const sha256 = await sha256Hex(bytes);
  const artifact: ManifestArtifact = {
    projectId,
    sessionId,
    scope: 'session',
    relativePath,
    sha256,
    size: bytes.length,
    status: 'uploaded',
    mediaType: 'application/json',
    role: 'transcript',
  };
  const resolved: ResolvedArtifact = {
    ...artifact,
    content,
  };
  return { artifact, resolved };
}

async function makeManifest(
  sessionId: string,
  relativeTime: number,
): Promise<{ manifest: SyncManifest; resolved: ResolvedArtifact[] }> {
  const content = makeTranscriptContent(sessionId);
  const { artifact, resolved } = await makeArtifact(
    'project-fixture',
    sessionId,
    'transcript.jsonl',
    content,
  );
  const timestamp = new Date(relativeTime).toISOString();
  const manifest: SyncManifest = {
    schemaVersion: 1,
    projectId: 'project-fixture',
    sessionId,
    harness: 'test-harness',
    harnessVersion: '0.1.0',
    syncVersion: '0.1.0',
    pluginVersion: '0.1.0',
    transcriptsCaptured: true,
    occurrenceTime: timestamp,
    captureTime: timestamp,
    ingestionTime: timestamp,
    mainTranscriptRelativePath: 'transcript.jsonl',
    artifacts: [artifact],
    syncRuns: [],
  };
  return { manifest, resolved: [resolved] };
}

describe('RebuildFrontierEngine', () => {
  let executor: WasmSqliteExecutor;
  let registry: TransformerRegistry;
  let transformer: StubTransformer;
  let hasher: ReturnType<typeof createSha256ContentHasher>;
  let resolver: ArtifactResolver;
  let engine: RebuildFrontierEngine;

  beforeEach(async () => {
    executor = await WasmSqliteExecutor.create();
    await executor.exec(FRESH_SCHEMA_SQL);

    transformer = new StubTransformer();
    registry = new TransformerRegistry();
    registry.register(transformer);
    hasher = createSha256ContentHasher();

    resolver = {
      resolve: async (ref) => {
        const content = makeTranscriptContent(ref.relativePath);
        return { ...ref, content };
      },
    };

    engine = new RebuildFrontierEngine({ executor });
  });

  async function ingestSession(
    sessionId: string,
    relativeTime: number,
    release = ANALYSIS_RELEASE_ID,
  ): Promise<string> {
    const { manifest, resolved } = await makeManifest(sessionId, relativeTime);
    const orchestrator = new DefaultIngestionOrchestrator({
      executor,
      resolver,
      hasher,
      registry,
      analysisReleaseId: release,
    });
    const receipt = await orchestrator.ingestManifest({
      manifest,
      source: {
        sourceId: 'default',
        environmentId: 'dev',
        projectId: 'project-fixture',
        sessionId,
      },
      resolvedArtifacts: resolved,
      integrityVerified: true,
    });
    expect(receipt.status).toBe('committed');
    return receipt.sessionId;
  }

  it('rebuilds frontier contributions and rollups for an existing session', async () => {
    const sessionId = await ingestSession('session-1', Date.UTC(2026, 0, 1, 10, 0, 0));

    const frontier = await engine.computeFrontier(sessionId, 'late_insert');
    expect(frontier).toBeDefined();

    const report = await engine.rebuildFrontier(requireFrontier(frontier), ANALYSIS_RELEASE_ID);
    expect(report.sessionsProcessed).toBe(1);
    expect(report.sessionsUnavailable).toBe(0);
    expect(report.failures).toHaveLength(0);
    expect(report.contributionsApplied).toBeGreaterThan(0);
    expect(report.rollupsReconciled).toBe(true);

    const { rows: contributions } = await executor.exec(
      'SELECT * FROM rollup_contributions WHERE session_id = ?',
      [sessionId],
    );
    expect(contributions.length).toBeGreaterThan(0);

    const { rows: rollups } = await executor.exec(
      'SELECT * FROM project_daily_rollups WHERE analysis_release_id = ?',
      [ANALYSIS_RELEASE_ID],
    );
    expect(rollups.length).toBeGreaterThan(0);
  });

  it('rebuilds frontier after a timestamp correction', async () => {
    const original = Date.UTC(2026, 0, 2, 10, 0, 0);
    const corrected = Date.UTC(2026, 0, 2, 9, 0, 0);
    const sessionId = await ingestSession('session-corrected', original);

    const frontier = await engine.computeFrontier(sessionId, 'timestamp_correction', {
      correctedTime: corrected,
    });
    expect(frontier).toBeDefined();
    expect(frontier?.startTime).toBeLessThanOrEqual(corrected);

    const report = await engine.rebuildFrontier(requireFrontier(frontier), ANALYSIS_RELEASE_ID);
    expect(report.sessionsProcessed).toBe(1);
    expect(report.failures).toHaveLength(0);
    expect(report.contributionsApplied).toBeGreaterThan(0);
  });

  it('rebuilds frontier after reclassification with a new generation', async () => {
    const sessionId = await ingestSession('session-reclass', Date.UTC(2026, 0, 3, 10, 0, 0));

    const frontier = await engine.computeFrontier(sessionId, 'reclassification');
    const initial = await engine.rebuildFrontier(requireFrontier(frontier), ANALYSIS_RELEASE_ID);
    expect(initial.contributionsApplied).toBeGreaterThan(0);

    const { rows: genRows } = await executor.exec(
      'SELECT id, session_id, analysis_release_id, parser_version, transformer_version, ontology_version, metric_version, schema_version, status, source_availability, created_at FROM transformation_generations WHERE session_id = ? AND analysis_release_id = ?',
      [sessionId, ANALYSIS_RELEASE_ID],
    );
    const originalGenerationId = String(genRows[0].id);

    const newGenerationId = 'gen-reclass-1';
    await executor.exec(
      `INSERT INTO transformation_generations
         (id, session_id, analysis_release_id, parser_version, transformer_version,
          ontology_version, metric_version, schema_version, status, source_availability, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newGenerationId,
        sessionId,
        ANALYSIS_RELEASE_ID,
        'parser-0',
        'transformer-0',
        'ontology-0',
        'metric-0',
        'schema-0',
        'committed',
        'local',
        Date.now(),
      ],
    );

    const { rows: valueRows } = await executor.exec(
      'SELECT metric_definition_id, comparability_group_id FROM metric_values WHERE generation_id = ?',
      [originalGenerationId],
    );
    expect(valueRows.length).toBeGreaterThan(0);

    await executor.exec(
      `INSERT INTO metric_values (
        id, metric_definition_id, comparability_group_id, generation_id, session_id,
        value_type, integer_value, value_class, confidence, root_inclusion,
        is_unavailable, is_not_applicable, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'mv-reclass-1',
        valueRows[0].metric_definition_id,
        valueRows[0].comparability_group_id,
        newGenerationId,
        sessionId,
        'integer',
        999,
        'exact',
        1,
        'root_only',
        0,
        0,
        Date.now(),
        Date.now(),
      ],
    );

    await executor.exec('UPDATE sessions SET current_generation_id = ? WHERE id = ?', [
      newGenerationId,
      sessionId,
    ]);

    const report = await engine.rebuildFrontier(requireFrontier(frontier), ANALYSIS_RELEASE_ID);
    expect(report.sessionsProcessed).toBe(1);
    expect(report.failures).toHaveLength(0);

    const { rows: contributions } = await executor.exec(
      'SELECT additive_value FROM rollup_contributions WHERE session_id = ?',
      [sessionId],
    );
    expect(contributions.length).toBeGreaterThan(0);
    const contribution = Number(contributions[0].additive_value);
    expect(contribution).toBe(999);
  });

  it('rebuilds frontier after session deletion and subtracts contributions', async () => {
    const sessionId = await ingestSession('session-delete', Date.UTC(2026, 0, 4, 10, 0, 0));

    const frontier = await engine.computeFrontier(sessionId, 'deletion');
    const initial = await engine.rebuildFrontier(requireFrontier(frontier), ANALYSIS_RELEASE_ID);
    expect(initial.contributionsApplied).toBeGreaterThan(0);

    await executor.exec('DELETE FROM sessions WHERE id = ?', [sessionId]);

    const report = await engine.rebuildFrontier(requireFrontier(frontier), ANALYSIS_RELEASE_ID);
    expect(report.sessionsProcessed).toBe(0);
    expect(report.contributionsApplied).toBe(0);

    const { rows: contributions } = await executor.exec(
      'SELECT * FROM rollup_contributions WHERE session_id = ?',
      [sessionId],
    );
    expect(contributions.length).toBe(0);

    const { rows: rollups } = await executor.exec(
      'SELECT * FROM project_daily_rollups WHERE analysis_release_id = ?',
      [ANALYSIS_RELEASE_ID],
    );
    expect(rollups.length).toBe(0);
  });

  it('queues a maintenance job when the rebuild exceeds the budget', async () => {
    const smallEngine = new RebuildFrontierEngine({
      executor,
      budget: { maxAffectedSessions: 1, maxAffectedSnapshots: 10, maxDurationMillis: 10_000 },
    });

    await ingestSession('session-budget-a', Date.UTC(2026, 0, 5, 10, 0, 0));
    await ingestSession('session-budget-b', Date.UTC(2026, 0, 5, 11, 0, 0));

    const frontier = await smallEngine.computeFrontier('session-budget-a', 'late_insert');
    const report = await smallEngine.rebuildFrontier(
      requireFrontier(frontier),
      ANALYSIS_RELEASE_ID,
    );

    expect(report.queued).toBe(true);
    expect(report.jobId).toBeTruthy();

    const { rows } = await executor.exec(
      'SELECT status FROM rebuild_maintenance_jobs WHERE id = ?',
      [report.jobId],
    );
    expect(rows.length).toBe(1);
    expect(String(rows[0].status)).toBe('queued');
  });

  it('treats an erased session as a discontinuity in cohorts', async () => {
    const before = await ingestSession('session-eraser-before', Date.UTC(2026, 0, 6, 9, 0, 0));
    const after = await ingestSession('session-eraser-after', Date.UTC(2026, 0, 6, 11, 0, 0));

    await executor.exec("UPDATE sessions SET finality = 'censored' WHERE id = ?", [after]);

    const frontier = await engine.computeFrontier(before, 'reclassification');
    const report = await engine.rebuildFrontier(requireFrontier(frontier), ANALYSIS_RELEASE_ID);

    expect(report.cohortsRebuilt).toBeGreaterThan(0);

    const { rows } = await executor.exec(
      `SELECT ccm.session_id
       FROM comparison_cohort_members ccm
       JOIN sessions s ON s.id = ccm.session_id
       WHERE s.finality = 'censored'`,
    );
    expect(rows.length).toBe(0);
  });

  it('reassigns a project and rebuilds affected rollups', async () => {
    const sessionId = await ingestSession('session-reassign', Date.UTC(2026, 0, 7, 10, 0, 0));

    const { rows } = await executor.exec(
      `SELECT sp.id AS source_project_id, p.portfolio_id, p.id AS project_id
       FROM source_projects sp
       JOIN projects p ON p.id = sp.project_id
       WHERE sp.native_project_id = ?`,
      ['project-fixture'],
    );
    const sourceProjectId = String(rows[0].source_project_id);
    const portfolioId = String(rows[0].portfolio_id);
    const fromProjectId = String(rows[0].project_id);

    const toProjectId = 'project-reassign-target';
    await executor.exec(
      'INSERT INTO projects (id, portfolio_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [toProjectId, portfolioId, 'reassign-target', Date.now(), Date.now()],
    );

    const reports = await engine.reassignProject(
      portfolioId,
      sourceProjectId,
      toProjectId,
      ANALYSIS_RELEASE_ID,
    );
    expect(reports.length).toBe(2);
    expect(reports.every((r) => r.failures.length === 0)).toBe(true);

    const { rows: sessionRows } = await executor.exec(
      'SELECT project_id FROM sessions WHERE id = ?',
      [sessionId],
    );
    expect(String(sessionRows[0].project_id)).toBe(toProjectId);

    const { rows: contributions } = await executor.exec(
      'SELECT project_id FROM rollup_contributions WHERE session_id = ?',
      [sessionId],
    );
    expect(contributions.length).toBeGreaterThan(0);
    expect(contributions.every((r) => String(r.project_id) === toProjectId)).toBe(true);

    const { rows: toRollups } = await executor.exec(
      'SELECT * FROM project_daily_rollups WHERE project_id = ?',
      [toProjectId],
    );
    expect(toRollups.length).toBeGreaterThan(0);

    const { rows: fromRollups } = await executor.exec(
      'SELECT * FROM project_daily_rollups WHERE project_id = ?',
      [fromProjectId],
    );
    expect(fromRollups.length).toBe(0);
  });
});
