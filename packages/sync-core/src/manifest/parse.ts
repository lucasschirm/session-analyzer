import type { ArtifactScope, ManifestArtifact } from '../artifact.js';
import { SYNC_ERROR_CATALOG, type SyncErrorCode } from '../errors.js';
import type { SyncRun, SyncTrigger } from '../sync-run.js';
import { MANIFEST_SCHEMA_VERSION } from '../versions.js';
import type { SyncManifest } from './contract.js';

class ManifestParseError extends Error {
  constructor(
    public readonly code: SyncErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ManifestParseError';
  }
}

const VALID_SCOPES: ArtifactScope[] = ['session', 'workspace', 'global', 'runtime'];
const VALID_STATUSES = ['uploaded', 'failed', 'skipped', 'pending'] as const;

const VALID_TRIGGERS: SyncTrigger[] = [
  'session-start',
  'file-changed',
  'pre-compact',
  'post-compact',
  'stop',
  'stop-failure',
  'subagent-stop',
  'session-end',
  'manual',
];

const KNOWN_ARTIFACT_FIELDS = [
  'projectId',
  'sessionId',
  'scope',
  'relativePath',
  'sha256',
  'size',
  'status',
];

const KNOWN_SYNC_RUN_FIELDS = [
  'trigger',
  'filesDiscovered',
  'filesChanged',
  'filesUploaded',
  'filesFailed',
  'filesSkipped',
  'bytesDiscovered',
  'bytesChanged',
  'bytesUploaded',
  'discoveryDurationMs',
  'sanitizationDurationMs',
  'hashDurationMs',
  'uploadDurationMs',
  'totalDurationMs',
];

const KNOWN_TOP_LEVEL_FIELDS = [
  'schemaVersion',
  'projectId',
  'sessionId',
  'harness',
  'harnessVersion',
  'model',
  'startedAt',
  'endedAt',
  'durationMs',
  'endReason',
  'syncVersion',
  'pluginVersion',
  'transcriptsCaptured',
  'mainTranscriptRelativePath',
  'artifacts',
  'syncRuns',
];

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new ManifestParseError('SYNC_JSON_PARSE_FAILED', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new ManifestParseError(
      'SYNC_JSON_PARSE_FAILED',
      `${field} is required and must be a non-empty string`,
    );
  }
  return value;
}

function assertOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ManifestParseError(
      'SYNC_JSON_PARSE_FAILED',
      `${field} must be a string when present`,
    );
  }
  return value;
}

function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ManifestParseError(
      'SYNC_JSON_PARSE_FAILED',
      `${field} is required and must be a boolean`,
    );
  }
  return value;
}

function assertOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new ManifestParseError(
      'SYNC_JSON_PARSE_FAILED',
      `${field} must be a number when present`,
    );
  }
  return value;
}

function assertNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new ManifestParseError(
      'SYNC_JSON_PARSE_FAILED',
      `${field} is required and must be a number`,
    );
  }
  return value;
}

function collectExtras(record: Record<string, unknown>, known: string[]): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) {
      extras[key] = record[key];
    }
  }
  return extras;
}

function parseArtifactScope(value: unknown): ArtifactScope {
  const scope = assertString(value, 'artifact.scope');
  if (!VALID_SCOPES.includes(scope as ArtifactScope)) {
    throw new ManifestParseError(
      'SYNC_JSON_PARSE_FAILED',
      `artifact.scope must be one of ${VALID_SCOPES.join(', ')}`,
    );
  }
  return scope as ArtifactScope;
}

function parseArtifactStatus(value: unknown): ManifestArtifact['status'] {
  const status = assertString(value, 'artifact.status');
  if (!VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])) {
    throw new ManifestParseError(
      'SYNC_JSON_PARSE_FAILED',
      `artifact.status must be one of ${VALID_STATUSES.join(', ')}`,
    );
  }
  return status as ManifestArtifact['status'];
}

function parseArtifact(input: unknown): ManifestArtifact {
  const record = assertRecord(input, 'each artifact');
  const scope = parseArtifactScope(record.scope);
  const status = parseArtifactStatus(record.status);
  return {
    projectId: assertString(record.projectId, 'artifact.projectId'),
    sessionId: assertString(record.sessionId, 'artifact.sessionId'),
    scope,
    relativePath: assertString(record.relativePath, 'artifact.relativePath'),
    sha256: assertString(record.sha256, 'artifact.sha256'),
    size: assertNumber(record.size, 'artifact.size'),
    status,
    ...collectExtras(record, KNOWN_ARTIFACT_FIELDS),
  } as unknown as ManifestArtifact;
}

function parseTrigger(value: unknown): SyncTrigger {
  const trigger = assertString(value, 'syncRun.trigger');
  if (!VALID_TRIGGERS.includes(trigger as SyncTrigger)) {
    throw new ManifestParseError(
      'SYNC_JSON_PARSE_FAILED',
      'syncRun.trigger must be a known trigger',
    );
  }
  return trigger as SyncTrigger;
}

