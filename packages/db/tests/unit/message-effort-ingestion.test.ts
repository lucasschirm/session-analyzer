import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRESH_SCHEMA_SQL } from '@lucasschirm/sal-db-core';
import { MANIFEST_SCHEMA_VERSION } from '@lucasschirm/sal-sync-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';

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

function manifestBundle(
  content: string,
  sha256: string,
  projectId: string,
  sessionId: string,
  relativePath = 'session/transcript.jsonl',
) {
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    projectId,
    sessionId,
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
  };
  return {
    manifest,
    source: { sourceId: 'default', environmentId: 'dev', projectId, sessionId },
    resolvedArtifacts: [
      { relativePath, mediaType: 'application/jsonl', sha256, size: content.length, content },
    ],
    integrityVerified: false,
  };
}

async function setupIngestion(executor: WasmSqliteExecutor) {
  const hasher = createSha256ContentHasher();
  const orchestrator = new DefaultIngestionOrchestrator({
    executor,
    hasher,
    registry: createDefaultRegistry(),
    resolver: { resolve: async (ref) => ({ ...ref, content: new Uint8Array(0) }) },
    analysisReleaseId: 'ar-default',
  });
  return { orchestrator, hasher };
}

/**
 * A synthetic multi-assistant-entry session. Defaults to high, high, xhigh
 * (1 transition, n=3); pass a shorter/different `efforts` array to build a
 * session with fewer request orders (e.g. for reprocess/prune tests).
 */
