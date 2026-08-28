import { beforeAll, describe, expect, it } from 'vitest';
import {
  EnvironmentStore,
  IngestionSourceStore,
  PortfolioStore,
  ProjectStore,
  SourceProjectStore,
  TenantStore,
} from '../../src/identity.js';
import {
  ArtifactBlobStore,
  ArtifactReferenceStore,
  CREATE_ARTIFACT_BLOBS_TABLE,
  CREATE_ARTIFACT_REFERENCES_TABLE,
  CREATE_MANIFEST_ARTIFACTS_TABLE,
  CREATE_MANIFEST_COVERAGE_TABLE,
  CREATE_RETENTION_POLICIES_TABLE,
  CREATE_SOURCE_LOCATIONS_TABLE,
  CREATE_SOURCE_MANIFESTS_TABLE,
  CREATE_SOURCE_TOMBSTONES_TABLE,
  MANIFEST_MIGRATIONS_FRAGMENT,
  ManifestArtifactStore,
  ManifestCoverageStore,
  RetentionPolicyStore,
  SourceLocationStore,
  SourceManifestStore,
  SourceTombstoneStore,
} from '../../src/manifest.js';
import { FRESH_SCHEMA_SQL } from '../../src/schema.js';
import { getSqlite3, WasmSqliteExecutor } from '../helpers/sqlite-wasm-adapter.js';

const MANIFEST_DDL = `
${CREATE_SOURCE_MANIFESTS_TABLE}
${CREATE_MANIFEST_COVERAGE_TABLE}
${CREATE_MANIFEST_ARTIFACTS_TABLE}
${CREATE_ARTIFACT_BLOBS_TABLE}
${CREATE_ARTIFACT_REFERENCES_TABLE}
${CREATE_SOURCE_LOCATIONS_TABLE}
${CREATE_RETENTION_POLICIES_TABLE}
${CREATE_SOURCE_TOMBSTONES_TABLE}
`;

beforeAll(async () => {
  await getSqlite3();
});

async function createManifestExecutor(): Promise<WasmSqliteExecutor> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  await executor.exec(MANIFEST_DDL);
  return executor;
}

interface IdentitySeed {
  tenantId: string;
  portfolioId: string;
  ingestionSourceId: string;
  environmentId: string;
  projectId: string;
  sourceProjectId: string;
}

async function seedIdentity(executor: WasmSqliteExecutor): Promise<IdentitySeed> {
  const tenantId = 'tenant-1';
  await TenantStore.insert(executor, {
    id: tenantId,
    name: 'Local Tenant',
    createdAt: 1,
    updatedAt: 1,
  });

  const portfolioId = await PortfolioStore.insert(executor, {
    id: 'portfolio-1',
    tenantId,
    name: 'Default Portfolio',
    createdAt: 1,
    updatedAt: 1,
  });

  const ingestionSourceId = await IngestionSourceStore.insert(executor, {
    id: 'ingestion-1',
    portfolioId,
    nativeSourceId: 'claude-local',
    displayName: 'Claude Local',
    type: 'claude_code',
    authority: 'local',
    supportsCursor: true,
    supportsCheckpoint: false,
    createdAt: 1,
    updatedAt: 1,
  });

  const environmentId = await EnvironmentStore.insert(executor, portfolioId, {
    id: 'env-1',
    ingestionSourceId,
    nativeEnvironmentId: 'env-native-1',
    createdAt: 1,
    updatedAt: 1,
  });

  await ProjectStore.insert(executor, {
    id: 'project-1',
    portfolioId,
    name: 'default-project',
    displayName: 'Default Project',
    createdAt: 1,
    updatedAt: 1,
  });

  const sourceProjectId = await SourceProjectStore.insert(executor, portfolioId, {
    id: 'source-project-1',
    projectId: 'project-1',
    ingestionSourceId,
    nativeProjectId: 'native-project-1',
    createdAt: 1,
    updatedAt: 1,
  });

  return {
    tenantId,
    portfolioId,
    ingestionSourceId,
    environmentId,
    projectId: 'project-1',
    sourceProjectId,
  };
}

