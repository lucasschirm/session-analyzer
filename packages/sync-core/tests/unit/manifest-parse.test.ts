import { describe, expect, it } from 'vitest';

import {
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION_LATEST,
  parseSyncManifest,
  SYNC_VERSION,
  type SyncManifest,
} from '../../src/index.js';

function makeArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: 'proj-1',
    sessionId: 'sess-1',
    scope: 'workspace',
    relativePath: '.claude/settings.json',
    sha256: 'a'.repeat(64),
    size: 123,
    status: 'uploaded',
    ...overrides,
  };
}

function makeSyncRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trigger: 'session-end',
    filesDiscovered: 1,
    filesChanged: 1,
    filesUploaded: 1,
    filesFailed: 0,
    filesSkipped: 0,
    bytesDiscovered: 100,
    bytesChanged: 100,
    bytesUploaded: 100,
    discoveryDurationMs: 1,
    sanitizationDurationMs: 2,
    hashDurationMs: 3,
    uploadDurationMs: 4,
    totalDurationMs: 10,
    ...overrides,
  };
}

function makeManifest(
  overrides: Record<string, unknown> = {},
  schemaVersion = MANIFEST_SCHEMA_VERSION,
): Record<string, unknown> {
  return {
    schemaVersion,
    projectId: 'proj-1',
    sessionId: 'sess-1',
    harness: 'claude',
    harnessVersion: '1.2.3',
    syncVersion: SYNC_VERSION,
    pluginVersion: 'plugin-1.0.0',
    transcriptsCaptured: true,
    artifacts: [makeArtifact()],
    syncRuns: [makeSyncRun()],
    ...overrides,
  };
}

