import { FRESH_SCHEMA_SQL } from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createAnalyticsDataSource } from '../../src/analytics.js';
import type { IngestionReceipt } from '../../src/ingestion.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';

const ANALYSIS_RELEASE = 'ar-pipe016';
const PROJECT = 'project-pipe016';
const EFFORT_METRIC_ROOT = 'claude:effort:changes:root_only';

function baseEntry(sessionId: string, uuid: string, parentUuid: string | null) {
  return { sessionId, timestamp: '2026-08-01T10:00:00.000Z', parentUuid, uuid, isSidechain: false };
}

function makePermissionLine(sessionId: string): string {
  return JSON.stringify({ type: 'permission-mode', permissionMode: 'normal', sessionId });
}

/**
 * A session with `efforts.length` user/assistant turn pairs, one assistant
 * entry per raw effort value in `efforts` (`undefined` produces an entry
 * with no `effort` field at all, mirroring a pre-#289 or unrecognized
 * message).
 */
function makeTranscript(sessionId: string, efforts: readonly (string | undefined)[]): string {
  const lines = [makePermissionLine(sessionId)];
  let parentUuid: string | null = null;
  efforts.forEach((effort, i) => {
    const userUuid = `${sessionId}-u-${i}`;
    const assistantUuid = `${sessionId}-a-${i}`;
    lines.push(
      JSON.stringify({
        ...baseEntry(sessionId, userUuid, parentUuid),
        type: 'user',
        message: { role: 'user', content: `turn ${i}` },
      }),
    );
    const assistantLine: Record<string, unknown> = {
      ...baseEntry(sessionId, assistantUuid, userUuid),
      type: 'assistant',
      requestId: `${sessionId}-req-${i}`,
      message: {
        model: 'claude-3-5-sonnet-20241022',
        role: 'assistant',
        content: [{ type: 'text', text: `reply ${i}` }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
    if (effort !== undefined) assistantLine.effort = effort;
    lines.push(JSON.stringify(assistantLine));
    parentUuid = assistantUuid;
  });
  return lines.join('\n');
}

async function ingestSession(
  orchestrator: DefaultIngestionOrchestrator,
  hasher: ReturnType<typeof createSha256ContentHasher>,
  sessionId: string,
  efforts: readonly (string | undefined)[],
): Promise<IngestionReceipt> {
  const content = makeTranscript(sessionId, efforts);
  const sha256 = await hasher.hash(content);
  return orchestrator.ingestManual({
    artifacts: [
      {
        relativePath: 'session/transcript.jsonl',
        mediaType: 'application/jsonl',
        sha256,
        size: content.length,
        content,
        status: 'uploaded',
      },
    ],
    source: { sourceId: 'default' },
    harness: 'claude-code',
    projectId: PROJECT,
    sessionId,
  });
}

async function setup() {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  const hasher = createSha256ContentHasher();
  const orchestrator = new DefaultIngestionOrchestrator({
    executor,
    hasher,
    registry: createDefaultRegistry(),
    resolver: { resolve: async (ref) => ({ ...ref, content: new Uint8Array(0) }) },
    analysisReleaseId: ANALYSIS_RELEASE,
  });
  const dataSource = createAnalyticsDataSource(executor);
  return { executor, hasher, orchestrator, dataSource };
}

describe('PIPE-016: effort-change metric — per-message capture, message_effort backfill, rollup reconciliation', () => {
  it('captures message_effort rows and a measured-zero root_only transition count for a single-tier session', async () => {
    const { executor, hasher, orchestrator } = await setup();
    const receipt = await ingestSession(orchestrator, hasher, 'sess-pipe016-single', ['high']);
    expect(receipt.status).toBe('committed');

    const { rows } = await executor.exec(
      'SELECT request_order, raw_effort, normalized_effort FROM message_effort WHERE session_id = ? ORDER BY request_order',
      [receipt.sessionId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.raw_effort).toBe('high');
    expect(rows[0]?.normalized_effort).toBe('high');

    const { rows: metricRows } = await executor.exec(
      `SELECT mv.integer_value, mv.is_unavailable, mv.unavailable_reason
       FROM metric_values mv
       JOIN metric_definitions md ON md.id = mv.metric_definition_id
       WHERE md.metric_id = ? AND mv.generation_id = ?`,
      [EFFORT_METRIC_ROOT, receipt.generationId],
    );
    expect(metricRows).toHaveLength(1);
    // n=1 -> a measured 0, never unavailable (missing-is-never-zero.md).
    expect(metricRows[0]?.integer_value).toBe(0);
    expect(metricRows[0]?.is_unavailable).toBe(0);
    expect(metricRows[0]?.unavailable_reason).toBeNull();
  });

  it('counts exactly one transition for a three-message session (high, high, xhigh)', async () => {
    const { executor, hasher, orchestrator } = await setup();
    const receipt = await ingestSession(orchestrator, hasher, 'sess-pipe016-multi', [
      'high',
      'high',
      'xhigh',
    ]);
    expect(receipt.status).toBe('committed');

    const { rows } = await executor.exec(
      'SELECT raw_effort FROM message_effort WHERE session_id = ? ORDER BY request_order',
      [receipt.sessionId],
    );
    expect(rows.map((r) => r.raw_effort)).toEqual(['high', 'high', 'xhigh']);

    const { rows: metricRows } = await executor.exec(
      `SELECT mv.integer_value, mv.is_unavailable
       FROM metric_values mv
       JOIN metric_definitions md ON md.id = mv.metric_definition_id
       WHERE md.metric_id = ? AND mv.generation_id = ?`,
      [EFFORT_METRIC_ROOT, receipt.generationId],
    );
    expect(metricRows[0]?.integer_value).toBe(1);
    expect(metricRows[0]?.is_unavailable).toBe(0);
  });

  it('is unavailable (never a fabricated 0) when no assistant entry carries any effort value', async () => {
    const { executor, hasher, orchestrator } = await setup();
    // Both entries omit `effort` entirely (pre-#289 style transcript) — no
    // raw or normalized signal at all, so zero message_effort rows are
    // written (absence of a row is the signal, mirroring session_relations).
    const receipt = await ingestSession(orchestrator, hasher, 'sess-pipe016-none', [
      undefined,
      undefined,
    ]);
    expect(receipt.status).toBe('committed');

    const { rows } = await executor.exec('SELECT * FROM message_effort WHERE session_id = ?', [
      receipt.sessionId,
    ]);
    expect(rows).toHaveLength(0);

    const { rows: metricRows } = await executor.exec(
      `SELECT mv.integer_value, mv.is_unavailable, mv.unavailable_reason
       FROM metric_values mv
       JOIN metric_definitions md ON md.id = mv.metric_definition_id
       WHERE md.metric_id = ? AND mv.generation_id = ?`,
      [EFFORT_METRIC_ROOT, receipt.generationId],
    );
    expect(metricRows).toHaveLength(1);
    expect(metricRows[0]?.integer_value).toBeNull();
    expect(metricRows[0]?.is_unavailable).toBe(1);
    expect(metricRows[0]?.unavailable_reason).toBe(
      'no recognized effort signal observed for this session',
    );
  });

  it('still writes a message_effort row for an unrecognized raw value (raw captured, normalized null), while the metric stays unavailable', async () => {
    const { executor, hasher, orchestrator } = await setup();
    const receipt = await ingestSession(orchestrator, hasher, 'sess-pipe016-unrecognized', [
      'not-a-real-level',
    ]);
    expect(receipt.status).toBe('committed');

    const { rows } = await executor.exec(
      'SELECT raw_effort, normalized_effort FROM message_effort WHERE session_id = ?',
      [receipt.sessionId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.raw_effort).toBe('not-a-real-level');
    expect(rows[0]?.normalized_effort).toBeNull();

    const { rows: metricRows } = await executor.exec(
      `SELECT mv.is_unavailable FROM metric_values mv
       JOIN metric_definitions md ON md.id = mv.metric_definition_id
       WHERE md.metric_id = ? AND mv.generation_id = ?`,
      [EFFORT_METRIC_ROOT, receipt.generationId],
    );
    expect(metricRows[0]?.is_unavailable).toBe(1);
  });

  it('reconciles project-level rollup contributions as the sum of session contributions (generic aggregation:sum path)', async () => {
    const { executor, hasher, orchestrator } = await setup();
    const single = await ingestSession(orchestrator, hasher, 'sess-pipe016-rollup-a', ['high']);
    const multi = await ingestSession(orchestrator, hasher, 'sess-pipe016-rollup-b', [
      'high',
      'high',
      'xhigh',
    ]);
    expect(single.status).toBe('committed');
    expect(multi.status).toBe('committed');

    // #289 ships no dashboard consumer for this metric (no new DTO/
    // AnalyticsDataSource method) — so this asserts the metric reconciles
    // through the generic rollup_contributions path directly, per the
    // issue's own "assert it, don't assume" instruction, rather than via a
    // headline/trend query that doesn't exist yet.
    const { rows } = await executor.exec(
      `SELECT SUM(rc.additive_value) AS total
       FROM rollup_contributions rc
       JOIN metric_definitions md ON md.id = rc.metric_definition_id
       WHERE md.metric_id = ? AND rc.contribution_scope = 'root_only' AND rc.bucket_type = 'daily'
         AND rc.session_id IN (?, ?)`,
      [EFFORT_METRIC_ROOT, single.sessionId, multi.sessionId],
    );
    // Session A contributes 0 (measured zero), session B contributes 1.
    expect(Number(rows[0]?.total)).toBe(1);
  });
});