function multiTierJsonl(sessionId: string, efforts: string[] = ['high', 'high', 'xhigh']): string {
  const lines = [JSON.stringify({ type: 'permission-mode', permissionMode: 'normal', sessionId })];
  let parentUuid: string | null = null;
  efforts.forEach((effort, i) => {
    const userUuid = `${sessionId}-u-${i}`;
    const assistantUuid = `${sessionId}-a-${i}`;
    lines.push(
      JSON.stringify({
        parentUuid,
        type: 'user',
        uuid: userUuid,
        sessionId,
        timestamp: `2026-08-01T10:${String(i).padStart(2, '0')}:00.000Z`,
        message: { role: 'user', content: `turn ${i}` },
      }),
    );
    lines.push(
      JSON.stringify({
        parentUuid: userUuid,
        type: 'assistant',
        uuid: assistantUuid,
        sessionId,
        timestamp: `2026-08-01T10:${String(i).padStart(2, '0')}:30.000Z`,
        requestId: `req-${sessionId}-${i}`,
        effort,
        message: {
          model: 'claude-3-5-sonnet-20241022',
          role: 'assistant',
          content: [{ type: 'text', text: `reply ${i}` }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    );
    parentUuid = assistantUuid;
  });
  return lines.join('\n');
}

describe('message_effort ingestion writer', () => {
  it('writes a row for a model_request-sourced record (Claude Code path)', async () => {
    // t2-happy-path.jsonl's single assistant entry has effort: "high"
    // (see #289 finding 1 / claude-code.test.ts).
    const content = readFixture('t2-happy-path.jsonl');
    const executor = await createExecutor();
    const { orchestrator, hasher } = await setupIngestion(executor);
    const sha256 = await hasher.hash(content);
    const bundle = manifestBundle(content, sha256, 'project-meff-writer', 'sess-happy-1');

    const receipt = await orchestrator.ingestManifest(bundle);
    expect(receipt.status).toBe('committed');

    const { rows } = await executor.exec(
      'SELECT raw_effort, normalized_effort, generation_id FROM message_effort WHERE session_id = ?',
      [receipt.sessionId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.raw_effort).toBe('high');
    expect(rows[0]?.normalized_effort).toBe('high');
    expect(rows[0]?.generation_id).toBe(receipt.generationId);
  });

  it('writes a row for a synthetic model_usage-sourced record (dual-type path, e.g. future Devin)', async () => {
    const content = readFixture('t2-happy-path.jsonl');
    const executor = await createExecutor();
    const hasher = createSha256ContentHasher();
    const registry = createDefaultRegistry();
    const orchestrator = new DefaultIngestionOrchestrator({
      executor,
      hasher,
      registry,
      resolver: { resolve: async (ref) => ({ ...ref, content: new Uint8Array(0) }) },
      analysisReleaseId: 'ar-default',
    });
    const sha256 = await hasher.hash(content);
    const bundle = manifestBundle(content, sha256, 'project-meff-dual', 'sess-dual-1');

    const sourceFingerprint = await hasher.hash(`session/transcript.jsonl:${sha256}`);
    const transformer = registry.resolve('claude-code');
    const sourceIdentity = bundle.source;
    const artifactBundle = {
      artifacts: bundle.resolvedArtifacts.map((a) => ({ ...a, status: 'uploaded' as const })),
      sourceIdentity,
      sourceFingerprint,
    };
    const result = transformer.transform(artifactBundle, {
      analysisReleaseId: 'ar-default',
      parserId: transformer.id,
      parserVersion: '0.1.0',
      sourceFingerprint,
      sourceEnvironmentId: sourceIdentity.environmentId,
      sourceProjectId: sourceIdentity.projectId,
      sourceSessionId: sourceIdentity.sessionId,
    });
    const rootSessionId = result.sessionSummaries[0]?.sessionId;
    expect(rootSessionId).toBeTruthy();

    // Claude never emits `model_usage` records carrying effort/normalizedEffort
    // itself (finding 3 / #289 body) — this synthetic record proves the
    // writer's dual-type check works generically, ahead of the Devin-side
    // effort issue that will populate this shape for real.
    const syntheticUsageRecord = {
      recordId: 'synthetic-model-usage-effort',
      recordType: 'model_usage',
      sessionId: rootSessionId,
      sourceEventId: 'synthetic',
      provenance: { path: 'synthetic' },
      payload: { requestOrder: 999, effort: 'low', normalizedEffort: 'low' },
    };
    const augmentedResult = { ...result, evidence: [...result.evidence, syntheticUsageRecord] };

    const receipt = await orchestrator.commitAtomic({
      generationId: 'gen-dual-1',
      sessionId: rootSessionId as string,
      rootSessionId: rootSessionId as string,
      affectedProjectIds: ['project-meff-dual'],
      analysisReleaseId: 'ar-default',
      candidateRecords: [],
      result: augmentedResult as never,
      manifest: bundle.manifest,
      source: sourceIdentity,
    });
    expect(receipt.status).toBe('committed');

    const { rows } = await executor.exec(
      'SELECT raw_effort, normalized_effort FROM message_effort WHERE session_id = ? AND request_order = 999',
      [rootSessionId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.raw_effort).toBe('low');
    expect(rows[0]?.normalized_effort).toBe('low');
  });

  it('prunes stale message_effort rows when a reprocessed generation has fewer request orders', async () => {
    const executor = await createExecutor();
    const { orchestrator, hasher } = await setupIngestion(executor);
    const sessionId = 'sess-prune-1';

    // Generation 1: 3 assistant entries -> request_order 2, 4, 6.
    const contentA = multiTierJsonl(sessionId, ['high', 'medium', 'xhigh']);
    const shaA = await hasher.hash(contentA);
    const first = await orchestrator.ingestManifest(
      manifestBundle(contentA, shaA, 'project-meff-prune', sessionId),
    );
    expect(first.status).toBe('committed');

    const before = await executor.exec(
      'SELECT request_order, raw_effort FROM message_effort WHERE session_id = ? ORDER BY request_order',
      [first.sessionId],
    );
    expect(before.rows.map((r) => Number(r.request_order))).toEqual([2, 4, 6]);
    expect(before.rows.map((r) => r.raw_effort)).toEqual(['high', 'medium', 'xhigh']);

    // Reprocess the same session with fewer entries: only 2 assistant
    // entries -> request_order 2, 4. Same manifest sessionId/projectId,
    // different artifact bytes, so ingestManifest computes a genuinely new
    // generationId and replaces the current generation. Because
    // request_order 2 and 4 are upserted in place (same unique key as
    // before), only a real DELETE-based prune of rows outside the new
    // generation's request orders removes the now-stale request_order=6
    // row — a plain upsert-overwrite would leave it lingering.
    const contentB = multiTierJsonl(sessionId, ['high', 'medium']);
    const shaB = await hasher.hash(contentB);
    const second = await orchestrator.ingestManifest(
      manifestBundle(contentB, shaB, 'project-meff-prune', sessionId),
    );
    expect(second.status).toBe('committed');
    expect(second.generationId).not.toBe(first.generationId);

    const after = await executor.exec(
      'SELECT request_order, raw_effort, normalized_effort, generation_id FROM message_effort WHERE session_id = ? ORDER BY request_order',
      [first.sessionId],
    );
    expect(after.rows).toHaveLength(2);
    expect(after.rows.map((r) => Number(r.request_order))).toEqual([2, 4]);
    expect(after.rows.map((r) => r.raw_effort)).toEqual(['high', 'medium']);
    expect(after.rows.map((r) => r.normalized_effort)).toEqual(['high', 'medium']);
    for (const row of after.rows) {
      expect(row.generation_id).toBe(second.generationId);
    }

    // The stale request_order=6 row from generation 1 must be gone, not
    // just left with its old generation_id.
    const staleRow = after.rows.find((r) => Number(r.request_order) === 6);
    expect(staleRow).toBeUndefined();
  });
});

describe('claude:effort:changes:* rollup reconciliation', () => {
  it('sums per-session root_only contributions across a multi-session project via the generic aggregation:sum path', async () => {
    const executor = await createExecutor();
    const { orchestrator, hasher } = await setupIngestion(executor);
    const projectId = 'project-meff-rollup';

    // Session A (t2-happy-path.jsonl): 1 recognized entry, 0 transitions
    // (measured zero).
    const contentA = readFixture('t2-happy-path.jsonl');
    const shaA = await hasher.hash(contentA);
    const receiptA = await orchestrator.ingestManifest(
      manifestBundle(contentA, shaA, projectId, 'sess-rollup-a'),
    );
    expect(receiptA.status).toBe('committed');

    // Session B (synthetic multi-tier): 3 recognized entries, 1 transition.
    const contentB = multiTierJsonl('sess-rollup-b-native');
    const shaB = await hasher.hash(contentB);
    const receiptB = await orchestrator.ingestManifest(
      manifestBundle(contentB, shaB, projectId, 'sess-rollup-b'),
    );
    expect(receiptB.status).toBe('committed');

    // Cross-check each session's own metric_values row first.
    const perSession = await executor.exec(
      `SELECT mv.session_id, mv.integer_value
       FROM metric_values mv
       JOIN metric_definitions md ON md.id = mv.metric_definition_id
       WHERE md.metric_id = 'claude:effort:changes:root_only'
         AND mv.generation_id IN (?, ?)`,
      [receiptA.generationId, receiptB.generationId],
    );
    expect(perSession.rows.length).toBeGreaterThanOrEqual(2);
    const bySession = new Map(perSession.rows.map((r) => [r.session_id, r.integer_value]));
    expect(bySession.get(receiptA.sessionId)).toBe(0);
    expect(bySession.get(receiptB.sessionId)).toBe(1);

    // The generic aggregation:'sum' rollup path (rollup-reconciliation.ts's
    // listAdditiveMetricValues) must have picked up claude:effort:changes:*
    // without any bespoke rollup code (per #289's own "Rollup" section) —
    // assert it directly against rollup_contributions rather than assuming.
    // Each session contributes one 'daily' bucket row (the project-daily
    // total) plus several 'dimension' bucket rows (per-model/harness/etc.
    // breakdowns); scoping to 'daily' avoids re-summing the same session's
    // contribution once per dimension. `rollup_contributions.project_id` is
    // db-core's internal derived project id (not the raw manifest
    // projectId string), so this scopes by session id instead.
    const { rows } = await executor.exec(
      `SELECT SUM(rc.additive_value) AS total, COUNT(*) AS n
       FROM rollup_contributions rc
       JOIN metric_definitions md ON md.id = rc.metric_definition_id
       WHERE md.metric_id = 'claude:effort:changes:root_only'
         AND rc.contribution_scope = 'root_only'
         AND rc.bucket_type = 'daily'
         AND rc.session_id IN (?, ?)`,
      [receiptA.sessionId, receiptB.sessionId],
    );
    expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(2);
    // Session A contributes 0 (measured zero), session B contributes 1.
    expect(Number(rows[0]?.total)).toBe(1);
  });
});
