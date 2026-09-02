import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FRESH_SCHEMA_SQL,
  getCurrentGenerationId,
  SnapshotCompletenessStore,
  type SqliteExecutor,
} from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import type { Artifact } from '@lucasschirm/sal-transformer-shared';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createAnalyticsDataSource } from '../../src/analytics.js';
import type { IngestionReceipt } from '../../src/ingestion.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import type { ArtifactContent } from '../../src/ports.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '../../../parsers/claude-session-parser/tests/fixtures');

const ANALYSIS_RELEASE = 'ar-pipe007';
const PROJECT = 'project-pipe007';
const SESSION = 'sess-pipe007';
const TRANSCRIPT_PATH = 'session/transcript.jsonl';
const BEFORE_SKILL_PATH = '.claude/skills/before/skill.md';
const AFTER_SKILL_PATH = '.claude/skills/after/skill.md';

interface GenerationRow {
  readonly id: string;
  readonly status: string;
  readonly supersededById: string | null;
  readonly createdAt: number;
}

interface SnapshotRow {
  readonly id: string;
  readonly generationId: string;
  readonly captureTime: number;
  readonly temporalRole: string;
}

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

function reassignTranscriptSession(content: string, sessionId: string): string {
  const match = /"sessionId": "([^"]+)"/.exec(content);
  const original = match ? match[1] : 'unknown';
  return content.replace(
    new RegExp(`"sessionId": "${original}"`, 'g'),
    `"sessionId": "${sessionId}"`,
  );
}

function makeSkillContent(name: string): string {
  return `---
name: ${name}
description: >
  Skill ${name} for the supersede test.
metadata:
  version: "0.1.0"
allowed-tools: [Read, Edit, Bash]
---

# ${name}
`;
}

function makeArtifact(
  relativePath: string,
  mediaType: string,
  content: string,
  sha256: string,
): Artifact<ArtifactContent> {
  return {
    relativePath,
    mediaType,
    content,
    sha256,
    size: content.length,
    status: 'uploaded',
  };
}

function makeOrchestrator(executor: SqliteExecutor): DefaultIngestionOrchestrator {
  return new DefaultIngestionOrchestrator({
    executor,
    hasher: createSha256ContentHasher(),
    registry: createDefaultRegistry(),
    resolver: { resolve: async (ref) => ({ ...ref, content: new Uint8Array(0) }) },
    analysisReleaseId: ANALYSIS_RELEASE,
  });
}

async function prepareBundle(
  hasher: ReturnType<typeof createSha256ContentHasher>,
  transcriptName: string,
  skillName: string,
  skillPath: string,
): Promise<readonly Artifact<ArtifactContent>[]> {
  const transcript = reassignTranscriptSession(readFixture(transcriptName), SESSION);
  const skill = makeSkillContent(skillName);
  const transcriptSha = await hasher.hash(transcript);
  const skillSha = await hasher.hash(skill);
  return [
    makeArtifact(TRANSCRIPT_PATH, 'application/jsonl', transcript, transcriptSha),
    makeArtifact(skillPath, 'text/markdown', skill, skillSha),
  ];
}

async function ingestBundle(
  orchestrator: DefaultIngestionOrchestrator,
  artifacts: readonly Artifact<ArtifactContent>[],
): Promise<IngestionReceipt> {
  return orchestrator.ingestManual({
    artifacts,
    source: { sourceId: 'default' },
    harness: 'claude-code',
    projectId: PROJECT,
    sessionId: SESSION,
  });
}

async function findProjectId(executor: SqliteExecutor, sessionId: string): Promise<string> {
  const { rows } = await executor.exec('SELECT project_id FROM sessions WHERE id = ?', [sessionId]);
  return String(rows[0]?.project_id ?? '');
}

async function getSessionGenerations(
  executor: SqliteExecutor,
  sessionId: string,
): Promise<readonly GenerationRow[]> {
  const { rows } = await executor.exec(
    `SELECT id, status, superseded_by_id, created_at
     FROM transformation_generations
     WHERE session_id = ?
     ORDER BY created_at`,
    [sessionId],
  );
  return rows.map((r) => ({
    id: String(r.id),
    status: String(r.status),
    supersededById:
      r.superseded_by_id === null || r.superseded_by_id === undefined
        ? null
        : String(r.superseded_by_id),
    createdAt: Number(r.created_at),
  }));
}

async function getSessionSnapshots(
  executor: SqliteExecutor,
  sessionId: string,
): Promise<readonly SnapshotRow[]> {
  const { rows } = await executor.exec(
    `SELECT id, generation_id, capture_time, temporal_role
     FROM configuration_snapshots
     WHERE session_id = ?
     ORDER BY capture_time`,
    [sessionId],
  );
  return rows.map((r) => ({
    id: String(r.id),
    generationId: String(r.generation_id),
    captureTime: Number(r.capture_time),
    temporalRole: String(r.temporal_role),
  }));
}

