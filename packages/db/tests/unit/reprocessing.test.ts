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
} from '@lucasschirm/sal-transformer-shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import type { ArtifactResolver, ResolvedArtifact } from '../../src/ports.js';
import { RebuildFrontierEngine } from '../../src/rebuild-frontiers.js';
import { DefaultReprocessingEngine, type RebuildFrontier } from '../../src/reprocessing.js';

function requireFrontier(frontier: RebuildFrontier | undefined): RebuildFrontier {
  if (!frontier) throw new Error('Frontier expected to be defined');
  return frontier;
}

const ANALYSIS_RELEASE_ID = 'release-1';
const ANALYSIS_RELEASE_2 = 'release-2';

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

describe('DefaultReprocessingEngine', () => {
  let executor: WasmSqliteExecutor;
  let registry: TransformerRegistry;
  let transformer: StubTransformer;
  let hasher: ReturnType<typeof createSha256ContentHasher>;
  let resolver: ArtifactResolver;
  let engine: DefaultReprocessingEngine;
  let frontierEngine: RebuildFrontierEngine;

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

    engine = new DefaultReprocessingEngine({
      executor,
      resolver,
      hasher,
      registry,
      analysisReleaseId: ANALYSIS_RELEASE_ID,
    });
    frontierEngine = new RebuildFrontierEngine({ executor });
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

  async function lifecycleEvidenceCounts(
    sessionId: string,
    generationId: string,
    snapshotId: string,
  ): Promise<
    Record<'exposures' | 'lifecycle' | 'availability' | 'context' | 'cohort' | 'insight', number>
  > {
    const count = async (sql: string, params: unknown[]) =>
      Number((await executor.exec(sql, params)).rows[0].n);
    const queries: Record<string, [string, unknown[]]> = {
      exposures: [
        `SELECT COUNT(*) AS n FROM session_component_exposures WHERE session_id = ? AND COALESCE(generation_id, '') = ?`,
        [sessionId, generationId],
      ],
      lifecycle: [
        `SELECT COUNT(*) AS n FROM component_lifecycle_events WHERE snapshot_id = ?`,
        [snapshotId],
      ],
      availability: [
        `SELECT COUNT(*) AS n FROM component_availability_events WHERE session_id = ? AND COALESCE(generation_id, '') = ?`,
        [sessionId, generationId],
      ],
      context: [
        `SELECT COUNT(*) AS n FROM component_context_events WHERE session_id = ? AND COALESCE(generation_id, '') = ?`,
        [sessionId, generationId],
      ],
      cohort: [
        `SELECT COUNT(*) AS n FROM comparison_cohort_members WHERE session_id = ? AND COALESCE(generation_id, '') = ?`,
        [sessionId, generationId],
      ],
      insight: [
        `SELECT COUNT(*) AS n FROM insight_evidence WHERE generation_id = ?`,
        [generationId],
      ],
    };
    const result: Record<string, number> = {};
    for (const [key, [sql, params]] of Object.entries(queries)) {
      result[key] = await count(sql, params);
    }
    return result as ReturnType<typeof lifecycleEvidenceCounts>;
  }

  it('rebuilds frontier contributions and rollups for existing sessions', async () => {
    const sessionId = await ingestSession('session-1', Date.UTC(2026, 0, 1, 10, 0, 0));

    const frontier = await engine.computeFrontier(sessionId, 'late_insert');
    expect(frontier).toBeDefined();

    const report = await engine.rebuildFrontier(requireFrontier(frontier), ANALYSIS_RELEASE_ID);
    expect(report.sessionsProcessed).toBe(1);
    expect(report.failures).toHaveLength(0);
    expect(report.contributionsApplied).toBeGreaterThan(0);

    const { rows } = await executor.exec(
      'SELECT * FROM rollup_contributions WHERE session_id = ?',
      [sessionId],
    );
    expect(rows.length).toBeGreaterThan(0);

    const { rows: rollups } = await executor.exec(
      'SELECT * FROM project_daily_rollups WHERE analysis_release_id = ?',
      [ANALYSIS_RELEASE_ID],
    );
    expect(rollups.length).toBeGreaterThan(0);
  });

  it('preserves prior generation when source is unavailable', async () => {
    const sessionId = await ingestSession('session-unavailable', Date.UTC(2026, 0, 2, 10, 0, 0));

    const { rows: before } = await executor.exec(
      'SELECT current_generation_id FROM sessions WHERE id = ?',
      [sessionId],
    );
    const generationBefore = String(before[0].current_generation_id);

    await executor.exec(
      "UPDATE source_manifests SET reprocessing_status = 'unavailable' WHERE session_id = ?",
      [sessionId],
    );

    const report = await engine.reprocessSession(sessionId, ANALYSIS_RELEASE_2);
    expect(report.sessionsUnavailable).toBe(1);

    const { rows: after } = await executor.exec(
      'SELECT current_generation_id FROM sessions WHERE id = ?',
      [sessionId],
    );
    expect(String(after[0].current_generation_id)).toBe(generationBefore);
  });

  it('reprocesses from remote source when resolver can reacquire artifacts', async () => {
    const sessionId = await ingestSession('session-reacquire', Date.UTC(2026, 0, 3, 10, 0, 0));

    const { rows: before } = await executor.exec(
      'SELECT current_generation_id FROM sessions WHERE id = ?',
      [sessionId],
    );
    const generationBefore = String(before[0].current_generation_id);

    transformer.setSessionValue(sessionId, 100);

    const report = await engine.reprocessSession(sessionId, ANALYSIS_RELEASE_2);
    expect(report.sessionsProcessed).toBe(1);
    expect(report.sessionsUnavailable).toBe(0);
    expect(report.failures).toHaveLength(0);

    const { rows: after } = await executor.exec(
      'SELECT current_generation_id FROM sessions WHERE id = ?',
      [sessionId],
    );
    const generationAfter = String(after[0].current_generation_id);
    expect(generationAfter).not.toBe(generationBefore);

    const { rows: values } = await executor.exec(
      `SELECT mv.integer_value FROM metric_values mv
       JOIN transformation_generations g ON g.id = mv.generation_id
       WHERE mv.session_id = ? AND g.analysis_release_id = ?`,
      [sessionId, ANALYSIS_RELEASE_2],
    );
    expect(values.length).toBeGreaterThan(0);
    expect(values[0].integer_value).toBe(100);
  });

  it('deletes a session and subtracts its contributions', async () => {
    const sessionId = await ingestSession('session-delete', Date.UTC(2026, 0, 4, 10, 0, 0));
    const frontier = await engine.computeFrontier(sessionId, 'deletion');
    await engine.rebuildFrontier(requireFrontier(frontier), ANALYSIS_RELEASE_ID);

    const { rows: before } = await executor.exec(
      'SELECT * FROM rollup_contributions WHERE session_id = ?',
      [sessionId],
    );
    expect(before.length).toBeGreaterThan(0);

    const { rows: sessionRow } = await executor.exec(
      'SELECT s.project_id, src.portfolio_id FROM sessions s JOIN ingestion_sources src ON src.id = s.ingestion_source_id WHERE s.id = ?',
      [sessionId],
    );
    await engine.deleteSession(
      sessionId,
      String(sessionRow[0].project_id),
      String(sessionRow[0].portfolio_id),
    );

    const { rows: afterSession } = await executor.exec('SELECT * FROM sessions WHERE id = ?', [
      sessionId,
    ]);
    expect(afterSession.length).toBe(0);

    const { rows: afterContributions } = await executor.exec(
      'SELECT * FROM rollup_contributions WHERE session_id = ?',
      [sessionId],
    );
    expect(afterContributions.length).toBe(0);
  });

  it('records authoritative tombstones and removes matching source sessions', async () => {
    const sessionId = await ingestSession('session-tombstone', Date.UTC(2026, 0, 5, 10, 0, 0));
    const { rows: sessionRows } = await executor.exec(
      'SELECT s.ingestion_source_id, s.native_session_id, src.portfolio_id FROM sessions s JOIN ingestion_sources src ON src.id = s.ingestion_source_id WHERE s.id = ?',
      [sessionId],
    );
    const ingestionSourceId = String(sessionRows[0].ingestion_source_id);
    const nativeSessionId = String(sessionRows[0].native_session_id);
    const portfolioId = String(sessionRows[0].portfolio_id);

    await engine.recordAuthoritativeTombstone(
      {
        ingestionSourceId,
        sourceType: 'session',
        sourceId: nativeSessionId,
        tombstoneAuthority: 'test',
      },
      portfolioId,
    );

    const { rows } = await executor.exec('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    expect(rows.length).toBe(0);
  });

  it('rebuilds stale rollups with current generation', async () => {
    const sessionId = await ingestSession('session-stale', Date.UTC(2026, 0, 6, 10, 0, 0));
    const frontier = await engine.computeFrontier(sessionId, 'reclassification');
    await engine.rebuildFrontier(requireFrontier(frontier), ANALYSIS_RELEASE_ID);

    const { rows: before } = await executor.exec(
      'SELECT generation_id FROM project_daily_rollups WHERE analysis_release_id = ? LIMIT 1',
      [ANALYSIS_RELEASE_ID],
    );
    const staleGeneration = String(before[0].generation_id);

    await executor.exec(
      `INSERT INTO transformation_generations
         (id, session_id, analysis_release_id, parser_version, transformer_version,
          ontology_version, metric_version, schema_version, status, source_availability, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'stale-generation',
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

    await executor.exec(
      'UPDATE project_daily_rollups SET generation_id = ? WHERE analysis_release_id = ?',
      ['stale-generation', ANALYSIS_RELEASE_ID],
    );

    await engine.rebuildFrontier(requireFrontier(frontier), ANALYSIS_RELEASE_ID);

    const { rows: after } = await executor.exec(
      'SELECT generation_id FROM project_daily_rollups WHERE analysis_release_id = ? LIMIT 1',
      [ANALYSIS_RELEASE_ID],
    );
    expect(String(after[0].generation_id)).not.toBe('stale-generation');
    expect(String(after[0].generation_id)).toBe(staleGeneration);
  });

  it('records out-of-order manifest ordering and rebuilds frontier', async () => {
    const sessionId = await ingestSession('session-ooo', Date.UTC(2026, 0, 7, 10, 0, 0));

    const { rows } = await executor.exec(
      'SELECT sm.id, src.portfolio_id FROM source_manifests sm JOIN ingestion_sources src ON src.id = sm.ingestion_source_id WHERE sm.session_id = ?',
      [sessionId],
    );
    const sourceManifestId = String(rows[0].id);
    const portfolioId = String(rows[0].portfolio_id);

    const report = await engine.recordOutOfOrderManifest({
      sourceManifestId,
      occurrenceTime: Date.UTC(2026, 0, 7, 9, 0, 0),
      captureTime: Date.UTC(2026, 0, 7, 9, 0, 0),
      ingestionTime: Date.UTC(2026, 0, 7, 9, 0, 0),
      canonicalSequenceNumber: 1,
      orderingConfidence: 0.95,
      portfolioId,
    });

    expect(report.sessionsProcessed).toBeGreaterThanOrEqual(0);

    const { rows: updated } = await executor.exec(
      'SELECT sequence_number, occurrence_time FROM source_manifests WHERE id = ?',
      [sourceManifestId],
    );
    expect(Number(updated[0].sequence_number)).toBe(1);
    expect(Number(updated[0].occurrence_time)).toBe(Date.UTC(2026, 0, 7, 9, 0, 0));
  });

  it('performs privacy erasure and rebuilds frontier', async () => {
    const sessionId = await ingestSession('session-erasure', Date.UTC(2026, 0, 8, 10, 0, 0));
    const frontier = await engine.computeFrontier(sessionId, 'deletion');

    const { rows: sessionRow } = await executor.exec(
      'SELECT s.project_id, src.portfolio_id FROM sessions s JOIN ingestion_sources src ON src.id = s.ingestion_source_id WHERE s.id = ?',
      [sessionId],
    );

    const report = await engine.privacyErasure(
      sessionId,
      requireFrontier(frontier).projectId,
      String(sessionRow[0].portfolio_id),
    );

    expect(report.sessionsProcessed).toBe(1);

    const { rows } = await executor.exec('SELECT finality FROM sessions WHERE id = ?', [sessionId]);
    expect(String(rows[0].finality)).toBe('censored');
  });

  it('reconciles rollups after rebuild', async () => {
    const sessionId = await ingestSession('session-reconcile', Date.UTC(2026, 0, 9, 10, 0, 0));
    const frontier = await engine.computeFrontier(sessionId, 'reclassification');
    const report = await engine.rebuildFrontier(requireFrontier(frontier), ANALYSIS_RELEASE_ID);

    expect(report.rollupsReconciled).toBe(true);
  });

  it('transitions source manifests to remote_reacquirable when a local blob is purged', async () => {
    const sessionId = await ingestSession('session-purge', Date.UTC(2026, 0, 10, 10, 0, 0));
    const { manifest } = await makeManifest('session-purge', Date.UTC(2026, 0, 10, 10, 0, 0));
    const artifact = manifest.artifacts[0];
    if (!artifact) throw new Error('Expected at least one artifact');

    await engine.purgeLocalBlob(artifact.sha256);

    const { rows } = await executor.exec(
      'SELECT reprocessing_status FROM source_manifests WHERE session_id = ?',
      [sessionId],
    );
    expect(rows.length).toBe(1);
    expect(String(rows[0]?.reprocessing_status)).toBe('remote_reacquirable');
  });

  it('preserves lifecycle evidence across reprocess generations', async () => {
    const tA = Date.UTC(2026, 0, 11, 10, 0, 0);
    const sessionId = await ingestSession('session-reprocess-gen', tA);

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

    const componentId = 'comp-reprocess-preserve';
    await ComponentIdentityStore.insert(executor, {
      id: componentId,
      portfolioId,
      kind: 'tool',
      canonicalSourceIdentity: 'comp://reprocess-preserve',
    });
    const versionA = 'cv-reprocess-preserve-a';
    await ComponentVersionStore.insert(executor, {
      id: versionA,
      componentId,
      contentHash: 'hash-reprocess-a',
    });

    const snapAId = 'cs-reprocess-preserve-a';
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
      id: 'sc-reprocess-preserve-a',
      snapshotId: snapAId,
      componentVersionId: versionA,
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
    const reportA = await frontierEngine.rebuildFrontier(frontierA, ANALYSIS_RELEASE_ID);
    expect(reportA.sessionsProcessed).toBe(1);
    expect(reportA.failures).toHaveLength(0);

    const before = await lifecycleEvidenceCounts(sessionId, genA, snapAId);
    for (const value of Object.values(before)) {
      expect(value).toBeGreaterThan(0);
    }

    const reportB = await engine.reprocessSession(sessionId, ANALYSIS_RELEASE_2);
    expect(reportB.sessionsProcessed).toBe(1);
    expect(reportB.failures).toHaveLength(0);

    const { rows: afterSession } = await executor.exec(
      'SELECT current_generation_id FROM sessions WHERE id = ?',
      [sessionId],
    );
    const genB = String(afterSession[0].current_generation_id);
    expect(genB).not.toBe(genA);

    const after = await lifecycleEvidenceCounts(sessionId, genA, snapAId);
    expect(after).toEqual(before);
  });
});
