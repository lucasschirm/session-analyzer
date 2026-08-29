import {
  FRESH_SCHEMA_SQL,
  MetricDefinitionStore,
  MetricValueStore,
  ProjectDailyRollupStore,
  RollupContributionStore,
} from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { type AnalyticsDataSource, createAnalyticsDataSource } from '../../src/analytics.js';
import type { IngestionReceipt } from '../../src/ingestion.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';

const ANALYSIS_RELEASE = 'ar-pipe008';
const PROJECT = 'project-pipe008';
const COST_METRIC_ID = 'claude:cost:total:root_only';
const KNOWN_MODEL = 'claude-3-5-sonnet-20241022';
const UNKNOWN_MODEL = 'openai/gpt-4';

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
    sessionId: 'sess-pipe008-missing',
    model: UNKNOWN_MODEL,
    inputTokens: 1_000,
    outputTokens: 200,
    cacheCreationTokens: 50,
    cacheReadTokens: 20,
  },
  {
    sessionId: 'sess-pipe008-known-a',
    model: KNOWN_MODEL,
    inputTokens: 1_000,
    outputTokens: 200,
    cacheCreationTokens: 50,
    cacheReadTokens: 20,
  },
  {
    sessionId: 'sess-pipe008-known-b',
    model: 'claude-3-5-haiku-20241022',
    inputTokens: 500,
    outputTokens: 100,
    cacheCreationTokens: 20,
    cacheReadTokens: 10,
  },
];

interface TestContext {
  readonly executor: WasmSqliteExecutor;
  readonly dataSource: AnalyticsDataSource;
  readonly projectId: string;
  readonly costDefId: string;
  readonly missingSessionId: string;
  readonly knownSessionIds: readonly [string, string];
  readonly knownCosts: readonly [number, number];
}

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

async function findProjectId(executor: WasmSqliteExecutor, sessionId: string): Promise<string> {
  const { rows } = await executor.exec('SELECT project_id FROM sessions WHERE id = ?', [sessionId]);
  return String(rows[0]?.project_id ?? '');
}

function createOrchestrator(
  executor: WasmSqliteExecutor,
  hasher: ReturnType<typeof createSha256ContentHasher>,
): DefaultIngestionOrchestrator {
  return new DefaultIngestionOrchestrator({
    executor,
    hasher,
    registry: createDefaultRegistry(),
    resolver: { resolve: async (ref) => ({ ...ref, content: new Uint8Array(0) }) },
    analysisReleaseId: ANALYSIS_RELEASE,
  });
}

async function ingestAllFixtures(
  orchestrator: DefaultIngestionOrchestrator,
  hasher: ReturnType<typeof createSha256ContentHasher>,
): Promise<IngestionReceipt[]> {
  const receipts: IngestionReceipt[] = [];
  for (const fixture of FIXTURES) {
    const receipt = await ingestSession(orchestrator, hasher, fixture);
    expect(receipt.status).toBe('committed');
    receipts.push(receipt);
  }
  return receipts;
}

async function extractKnownCosts(
  executor: WasmSqliteExecutor,
  costDefId: string,
  receipts: readonly IngestionReceipt[],
): Promise<readonly [number, number]> {
  const knownValues: number[] = [];
  for (let i = 1; i < receipts.length; i++) {
    const cost = await getCostValue(executor, costDefId, receipts[i].sessionId);
    if (cost?.numericValue === null || cost?.numericValue === undefined) {
      throw new Error(`Expected known cost for ${receipts[i].sessionId}`);
    }
    knownValues.push(cost.numericValue);
  }
  return [knownValues[0], knownValues[1]];
}

async function setupContext(): Promise<TestContext> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  const hasher = createSha256ContentHasher();
  const orchestrator = createOrchestrator(executor, hasher);
  const dataSource = createAnalyticsDataSource(executor);

  const receipts = await ingestAllFixtures(orchestrator, hasher);
  const projectId = await findProjectId(executor, receipts[1].sessionId);
  const definition = await MetricDefinitionStore.getByMetricIdAndVersion(
    executor,
    COST_METRIC_ID,
    1,
  );
  if (!definition) throw new Error(`Metric definition not found: ${COST_METRIC_ID}`);

  const knownCosts = await extractKnownCosts(executor, definition.id, receipts);

  return {
    executor,
    dataSource,
    projectId,
    costDefId: definition.id,
    missingSessionId: receipts[0].sessionId,
    knownSessionIds: [receipts[1].sessionId, receipts[2].sessionId],
    knownCosts,
  };
}

