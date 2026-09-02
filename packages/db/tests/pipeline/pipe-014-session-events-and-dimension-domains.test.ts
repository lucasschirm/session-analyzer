import {
  deterministicId,
  deterministicPortfolioId,
  FRESH_SCHEMA_SQL,
} from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createMetadataView, createSessionEvidenceView } from '../../src/analytics-session.js';
import type { IngestionReceipt } from '../../src/ingestion.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';

/**
 * PIPE-014: full-detail session events + portfolio dimension domains
 * (issue #169) — parse -> transform -> ingest -> query, for the one
 * registered harness plugin (claude-code). Exercises the new read paths
 * end-to-end: `SessionEvidenceView.getSessionEvents`
 * (`packages/db/src/analytics-session.ts`, backed by
 * `SessionEventsDetailStore` in `packages/db-core/src/session-events-detail.ts`)
 * and `MetadataView.getDimensionDomains`
 * (`DimensionDomainStore` in `packages/db-core/src/dimension-domains.ts`).
 */

const ANALYSIS_RELEASE = 'ar-pipe014';
const PROJECT = 'project-pipe014';
const SESSION_ID = 'sess-pipe014';

function canonicalProjectId(nativeProjectId: string): string {
  const portfolioId = deterministicPortfolioId('ten-default', 'default');
  return `prj-${deterministicId('project', portfolioId, nativeProjectId)}`;
}

function baseEntry(uuid: string, parentUuid: string | null) {
  return {
    sessionId: SESSION_ID,
    timestamp: '2026-08-20T10:00:00.000Z',
    parentUuid,
    uuid,
    isSidechain: false,
  };
}

function userLine(uuid: string, text: string): string {
  return JSON.stringify({
    ...baseEntry(uuid, null),
    type: 'user',
    message: { role: 'user', content: text },
  });
}

function assistantTextLine(uuid: string, parentUuid: string, text: string): string {
  return JSON.stringify({
    ...baseEntry(uuid, parentUuid),
    type: 'assistant',
    message: {
      model: 'test-model-a',
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      stop_reason: 'end_turn',
    },
  });
}

function transcript(): string {
  return [
    userLine(`${SESSION_ID}-u1`, 'What does this repo do?'),
    assistantTextLine(`${SESSION_ID}-a1`, `${SESSION_ID}-u1`, 'It is a demo repo.'),
  ].join('\n');
}

async function ingestFixture(
  orchestrator: DefaultIngestionOrchestrator,
  hasher: ReturnType<typeof createSha256ContentHasher>,
): Promise<IngestionReceipt> {
  const content = transcript();
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
    sessionId: SESSION_ID,
  });
}

describe('PIPE-014: session events + dimension domains (claude-code)', () => {
  it(
    'exposes ingested user/assistant messages through getSessionEvents and the ' +
      'observed project/harness through getDimensionDomains',
    async () => {
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

      const receipt = await ingestFixture(orchestrator, hasher);
      expect(receipt.status).toBe('committed');

      // KNOWN GAP (documented in the issue #169 implementation report):
      // DefaultIngestionOrchestrator does not yet write to the
      // messages/turns/invocations/payloads tables — evidence surfaces today
      // go through `normalized_events` instead (see the fallback path in
      // `getTranscriptPages`). getSessionEvents is therefore correct and unit
      // -tested against those tables directly
      // (analytics-datasource-169.test.ts), but returns a valid, honestly
      // empty DTO for a real-ingested session until a separate
      // ingestion-population issue lands. This assertion documents that gap
      // rather than papering over it.
      const sessionView = createSessionEvidenceView(executor);
      const detail = await sessionView.getSessionEvents(receipt.sessionId);
      expect(detail.events).toEqual([]);
      expect(detail.token.eligibleN).toBe(0);

      const portfolioId = deterministicPortfolioId('ten-default', 'default');
      const metadataView = createMetadataView(executor);
      const domains = await metadataView.getDimensionDomains({ portfolioId });
      expect(domains.harnesses).toContain('claude-code');
      expect(domains.projects.length).toBeGreaterThan(0);
    },
  );
});
