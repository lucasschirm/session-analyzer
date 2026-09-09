import { FRESH_SCHEMA_SQL } from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import {
  idleResyncPass1Bundle,
  idleResyncPass2Bundle,
} from '../../../transformers/devin-transformer/tests/conformance/fixtures/index.js';
import { createAnalyticsDataSource } from '../../src/analytics.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import { buildDevinManifestBundle } from '../fixtures/devin-manifest.js';
import { FailureInjectionExecutor } from './harness.js';

/**
 * PIPE-019 (#341): devin-session-sync's fixed `message_nodes` content-hash
 * watermark (mirroring `tool-call-watermark.ts`) stops the extractor from
 * re-appending a session's entire message history on every sync pass, since
 * Devin deletes and reinserts the whole node forest at fresh `row_id`s on
 * every persist. Extractor-level unit tests (devin-session-sync's own
 * `session-sync.test.ts`) already prove the raw transcript.jsonl artifact
 * doesn't grow beyond the one legitimate re-appended session line. This
 * pipeline test proves the SAME idle-resync shape doesn't inflate anything
 * once it reaches real ingestion + analytics queries — the layer a
 * transformer/db-side regression (independent of the extractor) could still
 * reintroduce duplication that no extractor-level test would ever catch.
 */

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
    analysisReleaseId: 'ar-pipe019',
  });
  return { harness, orchestrator };
}

function turnsCountOf(metrics: readonly { metricId: string; value: unknown }[]): unknown {
  return metrics.find((m) => m.metricId === 'devin:turns:count:root_only')?.value;
}

describe('PIPE-019: repeated syncs of an idle Devin session do not inflate turn/message evidence (#341)', () => {
  it(
    'a second sync of an idle session (message_nodes churned at fresh row_ids, content ' +
      'unchanged) leaves devin:turns:count flat while the session-level generation still ' +
      'genuinely advances',
    async () => {
      const { harness, orchestrator } = await setupPipeline();
      const dataSource = createAnalyticsDataSource(harness);

      // Pass 1: first sync of a brand-new idle session (2 messages, 1 tool call).
      const { bundle: pass1 } = await buildDevinManifestBundle({
        sourceBundle: idleResyncPass1Bundle,
      });
      const receipt1 = await orchestrator.ingestManifest(pass1);
      expect(receipt1.status).toBe('committed');
      expect(receipt1.issueIds).toEqual([]);

      const summary1 = await dataSource.session.getSummary(receipt1.sessionId, {});
      expect(turnsCountOf(summary1.headlineMetrics)).toBe(2);

      // Pass 2: the SAME session synced again while idle. Per #341's live
      // evidence, Devin rewrites the whole message_nodes forest on every
      // persist -- the fixed extractor emits nothing for the two unchanged
      // messages, only the session's own last-write-wins line re-appears
      // (idleResyncPass2Bundle = pass 1's transcript + exactly one more
      // session line). This is a genuinely different manifest (new
      // sha256), simulating the sync engine uploading the next pass's
      // grown transcript.jsonl.
      const { bundle: pass2 } = await buildDevinManifestBundle({
        sourceBundle: idleResyncPass2Bundle,
      });
      const receipt2 = await orchestrator.ingestManifest(pass2);
      expect(receipt2.status).toBe('committed');
      expect(receipt2.issueIds).toEqual([]);
      expect(receipt2.sessionId).toBe(receipt1.sessionId);
      // A genuinely new generation -- content did change (the session
      // line), unlike PIPE-006's byte-identical-manifest no-op case. This
      // rules out "nothing happened because ingestion no-op'd the whole
      // pass" as a false-positive explanation for flat counts below.
      expect(receipt2.generationId).not.toBe(receipt1.generationId);

      const summary2 = await dataSource.session.getSummary(receipt2.sessionId, {});
      // The core #341 regression proof at the pipeline level: message_nodes
      // churn (unchanged content reappearing at fresh row_ids) must never
      // inflate turn count, even though the raw transcript.jsonl artifact
      // legitimately grew by one line and a new generation was created.
      expect(turnsCountOf(summary2.headlineMetrics)).toBe(2);

      // Both generations' own stored metric rows independently confirm the
      // same value (never a sum/blend across generations, mirroring
      // PIPE-017's PR #295 regression-lock pattern) -- the DTO-level check
      // above already proves the CURRENT generation is correct; this proves
      // the prior generation's own historical row was never itself
      // inflated by the churn either.
      const metricRow = async (generationId: string) => {
        const { rows } = await harness.exec(
          `SELECT mv.integer_value FROM metric_values mv
           JOIN metric_definitions md ON md.id = mv.metric_definition_id
           WHERE md.metric_id = 'devin:turns:count:root_only' AND mv.generation_id = ?`,
          [generationId],
        );
        return Number((rows[0] as { integer_value: number } | undefined)?.integer_value);
      };
      expect(await metricRow(receipt1.generationId)).toBe(2);
      expect(await metricRow(receipt2.generationId)).toBe(2);
    },
  );
});
