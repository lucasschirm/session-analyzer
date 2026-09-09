import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deterministicId,
  deterministicPortfolioId,
  FRESH_SCHEMA_SQL,
  type SqliteExecutor,
} from '@lucasschirm/sal-db-core';
import type { ManifestSchemaVersion, SyncManifest } from '@lucasschirm/sal-sync-core';
import { MANIFEST_SCHEMA_VERSION } from '@lucasschirm/sal-sync-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import type {
  Artifact,
  ArtifactContent,
  SourceIdentity,
  TransformContext,
  TransformResult,
  UnknownArtifactBundle,
} from '@lucasschirm/sal-transformer-shared';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import {
  createSha256ContentHasher,
  DefaultIngestionOrchestrator,
  type IngestionContext,
  type IngestionReceipt,
} from '../../src/ingestion.js';
import {
  type ManualIngestionFlowInput,
  ManualIngestionOrchestrator,
} from '../../src/manual-ingestion.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '../../../parsers/claude-session-parser/tests/fixtures');

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

async function createExecutor(): Promise<WasmSqliteExecutor> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  return executor;
}

function createIngestionContext(executor: SqliteExecutor): IngestionContext {
  return {
    executor,
    hasher: createSha256ContentHasher(),
    registry: createDefaultRegistry(),
    resolver: { resolve: async (ref) => ({ ...ref, content: new Uint8Array(0) }) },
    analysisReleaseId: 'ar-default',
  };
}

function createManualBundle(
  artifacts: Artifact<ArtifactContent>[],
  overrides?: Partial<ManualIngestionFlowInput>,
): ManualIngestionFlowInput {
  return {
    projectId: 'project-fixture',
    sessionId: 'sess-happy-1',
    source: { sourceId: 'default', environmentId: 'dev' },
    harness: 'claude-code',
    ...overrides,
    artifacts,
  };
}

async function hashArtifact(
  hasher: IngestionContext['hasher'],
  artifact: Artifact<ArtifactContent>,
): Promise<string> {
  return artifact.sha256 ?? (artifact.content ? await hasher.hash(artifact.content) : '');
}

function reassignTranscriptSession(content: string, sessionId: string, uuidPrefix: string): string {
  const originalSessionMatch = /"sessionId": "([^"]+)"/.exec(content);
  const originalSession = originalSessionMatch ? originalSessionMatch[1] : 'unknown';
  let updated = content.replace(
    new RegExp(`"sessionId": "${originalSession}"`, 'g'),
    `"sessionId": "${sessionId}"`,
  );
  updated = updated.replace(/"uuid": "([^"]+)"/g, (_, uuid) => `"uuid": "${uuidPrefix}${uuid}"`);
  return updated;
}

async function sourceFingerprintFor(
  hasher: IngestionContext['hasher'],
  artifacts: Artifact<ArtifactContent>[],
): Promise<string> {
  const fingerprints: string[] = [];
  for (const artifact of artifacts) {
    const sha256 = await hashArtifact(hasher, artifact);
    fingerprints.push(`${artifact.relativePath}:${sha256}`);
  }
  fingerprints.sort();
  return hasher.hash(fingerprints.join('\n'));
}

/**
 * Simulates an authoritative sync with a richer artifact set using the
 * existing DefaultIngestionOrchestrator.commitAtomic path. This bypasses the
 * source-identity bug in DefaultIngestionOrchestrator.ingestManifest by
 * supplying a pre-resolved source identity and a SyncManifest directly.
 */