function parseSyncRunMetrics(record: Record<string, unknown>): Record<string, number> {
  return {
    filesDiscovered: assertNumber(record.filesDiscovered, 'syncRun.filesDiscovered'),
    filesChanged: assertNumber(record.filesChanged, 'syncRun.filesChanged'),
    filesUploaded: assertNumber(record.filesUploaded, 'syncRun.filesUploaded'),
    filesFailed: assertNumber(record.filesFailed, 'syncRun.filesFailed'),
    filesSkipped: assertNumber(record.filesSkipped, 'syncRun.filesSkipped'),
    bytesDiscovered: assertNumber(record.bytesDiscovered, 'syncRun.bytesDiscovered'),
    bytesChanged: assertNumber(record.bytesChanged, 'syncRun.bytesChanged'),
    bytesUploaded: assertNumber(record.bytesUploaded, 'syncRun.bytesUploaded'),
    discoveryDurationMs: assertNumber(record.discoveryDurationMs, 'syncRun.discoveryDurationMs'),
    sanitizationDurationMs: assertNumber(
      record.sanitizationDurationMs,
      'syncRun.sanitizationDurationMs',
    ),
    hashDurationMs: assertNumber(record.hashDurationMs, 'syncRun.hashDurationMs'),
    uploadDurationMs: assertNumber(record.uploadDurationMs, 'syncRun.uploadDurationMs'),
    totalDurationMs: assertNumber(record.totalDurationMs, 'syncRun.totalDurationMs'),
  };
}

function parseSyncRun(input: unknown): SyncRun {
  const record = assertRecord(input, 'each syncRun');
  const trigger = parseTrigger(record.trigger);
  return {
    trigger,
    ...parseSyncRunMetrics(record),
    ...collectExtras(record, KNOWN_SYNC_RUN_FIELDS),
  } as unknown as SyncRun;
}

function assertSyncManifestRecord(json: unknown): Record<string, unknown> {
  const record = assertRecord(json, 'Sync manifest');
  if (record.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new ManifestParseError(
      'MANIFEST_UNSUPPORTED_SCHEMA',
      `${SYNC_ERROR_CATALOG.MANIFEST_UNSUPPORTED_SCHEMA.description} (expected ${MANIFEST_SCHEMA_VERSION})`,
    );
  }
  return record;
}

function buildSyncManifest(record: Record<string, unknown>): SyncManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    projectId: assertString(record.projectId, 'projectId'),
    sessionId: assertString(record.sessionId, 'sessionId'),
    harness: assertString(record.harness, 'harness'),
    harnessVersion: assertString(record.harnessVersion, 'harnessVersion'),
    model: assertOptionalString(record.model, 'model'),
    startedAt: assertOptionalString(record.startedAt, 'startedAt'),
    endedAt: assertOptionalString(record.endedAt, 'endedAt'),
    durationMs: assertOptionalNumber(record.durationMs, 'durationMs'),
    endReason: assertOptionalString(record.endReason, 'endReason'),
    syncVersion: assertString(record.syncVersion, 'syncVersion'),
    pluginVersion: assertString(record.pluginVersion, 'pluginVersion'),
    transcriptsCaptured: assertBoolean(record.transcriptsCaptured, 'transcriptsCaptured'),
    mainTranscriptRelativePath: assertOptionalString(
      record.mainTranscriptRelativePath,
      'mainTranscriptRelativePath',
    ),
    artifacts: [],
    syncRuns: [],
  };
}

function parseArtifactArray(record: Record<string, unknown>): ManifestArtifact[] {
  if (!Array.isArray(record.artifacts)) {
    throw new ManifestParseError(
      'SYNC_JSON_PARSE_FAILED',
      'artifacts is required and must be an array',
    );
  }
  return record.artifacts.map((item, index) => {
    try {
      return parseArtifact(item);
    } catch (err) {
      if (err instanceof ManifestParseError) {
        throw new ManifestParseError(err.code, `artifact[${index}]: ${err.message}`);
      }
      throw err;
    }
  });
}

function parseSyncRunArray(record: Record<string, unknown>): SyncRun[] {
  if (!Array.isArray(record.syncRuns)) {
    throw new ManifestParseError(
      'SYNC_JSON_PARSE_FAILED',
      'syncRuns is required and must be an array',
    );
  }
  return record.syncRuns.map((item, index) => {
    try {
      return parseSyncRun(item);
    } catch (err) {
      if (err instanceof ManifestParseError) {
        throw new ManifestParseError(err.code, `syncRun[${index}]: ${err.message}`);
      }
      throw err;
    }
  });
}

function applyUnknownFields(
  record: Record<string, unknown>,
  manifest: SyncManifest,
  known: string[],
): void {
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) {
      (manifest as unknown as Record<string, unknown>)[key] = record[key];
    }
  }
}

/**
 * Parse a raw JSON-decoded object into a {@link SyncManifest}.
 *
 * Invariant: every expected field is validated, unknown fields are preserved,
 * and nested artifacts and sync runs are parsed with index-aware errors.
 */
export function parseSyncManifest(json: unknown): SyncManifest {
  const record = assertSyncManifestRecord(json);
  const manifest = buildSyncManifest(record);
  manifest.artifacts = parseArtifactArray(record);
  manifest.syncRuns = parseSyncRunArray(record);
  applyUnknownFields(record, manifest, KNOWN_TOP_LEVEL_FIELDS);
  return manifest;
}
