import {
  deterministicId,
  deterministicPortfolioId,
  FRESH_SCHEMA_SQL,
  SessionOutcomeStore,
  SessionStore,
} from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { getSessionOutcomeDistribution } from '../../src/analytics-session.js';
import type { IngestionReceipt } from '../../src/ingestion.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';

/**
 * PIPE-013: session outcome — parse → transform → ingest → outcome rollup
 * query, for the one registered harness plugin (claude-code; see the
 * per-harness signal audit posted on issue #178). Exercises the full
 * pipeline seam this feature adds: the transformer's outcome classification
 * (packages/transformer/src/plugin/claude-code.ts), the
 * `sessions.outcome` canonical column (packages/db-core migration v81),
 * and the `SessionOutcomeStore.rollupByProject` / `getSessionOutcomeDistribution`
 * rollup query db-core/db expose for sub-issue #169's DTO consumers.
 */

const ANALYSIS_RELEASE = 'ar-pipe013';
const PROJECT = 'project-pipe013';

/**
 * Mirrors `DefaultIngestionOrchestrator.resolveManualCanonicalIdentity`'s
 * `projectId` derivation exactly (same deterministic-id helpers, same
 * inputs for a manual ingest with the default tenant/portfolio) so this
 * test can address `SessionStore`/`SessionOutcomeStore` by the real
 * canonical `project_id` without any raw SQL lookup
 * (`.agents/rules/sql-only-in-db-core.md`).
 */
function canonicalProjectId(nativeProjectId: string): string {
  const portfolioId = deterministicPortfolioId('ten-default', 'default');
  return `prj-${deterministicId('project', portfolioId, nativeProjectId)}`;
}

function baseEntry(sessionId: string, uuid: string, parentUuid: string | null) {
  return { sessionId, timestamp: '2026-08-20T10:00:00.000Z', parentUuid, uuid, isSidechain: false };
}

function userLine(sessionId: string, uuid: string, text: string): string {
  return JSON.stringify({
    ...baseEntry(sessionId, uuid, null),
    type: 'user',
    message: { role: 'user', content: text },
  });
}