async function ingestAuthoritativeSync(
  defaultOrchestrator: DefaultIngestionOrchestrator,
  context: IngestionContext,
  _executor: SqliteExecutor,
  source: SourceIdentity,
  projectId: string,
  sessionId: string,
  artifacts: Artifact<ArtifactContent>[],
): Promise<IngestionReceipt> {
  const hasher = context.hasher;
  const registry = context.registry;
  const sourceFingerprint = await sourceFingerprintFor(hasher, artifacts);

  const transformer = registry.resolve('claude-code');
  const artifactBundle: UnknownArtifactBundle = {
    artifacts: artifacts as Artifact<unknown>[],
    sourceIdentity: source,
    sourceFingerprint,
  };

  const transformContext: TransformContext = {
    analysisReleaseId: context.analysisReleaseId,
    parserId: transformer.id,
    parserVersion: '0.1.0',
    sourceFingerprint,
    sourceEnvironmentId: source.environmentId,
    sourceProjectId: source.projectId,
    sourceSessionId: source.sessionId,
  };

  const result: TransformResult = transformer.transform(artifactBundle, transformContext);

  const rootSession =
    result.sessionSummaries.find((s) => s.rootSessionId === s.sessionId) ??
    result.sessionSummaries[0];
  if (!rootSession) {
    throw new Error('sync result produced no root session');
  }

  const portfolioId = deterministicPortfolioId('ten-default', 'default');
  const canonicalProjectId = `prj-${deterministicId('project', portfolioId, projectId)}`;

  const generationId = `gen-${deterministicId(
    'generation',
    canonicalProjectId,
    sessionId,
    sourceFingerprint,
    context.analysisReleaseId,
    result.parserVersion,
    result.transformerVersion,
    result.ontologyVersion,
    result.metricDefinitionVersion,
  )}`;

  const mainTranscript = artifacts.find(
    (a) => a.mediaType === 'application/jsonl' || a.relativePath.endsWith('.jsonl'),
  );

  const manifest: SyncManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION as ManifestSchemaVersion,
    projectId,
    sessionId,
    harness: 'claude-code',
    harnessVersion: '0.1.0',
    syncVersion: '0.1.0',
    pluginVersion: '0.1.0',
    sourceEnvironmentNamespace: source.sourceId,
    environmentId: source.environmentId,
    finality: 'partial',
    captureTime: new Date().toISOString(),
    ingestionTime: new Date().toISOString(),
    sequenceNumber: 0,
    transcriptsCaptured: mainTranscript !== undefined,
    mainTranscriptRelativePath: mainTranscript?.relativePath,
    artifacts: [],
    syncRuns: [],
  };

  return defaultOrchestrator.commitAtomic({
    generationId,
    sessionId: rootSession.sessionId,
    rootSessionId: rootSession.rootSessionId,
    affectedProjectIds: [canonicalProjectId],
    candidateRecords: [],
    analysisReleaseId: context.analysisReleaseId,
    result,
    manifest,
    source,
  });
}

