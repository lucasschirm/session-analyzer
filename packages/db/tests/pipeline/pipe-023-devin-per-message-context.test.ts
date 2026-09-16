import { FRESH_SCHEMA_SQL } from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createAnalyticsDataSource } from '../../src/analytics.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import { buildDevinManifestBundle } from '../fixtures/devin-manifest.js';
import { FailureInjectionExecutor } from './harness.js';

/**
 * PIPE-023: a transcript-only Devin session that carries per-request
 * `chat_message.metadata.metrics` (no ATIF) must feed the context-growth
 * series from those per-message requests — not from the harness's cumulative
 * `response_dimensions` session total.
 *
 * Regression coverage for the `brassy-humor` chart defect:
 *  1. The tier-3/4 session aggregate was parented to the first turn and/or
 *     carried `requestOrder: 1`, so the whole-session total (~50.2M tokens on
 *     the real session) landed on message #1 and fabricated a session-scale
 *     "compaction" on message #2.
 *  2. `model_usage.inputTokens` was cache-inclusive while `cacheReadTokens`
 *     was also set, so the generic context sum double-counted cache reads.
 *  3. Without a per-message tier, every message fell back to a single flat
 *     `numTokensPreceding` checkpoint.
 */

const SESSION_ID = 'devin-per-message-context';

// Session total is deliberately far larger than any single request, and the
// per-message sum deliberately does NOT equal it — the two sources are
// distinct, so the chart must use the per-message requests and the token
// metric must use the aggregate.
const SESSION_INPUT_TOKENS = 1_000_000;
const SESSION_CACHED_TOKENS = 2_000_000;
const SESSION_OUTPUT_TOKENS = 5_000;

function buildTranscript(): string {
  const session = JSON.stringify({
    type: 'session',
    ts: 1,
    order: 0,
    id: SESSION_ID,
    working_directory: '/repo',
    backend_type: 'devin',
    model: 'devin-default',
    agent_mode: 'auto',
    created_at: 1,
    last_activity_at: 2,
    title: 'Per-message context',
    main_chain_id: 2,
    metadata: JSON.stringify({
      response_dimensions: [
        { uid: 'input_tokens', kind: { CumulativeMetric: { value: SESSION_INPUT_TOKENS } } },
        { uid: 'output_tokens', kind: { CumulativeMetric: { value: SESSION_OUTPUT_TOKENS } } },
        {
          uid: 'cached_input_tokens',
          kind: { CumulativeMetric: { value: SESSION_CACHED_TOKENS } },
        },
      ],
    }),
  });

  const message = (nodeId: number, parentNodeId: number | null, metrics: object) =>
    JSON.stringify({
      type: 'message',
      ts: null,
      order: nodeId + 1,
      row_id: nodeId,
      session_id: SESSION_ID,
      node_id: nodeId,
      parent_node_id: parentNodeId,
      chat_message: JSON.stringify({
        message_id: `msg-${nodeId}`,
        role: 'assistant',
        content: `turn ${nodeId}`,
        metadata: {
          request_id: `req-${nodeId}`,
          generation_model: 'devin-default',
          metrics,
        },
      }),
      created_at: null,
      metadata: null,
    });

  return [
    session,
    message(1, null, {
      input_tokens: 10,
      output_tokens: 4,
      cache_read_tokens: 2,
      cache_creation_tokens: null,
    }),
    message(2, 1, {
      input_tokens: 18,
      output_tokens: 5,
      cache_read_tokens: 3,
      cache_creation_tokens: null,
    }),
  ].join('\n');
}

function loadFixtureBundle() {
  return buildDevinManifestBundle({
    sessionId: SESSION_ID,
    sourceBundle: {
      artifacts: [
        {
          relativePath: 'transcript.jsonl',
          content: buildTranscript(),
          mediaType: 'application/jsonl',
        },
      ],
    },
  });
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
    analysisReleaseId: 'ar-pipe023',
  });
  return { harness, orchestrator };
}

describe('PIPE-023: devin per-message context growth', () => {
  it('serves per-request context values, never the cumulative session aggregate', async () => {
    const { harness, orchestrator } = await setupPipeline();
    const { bundle } = await loadFixtureBundle();

    const receipt = await orchestrator.ingestManifest(bundle);
    expect(receipt.status).toBe('committed');

    const dataSource = createAnalyticsDataSource(harness);
    const series = await dataSource.session.getContextTimingSeries(receipt.sessionId);
    const contexts = series.points.map((p) => p.contextTokens);

    // Per-request context = input + cacheRead (cache-exclusive input contract):
    // 10 + 2 and 18 + 3.
    expect(contexts).toContain(12);
    expect(contexts).toContain(21);

    // The session aggregate (prompt = input + cached) must never appear as a
    // single message's context, and no message may exceed the session total.
    const sessionPrompt = SESSION_INPUT_TOKENS + SESSION_CACHED_TOKENS;
    const sessionTotal = sessionPrompt + SESSION_OUTPUT_TOKENS;
    expect(contexts.some((c) => c === sessionPrompt)).toBe(false);
    expect(contexts.every((c) => c === null || c <= sessionTotal)).toBe(true);
    expect(Math.max(...contexts.map((c) => c ?? 0))).toBeLessThan(1_000);

    // No fabricated session-scale compaction.
    expect(series.points.every((p) => (p.compactedTokens ?? 0) < 1_000)).toBe(true);
  });

  it('keeps the session token metric on the harness-reported aggregate', async () => {
    const { harness, orchestrator } = await setupPipeline();
    const { bundle } = await loadFixtureBundle();

    const receipt = await orchestrator.ingestManifest(bundle);
    expect(receipt.status).toBe('committed');

    const dataSource = createAnalyticsDataSource(harness);
    const summary = await dataSource.session.getSummary(receipt.sessionId, {});
    const total = summary.headlineMetrics.find((m) => m.metricId.startsWith('devin:tokens:total:'));
    // `devin:tokens:total` = prompt + completion = (input + cached) + output.
    expect(total?.value).toBe(SESSION_INPUT_TOKENS + SESSION_CACHED_TOKENS + SESSION_OUTPUT_TOKENS);
  });
});