async function assertSnapshotIsComplete(
  executor: SqliteExecutor,
  snapshotId: string,
): Promise<void> {
  const rows = await SnapshotCompletenessStore.listBySnapshot(executor, snapshotId);
  expect(rows.some((r) => r.status === 'complete')).toBe(true);
  expect(rows.some((r) => r.status === 'partial')).toBe(false);
}

async function countMetricValues(
  executor: SqliteExecutor,
  sessionId: string,
  generationId: string,
): Promise<number> {
  const { rows } = await executor.exec(
    'SELECT COUNT(*) AS c FROM metric_values WHERE session_id = ? AND generation_id = ?',
    [sessionId, generationId],
  );
  return Number(rows[0]?.c ?? 0);
}

async function getProjectRollupGenerationIds(
  executor: SqliteExecutor,
  projectId: string,
): Promise<readonly string[]> {
  const { rows } = await executor.exec(
    'SELECT DISTINCT generation_id FROM project_daily_rollups WHERE project_id = ?',
    [projectId],
  );
  return rows.map((r) => String(r.generation_id));
}

async function countCurrentSessionsForGeneration(
  executor: SqliteExecutor,
  generationId: string,
): Promise<number> {
  const { rows } = await executor.exec(
    'SELECT COUNT(*) AS c FROM sessions WHERE current_generation_id = ?',
    [generationId],
  );
  return Number(rows[0]?.c ?? 0);
}

describe('PIPE-007: generation supersede semantics', () => {
  it('replaces a session with a new generation and leaves exactly one visible', async () => {
    const executor = await WasmSqliteExecutor.create();
    await executor.exec(FRESH_SCHEMA_SQL);

    const orchestrator = makeOrchestrator(executor);
    const hasher = createSha256ContentHasher();

    const beforeArtifacts = await prepareBundle(
      hasher,
      't2-happy-path.jsonl',
      'before-skill',
      BEFORE_SKILL_PATH,
    );
    const before = await ingestBundle(orchestrator, beforeArtifacts);
    expect(before.status).toBe('committed');

    const afterArtifacts = await prepareBundle(
      hasher,
      't2-usage-aggregation.jsonl',
      'after-skill',
      AFTER_SKILL_PATH,
    );
    const after = await ingestBundle(orchestrator, afterArtifacts);
    expect(after.status).toBe('committed');
    expect(after.generationId).not.toBe(before.generationId);

    const sessionId = before.sessionId;
    expect(after.sessionId).toBe(sessionId);

    const current = await getCurrentGenerationId(executor, sessionId);
    expect(current).toBe(after.generationId);

    const projectId = await findProjectId(executor, sessionId);
    const generations = await getSessionGenerations(executor, sessionId);
    expect(generations).toHaveLength(2);

    const committed = generations.filter((g) => g.status === 'committed');
    const superseded = generations.filter((g) => g.status === 'superseded');
    expect(committed).toHaveLength(1);
    expect(superseded).toHaveLength(1);
    expect(committed[0]?.id).toBe(after.generationId);
    expect(superseded[0]?.id).toBe(before.generationId);
    expect(superseded[0]?.supersededById).toBe(after.generationId);

    const snapshots = await getSessionSnapshots(executor, sessionId);
    expect(snapshots).toHaveLength(2);
    for (const snapshot of snapshots) {
      await assertSnapshotIsComplete(executor, snapshot.id);
    }

    const dataSource = createAnalyticsDataSource(executor);
    const overview = await dataSource.portfolio.getOverview({ generationId: after.generationId });
    expect(overview.token.generationId).toBe(after.generationId);
    expect(overview.sessionCount).toBe(1);
    expect(overview.totalTokens).toBeGreaterThan(0);

    const trends = await dataSource.project.getSessionTrendSeries(projectId, {
      generationId: after.generationId,
    });
    expect(trends.token.generationId).toBe(after.generationId);
    expect(trends.series.length).toBeGreaterThan(0);

    expect(await countMetricValues(executor, sessionId, before.generationId)).toBeGreaterThan(0);
    expect(await countMetricValues(executor, sessionId, after.generationId)).toBeGreaterThan(0);

    const rollupGenerations = await getProjectRollupGenerationIds(executor, projectId);
    expect(rollupGenerations).toEqual([after.generationId]);

    expect(await countCurrentSessionsForGeneration(executor, before.generationId)).toBe(0);
    expect(await countCurrentSessionsForGeneration(executor, after.generationId)).toBe(1);
  });
});
