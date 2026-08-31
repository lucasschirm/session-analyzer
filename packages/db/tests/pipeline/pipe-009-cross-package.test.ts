import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRESH_SCHEMA_SQL } from '@lucasschirm/sal-db-core';
import { contentTypeFor, sha256Hex } from '@lucasschirm/sal-sync';
import {
  buildObjectKey,
  type GetObjectInput,
  type GetObjectResult,
  type PutObjectInput,
  type PutObjectResult,
  type StorageAdapter,
  type SyncManifest,
} from '@lucasschirm/sal-sync-core';
import {
  ClaudeCodeTransformer,
  createDefaultRegistry,
  type UnknownArtifactBundle,
} from '@lucasschirm/sal-transformer';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { runSessionEnd } from '../../../plugins/claude-session-sync/src/index.js';
import { runTransformerConformanceSuite } from '../../../transformer/tests/conformance/suite.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '../../../parsers/claude-session-parser/tests/fixtures');

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

class RecordingStorageAdapter implements StorageAdapter {
  private readonly objects = new Map<string, { body: Uint8Array; contentType?: string }>();

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const key = buildObjectKey(input);
    const sha256 = input.contentSha256 ?? sha256Hex(input.body);
    this.objects.set(key, { body: input.body, contentType: input.contentType });
    return { key, sha256 };
  }

  async getObject(input: GetObjectInput): Promise<GetObjectResult | undefined> {
    const key = buildObjectKey(input as PutObjectInput);
    const object = this.objects.get(key);
    if (!object) return undefined;
    return { body: object.body, contentType: object.contentType };
  }
}

async function createExecutor(): Promise<WasmSqliteExecutor> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  return executor;
}

interface WorkspaceFiles {
  workspaceRoot: string;
  transcriptPath: string;
  dataDir: string;
  homeDir: string;
  cleanup(): void;
}

