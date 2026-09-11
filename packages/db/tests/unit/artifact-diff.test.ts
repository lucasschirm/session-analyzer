import {
  ArtifactBlobStore as DbArtifactBlobStore,
  FRESH_SCHEMA_SQL,
} from '@lucasschirm/sal-db-core';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import {
  type ArtifactCanonicalizationInput,
  ArtifactCanonicalizer,
  ArtifactDiffEngine,
  ArtifactDiffRepository,
  type CanonicalizedArtifact,
} from '../../src/artifact-diff.js';
import { createSha256ContentHasher } from '../../src/ingestion.js';
import type { ArtifactBlobStore, ResolvedArtifact } from '../../src/ports.js';

const PORTFOLIO_ID = 'pf-artifact';
const INGESTION_SOURCE_ID = 'src-artifact';
const ENVIRONMENT_ID = 'env-artifact';
const PROJECT_ID = 'prj-artifact';
const SOURCE_PROJECT_ID = 'sp-artifact';
const TENANT_ID = 'ten-artifact';

function makeHasher() {
  return createSha256ContentHasher();
}

/**
 * In-file fake implementing the ArtifactBlobStore port
 * (packages/db/src/ports.ts:48-53). packages/db must not import a real
 * concrete store from packages/site (see packages/db/AGENTS.md) -- the
 * real-store, real-round-trip coverage lives in
 * packages/site/tests/unit/artifact-adapters.test.ts instead.
 *
 * `retain()` also performs a real `artifact_blobs` placeholder write via
 * `DbArtifactBlobStore.insert` -- mirroring
 * `createOpfsArtifactBlobStore.retain()`'s own `insertBlobMetadata` call
 * (packages/site/src/db/opfs-artifact-blob-store.ts) with the same default
 * retention class and no redaction fields. Without this, the fake never
 * performs a second SQL write, so no test in this file could ever tell
 * `writeBlobIfNew`'s correct write order (retain, then the authoritative
 * insert) apart from a reversed one -- both would leave exactly one row.
 */
function createFakeBlobStore(executor: WasmSqliteExecutor): ArtifactBlobStore & {
  readonly retainCalls: number[];
  readonly readCalls: string[];
  seed(artifact: ResolvedArtifact): void;
} {
  const stored = new Map<string, ResolvedArtifact>();
  const readCalls: string[] = [];
  const retainCalls: number[] = [];
  return {
    retainCalls,
    readCalls,
    seed: (artifact) => {
      stored.set(artifact.sha256, artifact);
    },
    retain: async (blob) => {
      retainCalls.push(1);
      stored.set(blob.sha256, blob);
      await DbArtifactBlobStore.insert(executor, {
        sha256: blob.sha256,
        size: blob.size,
        mediaType: blob.mediaType,
        retentionClass: 'retained',
        content: null,
      });
      const { content: _content, ...reference } = blob;
      return reference;
    },
    read: async (sha256) => {
      readCalls.push(sha256);
      return stored.get(sha256);
    },
    remove: async (sha256) => stored.delete(sha256),
    list: async () => [],
  };
}

function baseInput(
  content: string | null,
  overrides?: Partial<ArtifactCanonicalizationInput>,
): ArtifactCanonicalizationInput {
  return {
    harness: 'claude-code',
    kind: 'settings',
    content,
    relativePath: '.claude/config.json',
    classifierVersion: '1.0.0',
    canonicalizerVersion: '1.0.0',
    ...overrides,
  };
}

