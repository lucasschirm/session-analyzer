/**
 * Unit tests for the analytics worker startup backfill routine that moves
 * pre-existing `artifact_blobs.content` rows from SQLite into OPFS.
 */
import { ArtifactDiffRepository, createSha256ContentHasher } from '@lucasschirm/sal-db';
import {
  ArtifactBlobStore as DbArtifactBlobStore,
  FRESH_SCHEMA_SQL,
} from '@lucasschirm/sal-db-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { backfillArtifactBlobsToOpfs } from '../../src/db/analytics-worker';
import {
  createOpfsArtifactBlobStore,
  resetOpfsArtifactBlobsDirectoryCacheForTests,
} from '../../src/db/opfs-artifact-blob-store';
import { WasmSqliteExecutor } from '../../src/db/wasm-sqlite-executor';

function notFound(): DOMException {
  return new DOMException('Entry not found', 'NotFoundError');
}

function createFakeFileHandle(name: string, files: Map<string, Uint8Array>): FileSystemFileHandle {
  return {
    createWritable: vi.fn(async () => ({
      write: vi.fn(async (data: Uint8Array) => {
        files.set(name, data);
      }),
      close: vi.fn(async () => undefined),
    })),
    getFile: vi.fn(async () => {
      const bytes = files.get(name);
      if (!bytes) throw notFound();
      return { arrayBuffer: async () => bytes.buffer };
    }),
  } as unknown as FileSystemFileHandle;
}

function createFakeDirectoryHandle(files: Map<string, Uint8Array>): FileSystemDirectoryHandle {
  return {
    getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
      if (!files.has(name) && !options?.create) throw notFound();
      if (!files.has(name)) files.set(name, new Uint8Array());
      return createFakeFileHandle(name, files);
    }),
    removeEntry: vi.fn(async (name: string) => {
      if (!files.has(name)) throw notFound();
      files.delete(name);
    }),
  } as unknown as FileSystemDirectoryHandle;
}

interface OpfsFixture {
  files: Map<string, Uint8Array>;
  dirHandle: FileSystemDirectoryHandle;
  getDirectory: ReturnType<typeof vi.fn>;
  getDirectoryHandle: ReturnType<typeof vi.fn>;
}

function stubOpfs(): OpfsFixture {
  resetOpfsArtifactBlobsDirectoryCacheForTests();
  const files = new Map<string, Uint8Array>();
  const dirHandle = createFakeDirectoryHandle(files);
  const getDirectoryHandle = vi.fn(
    async (_name: string, _opts?: { create?: boolean }) => dirHandle,
  );
  const rootHandle = { getDirectoryHandle } as unknown as FileSystemDirectoryHandle;
  const getDirectory = vi.fn(async () => rootHandle);
  Object.defineProperty(globalThis, 'navigator', {
    value: { storage: { getDirectory } },
    configurable: true,
    writable: true,
  });
  return { files, dirHandle, getDirectory, getDirectoryHandle };
}

function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function createExecutor(): Promise<WasmSqliteExecutor> {
  const executor = await WasmSqliteExecutor.create({ preferOpfs: false });
  await executor.exec(FRESH_SCHEMA_SQL);
  return executor;
}

