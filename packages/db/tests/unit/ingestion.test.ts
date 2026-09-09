import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRESH_SCHEMA_SQL } from '@lucasschirm/sal-db-core';
import { MANIFEST_SCHEMA_VERSION } from '@lucasschirm/sal-sync-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createArtifactVersionView } from '../../src/analytics-session.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import { buildDevinManifestBundle } from '../fixtures/devin-manifest.js';

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
        scope: 'session' as const,
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

    const { rows: manifestArtifactRows } = await executor.exec(
      'SELECT id, source_manifest_id, scope, relative_path, sha256, size, status FROM manifest_artifacts WHERE manifest_session_id = ?',
      [bundle.manifest.sessionId],
    );
    expect(manifestArtifactRows).toHaveLength(1);
    expect(manifestArtifactRows[0]?.sha256).toBe(sha256);
    expect(manifestArtifactRows[0]?.relative_path).toBe(bundle.manifest.artifacts[0]?.relativePath);

    const { rows: referenceRows } = await executor.exec(
      `SELECT artifact_references.id, artifact_references.relationship FROM artifact_references
       JOIN manifest_artifacts a ON a.id = artifact_references.manifest_artifact_id
       WHERE a.manifest_session_id = ?`,
      [bundle.manifest.sessionId],
    );
    expect(referenceRows).toHaveLength(1);
    expect(referenceRows[0]?.relationship).toBe('contains');

    const view = createArtifactVersionView(executor);
    const metadata = await view.getMetadata(String(manifestArtifactRows[0]?.id));
    expect(metadata.artifactId).toBe(String(manifestArtifactRows[0]?.id));
    expect(metadata.sha256).toBe(sha256);
    expect(metadata.size).toBe(content.length);
    expect(metadata.sessionIds).toContain(receipt.sessionId);

    const diff = await view.getDiff(
      String(manifestArtifactRows[0]?.id),
      String(manifestArtifactRows[0]?.id),
    );
    expect(diff.contentAvailable).toBe(true);
  });

  it('ingests a manifest with an unresolved artifact without violating the blob_sha256 foreign key', async () => {
    // Regression test for TSK0042: a manifest can declare an artifact that was
    // never actually resolved (its bytes never fetched, present in
    // manifest.artifacts but absent from resolvedArtifacts). Recording an
    // artifact_references row for it must never reference the manifest's
    // unverified sha256 as blob_sha256, since no artifact_blobs row for that
    // hash was ever stored (FK: blob_sha256 -> artifact_blobs.sha256).
    const content = readFixture('t2-happy-path.jsonl');
    const hasher = createSha256ContentHasher();
    const sha256 = await hasher.hash(content);
    const relativePath = 'session/transcript.jsonl';
    const projectId = 'project-fixture';
    const sessionId = 'sess-unresolved-artifact';
    const unresolvedSha256 = 'a'.repeat(64);

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
          scope: 'session' as const,
          mediaType: 'application/jsonl',
          sha256,
          size: content.length,
          status: 'uploaded' as const,
        },
        {
          relativePath: 'session/unresolvable.bin',
          scope: 'session' as const,
          mediaType: 'application/octet-stream',
          sha256: unresolvedSha256,
          size: 0,
          status: 'uploaded' as const,
        },
      ],
      syncRuns: [],
    };

    const executor = await createExecutor();
    const orchestrator = await setupIngestion(executor);

    const receipt = await orchestrator.ingestManifest({
      manifest,
      source: { sourceId: 'default', environmentId: 'dev', projectId, sessionId },
      // Only the first artifact was actually resolved; the second is absent,
      // simulating a real unresolvable-artifact scenario.
      resolvedArtifacts: [
        { relativePath, mediaType: 'application/jsonl', sha256, size: content.length, content },
      ],
      integrityVerified: false,
    });

    expect(receipt.status).toBe('committed');

    const { rows: manifestArtifactRows } = await executor.exec(
      'SELECT id, sha256 FROM manifest_artifacts WHERE manifest_session_id = ? ORDER BY relative_path',
      [sessionId],
    );
    expect(manifestArtifactRows).toHaveLength(2);

    const { rows: referenceRows } = await executor.exec(
      `SELECT artifact_references.blob_sha256 FROM artifact_references
       JOIN manifest_artifacts a ON a.id = artifact_references.manifest_artifact_id
       WHERE a.manifest_session_id = ? ORDER BY a.relative_path`,
      [sessionId],
    );
    expect(referenceRows).toHaveLength(2);
    expect(referenceRows[0]?.blob_sha256).toBe(sha256);
    expect(referenceRows[1]?.blob_sha256).toBeNull();

    const { rows: blobRows } = await executor.exec(
      'SELECT sha256 FROM artifact_blobs WHERE sha256 = ?',
      [unresolvedSha256],
    );
    expect(blobRows).toHaveLength(0);
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

  it('populates component_identities, exposures, and configuration_snapshots when config artifacts are present', async () => {
    const transcriptContent = readFixture('t2-happy-path.jsonl');
    const skillContent = readFixture('e2e-skill-csv-wrangler.md');
    const agentContent = readFixture('e2e-agent-docs-drafter.md');
    const ruleContent = readFixture('e2e-rule-style.md');
    const mcpContent = readFixture('e2e-mcp.json');
    const settingsContent = readFixture('e2e-settings-project.json');

    const hasher = createSha256ContentHasher();
    const transcriptHash = await hasher.hash(transcriptContent);
    const skillHash = await hasher.hash(skillContent);
    const agentHash = await hasher.hash(agentContent);
    const ruleHash = await hasher.hash(ruleContent);
    const mcpHash = await hasher.hash(mcpContent);
    const settingsHash = await hasher.hash(settingsContent);

    const projectId = 'project-config';
    const sessionId = 'sess-config-1';
    const transcriptPath = 'transcript.jsonl';

    const configArtifacts = [
      {
        relativePath: '.claude/skills/csv-wrangler/SKILL.md',
        sha256: skillHash,
        size: skillContent.length,
        content: skillContent,
        scope: 'workspace' as const,
        status: 'uploaded' as const,
        mediaType: 'text/markdown',
      },
      {
        relativePath: '.claude/agents/docs-drafter.md',
        sha256: agentHash,
        size: agentContent.length,
        content: agentContent,
        scope: 'workspace' as const,
        status: 'uploaded' as const,
        mediaType: 'text/markdown',
      },
      {
        relativePath: '.claude/rules/style.md',
        sha256: ruleHash,
        size: ruleContent.length,
        content: ruleContent,
        scope: 'workspace' as const,
        status: 'uploaded' as const,
        mediaType: 'text/markdown',
      },
      {
        relativePath: '.mcp.json',
        sha256: mcpHash,
        size: mcpContent.length,
        content: mcpContent,
        scope: 'workspace' as const,
        status: 'uploaded' as const,
        mediaType: 'application/json',
      },
      {
        relativePath: '.claude/settings.json',
        sha256: settingsHash,
        size: settingsContent.length,
        content: settingsContent,
        scope: 'workspace' as const,
        status: 'uploaded' as const,
        mediaType: 'application/json',
      },
    ];

    const manifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      projectId,
      sessionId,
      harness: 'claude-code',
      harnessVersion: '0.1.0',
      syncVersion: '0.1.0',
      pluginVersion: '0.1.0',
      transcriptsCaptured: true,
      mainTranscriptRelativePath: transcriptPath,
      artifacts: [
        {
          relativePath: transcriptPath,
          mediaType: 'application/jsonl',
          sha256: transcriptHash,
          size: transcriptContent.length,
          status: 'uploaded' as const,
          scope: 'session' as const,
          projectId,
          sessionId,
        },
        ...configArtifacts.map((a) => ({
          relativePath: a.relativePath,
          mediaType: a.mediaType,
          sha256: a.sha256,
          size: a.size,
          status: a.status,
          scope: a.scope,
          projectId,
          sessionId,
        })),
      ],
      syncRuns: [],
    };

    const executor = await createExecutor();
    const orchestrator = await setupIngestion(executor);

    const receipt = await orchestrator.ingestManifest({
      manifest,
      source: { sourceId: 'default', environmentId: 'dev', projectId, sessionId },
      resolvedArtifacts: [
        {
          relativePath: transcriptPath,
          mediaType: 'application/jsonl',
          sha256: transcriptHash,
          size: transcriptContent.length,
          content: transcriptContent,
        },
        ...configArtifacts.map((a) => ({
          relativePath: a.relativePath,
          mediaType: a.mediaType,
          sha256: a.sha256,
          size: a.size,
          content: a.content,
        })),
      ],
      integrityVerified: false,
    });

    expect(receipt.status).toBe('committed');
    expect(receipt.issueIds).toEqual([]);

    // component_identities must be populated with skills, agents, rules, mcp, settings
    const { rows: componentRows } = await executor.exec(
      'SELECT kind, COUNT(*) AS c FROM component_identities GROUP BY kind ORDER BY kind',
    );
    expect(componentRows.length).toBeGreaterThan(0);
    const kinds = new Set(componentRows.map((r) => r.kind));
    expect(kinds.has('skill')).toBe(true);
    expect(kinds.has('agent')).toBe(true);
    expect(kinds.has('rule')).toBe(true);
    expect(kinds.has('mcp_server')).toBe(true);
    expect(kinds.has('setting')).toBe(true);

    // configuration_snapshots must be populated
    const { rows: snapshotRows } = await executor.exec(
      'SELECT COUNT(*) AS c FROM configuration_snapshots WHERE generation_id = ?',
      [receipt.generationId],
    );
    expect(snapshotRows[0]?.c).toBeGreaterThan(0);

    // session_component_exposures must be populated (temporalRole defaults to pre_session)
    const { rows: exposureRows } = await executor.exec(
      'SELECT COUNT(*) AS c FROM session_component_exposures WHERE session_id = ?',
      [receipt.sessionId],
    );
    expect(exposureRows[0]?.c).toBeGreaterThan(0);

    // snapshot_components must link components to the snapshot
    const { rows: snapshotComponentRows } = await executor.exec(
      `SELECT COUNT(*) AS c FROM snapshot_components sc
       JOIN configuration_snapshots cs ON cs.id = sc.snapshot_id
       WHERE cs.generation_id = ?`,
      [receipt.generationId],
    );
    expect(snapshotComponentRows[0]?.c).toBeGreaterThan(0);
  });

  it('ingests a devin manifest end-to-end', async () => {
    const executor = await createExecutor();
    const orchestrator = await setupIngestion(executor);
    const { bundle } = await buildDevinManifestBundle();

    const receipt = await orchestrator.ingestManifest(bundle);

    expect(receipt.status).toBe('committed');
    expect(receipt.issueIds).toEqual([]);

    const { rows: sessionRows } = await executor.exec(
      'SELECT id, harness, current_generation_id, native_session_id FROM sessions WHERE id = ?',
      [receipt.sessionId],
    );
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]?.harness).toBe('devin');
    expect(sessionRows[0]?.current_generation_id).toBe(receipt.generationId);
    expect(sessionRows[0]?.native_session_id).toBe(bundle.manifest.sessionId);

    const { rows: metricValues } = await executor.exec(
      'SELECT COUNT(*) AS c FROM metric_values WHERE generation_id = ?',
      [receipt.generationId],
    );
    expect(metricValues[0]?.c).toBeGreaterThan(0);

    const { rows: devinMetrics } = await executor.exec(
      `SELECT COUNT(*) AS c FROM metric_values mv
       JOIN metric_definitions md ON md.id = mv.metric_definition_id
       WHERE mv.generation_id = ? AND md.metric_id LIKE ?`,
      [receipt.generationId, 'devin:%'],
    );
    expect(devinMetrics[0]?.c).toBeGreaterThan(0);

    const { rows: summaries } = await executor.exec(
      'SELECT COUNT(*) AS c FROM session_summaries WHERE generation_id = ?',
      [receipt.generationId],
    );
    expect(summaries[0]?.c).toBeGreaterThan(0);

    const { rows: manifestArtifactRows } = await executor.exec(
      'SELECT scope, relative_path, status FROM manifest_artifacts WHERE manifest_session_id = ? ORDER BY relative_path',
      [bundle.manifest.sessionId],
    );
    expect(manifestArtifactRows).toHaveLength(bundle.manifest.artifacts.length);
    expect(manifestArtifactRows.map((r) => r.relative_path)).toEqual(
      bundle.manifest.artifacts.map((a) => a.relativePath).sort(),
    );
  });
});
