import {
  ComponentIdentityStore,
  ComponentVersionStore,
  ConfigurationSnapshotStore,
  FRESH_SCHEMA_SQL,
  SnapshotComponentStore,
} from '@lucasschirm/sal-db-core';
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

interface SessionInfo {
  projectId: string;
  environmentId: string;
  portfolioId: string;
  currentGenerationId: string;
}

async function querySessionInfo(
  executor: WasmSqliteExecutor,
  sessionId: string,
): Promise<SessionInfo> {
  const { rows } = await executor.exec(
    `SELECT s.project_id, s.environment_id, p.portfolio_id, s.current_generation_id
     FROM sessions s
     JOIN projects p ON p.id = s.project_id
     WHERE s.id = ?`,
    [sessionId],
  );
  return {
    projectId: String(rows[0].project_id),
    environmentId: String(rows[0].environment_id),
    portfolioId: String(rows[0].portfolio_id),
    currentGenerationId: String(rows[0].current_generation_id),
  };
}

async function insertComponentVersions(
  executor: WasmSqliteExecutor,
  portfolioId: string,
  componentId: string,
  versionA: string,
  versionB: string,
): Promise<void> {
  await ComponentIdentityStore.insert(executor, {
    id: componentId,
    portfolioId,
    kind: 'tool',
    canonicalSourceIdentity: `comp://${componentId}`,
  });
  await ComponentVersionStore.insert(executor, {
    id: versionA,
    componentId,
    contentHash: 'hash-a',
  });
  await ComponentVersionStore.insert(executor, {
    id: versionB,
    componentId,
    contentHash: 'hash-b',
  });
}

