import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRESH_SCHEMA_SQL } from '@lucasschirm/sal-db-core';
import { MANIFEST_SCHEMA_VERSION } from '@lucasschirm/sal-sync-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '../../../parsers/claude-session-parser/tests/fixtures');

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

async function createExecutor(): Promise<WasmSqliteExecutor> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  return executor;
}

function createManifestFixture(content: string, sha256: string, relativePath: string) {
  const projectId = 'project-fixture';
  const sessionId = 'sess-happy-1';

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    projectId,
    sessionId,
    harness: 'claude-code',
    harnessVersion: '0.1.0',
    syncVersion: '0.1.0',
    pluginVersion: '0.1.0',
    transcriptsCaptured: true,
    mainTranscriptRelativePath: relativePath,
    artifacts: [
      {
        relativePath,
        mediaType: 'application/jsonl',
        sha256,
        size: content.length,
        status: 'uploaded' as const,
      },
    ],
    syncRuns: [],
  };

  return {
    bundle: {
      manifest,
      source: {
        sourceId: 'default',
        environmentId: 'dev',
        projectId,
        sessionId,
      },
      resolvedArtifacts: [
        {
          relativePath,
          mediaType: 'application/jsonl',
          sha256,
          size: content.length,
          content,
        },
      ],
      integrityVerified: false,
    },
  };
}

async function setupIngestion(executor: WasmSqliteExecutor, registry = createDefaultRegistry()) {
  const hasher = createSha256ContentHasher();
  return new DefaultIngestionOrchestrator({
    executor,
    hasher,
    registry,
    resolver: { resolve: async (ref) => ({ ...ref, content: new Uint8Array(0) }) },
    analysisReleaseId: 'ar-default',
  });
}