describe('parseSyncManifest', () => {
  it('accepts a valid v2 manifest', () => {
    const manifest = parseSyncManifest(makeManifest());
    expect(manifest.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(manifest.projectId).toBe('proj-1');
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.syncRuns).toHaveLength(1);
  });

  it('rejects schemaVersion 1 with MANIFEST_UNSUPPORTED_SCHEMA', () => {
    expect(() => parseSyncManifest(makeManifest({ schemaVersion: 1 }))).toThrow(
      /MANIFEST_UNSUPPORTED_SCHEMA|schemaVersion/,
    );
  });

  it('rejects unsupported schema versions with MANIFEST_UNSUPPORTED_SCHEMA', () => {
    expect(() => parseSyncManifest(makeManifest({}, 4))).toThrow(
      /MANIFEST_UNSUPPORTED_SCHEMA|schemaVersion/,
    );
    expect(() => parseSyncManifest(makeManifest({}, 99))).toThrow(
      /MANIFEST_UNSUPPORTED_SCHEMA|schemaVersion/,
    );
  });

  it('rejects a missing schemaVersion with MANIFEST_UNSUPPORTED_SCHEMA', () => {
    const { schemaVersion: _, ...without } = makeManifest();
    expect(() => parseSyncManifest(without)).toThrow(/MANIFEST_UNSUPPORTED_SCHEMA|schemaVersion/);
  });

  it('rejects a non-numeric schemaVersion with MANIFEST_UNSUPPORTED_SCHEMA', () => {
    expect(() => parseSyncManifest(makeManifest({ schemaVersion: '2' }))).toThrow(
      /MANIFEST_UNSUPPORTED_SCHEMA|schemaVersion/,
    );
  });

  it('tolerates unknown extra top-level fields for forward compatibility', () => {
    const manifest = parseSyncManifest(
      makeManifest({ futureField: 'preserved', nestedExtra: { value: 42 } }),
    );
    expect((manifest as Record<string, unknown>).futureField).toBe('preserved');
    expect((manifest as Record<string, unknown>).nestedExtra).toEqual({ value: 42 });
  });

  it('validates required top-level string fields', () => {
    expect(() => parseSyncManifest(makeManifest({ projectId: 123 }))).toThrow();
    expect(() => parseSyncManifest(makeManifest({ sessionId: '' }))).toThrow();
    expect(() => parseSyncManifest(makeManifest({ harness: null }))).toThrow();
  });

  it('validates artifact shape', () => {
    expect(() => parseSyncManifest(makeManifest({ artifacts: [{ invalid: true }] }))).toThrow();
  });

  it('validates syncRun shape', () => {
    expect(() => parseSyncManifest(makeManifest({ syncRuns: [{ invalid: true }] }))).toThrow();
  });

  it('parses v2 as partial with unknown category coverage by default', () => {
    const manifest = parseSyncManifest(makeManifest());
    expect(manifest.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(manifest.finality).toBe('partial');
    expect(manifest.expectedCategoryCoverage).toEqual([]);
    expect(manifest.categoryCoverage).toEqual({});
    expect(manifest.sourceTombstones).toEqual([]);
  });

  it('parses v2 with explicit expected categories as unknown', () => {
    const manifest = parseSyncManifest(
      makeManifest({ expectedCategoryCoverage: ['rule', 'skill', 'agent'] }),
    );
    expect(manifest.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(manifest.finality).toBe('partial');
    expect(manifest.categoryCoverage).toEqual({
      rule: { discoveryCompleteness: 'unknown' },
      skill: { discoveryCompleteness: 'unknown' },
      agent: { discoveryCompleteness: 'unknown' },
    });
  });

  it('round-trips a valid v3 manifest', () => {
    const input = makeManifest(
      {
        sourceEnvironmentNamespace: 'ns-1',
        environmentId: 'env-1',
        finality: 'final',
        occurrenceTime: '2026-08-24T10:00:00Z',
        ingestionTime: '2026-08-24T10:01:00Z',
        captureTime: '2026-08-24T10:02:00Z',
        sequenceNumber: 42,
        workspaceId: 'ws-1',
        repositoryId: 'repo-1',
        scopeChain: ['ws-1', 'repo-1'],
        collectorVersion: 'collector-1.0.0',
        sanitizationPolicyVersion: 'policy-2',
        expectedCategoryCoverage: ['rule', 'skill', 'agent'],
        categoryCoverage: {
          rule: { discoveryCompleteness: 'complete' },
          skill: { discoveryCompleteness: 'partial', reasons: ['not found'] },
          agent: { discoveryCompleteness: 'unknown' },
        },
        sourceTombstones: [
          {
            sourceType: 'artifact',
            sourceId: 'sha:abc',
            deletedAt: '2026-08-24T09:00:00Z',
            reason: 'user deleted',
          },
        ],
        artifacts: [
          makeArtifact({
            role: 'configuration',
            mediaType: 'application/json',
            encoding: 'utf-8',
            collectionOutcome: 'collected',
            collectionReason: 'allowed by policy',
          }),
        ],
      },
      MANIFEST_SCHEMA_VERSION_LATEST,
    );

    const json = JSON.parse(JSON.stringify(input));
    const manifest = parseSyncManifest(json) as SyncManifest;

    expect(manifest.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION_LATEST);
    expect(manifest.sourceEnvironmentNamespace).toBe('ns-1');
    expect(manifest.environmentId).toBe('env-1');
    expect(manifest.finality).toBe('final');
    expect(manifest.occurrenceTime).toBe('2026-08-24T10:00:00Z');
    expect(manifest.ingestionTime).toBe('2026-08-24T10:01:00Z');
    expect(manifest.captureTime).toBe('2026-08-24T10:02:00Z');
    expect(manifest.sequenceNumber).toBe(42);
    expect(manifest.workspaceId).toBe('ws-1');
    expect(manifest.repositoryId).toBe('repo-1');
    expect(manifest.scopeChain).toEqual(['ws-1', 'repo-1']);
    expect(manifest.collectorVersion).toBe('collector-1.0.0');
    expect(manifest.sanitizationPolicyVersion).toBe('policy-2');
    expect(manifest.expectedCategoryCoverage).toEqual(['rule', 'skill', 'agent']);
    expect(manifest.categoryCoverage).toEqual({
      rule: { discoveryCompleteness: 'complete' },
      skill: { discoveryCompleteness: 'partial', reasons: ['not found'] },
      agent: { discoveryCompleteness: 'unknown' },
    });
    expect(manifest.sourceTombstones).toEqual([
      {
        sourceType: 'artifact',
        sourceId: 'sha:abc',
        deletedAt: '2026-08-24T09:00:00Z',
        reason: 'user deleted',
      },
    ]);

    const artifact = manifest.artifacts[0];
    expect(artifact.role).toBe('configuration');
    expect(artifact.mediaType).toBe('application/json');
    expect(artifact.encoding).toBe('utf-8');
    expect(artifact.collectionOutcome).toBe('collected');
    expect(artifact.collectionReason).toBe('allowed by policy');
  });

  it('parses source tombstones', () => {
    const manifest = parseSyncManifest(
      makeManifest(
        {
          sourceTombstones: [
            {
              sourceType: 'artifact',
              sourceId: 'sha:abc',
              deletedAt: '2026-08-24T09:00:00Z',
              reason: 'user deleted',
            },
            {
              sourceType: 'session',
              sourceId: 'sess-2',
              deletedAt: '2026-08-24T09:01:00Z',
            },
          ],
        },
        MANIFEST_SCHEMA_VERSION_LATEST,
      ),
    );

    const tombstones = manifest.sourceTombstones ?? [];
    expect(tombstones).toHaveLength(2);
    expect(tombstones[0]).toEqual({
      sourceType: 'artifact',
      sourceId: 'sha:abc',
      deletedAt: '2026-08-24T09:00:00Z',
      reason: 'user deleted',
    });
    expect(tombstones[1]).toEqual({
      sourceType: 'session',
      sourceId: 'sess-2',
      deletedAt: '2026-08-24T09:01:00Z',
    });
  });

  it('validates v3 artifact role, media, encoding, and collection outcome', () => {
    expect(() =>
      parseSyncManifest(
        makeManifest(
          {
            artifacts: [makeArtifact({ role: 123 })],
          },
          MANIFEST_SCHEMA_VERSION_LATEST,
        ),
      ),
    ).toThrow(/role must be a string/);

    expect(() =>
      parseSyncManifest(
        makeManifest(
          {
            artifacts: [makeArtifact({ collectionOutcome: 'stolen' })],
          },
          MANIFEST_SCHEMA_VERSION_LATEST,
        ),
      ),
    ).toThrow(/collectionOutcome must be one of/);
  });

  it('validates finality values', () => {
    expect(() =>
      parseSyncManifest(makeManifest({ finality: 'draft' }, MANIFEST_SCHEMA_VERSION_LATEST)),
    ).toThrow(/finality must be one of/);
  });

  it('defaults missing v3 finality and category coverage to partial and unknown', () => {
    const manifest = parseSyncManifest(
      makeManifest(
        {
          expectedCategoryCoverage: ['rule', 'skill'],
        },
        MANIFEST_SCHEMA_VERSION_LATEST,
      ),
    );

    expect(manifest.finality).toBe('partial');
    expect(manifest.categoryCoverage).toEqual({
      rule: { discoveryCompleteness: 'unknown' },
      skill: { discoveryCompleteness: 'unknown' },
    });
  });
});