async function seedExecutor(executor: WasmSqliteExecutor): Promise<void> {
  await executor.exec(FRESH_SCHEMA_SQL);
  await executor.exec(
    'INSERT INTO tenants (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    [TENANT_ID, 'Test', 0, 0],
  );
  await executor.exec(
    'INSERT INTO portfolios (id, tenant_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [PORTFOLIO_ID, TENANT_ID, 'Test', 0, 0],
  );
  await executor.exec(
    'INSERT INTO ingestion_sources (id, portfolio_id, native_source_id, display_name, type, authority, supports_cursor, supports_checkpoint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [INGESTION_SOURCE_ID, PORTFOLIO_ID, 'default', 'Default', 'sync', 'local', 0, 0, 0, 0],
  );
  await executor.exec(
    'INSERT INTO environments (id, ingestion_source_id, native_environment_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [ENVIRONMENT_ID, INGESTION_SOURCE_ID, 'dev', 0, 0],
  );
  await executor.exec(
    'INSERT INTO projects (id, portfolio_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [PROJECT_ID, PORTFOLIO_ID, 'Test', 0, 0],
  );
  await executor.exec(
    'INSERT INTO source_projects (id, project_id, ingestion_source_id, native_project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [SOURCE_PROJECT_ID, PROJECT_ID, INGESTION_SOURCE_ID, 'test', 0, 0],
  );
  for (const sessionId of ['sess-left', 'sess-right']) {
    await executor.exec(
      'INSERT INTO sessions (id, project_id, ingestion_source_id, environment_id, harness, native_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [sessionId, PROJECT_ID, INGESTION_SOURCE_ID, ENVIRONMENT_ID, 'claude-code', sessionId, 0, 0],
    );
  }
}