describe('DefaultIngestionOrchestrator', () => {
  it('ingests a synced manifest end-to-end', async () => {
    const content = readFixture('t2-happy-path.jsonl');
    const hasher = createSha256ContentHasher();
    const sha256 = await hasher.hash(content);

    const executor = await createExecutor();
    const orchestrator = await setupIngestion(executor);
    const { bundle } = createManifestFixture(content, sha256, 'session/transcript.jsonl');

    const receipt = await orchestrator.ingestManifest(bundle);

    expect(receipt.status).toBe('committed');
    expect(receipt.issueIds).toEqual([]);

    const { rows: sessionRows } = await executor.exec(
      'SELECT id, current_generation_id, finality, native_session_id FROM sessions WHERE id = ?',
      [receipt.sessionId],
    );
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]?.current_generation_id).toBe(receipt.generationId);
    expect(sessionRows[0]?.finality).toBe('open');
    expect(sessionRows[0]?.native_session_id).toBe('sess-happy-1');

    const { rows: metricValues } = await executor.exec(
      'SELECT COUNT(*) AS c FROM metric_values WHERE generation_id = ?',
      [receipt.generationId],
    );
    expect(metricValues[0]?.c).toBeGreaterThan(0);

    const { rows: evidence } = await executor.exec(
      'SELECT COUNT(*) AS c FROM normalized_events WHERE generation_id = ?',
      [receipt.generationId],
    );
    expect(evidence[0]?.c).toBeGreaterThan(0);

    const { rows: summaries } = await executor.exec(
      'SELECT COUNT(*) AS c FROM session_summaries WHERE generation_id = ?',
      [receipt.generationId],
    );
    expect(summaries[0]?.c).toBeGreaterThan(0);

    const { rows: generations } = await executor.exec(
      'SELECT status FROM transformation_generations WHERE id = ?',
      [receipt.generationId],
    );
    expect(generations[0]?.status).toBe('committed');
  });

  it('ingests a manual artifact bundle end-to-end', async () => {
    const content = readFixture('t2-happy-path.jsonl');
    const hasher = createSha256ContentHasher();
    const sha256 = await hasher.hash(content);

    const executor = await createExecutor();
    const orchestrator = await setupIngestion(executor);

    const receipt = await orchestrator.ingestManual({
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
      source: {
        sourceId: 'default',
      },
      harness: 'claude-code',
      projectId: 'project-fixture',
      sessionId: 'sess-happy-1',
    });

    expect(receipt.status).toBe('committed');

    const { rows: metricValues } = await executor.exec(
      'SELECT COUNT(*) AS c FROM metric_values WHERE generation_id = ?',
      [receipt.generationId],
    );
    expect(metricValues[0]?.c).toBeGreaterThan(0);
  });

  it('is idempotent for the same bundle', async () => {
    const content = readFixture('t2-happy-path.jsonl');
    const hasher = createSha256ContentHasher();
    const sha256 = await hasher.hash(content);

    const executor = await createExecutor();
    const orchestrator = await setupIngestion(executor);
    const { bundle } = createManifestFixture(content, sha256, 'session/transcript.jsonl');

    const first = await orchestrator.ingestManifest(bundle);
    const second = await orchestrator.ingestManifest(bundle);

    expect(first.generationId).toBe(second.generationId);
    expect(second.status).toBe('committed');

    const { rows: metricValues } = await executor.exec('SELECT COUNT(*) AS c FROM metric_values');
    expect(metricValues[0]?.c).toBeGreaterThan(0);

    const { rows: generations } = await executor.exec(
      'SELECT COUNT(*) AS c FROM transformation_generations',
    );
    expect(generations[0]?.c).toBe(1);
  });

  it('preserves the previous generation on fatal transform failure', async () => {
    const content = readFixture('t2-happy-path.jsonl');
    const hasher = createSha256ContentHasher();
    const sha256 = await hasher.hash(content);

    const executor = await createExecutor();
    const orchestrator = await setupIngestion(executor);
    const { bundle } = createManifestFixture(content, sha256, 'session/transcript.jsonl');

    const first = await orchestrator.ingestManifest(bundle);
    expect(first.status).toBe('committed');

    const invalidBundle = {
      ...bundle,
      resolvedArtifacts: [],
    };
    const failed = await orchestrator.ingestManifest(invalidBundle);

    expect(failed.status).toBe('failed');
    expect(failed.issueIds).toContain('missing_root_transcript');

    const { rows } = await executor.exec(
      'SELECT current_generation_id FROM sessions WHERE id = ?',
      [first.sessionId],
    );
    expect(rows[0]?.current_generation_id).toBe(first.generationId);

    const { rows: generations } = await executor.exec(
      'SELECT COUNT(*) AS c FROM transformation_generations',
    );
    expect(generations[0]?.c).toBe(1);
  });

  it('preserves the previous generation on hash mismatch', async () => {
    const content = readFixture('t2-happy-path.jsonl');
    const hasher = createSha256ContentHasher();
    const sha256 = await hasher.hash(content);

    const executor = await createExecutor();
    const orchestrator = await setupIngestion(executor);
    const { bundle } = createManifestFixture(content, sha256, 'session/transcript.jsonl');

    const first = await orchestrator.ingestManifest(bundle);
    expect(first.status).toBe('committed');

    const tamperedBundle = {
      ...bundle,
      resolvedArtifacts: [
        {
          ...bundle.resolvedArtifacts[0],
          sha256: '0000000000000000000000000000000000000000000000000000000000000000',
        },
      ],
    };
    const failed = await orchestrator.ingestManifest(tamperedBundle);

    expect(failed.status).toBe('failed');
    expect(failed.issueIds).toContain('integrity_hash_mismatch');

    const { rows } = await executor.exec(
      'SELECT current_generation_id FROM sessions WHERE id = ?',
      [first.sessionId],
    );
    expect(rows[0]?.current_generation_id).toBe(first.generationId);
  });

  it('rolls back an interrupted atomic generation replacement', async () => {
    const content = readFixture('t2-happy-path.jsonl');
    const hasher = createSha256ContentHasher();
    const sha256 = await hasher.hash(content);

    const executor = await createExecutor();
    const registry = createDefaultRegistry();
    const orchestrator = await setupIngestion(executor, registry);
    const { bundle } = createManifestFixture(content, sha256, 'session/transcript.jsonl');

    const first = await orchestrator.ingestManifest(bundle);
    expect(first.status).toBe('committed');

    const sourceFingerprint = await hasher.hash(`session/transcript.jsonl:${sha256}`);
    const transformer = registry.resolve('claude-code');
    const sourceIdentity = {
      sourceId: 'default',
      environmentId: 'dev',
      projectId: bundle.manifest.projectId,
      sessionId: bundle.manifest.sessionId,
    };
    const artifactBundle = {
      artifacts: bundle.resolvedArtifacts.map((a) => ({
        ...a,
        status: 'uploaded' as const,
      })),
      sourceIdentity,
      sourceFingerprint,
    };
    const result = transformer.transform(artifactBundle, {
      analysisReleaseId: 'ar-default',
      parserId: transformer.id,
      parserVersion: '0.1.0',
      sourceFingerprint,
      sourceEnvironmentId: sourceIdentity.environmentId,
      sourceProjectId: sourceIdentity.projectId,
      sourceSessionId: sourceIdentity.sessionId,
    });

    const brokenResult = {
      ...result,
      evidence: [
        ...result.evidence,
        {
          ...result.evidence[0],
          recordId: result.evidence[0].recordId,
        },
      ],
    };

    const receipt = await orchestrator.commitAtomic({
      generationId: `${first.generationId}-replacement`,
      sessionId: first.sessionId,
      rootSessionId: first.sessionId,
      affectedProjectIds: ['project-fixture'],
      analysisReleaseId: 'ar-default',
      candidateRecords: [],
      result: brokenResult as never,
      manifest: bundle.manifest,
      source: sourceIdentity,
    });

    expect(receipt.status).toBe('failed');

    const { rows } = await executor.exec(
      'SELECT current_generation_id FROM sessions WHERE id = ?',
      [first.sessionId],
    );
    expect(rows[0]?.current_generation_id).toBe(first.generationId);

    const { rows: generations } = await executor.exec(
      'SELECT COUNT(*) AS c FROM transformation_generations',
    );
    expect(generations[0]?.c).toBe(1);
  });
});