function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('manifest schema and stores', () => {
  it('creates all eight manifest/artifact tables', async () => {
    const executor = await createManifestExecutor();
    const { rows } = await executor.exec(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const names = rows.map((row) => row.name);

    expect(names).toContain('source_manifests');
    expect(names).toContain('manifest_coverage');
    expect(names).toContain('manifest_artifacts');
    expect(names).toContain('artifact_blobs');
    expect(names).toContain('artifact_references');
    expect(names).toContain('source_locations');
    expect(names).toContain('retention_policies');
    expect(names).toContain('source_tombstones');
  });

  it('exports a sequential, checksummed migrations fragment starting at id 15', async () => {
    expect(MANIFEST_MIGRATIONS_FRAGMENT.length).toBe(8);
    expect(MANIFEST_MIGRATIONS_FRAGMENT[0].id).toBe(15);
    expect(MANIFEST_MIGRATIONS_FRAGMENT[7].id).toBe(22);

    for (const migration of MANIFEST_MIGRATIONS_FRAGMENT) {
      expect(migration.name).toBeTruthy();
      expect(migration.sql).toBeTruthy();
      expect(migration.checksum).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  describe('SourceManifestStore and ManifestArtifactStore', () => {
    it('performs a full round trip for a manifest and its artifacts', async () => {
      const executor = await createManifestExecutor();
      const { portfolioId, ingestionSourceId, environmentId, sourceProjectId } =
        await seedIdentity(executor);

      const manifestId = await SourceManifestStore.insert(executor, portfolioId, {
        id: 'manifest-1',
        ingestionSourceId,
        environmentId,
        sourceProjectId,
        manifestSchemaVersion: 3,
        finality: 'final',
        captureTime: 1,
        sequenceNumber: 1,
        harness: 'claude_code',
        harnessVersion: '0.1.0',
        manifestHash: 'sha256-manifest-1',
        reprocessingStatus: 'local',
        createdAt: 1,
        updatedAt: 1,
      });

      const manifest = await SourceManifestStore.getById(executor, portfolioId, manifestId);
      expect(manifest).toEqual(
        expect.objectContaining({
          id: manifestId,
          ingestionSourceId,
          finality: 'final',
          manifestSchemaVersion: 3,
          reprocessingStatus: 'local',
        }),
      );

      const artifactId = await ManifestArtifactStore.insert(executor, portfolioId, {
        sourceManifestId: manifestId,
        manifestProjectId: 'native-project-1',
        manifestSessionId: 'native-session-1',
        harness: 'claude_code',
        harnessVersion: '0.1.0',
        manifestSchemaVersion: 3,
        scope: 'session',
        relativePath: 'subagents/agent-1.jsonl',
        sha256: 'sha256-artifact-1',
        size: 1234,
        status: 'uploaded',
        mediaType: 'application/x-jsonlines',
        createdAt: 1,
        updatedAt: 1,
      });

      const artifact = await ManifestArtifactStore.getById(executor, portfolioId, artifactId);
      expect(artifact).toEqual(
        expect.objectContaining({
          id: artifactId,
          sourceManifestId: manifestId,
          scope: 'session',
          relativePath: 'subagents/agent-1.jsonl',
          sha256: 'sha256-artifact-1',
          size: 1234,
          status: 'uploaded',
          mediaType: 'application/x-jsonlines',
        }),
      );

      const all = await ManifestArtifactStore.listByManifest(executor, portfolioId, manifestId);
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(artifactId);

      const coverageId = await ManifestCoverageStore.insert(executor, portfolioId, {
        sourceManifestId: manifestId,
        category: 'subagent',
        discoveryCompleteness: 'complete',
        createdAt: 1,
      });

      const coverage = await ManifestCoverageStore.listByManifest(
        executor,
        portfolioId,
        manifestId,
      );
      expect(coverage).toHaveLength(1);
      expect(coverage[0].id).toBe(coverageId);
    });
  });

  describe('ArtifactBlobStore', () => {
    it('round-trips content with redaction and keyed-digest metadata', async () => {
      const executor = await createManifestExecutor();
      const content = encodeText('sensitive transcript text');
      await ArtifactBlobStore.insert(executor, {
        sha256: 'sha256-blob-1',
        mediaType: 'text/plain',
        retentionClass: 'transcript',
        content,
        size: content.length,
        redactionScheme: 'local-keyed-digest',
        keyDomainId: 'domain-a',
        sensitiveDigest: 'digest-of-sensitive-value',
        redactionChangeMarker: true,
        isRedacted: true,
        verifiedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });

      const blob = await ArtifactBlobStore.getBySha256(executor, 'sha256-blob-1');
      expect(blob).toBeDefined();
      expect(blob?.retentionClass).toBe('transcript');
      expect(blob?.isRedacted).toBe(true);
      expect(blob?.redactionScheme).toBe('local-keyed-digest');
      expect(blob?.keyDomainId).toBe('domain-a');
      expect(blob?.sensitiveDigest).toBe('digest-of-sensitive-value');
      expect(blob?.redactionChangeMarker).toBe(1);
      expect(blob?.content).toEqual(content);
      expect(blob?.size).toBe(content.length);
      expect(blob?.verifiedAt).toBe(1);
    });

    it('verifies blob integrity by hash and size', async () => {
      const executor = await createManifestExecutor();
      const content = encodeText('plain text');
      await ArtifactBlobStore.insert(executor, {
        sha256: 'sha256-blob-2',
        retentionClass: 'configuration',
        content,
        size: content.length,
        createdAt: 1,
        updatedAt: 1,
      });

      expect(await ArtifactBlobStore.verify(executor, 'sha256-blob-2', content.length)).toBe(true);
      expect(await ArtifactBlobStore.verify(executor, 'sha256-blob-2', content.length + 1)).toBe(
        false,
      );
      expect(await ArtifactBlobStore.verify(executor, 'sha256-missing', content.length)).toBe(
        false,
      );
    });
  });

  describe('ArtifactReferenceStore', () => {
    it('records canonicalization hashes and links a blob to a manifest artifact', async () => {
      const executor = await createManifestExecutor();
      const { portfolioId, ingestionSourceId, environmentId, sourceProjectId } =
        await seedIdentity(executor);

      const manifestId = await SourceManifestStore.insert(executor, portfolioId, {
        id: 'manifest-ref',
        ingestionSourceId,
        environmentId,
        sourceProjectId,
        manifestSchemaVersion: 3,
        finality: 'final',
        harness: 'claude_code',
        harnessVersion: '0.1.0',
        manifestHash: 'sha256-manifest-ref',
        createdAt: 1,
        updatedAt: 1,
      });

      const artifactId = await ManifestArtifactStore.insert(executor, portfolioId, {
        sourceManifestId: manifestId,
        manifestProjectId: 'native-project-1',
        manifestSessionId: 'native-session-1',
        harness: 'claude_code',
        harnessVersion: '0.1.0',
        manifestSchemaVersion: 3,
        scope: 'session',
        relativePath: '.claude/settings.json',
        sha256: 'sha256-raw',
        size: 256,
        status: 'uploaded',
        createdAt: 1,
        updatedAt: 1,
      });

      await ArtifactBlobStore.insert(executor, {
        sha256: 'sha256-raw',
        retentionClass: 'configuration',
        content: encodeText('{}'),
        size: 2,
        createdAt: 1,
        updatedAt: 1,
      });

      const referenceId = await ArtifactReferenceStore.insert(executor, portfolioId, {
        sourceManifestId: manifestId,
        manifestArtifactId: artifactId,
        blobSha256: 'sha256-raw',
        componentKind: 'settings',
        componentId: 'settings-1',
        componentVersion: 'v1',
        rawSha256: 'sha256-raw',
        normalizedSha256: 'sha256-normalized',
        behaviorSha256: 'sha256-behavior',
        canonicalizationVersion: 'claude-config-1',
        classifierVersion: 'classifier-1',
        rulesApplied: JSON.stringify({
          lineEnding: 'lf',
          jsonKeyOrder: 'sorted',
          redaction: 'secret-keys',
        }),
        caseSensitivity: 'sensitive',
        relationship: 'contains',
        createdAt: 1,
        updatedAt: 1,
      });

      const reference = await ArtifactReferenceStore.getById(executor, portfolioId, referenceId);
      expect(reference).toEqual(
        expect.objectContaining({
          id: referenceId,
          blobSha256: 'sha256-raw',
          rawSha256: 'sha256-raw',
          normalizedSha256: 'sha256-normalized',
          behaviorSha256: 'sha256-behavior',
          canonicalizationVersion: 'claude-config-1',
          rulesApplied: expect.any(String),
          caseSensitivity: 'sensitive',
          relationship: 'contains',
        }),
      );
    });
  });

  describe('SourceLocationStore', () => {
    it('round-trips reacquisition metadata without credentials', async () => {
      const executor = await createManifestExecutor();
      const { portfolioId, ingestionSourceId } = await seedIdentity(executor);

      const sha256 = 'sha256-blob-loc';
      await ArtifactBlobStore.insert(executor, {
        sha256,
        retentionClass: 'transcript',
        content: encodeText('x'),
        size: 1,
        createdAt: 1,
        updatedAt: 1,
      });

      const locationId = await SourceLocationStore.insert(executor, portfolioId, {
        id: 'location-1',
        ingestionSourceId,
        blobSha256: sha256,
        locationType: 's3',
        safePath: 's3://bucket/prefix/session/artifact.jsonl',
        retrievalHints: JSON.stringify({ region: 'us-east-1' }),
        reacquisitionStatus: 'available',
        createdAt: 1,
        updatedAt: 1,
      });

      const locations = await SourceLocationStore.listByBlob(executor, portfolioId, sha256);
      expect(locations).toHaveLength(1);
      expect(locations[0].id).toBe(locationId);
      expect(locations[0].safePath).toBe('s3://bucket/prefix/session/artifact.jsonl');
      expect(locations[0].retrievalHints).toContain('us-east-1');
      expect(locations[0].reacquisitionStatus).toBe('available');
    });
  });

  describe('RetentionPolicyStore', () => {
    it('resolves policies from most-specific scope to least-specific', async () => {
      const executor = await createManifestExecutor();
      const { portfolioId, environmentId, projectId } = await seedIdentity(executor);

      const portfolioPolicyId = await RetentionPolicyStore.insert(executor, {
        portfolioId,
        retentionClass: 'transcript',
        retainForSeconds: 86400,
        createdAt: 1,
        updatedAt: 1,
      });

      const environmentPolicyId = await RetentionPolicyStore.insert(executor, {
        environmentId,
        retentionClass: 'transcript',
        retainForSeconds: 604800,
        createdAt: 1,
        updatedAt: 1,
      });

      const projectPolicyId = await RetentionPolicyStore.insert(executor, {
        projectId,
        retentionClass: 'transcript',
        retainForSeconds: 2592000,
        createdAt: 1,
        updatedAt: 1,
      });

      const projectResolved = await RetentionPolicyStore.resolvePolicy(executor, {
        portfolioId,
        environmentId,
        projectId,
        retentionClass: 'transcript',
      });
      expect(projectResolved?.id).toBe(projectPolicyId);

      const envResolved = await RetentionPolicyStore.resolvePolicy(executor, {
        portfolioId,
        environmentId,
        retentionClass: 'transcript',
      });
      expect(envResolved?.id).toBe(environmentPolicyId);

      const portfolioResolved = await RetentionPolicyStore.resolvePolicy(executor, {
        portfolioId,
        retentionClass: 'transcript',
      });
      expect(portfolioResolved?.id).toBe(portfolioPolicyId);
    });

    it('rejects a policy with zero or multiple scopes', async () => {
      const executor = await createManifestExecutor();
      await expect(
        RetentionPolicyStore.insert(executor, {
          retentionClass: 'transcript',
          retainForSeconds: 1,
        }),
      ).rejects.toThrow(/exactly one/);

      const { portfolioId, environmentId } = await seedIdentity(executor);
      await expect(
        RetentionPolicyStore.insert(executor, {
          portfolioId,
          environmentId,
          retentionClass: 'transcript',
          retainForSeconds: 1,
        }),
      ).rejects.toThrow(/exactly one/);
    });
  });

  describe('SourceTombstoneStore', () => {
    it('records authoritative deletions and distinguishes them from absent listings', async () => {
      const executor = await createManifestExecutor();
      const { portfolioId, ingestionSourceId } = await seedIdentity(executor);

      await SourceTombstoneStore.recordTombstone(executor, portfolioId, {
        ingestionSourceId,
        sourceType: 'session',
        sourceId: 'native-session-deleted',
        tombstoneAuthority: 'sync',
        reason: 'user deletion',
        createdAt: 1,
      });

      expect(
        await SourceTombstoneStore.isTombstoned(
          executor,
          portfolioId,
          ingestionSourceId,
          'session',
          'native-session-deleted',
        ),
      ).toBe(true);

      expect(
        await SourceTombstoneStore.isTombstoned(
          executor,
          portfolioId,
          ingestionSourceId,
          'session',
          'native-session-absent',
        ),
      ).toBe(false);

      const tombstone = await SourceTombstoneStore.getTombstone(
        executor,
        portfolioId,
        ingestionSourceId,
        'session',
        'native-session-deleted',
      );
      expect(tombstone).toEqual(
        expect.objectContaining({
          sourceType: 'session',
          sourceId: 'native-session-deleted',
          tombstoneAuthority: 'sync',
          reason: 'user deletion',
        }),
      );
    });
  });

  describe('integrity and constraints', () => {
    it('verifies artifact hashes against retained blobs before transformation', async () => {
      const executor = await createManifestExecutor();
      const { portfolioId, ingestionSourceId, environmentId, sourceProjectId } =
        await seedIdentity(executor);

      const manifestId = await SourceManifestStore.insert(executor, portfolioId, {
        id: 'manifest-verify',
        ingestionSourceId,
        environmentId,
        sourceProjectId,
        manifestSchemaVersion: 3,
        finality: 'final',
        harness: 'claude_code',
        harnessVersion: '0.1.0',
        manifestHash: 'sha256-manifest-verify',
        createdAt: 1,
        updatedAt: 1,
      });

      const artifactId = await ManifestArtifactStore.insert(executor, portfolioId, {
        sourceManifestId: manifestId,
        manifestProjectId: 'native-project-1',
        manifestSessionId: 'native-session-1',
        harness: 'claude_code',
        harnessVersion: '0.1.0',
        manifestSchemaVersion: 3,
        scope: 'session',
        relativePath: 'main.jsonl',
        sha256: 'sha256-verified',
        size: 100,
        status: 'uploaded',
        createdAt: 1,
        updatedAt: 1,
      });

      expect(
        await ManifestArtifactStore.verifyBlobHash(
          executor,
          portfolioId,
          artifactId,
          'sha256-missing',
        ),
      ).toBe(false);

      await ArtifactBlobStore.insert(executor, {
        sha256: 'sha256-verified',
        retentionClass: 'transcript',
        content: encodeText('session transcript'),
        size: 18,
        createdAt: 1,
        updatedAt: 1,
      });

      expect(
        await ManifestArtifactStore.verifyBlobHash(
          executor,
          portfolioId,
          artifactId,
          'sha256-verified',
        ),
      ).toBe(true);
      expect(
        await ManifestArtifactStore.verifyBlobHash(
          executor,
          portfolioId,
          artifactId,
          'sha256-mismatch',
        ),
      ).toBe(false);
    });

    it('enforces foreign keys and rejects unparameterized injections', async () => {
      const executor = await createManifestExecutor();
      const { portfolioId, ingestionSourceId } = await seedIdentity(executor);

      await expect(
        SourceManifestStore.insert(executor, portfolioId, {
          id: 'bad-manifest',
          ingestionSourceId: 'non-existent-source',
          manifestSchemaVersion: 3,
          finality: 'final',
          harness: 'claude_code',
          harnessVersion: '0.1.0',
          manifestHash: "'; drop table source_manifests; --",
          createdAt: 1,
          updatedAt: 1,
        }),
      ).rejects.toThrow(/not inserted/);

      const { rows } = await executor.exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='source_manifests'",
      );
      expect(rows).toHaveLength(1);

      const manifestId = await SourceManifestStore.insert(executor, portfolioId, {
        id: 'manifest-fk',
        ingestionSourceId,
        manifestSchemaVersion: 3,
        finality: 'final',
        harness: 'claude_code',
        harnessVersion: '0.1.0',
        manifestHash: 'sha256-fk',
        createdAt: 1,
        updatedAt: 1,
      });

      await expect(
        ManifestArtifactStore.insert(executor, portfolioId, {
          sourceManifestId: 'non-existent-manifest',
          manifestProjectId: 'p',
          manifestSessionId: 's',
          harness: 'claude_code',
          harnessVersion: '0.1.0',
          manifestSchemaVersion: 3,
          scope: 'session',
          relativePath: 'foo.jsonl',
          sha256: 'sha256-fk-artifact',
          size: 1,
          status: 'uploaded',
          createdAt: 1,
          updatedAt: 1,
        }),
      ).rejects.toThrow(/not inserted/);

      const artifactId = await ManifestArtifactStore.insert(executor, portfolioId, {
        sourceManifestId: manifestId,
        manifestProjectId: 'p',
        manifestSessionId: 's',
        harness: 'claude_code',
        harnessVersion: '0.1.0',
        manifestSchemaVersion: 3,
        scope: 'session',
        relativePath: 'foo.jsonl',
        sha256: 'sha256-fk-artifact',
        size: 1,
        status: 'uploaded',
        createdAt: 1,
        updatedAt: 1,
      });

      await expect(
        ArtifactReferenceStore.insert(executor, portfolioId, {
          sourceManifestId: manifestId,
          manifestArtifactId: artifactId,
          blobSha256: 'sha256-missing-blob',
          createdAt: 1,
          updatedAt: 1,
        }),
      ).rejects.toThrow();
    });
  });
});