function makeBackfillRow(
  sha256: string,
  content: string,
  overrides: Partial<{
    retentionClass: string;
    redactionScheme: string;
    keyDomainId: string;
    sensitiveDigest: string;
    redactionChangeMarker: boolean;
    isRedacted: boolean;
  }> = {},
) {
  const bytes = encodeText(content);
  return {
    sha256,
    mediaType: 'text/plain',
    retentionClass: (overrides.retentionClass ?? 'retained') as
      | 'transcript'
      | 'subagent'
      | 'configuration'
      | 'secret_digest'
      | 'user_controlled'
      | 'retained'
      | 'transient',
    content: bytes,
    size: bytes.length,
    redactionScheme: overrides.redactionScheme ?? null,
    keyDomainId: overrides.keyDomainId ?? null,
    sensitiveDigest: overrides.sensitiveDigest ?? null,
    redactionChangeMarker: overrides.redactionChangeMarker ?? false,
    isRedacted: overrides.isRedacted ?? false,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

describe('backfillArtifactBlobsToOpfs', () => {
  let opfs: OpfsFixture;
  let executor: WasmSqliteExecutor;

  beforeEach(async () => {
    opfs = stubOpfs();
    executor = await createExecutor();
  });

  it('migrates pre-existing rows, writing OPFS and nulling only content', async () => {
    const row1 = makeBackfillRow('sha-backfill-1', 'first payload', {
      retentionClass: 'transcript',
      redactionScheme: 'local-keyed-digest',
      keyDomainId: 'domain-a',
      sensitiveDigest: 'digest-a',
      redactionChangeMarker: true,
      isRedacted: true,
    });
    const row2 = makeBackfillRow('sha-backfill-2', 'second payload', {
      retentionClass: 'configuration',
    });

    await DbArtifactBlobStore.insert(executor, row1);
    await DbArtifactBlobStore.insert(executor, row2);

    await backfillArtifactBlobsToOpfs(executor);

    expect(opfs.files.get('sha-backfill-1')).toEqual(row1.content);
    expect(opfs.files.get('sha-backfill-2')).toEqual(row2.content);

    const after1 = await DbArtifactBlobStore.getBySha256(executor, 'sha-backfill-1');
    expect(after1?.content).toBeNull();
    expect(after1?.retentionClass).toBe('transcript');
    expect(after1?.redactionScheme).toBe('local-keyed-digest');
    expect(after1?.keyDomainId).toBe('domain-a');
    expect(after1?.sensitiveDigest).toBe('digest-a');
    expect(after1?.redactionChangeMarker).toBe(1);
    expect(after1?.isRedacted).toBe(true);
    expect(after1?.createdAt).toBe(1000);
    expect(after1?.size).toBe(row1.content.length);

    const after2 = await DbArtifactBlobStore.getBySha256(executor, 'sha-backfill-2');
    expect(after2?.content).toBeNull();
    expect(after2?.retentionClass).toBe('configuration');
    expect(after2?.redactionScheme).toBeNull();
    expect(after2?.createdAt).toBe(1000);
  });

  it('does not abort the batch when a single OPFS write fails', async () => {
    const good = makeBackfillRow('sha-good', 'good payload');
    const bad = makeBackfillRow('sha-fail', 'failing payload');

    await DbArtifactBlobStore.insert(executor, good);
    await DbArtifactBlobStore.insert(executor, bad);

    const originalGetFileHandle = opfs.dirHandle.getFileHandle;
    opfs.dirHandle.getFileHandle = vi.fn(async (name: string, options?: { create?: boolean }) => {
      if (name === 'sha-fail' && options?.create) {
        throw new Error('OPFS write failed');
      }
      return originalGetFileHandle(name, options);
    });

    await backfillArtifactBlobsToOpfs(executor);

    expect(opfs.files.get('sha-good')).toEqual(good.content);
    expect(opfs.files.has('sha-fail')).toBe(false);

    const goodAfter = await DbArtifactBlobStore.getBySha256(executor, 'sha-good');
    expect(goodAfter?.content).toBeNull();

    const badAfter = await DbArtifactBlobStore.getBySha256(executor, 'sha-fail');
    expect(badAfter?.content).not.toBeNull();
  });

  it('vacuums once after a pass with multiple rows', async () => {
    const vacuumSpy = vi.spyOn(executor, 'vacuum').mockImplementation(() => undefined);

    await DbArtifactBlobStore.insert(executor, makeBackfillRow('sha-vacuum-1', 'one'));
    await DbArtifactBlobStore.insert(executor, makeBackfillRow('sha-vacuum-2', 'two'));

    await backfillArtifactBlobsToOpfs(executor);

    expect(vacuumSpy).toHaveBeenCalledTimes(1);
  });

  it('skips writes and vacuum when no rows have content', async () => {
    const vacuumSpy = vi.spyOn(executor, 'vacuum').mockImplementation(() => undefined);

    await DbArtifactBlobStore.insert(executor, {
      sha256: 'sha-null-only',
      mediaType: 'text/plain',
      retentionClass: 'retained',
      content: null,
      size: 0,
      createdAt: 1000,
      updatedAt: 1000,
    });

    await backfillArtifactBlobsToOpfs(executor);

    expect(opfs.getDirectory).not.toHaveBeenCalled();
    expect(vacuumSpy).not.toHaveBeenCalled();
  });

  it('is idempotent: a second pass finds no rows and writes nothing', async () => {
    const row = makeBackfillRow('sha-idempotent', 'idempotent payload');
    await DbArtifactBlobStore.insert(executor, row);

    await backfillArtifactBlobsToOpfs(executor);
    expect(opfs.files.get('sha-idempotent')).toEqual(row.content);

    const firstPass = await DbArtifactBlobStore.getBySha256(executor, 'sha-idempotent');
    expect(firstPass?.content).toBeNull();

    // The cache may or may not have been warmed on the first call; record calls
    // so far so we can assert the second pass does not touch OPFS again.
    const callsBefore = opfs.getDirectory.mock.calls.length;
    const vacuumSpy = vi.spyOn(executor, 'vacuum').mockImplementation(() => undefined);

    await backfillArtifactBlobsToOpfs(executor);

    expect(opfs.getDirectory.mock.calls.length).toBe(callsBefore);
    expect(vacuumSpy).not.toHaveBeenCalled();

    const secondPass = await DbArtifactBlobStore.getBySha256(executor, 'sha-idempotent');
    expect(secondPass?.content).toBeNull();
  });

  it('preserves getCanonicalizedArtifact isPurged and bytes across the backfill', async () => {
    stubOpfs();
    const executor = await createExecutor();
    const ids = {
      tenant: 'ten-backfill',
      portfolio: 'pf-backfill',
      ingestionSource: 'src-backfill',
      environment: 'env-backfill',
      project: 'prj-backfill',
      sourceProject: 'sp-backfill',
      session: 'sess-backfill',
      sourceManifest: 'sm-backfill',
      manifestArtifact: 'ma-backfill',
      reference: 'ref-backfill',
    };

    await executor.exec(
      'INSERT INTO tenants (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
      [ids.tenant, 'Test', 0, 0],
    );
    await executor.exec(
      'INSERT INTO portfolios (id, tenant_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [ids.portfolio, ids.tenant, 'Test', 0, 0],
    );
    await executor.exec(
      `INSERT INTO ingestion_sources (
        id, portfolio_id, native_source_id, display_name, type, authority,
        supports_cursor, supports_checkpoint, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ids.ingestionSource, ids.portfolio, 'default', 'Default', 'sync', 'local', 0, 0, 0, 0],
    );
    await executor.exec(
      'INSERT INTO environments (id, ingestion_source_id, native_environment_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [ids.environment, ids.ingestionSource, 'dev', 0, 0],
    );
    await executor.exec(
      'INSERT INTO projects (id, portfolio_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [ids.project, ids.portfolio, 'Test', 0, 0],
    );
    await executor.exec(
      'INSERT INTO source_projects (id, project_id, ingestion_source_id, native_project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [ids.sourceProject, ids.project, ids.ingestionSource, 'test', 0, 0],
    );
    await executor.exec(
      'INSERT INTO sessions (id, project_id, ingestion_source_id, environment_id, harness, native_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        ids.session,
        ids.project,
        ids.ingestionSource,
        ids.environment,
        'claude-code',
        ids.session,
        0,
        0,
      ],
    );
    await executor.exec(
      `INSERT INTO source_manifests (
        id, ingestion_source_id, environment_id, source_project_id, session_id,
        manifest_schema_version, finality, occurrence_time, capture_time, ingestion_time, sequence_number,
        native_project_id, native_session_id,
        harness, harness_version, transcripts_captured, main_transcript_relative_path, manifest_hash,
        reprocessing_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ids.sourceManifest,
        ids.ingestionSource,
        ids.environment,
        ids.sourceProject,
        ids.session,
        3,
        'final',
        0,
        0,
        0,
        0,
        'test',
        ids.session,
        'claude-code',
        '0.1.0',
        0,
        null,
        'mh-backfill',
        'local',
        0,
        0,
      ],
    );
    await executor.exec(
      `INSERT INTO manifest_artifacts (
        id, source_manifest_id, manifest_project_id, manifest_session_id, harness, harness_version,
        manifest_schema_version, scope, relative_path, sha256, size, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ids.manifestArtifact,
        ids.sourceManifest,
        ids.project,
        ids.session,
        'claude-code',
        '0.1.0',
        3,
        'workspace',
        '.claude/settings.json',
        'sha256-placeholder',
        1,
        'uploaded',
        0,
        0,
      ],
    );

    const textContent = JSON.stringify({ model: 'claude-3-5-sonnet', scope: 'project' });
    const bytes = encodeText(textContent);
    const hasher = createSha256ContentHasher();
    const sha256 = await hasher.hash(bytes);

    await DbArtifactBlobStore.insert(executor, {
      sha256,
      mediaType: 'application/json',
      retentionClass: 'configuration',
      content: bytes,
      size: bytes.length,
      redactionScheme: 'local-keyed-digest',
      keyDomainId: 'domain-backfill',
      sensitiveDigest: 'digest-backfill',
      redactionChangeMarker: true,
      isRedacted: true,
      createdAt: 1,
      updatedAt: 1,
    });

    await executor.exec(
      `INSERT INTO artifact_references (
        id, source_manifest_id, manifest_artifact_id, blob_sha256, observing_session_id,
        component_kind, component_id, component_version, source_pointer,
        raw_sha256, normalized_sha256, behavior_sha256, canonicalization_version,
        classifier_version, rules_applied, case_sensitivity, relationship, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ids.reference,
        ids.sourceManifest,
        ids.manifestArtifact,
        sha256,
        ids.session,
        'settings',
        null,
        null,
        '',
        '',
        '',
        '',
        'claude-code:settings:1.0.0:rules',
        '1.0.0',
        '',
        'sensitive',
        'contains',
        0,
        0,
      ],
    );

    const blobStore = createOpfsArtifactBlobStore(executor);
    const repository = new ArtifactDiffRepository(hasher, blobStore);

    const before = await repository.getCanonicalizedArtifact(
      executor,
      ids.portfolio,
      ids.reference,
    );
    expect(before).toBeDefined();
    expect(before?.isPurged).toBe(false);
    expect(before?.content).toEqual(bytes);

    await backfillArtifactBlobsToOpfs(executor);

    const row = await DbArtifactBlobStore.getBySha256(executor, sha256);
    expect(row?.content).toBeNull();

    const after = await repository.getCanonicalizedArtifact(executor, ids.portfolio, ids.reference);
    expect(after).toBeDefined();
    expect(after?.isPurged).toBe(false);
    expect(after?.content).toEqual(bytes);
    expect(after?.sensitiveDigest).toBe('digest-backfill');
    expect(after?.keyDomainId).toBe('domain-backfill');
  });
});
