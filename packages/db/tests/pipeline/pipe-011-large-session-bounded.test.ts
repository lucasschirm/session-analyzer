import { FRESH_SCHEMA_SQL, getCurrentGenerationId } from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import type { AnalyticsDataSource } from '../../src/analytics.js';
import { createAnalyticsDataSource } from '../../src/analytics.js';
import type { IngestionReceipt } from '../../src/ingestion.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import type { ContentHasher } from '../../src/ports.js';
import { FailureInjectionExecutor } from './harness.js';

const PROJECT_ID = 'project-pipe011';
const SESSION_ID = 'sess-pipe011-large';
const ANALYSIS_RELEASE_ID = 'ar-pipe011';

/**
 * Number of assistant/user/tool-result turns in the oversized fixture.
 * This produces a transcript with several thousand events and stresses the
 * parse → transform → ingest → query path while remaining deterministic.
 */
const TURN_COUNT = 5000;

/**
 * Wall-clock bound for the full pipeline. Measured at ~2.9s for 5000 turns
 * on this macOS host; 30s gives a ~10x margin for CI variance while still
 * failing before the runner timeout if the pipeline stalls or grows
 * unboundedly.
 */
const DURATION_BOUND_MS = 30_000;
const TEST_TIMEOUT_MS = 60_000;

const TOOL_NAMES = ['Read', 'Bash', 'Glob', 'Grep', 'Write', 'Edit'] as const;
const MODELS = ['model-a', 'model-b', 'model-c'] as const;

function toolNameForTurn(turnIndex: number): string {
  return TOOL_NAMES[turnIndex % TOOL_NAMES.length] ?? 'Read';
}

function modelForTurn(turnIndex: number): string {
  return MODELS[turnIndex % MODELS.length] ?? 'model-a';
}

function timestampForTurn(turnIndex: number, offsetSeconds: number): string {
  const base = new Date('2026-08-01T10:00:00.000Z').getTime();
  return new Date(base + (turnIndex * 3 + offsetSeconds) * 1000).toISOString();
}

function headerLines(sessionId: string): string[] {
  return [
    JSON.stringify({ type: 'mode', mode: 'default', sessionId }),
    JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId }),
    JSON.stringify({ type: 'agent-name', agentName: 'large-session-agent', sessionId }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Large session benchmark', sessionId }),
    JSON.stringify({
      type: 'last-prompt',
      lastPrompt: 'Process many turns',
      leafUuid: 'u-last',
      sessionId,
    }),
  ];
}

interface TurnUuids {
  readonly userUuid: string;
  readonly assistantUuid: string;
  readonly resultUuid: string;
  readonly toolUseId: string;
}

function uuidsForTurn(turnIndex: number): TurnUuids {
  return {
    userUuid: `u-${turnIndex}`,
    assistantUuid: `a-${turnIndex}`,
    resultUuid: `r-${turnIndex}`,
    toolUseId: `toolu-${turnIndex}`,
  };
}

function toolInput(name: string, turnIndex: number): Record<string, unknown> {
  const file = `src/file-${turnIndex}.ts`;
  if (name === 'Read') return { file_path: file };
  if (name === 'Bash') return { command: `echo "turn ${turnIndex}"` };
  if (name === 'Glob') return { pattern: 'src/**/*.ts' };
  if (name === 'Grep') return { pattern: `pattern-${turnIndex}`, path: 'src' };
  if (name === 'Write') return { file_path: file, content: `// turn ${turnIndex}` };
  if (name === 'Edit') return { file_path: file, old_string: 'old', new_string: 'new' };
  return { query: `query-${turnIndex}` };
}

function fileToolResult(turnIndex: number): Record<string, unknown> {
  return {
    file: {
      filePath: `src/file-${turnIndex}.ts`,
      content: `Content for turn ${turnIndex}`,
      numLines: 1,
      totalLines: 1,
    },
  };
}

function toolUseResult(name: string, turnIndex: number): Record<string, unknown> {
  if (name === 'Read' || name === 'Write' || name === 'Edit') return fileToolResult(turnIndex);
  if (name === 'Bash') return { stdout: `stdout for turn ${turnIndex}`, exitCode: 0 };
  if (name === 'Glob') return { filenames: ['src/a.ts', 'src/b.ts'], numFiles: 2 };
  if (name === 'Grep') return { totalMatches: 1 };
  return { content: `Result for turn ${turnIndex}` };
}

function resultContent(name: string, turnIndex: number): unknown {
  if (name === 'Glob') return ['src/a.ts', 'src/b.ts'];
  if (name === 'Grep') return `match for pattern-${turnIndex}`;
  return `Content for turn ${turnIndex}`;
}

function userMessageLine(turnIndex: number, parentUuid: string | null, sessionId: string): string {
  const { userUuid } = uuidsForTurn(turnIndex);
  return JSON.stringify({
    type: 'user',
    uuid: userUuid,
    parentUuid,
    timestamp: timestampForTurn(turnIndex, 1),
    sessionId,
    cwd: '/project',
    message: { role: 'user', content: `Turn ${turnIndex} request` },
  });
}

