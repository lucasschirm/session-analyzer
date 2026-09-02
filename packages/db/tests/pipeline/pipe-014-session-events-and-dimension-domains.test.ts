import {
  deterministicId,
  deterministicPortfolioId,
  FRESH_SCHEMA_SQL,
} from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createPortfolioView } from '../../src/analytics-portfolio.js';
import { createMetadataView, createSessionEvidenceView } from '../../src/analytics-session.js';
import type { IngestionReceipt } from '../../src/ingestion.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import { createProjectBehaviorView } from '../../src/project-behavior.js';

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

      // Portfolio KPI-band additions from issue #169 round 2 (token totals,
      // cost coverage, clean-completion rate, sessions-by-model,
      // model x harness matrix, invocations-by-domain). These read
      // model_requests/model_usage/invocations, which
      // DefaultIngestionOrchestrator does not populate yet (same documented
      // gap as getSessionEvents above) — so every DTO here is honestly
      // empty/unknown rather than a fabricated non-zero value. This
      // assertion exercises the full read-contract wiring end-to-end and
      // pins the "no data yet" contract so a future ingestion-population fix
      // is caught by a real assertion change here, not a silent pass.
      const portfolioView = createPortfolioView(executor);
      const band = await portfolioView.getKpiBand({ portfolioId });
      expect(band.tokens.in.current).toBe(0);
      expect(band.tokens.in.currentN).toBe(0);
      expect(band.cost.currentTotal).toBeNull();
      expect(band.cost.currentReportedHarnesses).toBe(0);
      expect(band.cleanCompletionRate.value).toBeNull();

      const modelBar = await portfolioView.getSessionsByModel({ portfolioId });
      expect(modelBar.rows).toEqual([{ model: 'unknown', sessionCount: 1 }]);

      const matrix = await portfolioView.getModelHarnessMatrix({ portfolioId });
      expect(matrix.cells).toEqual([]);

      const invocationsByDomain = await portfolioView.getInvocationsByDomain({ portfolioId });
      expect(invocationsByDomain.totalInvocations).toBe(0);
      expect(invocationsByDomain.rows).toEqual([]);

      // Project Behavior stat strip / histogram / weekly tool error rate /
      // top tools / model x harness cohorts (issue #169, this pass). Same
      // documented ingestion gap as above: these read
      // sessions.end_time/turns/model_requests/model_usage/invocations,
      // none of which DefaultIngestionOrchestrator populates yet, so every
      // DTO here is honestly empty/null/unknown — this pins that contract
      // against a real ingested session rather than only a synthetic
      // db-core/db unit fixture.
      const projectView = createProjectBehaviorView(executor);
      const canonicalProject = canonicalProjectId(PROJECT);
      const statStrip = await projectView.getStatStrip(canonicalProject, {});
      expect(statStrip.sessions.current).toBe(1);
      // start_time/end_time are both populated by ingestion (unlike
      // turns/model_requests/model_usage/invocations, which are not) — this
      // session's duration is a real measured value, not missing.
      expect(statStrip.durationMedianMs.eligibleN).toBe(1);
      expect(statStrip.tokensPerSession).toEqual({ value: null, eligibleN: 1, knownN: 0 });

      const histogram = await projectView.getDurationHistogram(canonicalProject, {});
      expect(histogram.eligibleN).toBe(1);

      const errorRate = await projectView.getWeeklyToolErrorRate(canonicalProject);
      expect(errorRate.series).toEqual([]);
      expect(errorRate.currentValue).toBeNull();

      const topTools = await projectView.getTopTools(canonicalProject, {});
      expect(topTools.rows).toEqual([]);

      const cohorts = await projectView.getModelHarnessCohorts(canonicalProject, {});
      expect(cohorts.rows).toEqual([]);

      // Turn-timeline segments (issue #169, final round). Same documented
      // ingestion gap: DefaultIngestionOrchestrator does not populate
      // messages/turns/invocations, so there is no timestamped evidence to
      // place on the timeline (segments: []) — but sessions.start_time/
      // end_time ARE populated, so the timeline's outer bounds are a real
      // known duration, not missing. This exercises exactly the "bounded
      // window, no evidence yet" branch of `resolveTimelineBounds`.
      const timeline = await sessionView.getTurnTimeline(receipt.sessionId);
      expect(timeline.segments).toEqual([]);
      expect(timeline.totalDurationMs).not.toBeNull();
      expect(timeline.token.eligibleN).toBe(0);

      // Project leaderboard (issue #169, final round). sessionCount is a
      // real measured 1 (sessions are populated); tokens/clean-rate are
      // honestly unknown/null for the same documented ingestion gap as the
      // stat strip above.
      const leaderboard = await portfolioView.getProjectLeaderboard({ portfolioId });
      const leaderboardRow = leaderboard.rows.find((r) => r.projectId === canonicalProject);
      expect(leaderboardRow?.sessionCount).toBe(1);
      expect(leaderboardRow?.tokens).toEqual({
        inputTokens: 0,
        inputKnownN: 0,
        outputTokens: 0,
        outputKnownN: 0,
      });
      expect(leaderboardRow?.cleanRate).toEqual({ value: null, eligibleN: 0, knownN: 0 });
      expect(leaderboardRow?.trend).toHaveLength(30);
    },
  );
});
