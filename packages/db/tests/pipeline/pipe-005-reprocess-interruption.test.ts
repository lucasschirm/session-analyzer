import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FRESH_SCHEMA_SQL,
  getCurrentGenerationId,
  type SqliteExecutor,
} from '@lucasschirm/sal-db-core';
import { MANIFEST_SCHEMA_VERSION, type SyncManifest } from '@lucasschirm/sal-sync-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createAnalyticsDataSource } from '../../src/analytics.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import type { VerifiedManifestBundle } from '../../src/manifest.js';
import type { ResolvedArtifact } from '../../src/ports.js';
import type { ReprocessingReport } from '../../src/reprocessing.js';
import { DefaultReprocessingEngine } from '../../src/reprocessing.js';
import { FailureInjectionExecutor } from './harness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '../../../parsers/claude-session-parser/tests/fixtures');

const PROJECT = 'project-pipe005';
const SESSION = 'sess-pipe005';
const ORIGINAL_RELEASE = 'ar-pipe005';
const RECOVERY_RELEASE = 'ar-pipe005-recovery';
const TRANSCRIPT_PATH = 'session/transcript.jsonl';

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

function makeResolver() {
  return { resolve: async (ref: { sha256: string }) => ({ ...ref, content: new Uint8Array(0) }) };
}

function makeIngestionOrchestrator(executor: SqliteExecutor, analysisReleaseId: string) {
  return new DefaultIngestionOrchestrator({
    executor,
    hasher: createSha256ContentHasher(),
    registry: createDefaultRegistry(),
    resolver: makeResolver(),
    analysisReleaseId,
  });
}

function makeReprocessingEngine(executor: SqliteExecutor, analysisReleaseId: string) {
  return new DefaultReprocessingEngine({
    executor,
    resolver: makeResolver(),
    hasher: createSha256ContentHasher(),
    registry: createDefaultRegistry(),
    analysisReleaseId,
  });
}

function makeClaudeManifest(content: string, sha256: string, projectId: string, sessionId: string) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    projectId,
    sessionId,
    environmentId: 'default',
    harness: 'claude-code',
    harnessVersion: '0.1.0',
    syncVersion: '0.1.0',
    pluginVersion: '0.1.0',
    transcriptsCaptured: true,
    mainTranscriptRelativePath: TRANSCRIPT_PATH,
    artifacts: [
      {
        scope: 'session',
        relativePath: TRANSCRIPT_PATH,
        mediaType: 'application/jsonl',
        sha256,
        size: content.length,
        status: 'uploaded',
      },
    ],
    syncRuns: [],
  } as SyncManifest;
}

function makeResolvedArtifact(content: string, sha256: string): ResolvedArtifact {
  return {
    relativePath: TRANSCRIPT_PATH,
    mediaType: 'application/jsonl',
    sha256,
    size: content.length,
    content,
  };
}

function makeManifestBundle(
  content: string,
  sha256: string,
  projectId: string,
  sessionId: string,
): VerifiedManifestBundle {
  return {
    manifest: makeClaudeManifest(content, sha256, projectId, sessionId),
    source: { sourceId: 'default', environmentId: 'dev', projectId, sessionId },
    resolvedArtifacts: [makeResolvedArtifact(content, sha256)],
    integrityVerified: false,
  };
}

async function setupBaseline() {
  const inner = await WasmSqliteExecutor.create();
  await inner.exec(FRESH_SCHEMA_SQL);
  const harness = new FailureInjectionExecutor(inner);

  const content = readFixture('t2-happy-path.jsonl');
  const sha256 = await createSha256ContentHasher().hash(content);
  const bundle = makeManifestBundle(content, sha256, PROJECT, SESSION);

  const orchestrator = makeIngestionOrchestrator(harness, ORIGINAL_RELEASE);
  const receipt = await orchestrator.ingestManifest(bundle);
  expect(receipt.status).toBe('committed');

  const { rows } = await harness.exec('SELECT project_id FROM sessions WHERE id = ?', [
    receipt.sessionId,
  ]);
  const projectId = String(rows[0]?.project_id ?? '');

  return {
    harness,
    engine: makeReprocessingEngine(harness, RECOVERY_RELEASE),
    sessionId: receipt.sessionId,
    projectId,
    originalGenerationId: receipt.generationId,
  };
}

async function getGenerationStatus(executor: SqliteExecutor, generationId: string) {
  const { rows } = await executor.exec(
    'SELECT status FROM transformation_generations WHERE id = ?',
    [generationId],
  );
  return String(rows[0]?.status ?? '');
}

async function getRollupGenerationIds(executor: SqliteExecutor, projectId: string) {
  const { rows } = await executor.exec(
    'SELECT DISTINCT generation_id FROM project_daily_rollups WHERE project_id = ? ORDER BY generation_id',
    [projectId],
  );
  return rows.map((r) => String(r.generation_id ?? ''));
}

interface RollupCounts {
  readonly contributions: number;
  readonly daily: number;
}

