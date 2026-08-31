import { FRESH_SCHEMA_SQL } from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createAnalyticsDataSource } from '../../src/analytics.js';
import type { IngestionReceipt } from '../../src/ingestion.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';

const ANALYSIS_RELEASE = 'ar-pipe012';
const PROJECT = 'project-pipe012';
const COST_METRIC_ID = 'claude:cost:total:root_only';
const KNOWN_MODEL = 'claude-3-5-sonnet-20241022';

interface FixtureSession {
  readonly sessionId: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
}

const FIXTURES: readonly FixtureSession[] = [
  {
    sessionId: 'sess-pipe012-a',
    model: KNOWN_MODEL,
    inputTokens: 1_000,
    outputTokens: 200,
    cacheCreationTokens: 50,
    cacheReadTokens: 20,
  },
  {
    sessionId: 'sess-pipe012-b',
    model: KNOWN_MODEL,
    inputTokens: 500,
    outputTokens: 100,
    cacheCreationTokens: 20,
    cacheReadTokens: 10,
  },
];

function baseEntry(sessionId: string, uuid: string, parentUuid: string | null) {
  return { sessionId, timestamp: '2026-08-01T10:00:00.000Z', parentUuid, uuid, isSidechain: false };
}

function makePermissionLine(sessionId: string): string {
  return JSON.stringify({ type: 'permission-mode', permissionMode: 'normal', sessionId });
}

function makeUserLine(sessionId: string): string {
  return JSON.stringify({
    ...baseEntry(sessionId, `${sessionId}-user`, null),
    type: 'user',
    message: { role: 'user', content: 'Hello' },
  });
}

function makeAssistantLine(fixture: FixtureSession): string {
  const { sessionId, model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens } =
    fixture;
  return JSON.stringify({
    ...baseEntry(sessionId, `${sessionId}-assistant`, `${sessionId}-user`),
    type: 'assistant',
    requestId: `${sessionId}-req`,
    message: {
      model,
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi' }],
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: cacheCreationTokens,
        cache_read_input_tokens: cacheReadTokens,
      },
    },
  });
}

function makeTranscript(fixture: FixtureSession): string {
  const { sessionId } = fixture;
  return [makePermissionLine(sessionId), makeUserLine(sessionId), makeAssistantLine(fixture)].join(
    '\n',
  );
}

function expectedCost(fixture: FixtureSession): number {
  return (
    fixture.inputTokens * 0.000_003 +
    fixture.outputTokens * 0.000_015 +
    fixture.cacheCreationTokens * 0.000_003_75 +
    fixture.cacheReadTokens * 0.000_000_3
  );
}

async function ingestSession(
  orchestrator: DefaultIngestionOrchestrator,
  hasher: ReturnType<typeof createSha256ContentHasher>,
  fixture: FixtureSession,
): Promise<IngestionReceipt> {
  const content = makeTranscript(fixture);
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
    sessionId: fixture.sessionId,
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

  const receipts: IngestionReceipt[] = [];
  for (const fixture of FIXTURES) {
    const receipt = await ingestSession(orchestrator, hasher, fixture);
    expect(receipt.status).toBe('committed');
    receipts.push(receipt);
  }

  return { executor, dataSource, receipts };
}

async function findProjectId(executor: WasmSqliteExecutor, sessionId: string): Promise<string> {
  const { rows } = await executor.exec('SELECT project_id FROM sessions WHERE id = ?', [sessionId]);
  return String(rows[0]?.project_id ?? '');
}

describe('PIPE-012: pricing_version evidence record id is session-scoped', () => {
  it('ingests two same-project sessions using the same priced model without a primary key collision', async () => {
    const { executor, dataSource, receipts } = await setup();

    const { rows } = await executor.exec(
      'SELECT COUNT(*) AS count FROM normalized_events WHERE event_type = ?',
      ['pricing_versions'],
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(2);

    const projectId = await findProjectId(executor, receipts[0].sessionId);
    const trends = await dataSource.project.getSessionTrendSeries(projectId, {});
    const costPoint = trends.series.find((s) => s.metricId === COST_METRIC_ID);
    expect(costPoint).toBeDefined();

    let totalCost = 0;
    for (let i = 0; i < FIXTURES.length; i++) {
      const fixture = FIXTURES[i];
      const receipt = receipts[i];
      const summary = await dataSource.session.getSummary(receipt.sessionId);
      const cost = summary.headlineMetrics.find((m) => m.metricId === COST_METRIC_ID);
      expect(cost).toBeDefined();
      expect(cost?.value).toBeCloseTo(expectedCost(fixture), 10);
      totalCost += expectedCost(fixture);
    }

    expect(costPoint?.value).toBeCloseTo(totalCost, 10);
  });
});