async function insertCommittedGeneration(
  executor: WasmSqliteExecutor,
  id: string,
  sessionId: string,
  release: string,
): Promise<void> {
  await executor.exec(
    `INSERT INTO transformation_generations
       (id, session_id, analysis_release_id, parser_version, transformer_version,
        ontology_version, metric_version, schema_version, status, source_availability, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      sessionId,
      release,
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
}

async function insertConfigurationSnapshot(
  executor: WasmSqliteExecutor,
  id: string,
  sessionId: string,
  generationId: string,
  ordering: number,
  captureTime: number,
  environmentId: string,
  projectId: string,
  versionId: string,
): Promise<void> {
  await ConfigurationSnapshotStore.insert(executor, {
    id,
    sessionId,
    generationId,
    ordering,
    captureTime,
    ingestionTime: captureTime,
    harness: 'test-harness',
    temporalRole: 'pre_session',
    environmentId,
    projectId,
  });
  await SnapshotComponentStore.insert(executor, {
    id: `sc-${id}`,
    snapshotId: id,
    componentVersionId: versionId,
    sourceScope: 'runtime',
  });
}

async function lifecycleRowCounts(
  executor: WasmSqliteExecutor,
  generationId: string,
): Promise<Record<string, number>> {
  const tables: [string, string, string][] = [
    ['exposures', 'session_component_exposures', 'generation_id'],
    ['lifecycle', 'component_lifecycle_events', 'generation_id'],
    ['availability', 'component_availability_events', 'generation_id'],
    ['context', 'component_context_events', 'generation_id'],
    ['insight', 'insight_evidence', 'generation_id'],
  ];
  const counts: Record<string, number> = {};
  for (const [key, table, column] of tables) {
    const { rows } = await executor.exec(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, [
      generationId,
    ]);
    counts[key] = Number(rows[0].n);
  }
  return counts;
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

  it('preserves lifecycle evidence across generation rebuilds', async () => {
    const tA = Date.UTC(2026, 0, 10, 10, 0, 0);
    const sessionId = await ingestSession('session-gen-preserve', tA);

    const { rows: sessionRows } = await executor.exec(
      `SELECT s.project_id, s.environment_id, p.portfolio_id, s.current_generation_id
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.id = ?`,
      [sessionId],
    );
    const projectId = String(sessionRows[0].project_id);
    const environmentId = String(sessionRows[0].environment_id);
    const portfolioId = String(sessionRows[0].portfolio_id);
    const genA = String(sessionRows[0].current_generation_id);

    const componentId = 'comp-preserve';
    await ComponentIdentityStore.insert(executor, {
      id: componentId,
      portfolioId,
      kind: 'tool',
      canonicalSourceIdentity: 'comp://preserve',
    });
    await ComponentVersionStore.insert(executor, {
      id: 'cv-preserve-a',
      componentId,
      contentHash: 'hash-a',
    });
    await ComponentVersionStore.insert(executor, {
      id: 'cv-preserve-b',
      componentId,
      contentHash: 'hash-b',
    });

    const snapAId = 'cs-preserve-a';
    await ConfigurationSnapshotStore.insert(executor, {
      id: snapAId,
      sessionId,
      generationId: genA,
      ordering: 0,
      captureTime: tA,
      ingestionTime: tA,
      harness: 'test-harness',
      temporalRole: 'pre_session',
      environmentId,
      projectId,
    });
    await SnapshotComponentStore.insert(executor, {
      id: 'sc-preserve-a',
      snapshotId: snapAId,
      componentVersionId: 'cv-preserve-a',
      sourceScope: 'runtime',
    });

    await executor.exec('UPDATE sessions SET occurrence_time = ? WHERE id = ?', [tA, sessionId]);
    const frontierA: RebuildFrontier = {
      environmentId,
      projectId,
      workspaceId: null,
      harness: 'test-harness',
      scopeChain: null,
      startTime: tA,
      endTime: tA + 1,
      trigger: 'reclassification',
      triggerSessionId: sessionId,
      affectedProjectIds: [projectId],
    };
    const reportA = await engine.rebuildFrontier(frontierA, ANALYSIS_RELEASE_ID);
    expect(reportA.sessionsProcessed).toBe(1);
    expect(reportA.failures).toHaveLength(0);

    const tB = tA + 3600_000;
    const genB = 'gen-preserve-b';
    await executor.exec(
      `INSERT INTO transformation_generations
         (id, session_id, analysis_release_id, parser_version, transformer_version,
          ontology_version, metric_version, schema_version, status, source_availability, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        genB,
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

    const snapBId = 'cs-preserve-b';
    await ConfigurationSnapshotStore.insert(executor, {
      id: snapBId,
      sessionId,
      generationId: genB,
      ordering: 1,
      captureTime: tB,
      ingestionTime: tB,
      harness: 'test-harness',
      temporalRole: 'pre_session',
      environmentId,
      projectId,
    });
    await SnapshotComponentStore.insert(executor, {
      id: 'sc-preserve-b',
      snapshotId: snapBId,
      componentVersionId: 'cv-preserve-b',
      sourceScope: 'runtime',
    });

    await executor.exec(
      'UPDATE sessions SET current_generation_id = ?, occurrence_time = ? WHERE id = ?',
      [genB, tB, sessionId],
    );
    const frontierB: RebuildFrontier = {
      environmentId,
      projectId,
      workspaceId: null,
      harness: 'test-harness',
      scopeChain: null,
      startTime: tB,
      endTime: tB + 1,
      trigger: 'reclassification',
      triggerSessionId: sessionId,
      affectedProjectIds: [projectId],
    };
    const reportB = await engine.rebuildFrontier(frontierB, ANALYSIS_RELEASE_ID);
    expect(reportB.sessionsProcessed).toBe(1);
    expect(reportB.failures).toHaveLength(0);

    const { rows: aExposures } = await executor.exec(
      `SELECT * FROM session_component_exposures
       WHERE session_id = ? AND COALESCE(generation_id, '') = ?`,
      [sessionId, genA],
    );
    expect(aExposures.length).toBe(1);

    const { rows: aLifecycle } = await executor.exec(
      'SELECT * FROM component_lifecycle_events WHERE snapshot_id = ?',
      [snapAId],
    );
    expect(aLifecycle.length).toBe(1);

    const { rows: aAvailability } = await executor.exec(
      `SELECT * FROM component_availability_events
       WHERE session_id = ? AND COALESCE(generation_id, '') = ?`,
      [sessionId, genA],
    );
    expect(aAvailability.length).toBeGreaterThan(0);

    const { rows: aContext } = await executor.exec(
      `SELECT * FROM component_context_events
       WHERE session_id = ? AND COALESCE(generation_id, '') = ?`,
      [sessionId, genA],
    );
    expect(aContext.length).toBeGreaterThan(0);

    const { rows: aCohort } = await executor.exec(
      `SELECT * FROM comparison_cohort_members
       WHERE session_id = ? AND COALESCE(generation_id, '') = ?`,
      [sessionId, genA],
    );
    expect(aCohort.length).toBeGreaterThan(0);

    const { rows: aInsight } = await executor.exec(
      'SELECT * FROM insight_evidence WHERE generation_id = ?',
      [genA],
    );
    expect(aInsight.length).toBeGreaterThan(0);

    const { rows: bExposures } = await executor.exec(
      `SELECT * FROM session_component_exposures
       WHERE session_id = ? AND COALESCE(generation_id, '') = ?`,
      [sessionId, genB],
    );
    expect(bExposures.length).toBe(1);
  });

  it('rebuilds the current generation only with a wide computeFrontier window', async () => {
    const tA = Date.UTC(2026, 0, 13, 10, 0, 0);
    const tB = tA + 3600_000;
    const sessionId = await ingestSession('session-wide-frontier', tA);
    const info = await querySessionInfo(executor, sessionId);
    const componentId = 'comp-wide';
    const versionA = 'cv-wide-a';
    const versionB = 'cv-wide-b';
    await insertComponentVersions(executor, info.portfolioId, componentId, versionA, versionB);

    const snapA = 'cs-wide-a';
    await insertConfigurationSnapshot(
      executor,
      snapA,
      sessionId,
      info.currentGenerationId,
      0,
      tA,
      info.environmentId,
      info.projectId,
      versionA,
    );

    await executor.exec('UPDATE sessions SET occurrence_time = ? WHERE id = ?', [tA, sessionId]);
    const frontierA = requireFrontier(await engine.computeFrontier(sessionId, 'reclassification'));
    await engine.rebuildFrontier(frontierA, ANALYSIS_RELEASE_ID);
    const genA = info.currentGenerationId;
    const before = await lifecycleRowCounts(executor, genA);

    const genB = 'gen-wide-b';
    await insertCommittedGeneration(executor, genB, sessionId, ANALYSIS_RELEASE_ID);
    const snapB = 'cs-wide-b';
    await insertConfigurationSnapshot(
      executor,
      snapB,
      sessionId,
      genB,
      1,
      tB,
      info.environmentId,
      info.projectId,
      versionB,
    );
    await executor.exec('UPDATE sessions SET current_generation_id = ? WHERE id = ?', [
      genB,
      sessionId,
    ]);

    const frontier = requireFrontier(await engine.computeFrontier(sessionId, 'reclassification'));
    expect(frontier.startTime).toBe(tA);
    expect(frontier.endTime).toBeGreaterThanOrEqual(tB);

    const report = await engine.rebuildFrontier(frontier, ANALYSIS_RELEASE_ID);
    expect(report.sessionsProcessed).toBe(1);
    expect(report.failures).toHaveLength(0);

    const after = await lifecycleRowCounts(executor, genA);
    expect(after).toEqual(before);

    const { rows: bExposures } = await executor.exec(
      `SELECT * FROM session_component_exposures
       WHERE session_id = ? AND COALESCE(generation_id, '') = ?`,
      [sessionId, genB],
    );
    expect(bExposures.length).toBe(1);

    const { rows: bLifecycle } = await executor.exec(
      'SELECT event_type, after_version_id FROM component_lifecycle_events WHERE snapshot_id = ?',
      [snapB],
    );
    expect(bLifecycle.length).toBe(1);
    expect(String(bLifecycle[0].event_type)).toBe('baseline');
    expect(String(bLifecycle[0].after_version_id)).toBe(versionB);
  });

  it('compares component versions only within the same generation', async () => {
    const sessionId = await ingestSession('session-gen-compare', Date.UTC(2026, 0, 11, 10, 0, 0));

    const { rows: sessionRows } = await executor.exec(
      `SELECT s.project_id, s.environment_id, p.portfolio_id
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.id = ?`,
      [sessionId],
    );
    const projectId = String(sessionRows[0].project_id);
    const environmentId = String(sessionRows[0].environment_id);
    const portfolioId = String(sessionRows[0].portfolio_id);

    const componentId = 'comp-compare';
    await ComponentIdentityStore.insert(executor, {
      id: componentId,
      portfolioId,
      kind: 'tool',
      canonicalSourceIdentity: 'comp://compare',
    });
    const v1 = 'cv-compare-1';
    const v2 = 'cv-compare-2';
    await ComponentVersionStore.insert(executor, { id: v1, componentId, contentHash: '1' });
    await ComponentVersionStore.insert(executor, { id: v2, componentId, contentHash: '2' });

    const genA = 'gen-compare-a';
    const genB = 'gen-compare-b';
    await executor.exec(
      `INSERT INTO transformation_generations
         (id, session_id, analysis_release_id, parser_version, transformer_version,
          ontology_version, metric_version, schema_version, status, source_availability, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        genA,
        sessionId,
        ANALYSIS_RELEASE_ID,
        'parser-0',
        'transformer-0',
        'ontology-0',
        'metric-0',
        'schema-0',
        'committed',
        'local',
        1,
        genB,
        sessionId,
        ANALYSIS_RELEASE_ID,
        'parser-0',
        'transformer-0',
        'ontology-0',
        'metric-0',
        'schema-0',
        'committed',
        'local',
        2,
      ],
    );

    const makeSnapshot = async (
      id: string,
      generationId: string,
      ordering: number,
      captureTime: number,
      versionId: string,
    ): Promise<void> => {
      await ConfigurationSnapshotStore.insert(executor, {
        id,
        sessionId,
        generationId,
        ordering,
        captureTime,
        ingestionTime: captureTime,
        harness: 'test-harness',
        temporalRole: 'pre_session',
        environmentId,
        projectId,
      });
      await SnapshotComponentStore.insert(executor, {
        id: `sc-${id}`,
        snapshotId: id,
        componentVersionId: versionId,
        sourceScope: 'runtime',
      });
    };

    const snapA0 = 'cs-compare-a0';
    const snapB0 = 'cs-compare-b0';
    const snapA1 = 'cs-compare-a1';
    const snapB1 = 'cs-compare-b1';
    await makeSnapshot(snapA0, genA, 0, 1000, v1);
    await makeSnapshot(snapB0, genB, 1, 1001, v1);
    await makeSnapshot(snapA1, genA, 2, 1002, v2);
    await makeSnapshot(snapB1, genB, 3, 1003, v2);

    const snapshots = [
      {
        id: snapA0,
        sessionId,
        generationId: genA,
        ordering: 0,
        captureTime: 1000,
        temporalRole: 'pre_session',
        createdAt: 1000,
      },
      {
        id: snapB0,
        sessionId,
        generationId: genB,
        ordering: 1,
        captureTime: 1001,
        temporalRole: 'pre_session',
        createdAt: 1001,
      },
      {
        id: snapA1,
        sessionId,
        generationId: genA,
        ordering: 2,
        captureTime: 1002,
        temporalRole: 'pre_session',
        createdAt: 1002,
      },
      {
        id: snapB1,
        sessionId,
        generationId: genB,
        ordering: 3,
        captureTime: 1003,
        temporalRole: 'pre_session',
        createdAt: 1003,
      },
    ];

    const session = {
      id: sessionId,
      environmentId,
      projectId,
      portfolioId,
      currentGenerationId: genB,
      harness: 'test-harness',
      occurrenceTime: null,
      finality: 'final',
    };
    await executor.transaction(async (tx) => {
      await (
        engine as unknown as {
          rebuildSessionLifecycleExposuresCohorts: (
            tx: unknown,
            session: unknown,
            snapshots: unknown,
            sessionsById: unknown,
          ) => Promise<void>;
        }
      ).rebuildSessionLifecycleExposuresCohorts(tx, session, snapshots, new Map());
    });

    const lifecycleBySnap: Record<
      string,
      { event_type: string; before_version_id: string | null; after_version_id: string | null }[]
    > = {};
    for (const id of [snapA0, snapB0, snapA1, snapB1]) {
      const { rows } = await executor.exec(
        'SELECT event_type, before_version_id, after_version_id FROM component_lifecycle_events WHERE snapshot_id = ?',
        [id],
      );
      lifecycleBySnap[id] = rows as {
        event_type: string;
        before_version_id: string | null;
        after_version_id: string | null;
      }[];
    }

    expect(lifecycleBySnap[snapA0][0].event_type).toBe('baseline');
    expect(lifecycleBySnap[snapA0][0].after_version_id).toBe(v1);

    expect(lifecycleBySnap[snapB0][0].event_type).toBe('baseline');
    expect(lifecycleBySnap[snapB0][0].after_version_id).toBe(v1);

    expect(lifecycleBySnap[snapA1][0].event_type).toBe('updated');
    expect(lifecycleBySnap[snapA1][0].before_version_id).toBe(v1);
    expect(lifecycleBySnap[snapA1][0].after_version_id).toBe(v2);

    expect(lifecycleBySnap[snapB1][0].event_type).toBe('updated');
    expect(lifecycleBySnap[snapB1][0].before_version_id).toBe(v1);
    expect(lifecycleBySnap[snapB1][0].after_version_id).toBe(v2);
  });
});