function assistantTextLine(
  sessionId: string,
  uuid: string,
  parentUuid: string,
  text: string,
): string {
  return JSON.stringify({
    ...baseEntry(sessionId, uuid, parentUuid),
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

function assistantErrorLine(sessionId: string, uuid: string, parentUuid: string): string {
  return JSON.stringify({
    ...baseEntry(sessionId, uuid, parentUuid),
    type: 'assistant',
    isApiErrorMessage: true,
    apiErrorStatus: 529,
    error: { type: 'overloaded_error', message: 'overloaded' },
    message: { role: 'assistant', content: [{ type: 'text', text: 'overloaded' }] },
  });
}

function userInterruptedLine(sessionId: string, uuid: string, parentUuid: string): string {
  return JSON.stringify({
    ...baseEntry(sessionId, uuid, parentUuid),
    type: 'user',
    interruptedByShutdown: true,
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
  });
}

function unreadableTranscript(sessionId: string): string {
  return JSON.stringify({ type: 'mode', mode: 'normal', sessionId });
}

interface OutcomeFixture {
  readonly sessionId: string;
  readonly transcript: string;
}

function cleanFixture(): OutcomeFixture {
  const sessionId = 'sess-pipe013-clean';
  return {
    sessionId,
    transcript: [
      userLine(sessionId, `${sessionId}-u1`, 'What does this repo do?'),
      assistantTextLine(sessionId, `${sessionId}-a1`, `${sessionId}-u1`, 'It is a demo repo.'),
    ].join('\n'),
  };
}

function interruptedFixture(): OutcomeFixture {
  const sessionId = 'sess-pipe013-interrupted';
  return {
    sessionId,
    transcript: [
      userLine(sessionId, `${sessionId}-u1`, 'Run the full test suite.'),
      assistantTextLine(sessionId, `${sessionId}-a1`, `${sessionId}-u1`, 'Running now.'),
      userInterruptedLine(sessionId, `${sessionId}-u2`, `${sessionId}-a1`),
    ].join('\n'),
  };
}

function errorFixture(): OutcomeFixture {
  const sessionId = 'sess-pipe013-error';
  return {
    sessionId,
    transcript: [
      userLine(sessionId, `${sessionId}-u1`, 'Summarize the release notes.'),
      assistantErrorLine(sessionId, `${sessionId}-a1`, `${sessionId}-u1`),
    ].join('\n'),
  };
}

function unreadableFixture(): OutcomeFixture {
  const sessionId = 'sess-pipe013-unreadable';
  return { sessionId, transcript: unreadableTranscript(sessionId) };
}

async function ingestFixture(
  orchestrator: DefaultIngestionOrchestrator,
  hasher: ReturnType<typeof createSha256ContentHasher>,
  fixture: OutcomeFixture,
): Promise<IngestionReceipt> {
  const sha256 = await hasher.hash(fixture.transcript);
  return orchestrator.ingestManual({
    artifacts: [
      {
        relativePath: 'session/transcript.jsonl',
        mediaType: 'application/jsonl',
        sha256,
        size: fixture.transcript.length,
        content: fixture.transcript,
        status: 'uploaded',
      },
    ],
    source: { sourceId: 'default' },
    harness: 'claude-code',
    projectId: PROJECT,
    sessionId: fixture.sessionId,
  });
}

async function markFinal(
  executor: WasmSqliteExecutor,
  projectId: string,
  sessionId: string,
): Promise<void> {
  // The transformer does not yet emit finality='final' for any session (a
  // known, separately-tracked gap noted in the issue #178 signal audit) —
  // simulate the session-finalization step this metric's population rule
  // depends on (`finality = 'final'`) so the rollup query has a non-empty
  // population to exercise. Uses the typed db-core store, never raw SQL
  // (`.agents/rules/sql-only-in-db-core.md`).
  await SessionStore.update(executor, projectId, sessionId, { finality: 'final' });
}

describe('PIPE-013: session outcome rollup (claude-code)', () => {
  it('classifies clean/interrupted/error/unreadable outcomes end-to-end and rolls them up per project', async () => {
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

    const projectId = canonicalProjectId(PROJECT);
    const fixtures = [cleanFixture(), interruptedFixture(), errorFixture(), unreadableFixture()];
    const receipts: IngestionReceipt[] = [];
    for (const fixture of fixtures) {
      const receipt = await ingestFixture(orchestrator, hasher, fixture);
      expect(receipt.status).toBe('committed');
      receipts.push(receipt);
      await markFinal(executor, projectId, receipt.sessionId);
    }

    const outcomeByNative = new Map<string, unknown>();
    for (let i = 0; i < fixtures.length; i++) {
      const session = await SessionStore.getById(executor, projectId, receipts[i].sessionId);
      outcomeByNative.set(fixtures[i].sessionId, session?.outcome);
    }
    expect(outcomeByNative.get('sess-pipe013-clean')).toBe('clean');
    expect(outcomeByNative.get('sess-pipe013-interrupted')).toBe('interrupted_by_user');
    expect(outcomeByNative.get('sess-pipe013-error')).toBe('ended_on_error');
    expect(outcomeByNative.get('sess-pipe013-unreadable')).toBeNull();

    // Rollup query — db-core store, the seam sub-issue #169's DTO will read.
    const rollup = await SessionOutcomeStore.rollupByProject(executor, projectId);
    const byOutcome = new Map(rollup.map((r) => [r.outcome, r.count]));
    expect(byOutcome.get('clean')).toBe(1);
    expect(byOutcome.get('interrupted_by_user')).toBe(1);
    expect(byOutcome.get('ended_on_error')).toBe(1);
    expect(byOutcome.get(null)).toBe(1);

    // Coverage-breakdown DTO — db layer, per missing-is-never-zero and
    // aggregates-expose-sample-size: n classified vs n missing, never a bare
    // number.
    const distribution = await getSessionOutcomeDistribution(executor, projectId);
    expect(distribution.token.eligibleN).toBe(4);
    expect(distribution.token.knownN).toBe(3);
    expect(distribution.token.unknownCount).toBe(1);
    expect(distribution.buckets).toHaveLength(4);
  });
});
