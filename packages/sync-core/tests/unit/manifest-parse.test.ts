import { describe, expect, it } from 'vitest';

import { MANIFEST_SCHEMA_VERSION, parseSyncManifest, SYNC_VERSION } from '../../src/index.js';

function makeManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    projectId: 'proj-1',
    sessionId: 'sess-1',
    harness: 'claude',
    harnessVersion: '1.2.3',
    syncVersion: SYNC_VERSION,
    pluginVersion: 'plugin-1.0.0',
    transcriptsCaptured: true,
    artifacts: [
      {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        scope: 'workspace',
        relativePath: '.claude/settings.json',
        sha256: 'a'.repeat(64),
        size: 123,
        status: 'uploaded',
      },
    ],
    syncRuns: [
      {
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
      },
    ],
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

  it('rejects schemaVersion 3 with MANIFEST_UNSUPPORTED_SCHEMA', () => {
    expect(() => parseSyncManifest(makeManifest({ schemaVersion: 3 }))).toThrow(
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
});