function buildWorkspace(): WorkspaceFiles {
  const root = mkdtempSync(join(tmpdir(), 'pipe-009-'));
  const workspaceRoot = join(root, 'workspace');
  const sessionDir = join(workspaceRoot, 'e2e-sess-0001');
  const subagentDir = join(sessionDir, 'subagents');
  const dataDir = join(root, 'data');
  const homeDir = join(root, 'home');

  for (const dir of [
    workspaceRoot,
    subagentDir,
    dataDir,
    homeDir,
    join(homeDir, '.claude'),
    join(workspaceRoot, '.claude'),
    join(workspaceRoot, '.claude', 'skills', 'csv-wrangler'),
    join(workspaceRoot, '.claude', 'agents'),
    join(workspaceRoot, '.claude', 'rules'),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(join(workspaceRoot, 'transcript.jsonl'), readFixture('e2e-main-session.jsonl'));
  writeFileSync(
    join(subagentDir, 'agent-e2e-agent-0001.jsonl'),
    readFixture('e2e-subagent-transcript.jsonl'),
  );
  writeFileSync(
    join(subagentDir, 'agent-e2e-agent-0001.meta.json'),
    readFixture('e2e-subagent-meta.json'),
  );
  writeFileSync(join(workspaceRoot, '.mcp.json'), readFixture('e2e-mcp.json'));
  writeFileSync(
    join(workspaceRoot, '.claude', 'settings.json'),
    readFixture('e2e-settings-project.json'),
  );
  writeFileSync(
    join(workspaceRoot, '.claude', 'skills', 'csv-wrangler', 'skill.md'),
    readFixture('e2e-skill-csv-wrangler.md'),
    { encoding: 'utf8' },
  );
  writeFileSync(
    join(workspaceRoot, '.claude', 'agents', 'docs-drafter.md'),
    readFixture('e2e-agent-docs-drafter.md'),
  );
  writeFileSync(
    join(workspaceRoot, '.claude', 'rules', 'style.md'),
    readFixture('e2e-rule-style.md'),
  );

  return {
    workspaceRoot,
    transcriptPath: join(workspaceRoot, 'transcript.jsonl'),
    dataDir,
    homeDir,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

function buildEnv(_workspaceRoot: string, homeDir: string): Record<string, string | undefined> {
  return {
    HOME: homeDir,
    SAL_PROJECT_ID: 'pipe-009-project',
    SAL_STORAGE_TYPE: 's3',
    SAL_STORAGE_BUCKET: 'test-bucket',
    SAL_STORAGE_REGION: 'us-east-1',
    SAL_STORAGE_ENDPOINT: 'http://localhost:9000',
    SAL_STORAGE_ACCESS_KEY_ID: 'test',
    SAL_STORAGE_SECRET_ACCESS_KEY: 'test',
  };
}

describe('PIPE-009 cross-package pipeline', () => {
  it('runs plugin-produced artifacts through parser, transformer, conformance and ingestion', async () => {
    const workspace = buildWorkspace();
    try {
      const storage = new RecordingStorageAdapter();
      const env = buildEnv(workspace.workspaceRoot, workspace.homeDir);

      const exitCode = await runSessionEnd(
        {
          session_id: 'e2e-sess-0001',
          cwd: workspace.workspaceRoot,
          transcript_path: workspace.transcriptPath,
          reason: 'completed',
          started_at: '2026-08-10T10:00:00.000Z',
          ended_at: '2026-08-10T10:02:20.000Z',
          duration_ms: 140000,
          model: 'test-model-a',
          harness: 'claude',
          harness_version: '0.1.0',
        },
        { env, dataDir: workspace.dataDir, storageAdapter: storage },
      );

      expect(exitCode).toBe(0);

      const manifestBody = await storage.getObject({
        projectId: 'pipe-009-project',
        sessionId: 'e2e-sess-0001',
        scope: 'manifest',
        relativePath: 'manifest.json',
        contentSha256: undefined,
      });
      expect(manifestBody).toBeTruthy();
      if (!manifestBody) {
        throw new Error('Plugin did not produce a manifest artifact');
      }
      const manifestJson = new TextDecoder().decode(manifestBody.body);
      const manifest = JSON.parse(manifestJson) as SyncManifest;

      expect(manifest.harness).toBe('claude');
      expect(manifest.projectId).toBe('pipe-009-project');
      expect(manifest.sessionId).toBe('e2e-sess-0001');
      expect(manifest.mainTranscriptRelativePath).toBe('transcript.jsonl');
      expect(manifest.artifacts.length).toBeGreaterThan(1);

      const resolvedArtifacts = await Promise.all(
        manifest.artifacts.map(async (artifact) => {
          const body = await storage.getObject({
            projectId: artifact.projectId,
            sessionId: artifact.sessionId,
            scope: artifact.scope as 'session' | 'workspace' | 'global' | 'runtime' | 'manifest',
            relativePath: artifact.relativePath,
            contentSha256:
              artifact.scope === 'workspace' || artifact.scope === 'global'
                ? artifact.sha256
                : undefined,
          });
          if (!body) {
            throw new Error(`Plugin artifact missing: ${artifact.scope}/${artifact.relativePath}`);
          }
          return {
            sha256: artifact.sha256,
            size: artifact.size,
            relativePath: artifact.relativePath,
            mediaType: contentTypeFor(artifact.relativePath) ?? 'application/octet-stream',
            content: body.body,
          };
        }),
      );

      const hasher = createSha256ContentHasher();
      const sourceFingerprint = await hasher.hash(
        resolvedArtifacts
          .map((a) => `${a.relativePath}:${a.sha256}`)
          .sort()
          .join('\n'),
      );

      const sourceIdentity = {
        sourceId: 'default',
        projectId: manifest.projectId,
        sessionId: manifest.sessionId,
      };

      const bundle: UnknownArtifactBundle = {
        artifacts: resolvedArtifacts.map((a) => ({
          relativePath: a.relativePath,
          mediaType: a.mediaType,
          content: a.content,
          sha256: a.sha256,
          size: a.size,
          status: 'uploaded' as const,
        })),
        sourceIdentity,
        sourceFingerprint,
      };

      const transformContext = {
        analysisReleaseId: 'ar-pipe-009',
        parserId: '@lucasschirm/sal-claude-session-parser',
        parserVersion: '0.1.0',
        sourceFingerprint,
        sourceEnvironmentId: sourceIdentity.sourceId,
        sourceProjectId: sourceIdentity.projectId,
        sourceSessionId: sourceIdentity.sessionId,
      };

      const conformance = runTransformerConformanceSuite(ClaudeCodeTransformer, {
        fixtures: [
          {
            name: 'pipe-009-plugin-complete',
            description:
              'Plugin-produced manifest and transcripts from the Claude Code sync hook, used to gate PIPE-009 ingestion.',
            bundle,
            context: transformContext,
            tags: ['root', 'subagent', 'complete', 'provenance', 'deterministic'],
          },
        ],
      });
      expect(conformance.passed).toBe(true);

      const executor = await createExecutor();
      const orchestrator = new DefaultIngestionOrchestrator({
        executor,
        hasher,
        registry: createDefaultRegistry(),
        resolver: { resolve: async (ref) => ({ ...ref, content: new Uint8Array(0) }) },
        analysisReleaseId: 'ar-pipe-009',
      });

      const receipt = await orchestrator.ingestManifest({
        manifest,
        source: sourceIdentity,
        resolvedArtifacts,
        integrityVerified: false,
      });

      expect(receipt.status).toBe('committed');
      expect(receipt.issueIds).toHaveLength(0);

      const { rows: sourceRows } = await executor.exec(
        'SELECT id, harness, main_transcript_relative_path, manifest_hash, native_project_id, native_session_id, raw_metadata FROM source_manifests WHERE native_session_id = ?',
        [manifest.sessionId],
      );
      expect(sourceRows.length).toBe(1);
      const sourceRow = sourceRows[0] as {
        id: string;
        harness: string;
        main_transcript_relative_path: string;
        manifest_hash: string;
        native_project_id: string;
        native_session_id: string;
        raw_metadata: string;
      };
      expect(sourceRow.harness).toBe('claude');
      expect(sourceRow.main_transcript_relative_path).toBe('transcript.jsonl');
      expect(sourceRow.manifest_hash).toBe(sourceFingerprint);
      expect(sourceRow.native_project_id).toBe(manifest.projectId);
      expect(sourceRow.native_session_id).toBe(manifest.sessionId);

      const { rows: sessionRows } = await executor.exec(
        'SELECT id, harness, native_session_id, project_id, current_generation_id FROM sessions WHERE native_session_id = ?',
        [manifest.sessionId],
      );
      expect(sessionRows.length).toBe(1);
      const sessionRow = sessionRows[0] as {
        id: string;
        harness: string;
        native_session_id: string;
        project_id: string;
        current_generation_id: string;
      };
      expect(sessionRow.harness).toBe('claude-code');
      expect(sessionRow.native_session_id).toBe(manifest.sessionId);
      expect(sessionRow.current_generation_id).toBe(receipt.generationId);

      // The manifest_artifacts table must now be populated by real ingestion:
      // one row per manifest artifact, correctly linked to source_manifests.
      const { rows: manifestArtifactRows } = await executor.exec(
        'SELECT source_manifest_id, scope, relative_path, sha256, size, status FROM manifest_artifacts WHERE source_manifest_id = ?',
        [sourceRow.id],
      );
      expect(manifestArtifactRows.length).toBe(manifest.artifacts.length);
      for (const artifact of manifest.artifacts) {
        const row = manifestArtifactRows.find(
          (r) =>
            (r as { relative_path: string }).relative_path === artifact.relativePath &&
            (r as { sha256: string }).sha256 === artifact.sha256,
        ) as
          | {
              source_manifest_id: string;
              scope: string;
              relative_path: string;
              sha256: string;
              size: number;
              status: string;
            }
          | undefined;
        expect(row).toBeTruthy();
        if (row) {
          expect(row.source_manifest_id).toBe(sourceRow.id);
          expect(row.scope).toBe(artifact.scope ?? 'session');
          expect(row.sha256).toBe(artifact.sha256);
          expect(row.size).toBe(artifact.size);
          expect(row.status).toBe(artifact.status);
        }
      }

      // The artifact_references table should also have a 'contains' reference
      // for each manifest artifact, seeded by the ingestion pass.
      const { rows: referenceRows } = await executor.exec(
        `SELECT COUNT(*) AS c FROM artifact_references r
         JOIN manifest_artifacts a ON a.id = r.manifest_artifact_id
         WHERE a.source_manifest_id = ? AND r.relationship = 'contains'`,
        [sourceRow.id],
      );
      expect((referenceRows[0] as { c: number }).c).toBe(manifest.artifacts.length);

      // The stored manifest is the authoritative record for artifact identity:
      // each artifact carries scope, relative path, and sha256 under the manifest
      // harness, satisfying manifest-backed classification.
      const storedManifest = JSON.parse(sourceRow.raw_metadata) as {
        harness: string;
        artifacts: Array<{ scope: string; relativePath: string; sha256: string }>;
      };
      expect(storedManifest.harness).toBe('claude');
      for (const artifact of manifest.artifacts) {
        const stored = storedManifest.artifacts.find(
          (a) => a.relativePath === artifact.relativePath && a.scope === artifact.scope,
        );
        expect(stored).toBeTruthy();
        if (stored) {
          expect(stored.sha256).toBe(artifact.sha256);
        }
      }
    } finally {
      workspace.cleanup();
    }
  });
});
