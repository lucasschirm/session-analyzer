import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FRESH_SCHEMA_SQL,
  getCurrentGenerationId,
  NormalizedEventStore,
  SessionContextSeriesStore,
} from '@lucasschirm/sal-db-core';
import { MANIFEST_SCHEMA_VERSION } from '@lucasschirm/sal-sync-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import { describe, expect, it, vi } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createAnalyticsDataSource } from '../../src/analytics.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import { FailureInjectionExecutor } from './harness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '../../../parsers/claude-session-parser/tests/fixtures');

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

const PROJECT_ID = 'project-pipe021';
const SESSION_ID = 'sess-pipe021';
const ANALYSIS_RELEASE_ID = 'ar-pipe021';

/**
 * PIPE-021: the ingest-time context-growth series (`session_context_series`)
 * is materialized inside the atomic generation commit, serves
 * `getContextTimingSeries` without touching `normalized_events`, and is
 * replaced (never duplicated) on re-ingestion. Also pins the pointer-only
 * `raw_details` skeleton contract introduced alongside it.
 */

function createManifestFixture(content: string, sha256: string) {
  const relativePath = 'session/transcript.jsonl';
  return {
    manifest: {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      harness: 'claude-code',
      harnessVersion: '0.1.0',
      syncVersion: '0.1.0',
      pluginVersion: '0.1.0',
      transcriptsCaptured: true,
      mainTranscriptRelativePath: relativePath,
      artifacts: [
        {
          relativePath,
          scope: 'session' as const,
          mediaType: 'application/jsonl',
          sha256,
          size: content.length,
          status: 'uploaded' as const,
        },
      ],
      syncRuns: [],
      syncRunsCount: 0,
    },
    resolvedArtifacts: [
      {
        relativePath,
        mediaType: 'application/jsonl',
        sha256,
        size: content.length,
        content,
      },
    ],
    integrityVerified: false,
    source: {
      sourceId: 'default',
      environmentId: 'dev',
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
    },
  };
}

async function setupPipeline() {
  const inner = await WasmSqliteExecutor.create();
  await inner.exec(FRESH_SCHEMA_SQL);
  const harness = new FailureInjectionExecutor(inner);
  harness.setInjection(undefined);
  const orchestrator = new DefaultIngestionOrchestrator({
    executor: harness,
    hasher: createSha256ContentHasher(),
    registry: createDefaultRegistry(),
    resolver: { resolve: async (ref) => ({ ...ref, content: new Uint8Array(0) }) },
    analysisReleaseId: ANALYSIS_RELEASE_ID,
  });
  const hasher = createSha256ContentHasher();
  return { harness, orchestrator, hasher };
}

interface SkeletonRecord {
  recordId?: string;
  recordType?: string;
  parentId?: string;
  sourceEventId?: string;
  sourceField?: string;
  provenance?: { path?: string };
  payload?: Record<string, unknown>;
}

function skeletonOf(rawDetails: string | null): SkeletonRecord {
  return rawDetails ? (JSON.parse(rawDetails) as SkeletonRecord) : {};
}