async function insertSourceManifest(
  executor: WasmSqliteExecutor,
  sessionId: string,
  seq: number,
): Promise<string> {
  const id = `sm-${seq}-${sessionId}`;
  await executor.exec(
    `INSERT INTO source_manifests (
      id, ingestion_source_id, environment_id, source_project_id, session_id,
      manifest_schema_version, finality, occurrence_time, capture_time, ingestion_time, sequence_number,
      native_project_id, native_session_id,
      harness, harness_version, transcripts_captured, main_transcript_relative_path, manifest_hash,
      reprocessing_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      INGESTION_SOURCE_ID,
      ENVIRONMENT_ID,
      SOURCE_PROJECT_ID,
      sessionId,
      3,
      'final',
      0,
      0,
      0,
      seq,
      'test',
      sessionId,
      'claude-code',
      '0.1.0',
      0,
      null,
      `mh-${seq}`,
      'local',
      0,
      0,
    ],
  );
  return id;
}

async function insertManifestArtifact(
  executor: WasmSqliteExecutor,
  sourceManifestId: string,
  manifestSessionId: string,
  relativePath: string,
): Promise<string> {
  const id = `ma-${sourceManifestId}-${relativePath.replace(/\//g, '-')}`;
  await executor.exec(
    `INSERT INTO manifest_artifacts (
      id, source_manifest_id, manifest_project_id, manifest_session_id, harness, harness_version,
      manifest_schema_version, scope, relative_path, sha256, size, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      sourceManifestId,
      PROJECT_ID,
      manifestSessionId,
      'claude-code',
      '0.1.0',
      3,
      'workspace',
      relativePath,
      'sha256-placeholder',
      1,
      'uploaded',
      0,
      0,
    ],
  );
  return id;
}

describe('ArtifactCanonicalizer', () => {
  it('records separate raw-byte, normalized-content, and behavior-configuration hashes', async () => {
    const content = JSON.stringify({
      createdAt: '2026-01-01T00:00:00Z',
      id: 'cfg-1',
      model: 'claude-3-5-sonnet',
      permissions: { allow: ['read'] },
      z_field: 'zzz',
    });
    const canonicalizer = new ArtifactCanonicalizer(makeHasher());
    const result = await canonicalizer.canonicalize(baseInput(content));

    expect(result.rawSha256).not.toBe('');
    expect(result.normalizedSha256).not.toBe('');
    expect(result.behaviorSha256).not.toBe('');
    expect(result.rawSha256).not.toBe(result.normalizedSha256);
    expect(result.normalizedSha256).not.toBe(result.behaviorSha256);
    expect(result.rawSha256).not.toBe(result.behaviorSha256);
    expect(result.behaviorSummary).toEqual({
      model: 'claude-3-5-sonnet',
      permissions: { allow: ['read'] },
    });
  });

  it('versions canonicalization rules by harness, kind, and rule content', async () => {
    const canonicalizer = new ArtifactCanonicalizer(makeHasher());
    const content = '{"model": "claude-3-5-sonnet"}';
    const base = baseInput(content);
    const withRules = { ...base, rules: { jsonKeyOrder: false, generatedField: false } };

    const a = await canonicalizer.canonicalize(base);
    const b = await canonicalizer.canonicalize(withRules);

    expect(a.canonicalizationVersion).toContain('claude-code:settings:1.0.0:');
    expect(a.canonicalizationVersion).not.toBe(b.canonicalizationVersion);

    const a2 = await canonicalizer.canonicalize(base);
    expect(a2.canonicalizationVersion).toBe(a.canonicalizationVersion);
  });

  it('canonicalizes multi-component files with component-level hashes', async () => {
    const content = JSON.stringify({
      model: 'claude-3-5-sonnet',
      skills: [
        {
          name: 'greet',
          description: 'Greet',
          model: 'claude-3-5-sonnet',
          globs: ['.claude/skills/greet/**'],
        },
      ],
      agents: [
        {
          name: 'helper',
          description: 'Helper',
          model: 'claude-3-opus',
          instructions: 'Help',
        },
      ],
    });
    const canonicalizer = new ArtifactCanonicalizer(makeHasher());
    const result = await canonicalizer.canonicalize(
      baseInput(content, {
        components: [
          { kind: 'skill', sourcePointer: '/skills/0' },
          { kind: 'agent', sourcePointer: '/agents/0' },
        ],
      }),
    );

    expect(result.components.length).toBe(2);
    const skill = result.components.find((c) => c.sourcePointer === '/skills/0');
    const agent = result.components.find((c) => c.sourcePointer === '/agents/0');
    expect(skill).toBeDefined();
    expect(agent).toBeDefined();
    expect(skill?.rawSha256).not.toBe(result.rawSha256);
    expect(agent?.rawSha256).not.toBe(result.rawSha256);
    expect(skill?.normalizedSha256).not.toBe('');
    expect(agent?.normalizedSha256).not.toBe('');
    expect(skill?.behaviorSummary).toEqual({
      name: 'greet',
      description: 'Greet',
      model: 'claude-3-5-sonnet',
      globs: ['.claude/skills/greet/**'],
    });
    expect(agent?.behaviorSummary).toEqual({
      name: 'helper',
      description: 'Helper',
      model: 'claude-3-opus',
      instructions: 'Help',
    });
  });

  it('produces a keyed sensitive-change digest, not a constant redaction hash', async () => {
    const canonicalizer = new ArtifactCanonicalizer(makeHasher());

    const digestA = await canonicalizer.computeSensitiveDigest(
      'hmac-sha256-v1',
      'domain-a',
      'secret1',
    );
    const digestA2 = await canonicalizer.computeSensitiveDigest(
      'hmac-sha256-v1',
      'domain-a',
      'secret1',
    );
    const digestB = await canonicalizer.computeSensitiveDigest(
      'hmac-sha256-v1',
      'domain-a',
      'secret2',
    );
    const digestC = await canonicalizer.computeSensitiveDigest(
      'hmac-sha256-v1',
      'domain-b',
      'secret1',
    );

    expect(digestA).not.toBe('');
    expect(digestA).toBe(digestA2);
    expect(digestA).not.toBe(digestB);
    expect(digestA).not.toBe(digestC);

    const rekeyed = await canonicalizer.rekeySensitiveDigest(
      'hmac-sha256-v1',
      digestA,
      'domain-a',
      'domain-b',
      'secret1',
    );
    expect(rekeyed).toBe(digestC);

    await expect(
      canonicalizer.rekeySensitiveDigest(
        'hmac-sha256-v1',
        digestA,
        'domain-wrong',
        'domain-b',
        'secret1',
      ),
    ).rejects.toThrow('does not match');
  });

  it('emits a boolean change marker and local keyed digest when a sensitive source is supplied', async () => {
    const canonicalizer = new ArtifactCanonicalizer(makeHasher());
    const content = '{"model": "claude-3-5-sonnet"}';
    const result = await canonicalizer.canonicalize(
      baseInput(content, {
        sensitiveSource: {
          scheme: 'hmac-sha256-v1',
          keyDomainId: 'domain-a',
          content: 'secret-value',
        },
      }),
    );

    expect(result.sensitiveDigest).not.toBeNull();
    expect(result.sensitiveDigestScheme).toBe('hmac-sha256-v1');
    expect(result.keyDomainId).toBe('domain-a');
    expect(result.redactionChangeMarker).toBe(true);
  });

  it('marks purged source as metadata-only with empty hashes', async () => {
    const canonicalizer = new ArtifactCanonicalizer(makeHasher());
    const result = await canonicalizer.canonicalize(baseInput('any content', { content: null }));

    expect(result.isPurged).toBe(true);
    expect(result.rawSha256).toBe('');
    expect(result.normalizedSha256).toBe('');
    expect(result.behaviorSha256).toBe('');
    expect(result.components).toEqual([]);
  });
});

describe('ArtifactDiffEngine', () => {
  async function canonicalizeSkillAgent(content: string | null): Promise<CanonicalizedArtifact> {
    const canonicalizer = new ArtifactCanonicalizer(makeHasher());
    return canonicalizer.canonicalize(
      baseInput(content, {
        components: [
          { kind: 'skill', sourcePointer: '/skills/0' },
          { kind: 'agent', sourcePointer: '/agents/0' },
        ],
      }),
    );
  }

  it('produces unified and side-by-side diff output', async () => {
    const leftContent = JSON.stringify({
      model: 'claude-3-5-sonnet',
      skills: [
        {
          name: 'greet',
          description: 'Greet',
          model: 'claude-3-5-sonnet',
          globs: ['.claude/skills/greet/**'],
        },
      ],
      agents: [
        { name: 'helper', description: 'Helper', model: 'claude-3-opus', instructions: 'Help' },
      ],
    });
    const rightContent = JSON.stringify({
      model: 'claude-3-5-sonnet',
      skills: [
        {
          name: 'greet',
          description: 'Greet',
          model: 'claude-3-5-sonnet',
          globs: ['.claude/skills/greet/**'],
        },
      ],
      agents: [
        { name: 'helper', description: 'Helper', model: 'claude-3-5-sonnet', instructions: 'Help' },
      ],
    });

    const left = await canonicalizeSkillAgent(leftContent);
    const right = await canonicalizeSkillAgent(rightContent);
    const engine = new ArtifactDiffEngine(makeHasher());
    const diff = await engine.computeDiff(left, right, {
      leftSessions: ['sess-left'],
      rightSessions: ['sess-right'],
    });

    expect(diff.artifactId).toBe(left.relativePath);
    expect(diff.leftVersion).toBe(left.canonicalizationVersion);
    expect(diff.rightVersion).toBe(right.canonicalizationVersion);
    expect(diff.contentAvailable).toBe(true);
    expect(diff.unifiedDiff).toBeDefined();
    expect(diff.unifiedDiff).toContain('-');
    expect(diff.unifiedDiff).toContain('+');
    expect(diff.sideBySideDiff).toBeDefined();
    expect(diff.sideBySideDiff?.left.some((l) => l.changeType === 'removed')).toBe(true);
    expect(diff.sideBySideDiff?.right.some((r) => r.changeType === 'added')).toBe(true);
    expect(diff.observationalCohorts).toEqual([
      { sessionId: 'sess-left', left: true, right: false },
      { sessionId: 'sess-right', left: false, right: true },
    ]);

    const agentDiff = diff.componentDiffs.find((c) => c.sourcePointer === '/agents/0');
    expect(agentDiff).toBeDefined();
    expect(agentDiff?.unifiedDiff).toContain('claude-3-opus');
    expect(agentDiff?.unifiedDiff).toContain('claude-3-5-sonnet');
    expect(agentDiff?.metadataChanges.some((m) => m.field === 'behavior.model')).toBe(true);
  });

  it('presents metadata-only evidence when source text is purged', async () => {
    const leftContent = JSON.stringify({ model: 'claude-3-5-sonnet' });
    const left = await canonicalizeSkillAgent(leftContent);
    const right = await canonicalizeSkillAgent(null);
    const engine = new ArtifactDiffEngine(makeHasher());
    const diff = await engine.computeDiff(left, right);

    expect(diff.contentAvailable).toBe(false);
    expect(diff.unifiedDiff).toBeUndefined();
    expect(diff.sideBySideDiff).toBeUndefined();
    expect(diff.metadataChanges.some((m) => m.field === 'isPurged')).toBe(true);
  });
});

describe('ArtifactDiffRepository', () => {
  async function setup(): Promise<WasmSqliteExecutor> {
    const executor = await WasmSqliteExecutor.create();
    await seedExecutor(executor);
    return executor;
  }

  async function recordVersion(
    executor: WasmSqliteExecutor,
    sessionId: string,
    content: string | null,
    seq: number,
  ): Promise<{ sourceManifestId: string; manifestArtifactId: string; referenceId: string }> {
    const sourceManifestId = await insertSourceManifest(executor, sessionId, seq);
    const manifestArtifactId = await insertManifestArtifact(
      executor,
      sourceManifestId,
      sessionId,
      '.claude/config.json',
    );
    const repository = new ArtifactDiffRepository(makeHasher());
    const [referenceId] = await repository.record(
      executor,
      PORTFOLIO_ID,
      {
        sourceManifestId,
        manifestArtifactId,
        observingSessionId: sessionId,
      },
      baseInput(content, {
        components: [
          { kind: 'skill', sourcePointer: '/skills/0' },
          { kind: 'agent', sourcePointer: '/agents/0' },
        ],
      }),
    );
    return { sourceManifestId, manifestArtifactId, referenceId };
  }

  it('records artifact version canonicalization into the real db-core schema', async () => {
    const executor = await setup();
    const content = JSON.stringify({
      model: 'claude-3-5-sonnet',
      skills: [
        {
          name: 'greet',
          description: 'Greet',
          model: 'claude-3-5-sonnet',
          globs: ['.claude/skills/greet/**'],
        },
      ],
    });

    const { referenceId } = await recordVersion(executor, 'sess-left', content, 0);
    const repository = new ArtifactDiffRepository(makeHasher());
    const canonicalized = await repository.getCanonicalizedArtifact(
      executor,
      PORTFOLIO_ID,
      referenceId,
    );

    expect(canonicalized).toBeDefined();
    expect(canonicalized?.rawSha256).not.toBe('');
    expect(canonicalized?.normalizedSha256).not.toBe('');
    expect(canonicalized?.components.length).toBe(2);
    const skill = canonicalized?.components.find((c) => c.sourcePointer === '/skills/0');
    expect(skill).toBeDefined();
    expect(skill?.normalizedSha256).not.toBe('');
  });

  it('produces a diff across recorded versions using real SQLite', async () => {
    const executor = await setup();
    const leftContent = JSON.stringify({
      model: 'claude-3-5-sonnet',
      skills: [
        {
          name: 'greet',
          description: 'Greet',
          model: 'claude-3-5-sonnet',
          globs: ['.claude/skills/greet/**'],
        },
      ],
      agents: [
        { name: 'helper', description: 'Helper', model: 'claude-3-opus', instructions: 'Help' },
      ],
    });
    const rightContent = JSON.stringify({
      model: 'claude-3-5-sonnet',
      skills: [
        {
          name: 'greet',
          description: 'Greet',
          model: 'claude-3-5-sonnet',
          globs: ['.claude/skills/greet/**'],
        },
      ],
      agents: [
        { name: 'helper', description: 'Helper', model: 'claude-3-5-sonnet', instructions: 'Help' },
      ],
    });

    const { referenceId: leftReferenceId } = await recordVersion(
      executor,
      'sess-left',
      leftContent,
      0,
    );
    const { referenceId: rightReferenceId } = await recordVersion(
      executor,
      'sess-right',
      rightContent,
      1,
    );

    const repository = new ArtifactDiffRepository(makeHasher());
    const diff = await repository.getDiff(
      executor,
      PORTFOLIO_ID,
      leftReferenceId,
      rightReferenceId,
    );

    expect(diff).toBeDefined();
    expect(diff?.contentAvailable).toBe(true);
    expect(diff?.unifiedDiff).toBeDefined();
    expect(diff?.metadataChanges.some((m) => m.field === 'normalizedSha256')).toBe(true);

    const agentDiff = diff?.componentDiffs.find((c) => c.sourcePointer === '/agents/0');
    expect(agentDiff).toBeDefined();
    expect(agentDiff?.unifiedDiff).toContain('claude-3-opus');
    expect(agentDiff?.unifiedDiff).toContain('claude-3-5-sonnet');

    const cohorts = diff?.observationalCohorts;
    expect(cohorts.some((c) => c.sessionId === 'sess-left' && c.left)).toBe(true);
    expect(cohorts.some((c) => c.sessionId === 'sess-right' && c.right)).toBe(true);
  });

  it('presents metadata-only evidence for a purged recorded version', async () => {
    const executor = await setup();
    const leftContent = JSON.stringify({
      model: 'claude-3-5-sonnet',
      skills: [
        {
          name: 'greet',
          description: 'Greet',
          model: 'claude-3-5-sonnet',
          globs: ['.claude/skills/greet/**'],
        },
      ],
      agents: [
        { name: 'helper', description: 'Helper', model: 'claude-3-opus', instructions: 'Help' },
      ],
    });

    const { referenceId: leftReferenceId } = await recordVersion(
      executor,
      'sess-left',
      leftContent,
      0,
    );
    const { referenceId: rightReferenceId } = await recordVersion(executor, 'sess-right', null, 1);

    const repository = new ArtifactDiffRepository(makeHasher());
    const diff = await repository.getDiff(
      executor,
      PORTFOLIO_ID,
      leftReferenceId,
      rightReferenceId,
    );

    expect(diff).toBeDefined();
    expect(diff?.contentAvailable).toBe(false);
    expect(diff?.unifiedDiff).toBeUndefined();
    expect(diff?.sideBySideDiff).toBeUndefined();
    expect(diff?.metadataChanges.some((m) => m.field === 'isPurged')).toBe(true);
    const agentDiff = diff?.componentDiffs.find((c) => c.sourcePointer === '/agents/0');
    expect(agentDiff).toBeDefined();
    expect(agentDiff?.unifiedDiff).toBeUndefined();
    expect(agentDiff?.sideBySideDiff).toBeUndefined();
  });

  it('with blobStore provided, retains bytes first then writes the authoritative row with content: null, and the read side falls back to blobStore.read()', async () => {
    const executor = await setup();
    const hasher = makeHasher();
    const fake = createFakeBlobStore(executor);

    const content = JSON.stringify({ model: 'claude-3-5-sonnet', variant: 'with-store' });
    const sourceManifestId = await insertSourceManifest(executor, 'sess-left', 0);
    const manifestArtifactId = await insertManifestArtifact(
      executor,
      sourceManifestId,
      'sess-left',
      '.claude/config.json',
    );
    const repository = new ArtifactDiffRepository(hasher, fake);
    const [referenceId] = await repository.record(
      executor,
      PORTFOLIO_ID,
      { sourceManifestId, manifestArtifactId, observingSessionId: 'sess-left' },
      baseInput(content),
    );

    const sha = await hasher.hash(content);
    expect(fake.retainCalls).toHaveLength(1);

    const { rows } = await executor.exec('SELECT content FROM artifact_blobs WHERE sha256 = ?', [
      sha,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBeNull();

    // The authoritative metadata row's content is null, so the read side
    // must fall back to blobStore.read() -- and the bytes it retained must
    // round-trip byte-for-byte through that fallback.
    const canonicalized = await repository.getCanonicalizedArtifact(
      executor,
      PORTFOLIO_ID,
      referenceId,
    );
    expect(fake.readCalls).toEqual([sha]);
    expect(canonicalized?.rawSha256).toBe(sha);
  });

  it('with a non-default retentionClass and redaction input, the authoritative insert (not the store-side placeholder) determines the final row', async () => {
    const executor = await setup();
    const hasher = makeHasher();
    // createFakeBlobStore's retain() mirrors production's
    // insertBlobMetadata(): a placeholder row with retentionClass 'retained'
    // and every redaction field null/false. Choosing a different
    // retentionClass and real sensitiveSource input here means the final row
    // can only match if writeBlobIfNew's authoritative insert -- which
    // carries the real values -- runs AFTER retain(), not before. Reversing
    // that order (retainBytesIfStorePresent after DbArtifactBlobStore.insert
    // in packages/db/src/artifact-diff.ts) must fail this test.
    const fake = createFakeBlobStore(executor);
    const content = JSON.stringify({ model: 'claude-3-5-sonnet', variant: 'redacted' });
    const sourceManifestId = await insertSourceManifest(executor, 'sess-left', 0);
    const manifestArtifactId = await insertManifestArtifact(
      executor,
      sourceManifestId,
      'sess-left',
      '.claude/config.json',
    );
    const repository = new ArtifactDiffRepository(hasher, fake);
    await repository.record(
      executor,
      PORTFOLIO_ID,
      {
        sourceManifestId,
        manifestArtifactId,
        observingSessionId: 'sess-left',
        retentionClass: 'transient',
      },
      baseInput(content, {
        sensitiveSource: { scheme: 'aes-gcm', keyDomainId: 'domain-1', content: 'secret-value' },
      }),
    );

    const sha = await hasher.hash(content);
    const { rows } = await executor.exec(
      `SELECT retention_class, redaction_scheme, key_domain_id, sensitive_digest,
              redaction_change_marker, is_redacted
       FROM artifact_blobs WHERE sha256 = ?`,
      [sha],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row.retention_class).toBe('transient');
    expect(row.redaction_scheme).toBe('aes-gcm');
    expect(row.key_domain_id).toBe('domain-1');
    expect(row.sensitive_digest).not.toBeNull();
    expect(row.redaction_change_marker).toBe(1);
    expect(row.is_redacted).toBe(1);
  });

  it('with blobStore left undefined, behavior is unchanged: real bytes land directly in insert.content and blobStore.retain() is never invoked', async () => {
    const executor = await setup();
    const hasher = makeHasher();
    const content = JSON.stringify({ model: 'claude-3-5-sonnet', variant: 'without-store' });

    const sourceManifestId = await insertSourceManifest(executor, 'sess-right', 1);
    const manifestArtifactId = await insertManifestArtifact(
      executor,
      sourceManifestId,
      'sess-right',
      '.claude/settings.json',
    );
    const repository = new ArtifactDiffRepository(hasher);
    await repository.record(
      executor,
      PORTFOLIO_ID,
      { sourceManifestId, manifestArtifactId, observingSessionId: 'sess-right' },
      baseInput(content),
    );

    const sha = await hasher.hash(content);
    const { rows } = await executor.exec('SELECT content FROM artifact_blobs WHERE sha256 = ?', [
      sha,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).not.toBeNull();
    expect(new TextDecoder().decode(rows[0]?.content as Uint8Array)).toBe(content);
  });

  it('the content-address dedup guard skips blobStore.retain() when a metadata row for that sha256 already exists', async () => {
    const executor = await setup();
    const hasher = makeHasher();
    const fake = createFakeBlobStore(executor);
    const repository = new ArtifactDiffRepository(hasher, fake);
    const sharedContent = JSON.stringify({ model: 'claude-3-5-sonnet', variant: 'shared' });

    const sourceManifestIdA = await insertSourceManifest(executor, 'sess-left', 0);
    const manifestArtifactIdA = await insertManifestArtifact(
      executor,
      sourceManifestIdA,
      'sess-left',
      '.claude/config.json',
    );
    await repository.record(
      executor,
      PORTFOLIO_ID,
      { sourceManifestId: sourceManifestIdA, manifestArtifactId: manifestArtifactIdA },
      baseInput(sharedContent),
    );
    expect(fake.retainCalls).toHaveLength(1);

    // A second artifact reference observes byte-identical content (same
    // sha256, e.g. the same skill file synced from a second session). The
    // pre-existing metadata row must short-circuit the whole write block --
    // no second OPFS write, no redundant retain() call.
    const sourceManifestIdB = await insertSourceManifest(executor, 'sess-right', 1);
    const manifestArtifactIdB = await insertManifestArtifact(
      executor,
      sourceManifestIdB,
      'sess-right',
      '.claude/config.json',
    );
    await repository.record(
      executor,
      PORTFOLIO_ID,
      { sourceManifestId: sourceManifestIdB, manifestArtifactId: manifestArtifactIdB },
      baseInput(sharedContent),
    );

    expect(fake.retainCalls).toHaveLength(1);
  });

  it('propagates a failed blobStore.retain() without writing a partial content:null metadata row', async () => {
    const executor = await setup();
    const hasher = makeHasher();
    const fake = createFakeBlobStore(executor);
    const failingBlobStore = {
      ...fake,
      retain: async () => {
        throw new Error('simulated OPFS write failure');
      },
    };
    const repository = new ArtifactDiffRepository(hasher, failingBlobStore);
    const content = JSON.stringify({ model: 'claude-3-5-sonnet', variant: 'retain-fails' });
    const sourceManifestId = await insertSourceManifest(executor, 'sess-left', 0);
    const manifestArtifactId = await insertManifestArtifact(
      executor,
      sourceManifestId,
      'sess-left',
      '.claude/config.json',
    );

    await expect(
      repository.record(
        executor,
        PORTFOLIO_ID,
        { sourceManifestId, manifestArtifactId, observingSessionId: 'sess-left' },
        baseInput(content),
      ),
    ).rejects.toThrow('simulated OPFS write failure');

    // No metadata row must exist claiming content lives in a blob store that
    // never actually received it -- the dedup guard must see this sha256 as
    // genuinely new on the next attempt, not skip a half-written row.
    const sha = await hasher.hash(content);
    const { rows: blobRows } = await executor.exec(
      'SELECT content FROM artifact_blobs WHERE sha256 = ?',
      [sha],
    );
    expect(blobRows).toHaveLength(0);

    // record() must abort entirely -- no artifact_references row for this
    // attempt either.
    const { rows: refRows } = await executor.exec(
      'SELECT id FROM artifact_references WHERE manifest_artifact_id = ?',
      [manifestArtifactId],
    );
    expect(refRows).toHaveLength(0);
  });

  it('consults blobStore.read() only when the metadata row content is already null (e.g. a row nulled by the sub-issue-4 backfill)', async () => {
    const executor = await setup();
    const hasher = makeHasher();
    const fake = createFakeBlobStore(executor);
    const repository = new ArtifactDiffRepository(hasher, fake);

    // Simulate a row already nulled by the backfill (sub-issue 4), never via
    // the db-core ArtifactBlobStore class -- that would reintroduce, inside
    // this test file, the exact ArtifactBlobStore/port name collision this
    // issue's Scope section aliases away in the source file.
    const purgedSha256 = 'b'.repeat(64);
    const now = Date.now();
    await executor.exec(
      `INSERT INTO artifact_blobs (
        sha256, media_type, retention_class, content, size,
        redaction_scheme, key_domain_id, sensitive_digest, redaction_change_marker, is_redacted,
        verified_at, created_at, updated_at
      ) VALUES (?, NULL, 'retained', NULL, ?, NULL, NULL, NULL, 0, 0, NULL, ?, ?)`,
      [purgedSha256, 0, now, now],
    );

    const fallbackContent = 'fallback content from blobStore';
    fake.seed({
      sha256: purgedSha256,
      size: fallbackContent.length,
      relativePath: '',
      mediaType: 'application/octet-stream',
      content: fallbackContent,
    });

    const sourceManifestId = await insertSourceManifest(executor, 'sess-right', 1);
    const manifestArtifactId = await insertManifestArtifact(
      executor,
      sourceManifestId,
      'sess-right',
      '.claude/settings.json',
    );
    const [referenceId] = await repository.record(
      executor,
      PORTFOLIO_ID,
      {
        sourceManifestId,
        manifestArtifactId,
        observingSessionId: 'sess-right',
        blobSha256: purgedSha256,
      },
      baseInput(null),
    );

    const canonicalized = await repository.getCanonicalizedArtifact(
      executor,
      PORTFOLIO_ID,
      referenceId,
    );

    expect(fake.readCalls).toEqual([purgedSha256]);
    expect(canonicalized?.rawSha256).not.toBe('');
  });
});
