import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRESH_SCHEMA_SQL } from '@lucasschirm/sal-db-core';
import type {
  Artifact,
  ArtifactClassificationResult,
  ArtifactContent,
  DetectionResult,
  MetricCapability,
  ScalarMetricValue,
  SessionTransformer,
  TransformContext,
  TransformResult,
  UnknownArtifactBundle,
} from '@lucasschirm/sal-transformer';
import { ClaudeCodeTransformer, createDefaultRegistry } from '@lucasschirm/sal-transformer';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import { FailureInjectionExecutor } from './harness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '../../../parsers/claude-session-parser/tests/fixtures');

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

async function createExecutor(): Promise<FailureInjectionExecutor> {
  const inner = await WasmSqliteExecutor.create();
  await inner.exec(FRESH_SCHEMA_SQL);
  const harness = new FailureInjectionExecutor(inner);
  harness.setInjection(undefined);
  return harness;
}

interface MetricValueWithDefinition extends ScalarMetricValue {
  readonly dimensions: Readonly<Record<string, string>>;
  readonly rootScope: 'root_only' | 'inclusive';
  readonly definition: { readonly dimensions: readonly string[] };
}

function createUnknownDimensionTransformer(): SessionTransformer<UnknownArtifactBundle> {
  return {
    id: 'unknown-dimension',
    harnesses: ['unknown-dimension'],
    transformerVersion: '0.1.0',
    ontologyVersion: '0.1.0',
    detect: (): DetectionResult => ({
      kind: 'matched',
      harness: 'unknown-dimension',
      confidence: 1,
      reason: 'test-only transformer that injects an unregistered dimension',
    }),
    classifyArtifacts: (bundle?: UnknownArtifactBundle): ArtifactClassificationResult =>
      ClaudeCodeTransformer.classifyArtifacts(bundle),
    getCapabilities: (bundle?: UnknownArtifactBundle): MetricCapability[] =>
      ClaudeCodeTransformer.getCapabilities(bundle),
    transform: (bundle: UnknownArtifactBundle, context: TransformContext): TransformResult => {
      const result = ClaudeCodeTransformer.transform(bundle, context);
      return injectUnknownDimension(result);
    },
  };
}

function injectUnknownDimension(result: TransformResult): TransformResult {
  const values = result.metricValues as unknown as MetricValueWithDefinition[];
  const index = values.findIndex((v) => v.metricId === 'claude:tokens:input:root_only');
  if (index < 0) return result;

  const next = values.map((v, i) =>
    i === index
      ? {
          ...v,
          dimensions: { ...v.dimensions, unregistered_dimension: 'bogus' },
        }
      : v,
  );

  return {
    ...result,
    metricValues: next as unknown as readonly ScalarMetricValue[],
  };
}

async function countBogusValues(
  executor: FailureInjectionExecutor,
  generationId: string,
): Promise<number> {
  const { rows } = await executor.exec(
    `SELECT COUNT(*) AS c FROM metric_values
     WHERE generation_id = ? AND dimensions_key LIKE '%' || ? || '%'`,
    [generationId, 'bogus'],
  );
  return Number(rows[0]?.c ?? 0);
}

describe('PIPE-003: unknown metric dimension is never silently skipped', () => {
  it('rejects a transformer output that carries an unregistered metric dimension', async () => {
    const executor = await createExecutor();
    const hasher = createSha256ContentHasher();
    const registry = createDefaultRegistry();
    registry.register(createUnknownDimensionTransformer());

    const content = readFixture('t2-happy-path.jsonl');
    const sha256 = await hasher.hash(content);

    const artifact: Artifact<ArtifactContent> = {
      relativePath: 'session/transcript.jsonl',
      mediaType: 'application/jsonl',
      sha256,
      size: content.length,
      content,
      status: 'uploaded',
    };

    const orchestrator = new DefaultIngestionOrchestrator({
      executor,
      hasher,
      registry,
      resolver: { resolve: async (ref) => ({ ...ref, content: new Uint8Array(0) }) },
      analysisReleaseId: 'ar-pipe003',
    });

    const receipt = await orchestrator.ingestManual({
      artifacts: [artifact],
      source: { sourceId: 'default' },
      harness: 'unknown-dimension',
      projectId: 'project-pipe003',
      sessionId: 'sess-happy-1',
    });

    expect(receipt.status).toBe('failed');
    expect(receipt.issueIds).toContain('unknown_metric_dimension');

    const bogusValueCount = await countBogusValues(executor, receipt.generationId);
    expect(bogusValueCount).toBe(0);
  });
});