async function getCostValue(executor: WasmSqliteExecutor, costDefId: string, sessionId: string) {
  const values = await MetricValueStore.listBySession(executor, sessionId);
  return values.find((v) => v.metricDefinitionId === costDefId);
}

async function assertMissingSessionValue(context: TestContext): Promise<void> {
  const value = await getCostValue(context.executor, context.costDefId, context.missingSessionId);
  expect(value).toBeDefined();
  expect(value?.numericValue).toBeNull();
  expect(value?.isUnavailable).toBe(true);
  expect(value?.unavailableReason).toContain('pricing');
}

async function assertKnownSessionValues(context: TestContext): Promise<void> {
  for (const sessionId of context.knownSessionIds) {
    const value = await getCostValue(context.executor, context.costDefId, sessionId);
    expect(value).toBeDefined();
    expect(value?.numericValue).not.toBeNull();
    expect(value?.numericValue).toBeGreaterThan(0);
    expect(value?.isUnavailable).toBe(false);
  }
}

async function assertCoverageBreakdown(context: TestContext): Promise<void> {
  const coverage = await context.dataSource.metadata.getCoverageExplanation(COST_METRIC_ID, {
    filters: [{ field: 'projectId', operator: 'eq', value: context.projectId }],
  });
  expect(coverage.eligibleN).toBe(3);
  expect(coverage.knownN).toBe(2);
  expect(coverage.unknownCount).toBe(1);
  expect(coverage.coverage).toBe('partial');
}

async function getCostRollup(context: TestContext) {
  const rollups = await ProjectDailyRollupStore.listByProjectAndMetric(
    context.executor,
    context.projectId,
    context.costDefId,
  );
  return rollups.find((r) => r.dayBucket === '2026-08-01');
}

async function assertRollupExcludesMissing(context: TestContext): Promise<void> {
  const rollup = await getCostRollup(context);
  expect(rollup).toBeDefined();

  const [a, b] = context.knownCosts;
  const expectedSum = a + b;
  const expectedMean = expectedSum / 2;
  const expectedMin = Math.min(a, b);
  const expectedMax = Math.max(a, b);

  expect(rollup?.valueCount).toBe(2);
  expect(rollup?.valueSum).toBeCloseTo(expectedSum, 10);
  expect(rollup?.valueMean).toBeCloseTo(expectedMean, 10);
  expect(rollup?.valueMin).toBeCloseTo(expectedMin, 10);
  expect(rollup?.valueMax).toBeCloseTo(expectedMax, 10);
}

async function assertRollupContributions(context: TestContext): Promise<void> {
  const contributions = await RollupContributionStore.listByProject(
    context.executor,
    context.projectId,
  );
  const costContributions = contributions.filter(
    (c) =>
      c.metricDefinitionId === context.costDefId &&
      c.bucketType === 'daily' &&
      c.contributionScope === 'root_only',
  );

  expect(costContributions).toHaveLength(2);
  const values = costContributions.map((c) => c.additiveValue).sort((a, b) => a - b);
  const [a, b] = context.knownCosts;
  expect(values[0]).toBeCloseTo(Math.min(a, b), 10);
  expect(values[1]).toBeCloseTo(Math.max(a, b), 10);
}

async function assertTrendSeries(context: TestContext): Promise<void> {
  const series = await context.dataSource.project.getSessionTrendSeries(context.projectId, {});
  const costPoint = series.series.find((s) => s.metricId === COST_METRIC_ID);
  expect(costPoint).toBeDefined();

  const [a, b] = context.knownCosts;
  expect(costPoint?.value).toBeCloseTo(a + b, 10);
}

describe('PIPE-008: missing-vs-zero in aggregates', () => {
  it('records missing cost as unavailable and excludes it from rollups and coverage', async () => {
    const context = await setupContext();
    await assertMissingSessionValue(context);
    await assertKnownSessionValues(context);
    await assertCoverageBreakdown(context);
    await assertRollupExcludesMissing(context);
    await assertRollupContributions(context);
    await assertTrendSeries(context);
  });
});