describe('ManualIngestionOrchestrator', () => {
  it('ingests a transcript-only manual bundle end-to-end', async () => {
    const executor = await createExecutor();
    const context = createIngestionContext(executor);
    const orchestrator = new ManualIngestionOrchestrator(context);

    const transcript = readFixture('t2-happy-path.jsonl');
    const bundle = createManualBundle([
      {
        relativePath: 'session/transcript.jsonl',
        mediaType: 'application/jsonl',
        content: transcript,
      },
    ]);

    const receipt = await orchestrator.ingestManual(bundle);

    expect(receipt.status).toBe('committed');
    expect(receipt.issueIds).toEqual([]);
    expect(receipt.sessionId).toBeTruthy();

    const { rows: sessionRows } = await executor.exec(
      'SELECT id, current_generation_id, finality, native_session_id, project_id, ingestion_source_id FROM sessions WHERE id = ?',
      [receipt.sessionId],
    );
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]?.current_generation_id).toBe(receipt.generationId);
    expect(sessionRows[0]?.finality).toBe('open');
    expect(sessionRows[0]?.native_session_id).toBe('sess-happy-1');
    expect(sessionRows[0]?.project_id).toBeTruthy();
    expect(sessionRows[0]?.ingestion_source_id).toMatch(/^src-/);

    const { rows: metricValues } = await executor.exec(
      'SELECT COUNT(*) AS c FROM metric_values WHERE generation_id = ?',
      [receipt.generationId],
    );
    expect(metricValues[0]?.c).toBeGreaterThan(0);

    const { rows: evidence } = await executor.exec(
      'SELECT COUNT(*) AS c FROM normalized_events WHERE generation_id = ?',
      [receipt.generationId],
    );
    expect(evidence[0]?.c).toBeGreaterThan(0);
  });

  it('preserves directory-relative paths and records the supplied-file inventory', async () => {
    const executor = await createExecutor();
    const context = createIngestionContext(executor);
    const orchestrator = new ManualIngestionOrchestrator(context);

    const bundle = createManualBundle(
      [
        {
          relativePath: 'session/transcript.jsonl',
          mediaType: 'application/jsonl',
          content: readFixture('t2-happy-path.jsonl'),
        },
        {
          relativePath: '.claude/skills/example-skill/SKILL.md',
          mediaType: 'text/markdown',
          content: readFixture('t7-skill-full.md'),
        },
      ],
      { sessionId: 'sess-inventory-1', importBatchId: 'batch-abc-123' },
    );

    const receipt = await orchestrator.ingestManual(bundle);
    expect(receipt.status).toBe('committed');

    const { rows } = await executor.exec(
      'SELECT id, raw_metadata FROM source_manifests WHERE session_id = ?',
      [receipt.sessionId],
    );
    expect(rows).toHaveLength(1);

    const raw = JSON.parse(String(rows[0]?.raw_metadata ?? '{}'));
    expect(raw.importBatchId).toBe('batch-abc-123');
    expect(raw.suppliedFileInventory).toHaveLength(2);
    const paths = raw.suppliedFileInventory.map(
      (item: { relativePath: string }) => item.relativePath,
    );
    expect(paths).toContain('session/transcript.jsonl');
    expect(paths).toContain('.claude/skills/example-skill/SKILL.md');
    expect(raw.detection.kind).toBe('matched');
    expect(raw.detection.harness).toBe('claude-code');

    // Native source and session identity are recorded on the source manifest.
    const { rows: manifestRows } = await executor.exec(
      'SELECT native_project_id, native_session_id, finality, sequence_number FROM source_manifests WHERE id = ?',
      [rows[0]?.id],
    );
    expect(manifestRows[0]?.native_project_id).toBe('project-fixture');
    expect(manifestRows[0]?.native_session_id).toBe('sess-inventory-1');
    expect(manifestRows[0]?.finality).toBe('partial');
    expect(manifestRows[0]?.sequence_number).toBe(-1);
  });

  it('is idempotent for the same manual bundle', async () => {
    const executor = await createExecutor();
    const context = createIngestionContext(executor);
    const orchestrator = new ManualIngestionOrchestrator(context);

    const bundle = createManualBundle([
      {
        relativePath: 'session/transcript.jsonl',
        mediaType: 'application/jsonl',
        content: readFixture('t2-happy-path.jsonl'),
      },
    ]);

    const first = await orchestrator.ingestManual(bundle);
    expect(first.status).toBe('committed');

    const second = await orchestrator.ingestManual(bundle);
    expect(second.status).toBe('committed');
    expect(second.generationId).toBe(first.generationId);
    expect(second.sessionId).toBe(first.sessionId);

    const { rows } = await executor.exec('SELECT COUNT(*) AS c FROM transformation_generations');
    expect(rows[0]?.c).toBe(1);
  });

  it('fails with manual_conflict for a different manual bundle on the same session', async () => {
    const executor = await createExecutor();
    const context = createIngestionContext(executor);
    const orchestrator = new ManualIngestionOrchestrator(context);

    const firstBundle = createManualBundle([
      {
        relativePath: 'session/transcript.jsonl',
        mediaType: 'application/jsonl',
        content: readFixture('t2-happy-path.jsonl'),
      },
    ]);

    const first = await orchestrator.ingestManual(firstBundle);
    expect(first.status).toBe('committed');

    const secondBundle = createManualBundle([
      {
        relativePath: 'session/transcript.jsonl',
        mediaType: 'application/jsonl',
        content: readFixture('t2-happy-path.jsonl'),
      },
      {
        relativePath: '.claude/skills/example-skill/SKILL.md',
        mediaType: 'text/markdown',
        content: readFixture('t7-skill-full.md'),
      },
    ]);

    const second = await orchestrator.ingestManual(secondBundle);
    expect(second.status).toBe('failed');
    expect(second.issueIds).toContain('manual_conflict');
    expect(second.generationId).not.toBe(first.generationId);

    const { rows } = await executor.exec(
      'SELECT current_generation_id FROM sessions WHERE id = ?',
      [first.sessionId],
    );
    expect(rows[0]?.current_generation_id).toBe(first.generationId);
  });

  it('marks the configuration snapshot as partial and never complete', async () => {
    const executor = await createExecutor();
    const context = createIngestionContext(executor);
    const orchestrator = new ManualIngestionOrchestrator(context);

    const bundle = createManualBundle(
      [
        {
          relativePath: '.claude/skills/example-skill/SKILL.md',
          mediaType: 'text/markdown',
          content: readFixture('t7-skill-full.md'),
        },
        {
          relativePath: 'session/transcript.jsonl',
          mediaType: 'application/jsonl',
          content: readFixture('t2-happy-path.jsonl'),
        },
      ],
      { sessionId: 'sess-partial-1' },
    );

    const receipt = await orchestrator.ingestManual(bundle);
    expect(receipt.status).toBe('committed');

    const { rows } = await executor.exec(
      'SELECT source_completeness FROM session_summaries WHERE session_id = ?',
      [receipt.sessionId],
    );
    expect(rows).toHaveLength(2); // root_only and inclusive

    for (const row of rows) {
      const parsed = JSON.parse(String(row.source_completeness ?? '{}'));
      const values = Object.values(parsed.completeness ?? {}) as string[];
      expect(values).not.toContain('complete');
      for (const value of values) {
        expect(['partial', 'unavailable', 'unsupported']).toContain(value);
      }
    }
  });

  it('does not fabricate lifecycle events or exposure denominators', async () => {
    const executor = await createExecutor();
    const context = createIngestionContext(executor);
    const orchestrator = new ManualIngestionOrchestrator(context);

    const bundle = createManualBundle([
      {
        relativePath: 'session/transcript.jsonl',
        mediaType: 'application/jsonl',
        content: readFixture('t2-happy-path.jsonl'),
      },
    ]);

    await orchestrator.ingestManual(bundle);

    const { rows: lifecycle } = await executor.exec(
      'SELECT COUNT(*) AS c FROM component_lifecycle_events',
    );
    expect(lifecycle[0]?.c).toBe(0);

    const { rows: availability } = await executor.exec(
      'SELECT COUNT(*) AS c FROM component_availability_events',
    );
    expect(availability[0]?.c).toBe(0);

    const { rows: exposure } = await executor.exec(
      'SELECT COUNT(*) AS c FROM session_component_exposures',
    );
    expect(exposure[0]?.c).toBe(0);

    const { rows: snapshots } = await executor.exec(
      'SELECT COUNT(*) AS c FROM configuration_snapshots',
    );
    expect(snapshots[0]?.c).toBe(0);
  });

  it('rejects an ambiguous or unmatched manual detection', async () => {
    const executor = await createExecutor();
    const context = createIngestionContext(executor);
    const orchestrator = new ManualIngestionOrchestrator(context);

    const bundle: ManualIngestionFlowInput = {
      projectId: 'project-fixture',
      sessionId: 'sess-unmatched-1',
      source: { sourceId: 'default' },
      artifacts: [
        {
          relativePath: 'unknown.bin',
          mediaType: 'application/octet-stream',
          content: new Uint8Array([0, 1, 2, 3]),
        },
      ],
    };

    const receipt = await orchestrator.ingestManual(bundle);
    expect(receipt.status).toBe('failed');
    expect(receipt.issueIds[0]).toMatch(/^manual_harness_/);
  });

  it('enables a later authoritative sync to replace the manual generation without duplication', async () => {
    const executor = await createExecutor();
    const context = createIngestionContext(executor);
    const orchestrator = new ManualIngestionOrchestrator(context);
    const defaultOrchestrator = new DefaultIngestionOrchestrator(context);

    const source: SourceIdentity = {
      sourceId: 'default',
      environmentId: 'dev',
      projectId: 'project-fixture',
      sessionId: 'sess-happy-1',
    };

    const manualArtifacts: Artifact<ArtifactContent>[] = [
      {
        relativePath: 'session/transcript.jsonl',
        mediaType: 'application/jsonl',
        content: readFixture('t2-happy-path.jsonl'),
      },
    ];

    const manual = await orchestrator.ingestManual(createManualBundle(manualArtifacts, { source }));
    expect(manual.status).toBe('committed');

    const syncArtifacts: Artifact<ArtifactContent>[] = [
      {
        relativePath: 'session/transcript.jsonl',
        mediaType: 'application/jsonl',
        content: reassignTranscriptSession(
          readFixture('t2-usage-aggregation.jsonl'),
          'sess-happy-1',
          'sync-',
        ),
      },
      {
        relativePath: '.claude/skills/example-skill/SKILL.md',
        mediaType: 'text/markdown',
        content: readFixture('t7-skill-full.md'),
      },
    ];

    const sync = await ingestAuthoritativeSync(
      defaultOrchestrator,
      context,
      executor,
      source,
      'project-fixture',
      'sess-happy-1',
      syncArtifacts,
    );
    expect(sync.status).toBe('committed');
    expect(sync.generationId).not.toBe(manual.generationId);

    const { rows: sessions } = await executor.exec(
      'SELECT id, current_generation_id, ingestion_source_id, native_session_id FROM sessions',
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(manual.sessionId);
    expect(sessions[0]?.current_generation_id).toBe(sync.generationId);

    const { rows: generations } = await executor.exec(
      'SELECT id, superseded_at FROM transformation_generations ORDER BY created_at',
    );
    expect(generations).toHaveLength(2);
    expect(generations[0]?.superseded_at).toBeTruthy();
    expect(generations[1]?.id).toBe(sync.generationId);

    const { rows: sourceManifests } = await executor.exec(
      'SELECT COUNT(*) AS c FROM source_manifests',
    );
    expect(sourceManifests[0]?.c).toBe(2);

    const { rows: metrics } = await executor.exec(
      'SELECT COUNT(*) AS c FROM metric_values WHERE generation_id = ?',
      [sync.generationId],
    );
    expect(metrics[0]?.c).toBeGreaterThan(0);
  });

  it('fails when a manual bundle conflicts with an existing authoritative sync', async () => {
    const executor = await createExecutor();
    const context = createIngestionContext(executor);
    const orchestrator = new ManualIngestionOrchestrator(context);
    const defaultOrchestrator = new DefaultIngestionOrchestrator(context);

    const source: SourceIdentity = {
      sourceId: 'default',
      environmentId: 'dev',
      projectId: 'project-fixture',
      sessionId: 'sess-happy-1',
    };

    const syncArtifacts: Artifact<ArtifactContent>[] = [
      {
        relativePath: 'session/transcript.jsonl',
        mediaType: 'application/jsonl',
        content: reassignTranscriptSession(
          readFixture('t2-usage-aggregation.jsonl'),
          'sess-happy-1',
          'sync-',
        ),
      },
      {
        relativePath: '.claude/skills/example-skill/SKILL.md',
        mediaType: 'text/markdown',
        content: readFixture('t7-skill-full.md'),
      },
    ];

    const sync = await ingestAuthoritativeSync(
      defaultOrchestrator,
      context,
      executor,
      source,
      'project-fixture',
      'sess-happy-1',
      syncArtifacts,
    );
    expect(sync.status).toBe('committed');

    const manual = await orchestrator.ingestManual(
      createManualBundle(
        [
          {
            relativePath: 'session/transcript.jsonl',
            mediaType: 'application/jsonl',
            content: readFixture('t2-happy-path.jsonl'),
          },
        ],
        { source, sessionId: 'sess-happy-1' },
      ),
    );
    expect(manual.status).toBe('failed');
    expect(manual.issueIds).toContain('manual_conflict');
  });

  it('supports transcript-only inputs that have lost directory context', async () => {
    const executor = await createExecutor();
    const context = createIngestionContext(executor);
    const orchestrator = new ManualIngestionOrchestrator(context);

    const bundle = createManualBundle(
      [
        {
          relativePath: 'transcript.jsonl',
          mediaType: 'application/jsonl',
          content: readFixture('t2-happy-path.jsonl'),
        },
      ],
      { sessionId: 'sess-browser-1' },
    );

    const receipt = await orchestrator.ingestManual(bundle);
    expect(receipt.status).toBe('committed');

    const { rows } = await executor.exec(
      'SELECT raw_metadata FROM source_manifests WHERE native_session_id = ?',
      ['sess-browser-1'],
    );
    const raw = JSON.parse(String(rows[0]?.raw_metadata ?? '{}'));
    expect(raw.suppliedFileInventory[0]?.relativePath).toBe('transcript.jsonl');
  });
});