async function getRollupCounts(
  executor: SqliteExecutor,
  projectId: string,
  analysisReleaseId: string,
): Promise<RollupCounts> {
  const { rows: contributionRows } = await executor.exec(
    'SELECT COUNT(*) AS c FROM rollup_contributions WHERE project_id = ? AND analysis_release_id = ?',
    [projectId, analysisReleaseId],
  );
  const { rows: dailyRows } = await executor.exec(
    'SELECT COUNT(*) AS c FROM project_daily_rollups WHERE project_id = ? AND analysis_release_id = ?',
    [projectId, analysisReleaseId],
  );
  return {
    contributions: Number(contributionRows[0]?.c ?? 0),
    daily: Number(dailyRows[0]?.c ?? 0),
  };
}

async function assertInterruptionIsStale(
  harness: FailureInjectionExecutor,
  ctx: {
    sessionId: string;
    projectId: string;
    originalGenerationId: string;
    report: ReprocessingReport;
    release: string;
  },
) {
  expect(ctx.report.failures.length).toBeGreaterThan(0);
  expect(harness.getThrownStage()).toBe('reprocess');

  const current = await getCurrentGenerationId(harness, ctx.sessionId);
  expect(current).not.toBe(ctx.originalGenerationId);

  const originalStatus = await getGenerationStatus(harness, ctx.originalGenerationId);
  expect(originalStatus).toBe('superseded');

  const rollupGenerations = await getRollupGenerationIds(harness, ctx.projectId);
  expect(rollupGenerations).toContain(ctx.originalGenerationId);
  expect(rollupGenerations).not.toContain(current ?? '');

  const trends = await createAnalyticsDataSource(harness).project.getSessionTrendSeries(
    ctx.projectId,
    { analysisReleaseId: ctx.release },
  );
  expect(trends.token.generationId).toBe(ctx.originalGenerationId);
  expect(trends.token.generationId).not.toBe(current);
  expect(trends.series.length).toBeGreaterThan(0);
}

async function assertResumeIsCurrent(
  harness: FailureInjectionExecutor,
  ctx: {
    sessionId: string;
    projectId: string;
    originalGenerationId: string;
    report: ReprocessingReport;
    release: string;
  },
) {
  expect(ctx.report.failures).toHaveLength(0);
  expect(ctx.report.rollupsReconciled).toBe(true);

  const current = await getCurrentGenerationId(harness, ctx.sessionId);
  expect(current).not.toBe(ctx.originalGenerationId);

  const counts = await getRollupCounts(harness, ctx.projectId, ctx.release);
  expect(counts.contributions).toBeGreaterThan(0);
  expect(counts.daily).toBeGreaterThan(0);

  const trends = await createAnalyticsDataSource(harness).project.getSessionTrendSeries(
    ctx.projectId,
    { analysisReleaseId: ctx.release },
  );
  expect(trends.token.generationId).toBe(current);
  expect(trends.series.length).toBeGreaterThan(0);

  const rollupGenerations = await getRollupGenerationIds(harness, ctx.projectId);
  expect(rollupGenerations).toEqual([current ?? '']);
}

function assertReprocessIsIdempotent(
  report: ReprocessingReport,
  baseline: RollupCounts,
  next: RollupCounts,
) {
  expect(report.failures).toHaveLength(0);
  expect(report.rollupsReconciled).toBe(true);
  expect(next.contributions).toBe(baseline.contributions);
  expect(next.daily).toBe(baseline.daily);
}

describe('PIPE-005: reprocess interruption recovery', () => {
  it('reprocess interruption leaves stale rollups and a detectable failure state', async () => {
    const { harness, engine, sessionId, projectId, originalGenerationId } = await setupBaseline();

    harness.setInjection('reprocess');
    const report = await engine.reprocessSession(sessionId);

    await assertInterruptionIsStale(harness, {
      sessionId,
      projectId,
      originalGenerationId,
      report,
      release: ORIGINAL_RELEASE,
    });
  });

  it('resumed reprocess completes and rebuilds current rollups', async () => {
    const { harness, engine, sessionId, projectId, originalGenerationId } = await setupBaseline();

    harness.setInjection('reprocess');
    await engine.reprocessSession(sessionId);
    harness.setInjection(undefined);
    const report = await engine.reprocessSession(sessionId);

    await assertResumeIsCurrent(harness, {
      sessionId,
      projectId,
      originalGenerationId,
      report,
      release: RECOVERY_RELEASE,
    });
  });

  it('resumed reprocess is idempotent', async () => {
    const { harness, engine, sessionId, projectId } = await setupBaseline();

    harness.setInjection('reprocess');
    await engine.reprocessSession(sessionId);
    harness.setInjection(undefined);
    await engine.reprocessSession(sessionId);

    const baseline = await getRollupCounts(harness, projectId, RECOVERY_RELEASE);
    const report = await engine.reprocessSession(sessionId);
    const next = await getRollupCounts(harness, projectId, RECOVERY_RELEASE);

    assertReprocessIsIdempotent(report, baseline, next);
  });
});