function assistantMessage(turnIndex: number, toolUseId: string): Record<string, unknown> {
  const name = toolNameForTurn(turnIndex);
  return {
    role: 'assistant',
    model: modelForTurn(turnIndex),
    content: [
      { type: 'text', text: `Running ${name} for turn ${turnIndex}` },
      { type: 'tool_use', id: toolUseId, name, input: toolInput(name, turnIndex) },
    ],
    usage: {
      input_tokens: 100 + (turnIndex % 500),
      output_tokens: 50 + (turnIndex % 100),
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 5,
    },
  };
}

function assistantMessageLine(turnIndex: number, sessionId: string): string {
  const { assistantUuid, toolUseId } = uuidsForTurn(turnIndex);
  return JSON.stringify({
    type: 'assistant',
    uuid: assistantUuid,
    parentUuid: `u-${turnIndex}`,
    timestamp: timestampForTurn(turnIndex, 2),
    sessionId,
    cwd: '/project',
    message: assistantMessage(turnIndex, toolUseId),
  });
}

function toolResultLine(turnIndex: number, sessionId: string): string {
  const { resultUuid, toolUseId } = uuidsForTurn(turnIndex);
  const name = toolNameForTurn(turnIndex);
  return JSON.stringify({
    type: 'user',
    uuid: resultUuid,
    parentUuid: `a-${turnIndex}`,
    timestamp: timestampForTurn(turnIndex, 3),
    sessionId,
    cwd: '/project',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: resultContent(name, turnIndex) },
      ],
    },
    toolUseResult: toolUseResult(name, turnIndex),
  });
}

function turnLines(
  turnIndex: number,
  previousAssistantUuid: string | null,
  sessionId: string,
): string[] {
  const parentUuid = previousAssistantUuid ?? null;
  return [
    userMessageLine(turnIndex, parentUuid, sessionId),
    assistantMessageLine(turnIndex, sessionId),
    toolResultLine(turnIndex, sessionId),
  ];
}

function generateLargeTranscript(turnCount: number, sessionId: string): string {
  const lines = headerLines(sessionId);
  let previousAssistantUuid: string | null = null;
  for (let i = 0; i < turnCount; i++) {
    lines.push(...turnLines(i, previousAssistantUuid, sessionId));
    previousAssistantUuid = `a-${i}`;
  }
  lines.push(
    JSON.stringify({
      type: 'summary',
      summary: `Completed ${turnCount} turns`,
      leafUuid: 'u-last',
      sessionId,
    }),
  );
  return lines.join('\n');
}

function transcriptArtifact(content: string, sha256: string) {
  return {
    relativePath: 'session/transcript.jsonl',
    mediaType: 'application/jsonl',
    sha256,
    size: content.length,
    content,
    status: 'uploaded' as const,
  };
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
    analysisReleaseId: ANALYSIS_RELEASE_ID,
  });
  const hasher = createSha256ContentHasher();
  return { harness, orchestrator, hasher };
}

async function ingestFixture(
  orchestrator: DefaultIngestionOrchestrator,
  hasher: ContentHasher,
  content: string,
): Promise<IngestionReceipt> {
  const sha256 = await hasher.hash(content);
  return orchestrator.ingestManual({
    artifacts: [transcriptArtifact(content, sha256)],
    source: { sourceId: 'default' },
    harness: 'claude-code',
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
  });
}

async function runPipelineWithTimer(
  orchestrator: DefaultIngestionOrchestrator,
  hasher: ContentHasher,
  content: string,
): Promise<{ receipt: IngestionReceipt; durationMs: number }> {
  const start = Date.now();
  const receipt = await ingestFixture(orchestrator, hasher, content);
  const durationMs = Date.now() - start;
  return { receipt, durationMs };
}

async function assertResults(
  dataSource: AnalyticsDataSource,
  harness: FailureInjectionExecutor,
  receipt: IngestionReceipt,
) {
  const currentGenerationId = await getCurrentGenerationId(harness, receipt.sessionId);
  expect(currentGenerationId).toBe(receipt.generationId);

  const overview = await dataSource.portfolio.getOverview({});
  expect(overview.sessionCount).toBeGreaterThan(0);
  expect(overview.totalTokens).toBeGreaterThan(0);

  const summary = await dataSource.session.getSummary(receipt.sessionId);
  expect(summary.headlineMetrics.length).toBeGreaterThan(0);
  expect(summary.token.generationId).toBe(currentGenerationId);
}

/**
 * `scripts/generate-benchmark-fixtures.ts` produces synthetic benchmark
 * sessions that route through the `BenchmarkTransformer`, bypassing the
 * Claude Code parser entirely. For PIPE-011 we need to stress the real
 * parse → transform → ingest path, so this test builds an oversized but
 * realistic Claude Code JSONL transcript inline.
 */
describe('PIPE-011: large-session boundedness', () => {
  it('completes a large realistic session through the full pipeline within a bounded time', {
    timeout: TEST_TIMEOUT_MS,
  }, async () => {
    const { harness, orchestrator, hasher } = await setupPipeline();
    const content = generateLargeTranscript(TURN_COUNT, SESSION_ID);
    const { receipt, durationMs } = await runPipelineWithTimer(orchestrator, hasher, content);

    expect(receipt.status).toBe('committed');
    expect(durationMs).toBeLessThan(DURATION_BOUND_MS);

    const dataSource = createAnalyticsDataSource(harness);
    await assertResults(dataSource, harness, receipt);
  });
});