describe('PIPE-021: ingest-time context series', () => {
  it('materializes session_context_series and serves getContextTimingSeries without normalized_events', async () => {
    const { harness, orchestrator, hasher } = await setupPipeline();
    const content = readFixture('t2-happy-path.jsonl');
    const sha256 = await hasher.hash(content);
    const fixture = createManifestFixture(content, sha256);

    const receipt = await orchestrator.ingestManifest(fixture);
    expect(receipt.status).toBe('committed');

    // The series row exists for the committed generation.
    const row = await SessionContextSeriesStore.getBySessionAndGeneration(
      harness,
      receipt.sessionId,
      receipt.generationId,
    );
    if (!row) throw new Error('session_context_series row missing after ingest');
    expect(row.messageCount).toBeGreaterThan(0);
    expect(JSON.parse(row.contextTokens).length).toBe(row.messageCount);
    expect(JSON.parse(row.generationTokens ?? '[]').length).toBe(row.messageCount);
    expect(JSON.parse(row.pointMeta ?? '[]').length).toBe(row.messageCount);
    expect(JSON.parse(row.models ?? '[]').length).toBeGreaterThan(0);

    const dataSource = createAnalyticsDataSource(harness);
    const series = await dataSource.session.getContextTimingSeries(receipt.sessionId);
    expect(series.points.length).toBe(row.messageCount);

    // Points carry the fields the chart + drawer + #msg- links need.
    const withModel = series.points.find((p) => p.model);
    if (!withModel) throw new Error('no point carried a model');
    expect(withModel.contextTokens).toBeGreaterThan(0);
    expect(withModel.inputTokens).toBeGreaterThan(0);
    for (const p of series.points) {
      expect(p.messageIndex).toBeTruthy();
      expect(p.messageId).toBeTruthy();
      expect(p.transcriptIndex).toBeTruthy();
      expect(p.role).toBeTruthy();
      // Content is never persisted in the series row — it resolves from the
      // retained transcript artifact on demand.
      expect(p.content).toBeUndefined();
    }

    // Read-path independence: with normalized_events gone entirely, the stored
    // series still serves identical points (no raw_details re-parse).
    await harness.exec('DELETE FROM normalized_events WHERE session_id = ?', [receipt.sessionId]);
    const afterPurge = await dataSource.session.getContextTimingSeries(receipt.sessionId);
    expect(afterPurge.points).toEqual(series.points);
  });

  it('stores pointer-only skeletons in normalized_events', async () => {
    const { harness, orchestrator, hasher } = await setupPipeline();
    const content = readFixture('t2-happy-path.jsonl');
    const sha256 = await hasher.hash(content);
    const fixture = createManifestFixture(content, sha256);

    const receipt = await orchestrator.ingestManifest(fixture);
    expect(receipt.status).toBe('committed');

    const events = await NormalizedEventStore.listBySession(harness, receipt.sessionId);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const record = skeletonOf(event.rawDetails);
      expect(record.recordId).toBeTruthy();
      expect(record.recordType).toBeTruthy();
      expect(record.sourceEventId).toBeTruthy();
      // No verbatim content, usage objects, or tool payloads reach SQLite.
      expect(record.payload).not.toHaveProperty('content');
      expect(record.payload).not.toHaveProperty('usage');
      expect(record.payload).not.toHaveProperty('toolUseResult');
      expect(record.payload).not.toHaveProperty('model');
    }

    const messages = events.filter((e) => e.eventType === 'message');
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      const record = skeletonOf(message.rawDetails);
      expect(record.payload?.storage).toBe('artifact-blob');
      expect(typeof record.payload?.path).toBe('string');
      expect(record.provenance?.path).toBeTruthy();
    }
  });

  it('encodes compaction as a negative context value and decodes it back to the drawer fields', async () => {
    const { harness, orchestrator, hasher } = await setupPipeline();
    const content = readFixture('t2-happy-path.jsonl');
    const sha256 = await hasher.hash(content);
    const fixture = createManifestFixture(content, sha256);
    const { manifest, resolvedArtifacts } = fixture;

    const receipt = await orchestrator.ingestManifest(fixture);
    expect(receipt.status).toBe('committed');

    // Re-run the transform, then inject a compaction normalized_event into the
    // committed evidence to exercise the negative-encoding path.
    const registry = createDefaultRegistry();
    const transformer = registry.resolve('claude-code');
    // Same source identity the manifest ingest used (no environmentId → the
    // 'unknown' environment), so the transform's deterministic sessionId
    // matches `receipt.sessionId`.
    const sourceIdentity = {
      sourceId: 'default',
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
    };
    const sourceFingerprint = await hasher.hash(`session/transcript.jsonl:${sha256}`);
    const artifactBundle = {
      artifacts: resolvedArtifacts.map((a) => ({ ...a, status: 'uploaded' as const })),
      sourceIdentity,
      sourceFingerprint,
    };
    const result = transformer.transform(artifactBundle, {
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      parserId: transformer.id,
      parserVersion: '0.1.0',
      sourceFingerprint,
      sourceEnvironmentId: sourceIdentity.environmentId,
      sourceProjectId: sourceIdentity.projectId,
      sourceSessionId: sourceIdentity.sessionId,
    });
    const rootSession = result.sessionSummaries[0];
    if (!rootSession) throw new Error('transform produced no session summary');

    const compactionRecord = {
      recordId: 'evt-compaction-pipe021',
      recordType: 'normalized_event',
      sessionId: rootSession.sessionId,
      sourceEventId: 'evt-compaction-pipe021',
      sourceField: 'session',
      provenance: { path: 'session/transcript.jsonl' },
      payload: {
        category: 'compaction',
        // Between the second (10:00:02Z) and third (10:00:03Z) messages so
        // timestamp targeting lands on the last point.
        timestamp: '2026-08-01T10:00:02.500Z',
        preTokens: 1200,
        postTokens: 300,
      },
    } as const;

    const gen2 = await orchestrator.commitAtomic({
      generationId: `${receipt.generationId}-compaction`,
      sessionId: receipt.sessionId,
      rootSessionId: receipt.sessionId,
      affectedProjectIds: [PROJECT_ID],
      analysisReleaseId: ANALYSIS_RELEASE_ID,
      candidateRecords: [],
      result: {
        ...result,
        evidence: [...result.evidence, compactionRecord],
      },
      manifest,
      source: sourceIdentity,
    });
    expect(gen2.status).toBe('committed');

    const row = await SessionContextSeriesStore.getBySessionAndGeneration(
      harness,
      receipt.sessionId,
      gen2.generationId,
    );
    if (!row) throw new Error('session_context_series row missing for compaction generation');
    const contextArr = JSON.parse(row.contextTokens) as (number | null)[];
    const metaArr = JSON.parse(row.pointMeta ?? '[]') as ({ ctx?: number | null } | null)[];
    const compactionIndex = contextArr.findIndex((v) => typeof v === 'number' && v < 0);
    // preTokens - postTokens = 900 removed tokens encoded as -900.
    expect(contextArr[compactionIndex]).toBe(-900);
    expect(metaArr[compactionIndex]?.ctx).not.toBeUndefined();

    const dataSource = createAnalyticsDataSource(harness);
    const series = await dataSource.session.getContextTimingSeries(receipt.sessionId, {
      generationId: gen2.generationId,
    });
    const compactionPoint = series.points[compactionIndex];
    expect(compactionPoint?.compactedTokens).toBe(900);
    expect(compactionPoint?.removedTokens).toBe(900);
    expect(compactionPoint?.contextTokens).toBe(metaArr[compactionIndex]?.ctx ?? null);
  });

  it('replaces the series row when the session is re-ingested under a new generation', async () => {
    const { harness, orchestrator, hasher } = await setupPipeline();
    const content = readFixture('t2-happy-path.jsonl');
    const sha256 = await hasher.hash(content);
    const fixture = createManifestFixture(content, sha256);

    const first = await orchestrator.ingestManifest(fixture);
    expect(first.status).toBe('committed');

    // A changed transcript → different sha256 → different deterministic
    // generation id → the old series row is superseded, not duplicated.
    const content2 =
      content +
      '\n' +
      JSON.stringify({
        type: 'user',
        uuid: 'u-extra',
        parentUuid: 'u-10',
        timestamp: '2026-08-01T10:00:08.000Z',
        sessionId: 'sess-happy-1',
        message: { role: 'user', content: 'one more question' },
      });
    const sha256b = await hasher.hash(content2);
    const fixture2 = createManifestFixture(content2, sha256b);
    const second = await orchestrator.ingestManifest(fixture2);
    expect(second.status).toBe('committed');
    expect(second.generationId).not.toBe(first.generationId);
    expect(await getCurrentGenerationId(harness, first.sessionId)).toBe(second.generationId);

    const firstRow = await SessionContextSeriesStore.getBySessionAndGeneration(
      harness,
      first.sessionId,
      first.generationId,
    );
    const secondRow = await SessionContextSeriesStore.getBySessionAndGeneration(
      harness,
      second.sessionId,
      second.generationId,
    );
    // The prune mirrors normalized_events semantics: all of the session's
    // prior series rows are removed (superseded generations tombstone at read
    // time anyway), and only the new generation's row is written.
    expect(firstRow).toBeUndefined();
    if (!secondRow) throw new Error('session_context_series row missing for second generation');
    const current = await SessionContextSeriesStore.getBySession(harness, first.sessionId);
    expect(current?.id).toBe(secondRow?.id);

    const dataSource = createAnalyticsDataSource(harness);
    const series = await dataSource.session.getContextTimingSeries(first.sessionId);
    expect(series.points.length).toBe(secondRow.messageCount);
  });

  it('isolates a context-series write failure to the session — the commit still lands', async () => {
    const { harness, orchestrator, hasher } = await setupPipeline();
    const content = readFixture('t2-happy-path.jsonl');
    const sha256 = await hasher.hash(content);
    const fixture = createManifestFixture(content, sha256);

    const upsertSpy = vi
      .spyOn(SessionContextSeriesStore, 'upsert')
      .mockRejectedValueOnce(new Error('simulated series write failure'));

    const receipt = await orchestrator.ingestManifest(fixture);
    upsertSpy.mockRestore();

    // Session failure isolation: the generation still commits.
    expect(receipt.status).toBe('committed');
    expect(await getCurrentGenerationId(harness, receipt.sessionId)).toBe(receipt.generationId);

    // No series row was written…
    const row = await SessionContextSeriesStore.getBySession(harness, receipt.sessionId);
    expect(row).toBeUndefined();

    // …and the read path degrades to the legacy normalized_events fallback —
    // points still resolve (ordering via skeleton timestamps), just without
    // token detail since skeletons no longer carry usage payloads.
    const dataSource = createAnalyticsDataSource(harness);
    const series = await dataSource.session.getContextTimingSeries(receipt.sessionId);
    expect(series.points.length).toBeGreaterThan(0);
    expect(series.points.every((p) => p.contextTokens === null)).toBe(true);
  });
});
