import type { SqliteRow } from '@lucasschirm/sal-db-core';
import { FRESH_SCHEMA_SQL } from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createAnalyticsDataSource } from '../../src/analytics.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import { buildDevinManifestBundle } from '../fixtures/devin-manifest.js';
import { FailureInjectionExecutor } from './harness.js';

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
    analysisReleaseId: 'ar-pipe014',
  });
  return { harness, orchestrator };
}

describe('PIPE-014: devin drill-down data presence and missing-data reporting', () => {
  it('ingests a golden devin manifest and surfaces available drill-down data', async () => {
    const { harness, orchestrator } = await setupPipeline();
    const { bundle } = await buildDevinManifestBundle();

    const receipt = await orchestrator.ingestManifest(bundle);
    expect(receipt.status).toBe('committed');
    expect(receipt.issueIds).toEqual([]);

    const dataSource = createAnalyticsDataSource(harness);

    // Dashboard-level summary is present with the token headline metric and
    // the sample-size token required by the aggregates-expose-sample-size rule.
    const sessionSummary = await dataSource.session.getSummary(receipt.sessionId, {});
    expect(sessionSummary.harness).toBe('devin');
    const tokenMetric = sessionSummary.headlineMetrics.find((m) =>
      m.metricId.startsWith('devin:tokens:total:'),
    );
    expect(tokenMetric).toBeDefined();
    expect(tokenMetric?.value).toBe(150);
    expect(tokenMetric?.unit).toBe('token');
    expect(tokenMetric?.eligibleN).toBeGreaterThanOrEqual(1);
    expect(tokenMetric?.knownN).toBeGreaterThanOrEqual(1);
    expect(tokenMetric?.unknownCount).toBe(0);

    // Transcript drill-down is present: the transcript fallback in
    // getTranscriptPages surfaces message records from normalized_events.
    const transcript = await dataSource.session.getTranscriptPages(receipt.sessionId, {});
    expect(transcript.items.length).toBeGreaterThanOrEqual(1);
    const messages = transcript.items.map((row) => row.summary).join('\n');
    expect(messages).toContain('Hello');
    expect(messages).toContain('Hi there');

    // Evidence and component-fact drill-down are currently empty. The
    // ingestion pipeline persists raw evidence but does not yet populate the
    // turns/messages/invocations or session_component_stats tables. The DTOs
    // return empty items rather than erroring, which is the current
    // missing-data report.
    const evidence = await dataSource.session.getEvidencePages(receipt.sessionId, {});
    expect(evidence.items).toEqual([]);
    expect(evidence.nextCursor).toBeUndefined();
    expect(evidence.previousCursor).toBeUndefined();

    const componentFacts = await dataSource.session.getComponentFacts(receipt.sessionId, {});
    expect(componentFacts.items).toEqual([]);

    // Sanity check: the raw evidence does contain the tool invocation and
    // message records that the drill-down tables would consume once populated.
    const { rows } = await harness.exec(
      `SELECT event_type FROM normalized_events
       WHERE session_id = ? AND event_type IN ('invocation', 'message')
       ORDER BY event_type`,
      [receipt.sessionId],
    );
    const eventTypes = rows.map((row: SqliteRow) => String(row.event_type));
    expect(eventTypes).toContain('invocation');
    expect(eventTypes).toContain('message');
  });
});
