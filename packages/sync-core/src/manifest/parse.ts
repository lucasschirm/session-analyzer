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

function parseArtifact(input: unknown): ManifestArtifact {
  if (typeof input !== 'object' || input === null) {
    throw new ManifestParseError('SYNC_JSON_PARSE_FAILED', 'each artifact must be an object');
  }
  const record = input as Record<string, unknown>;
  const scope = assertString(record.scope, 'artifact.scope');
  if (!VALID_SCOPES.includes(scope as ArtifactScope)) {
    throw new ManifestParseError(
      'SYNC_JSON_PARSE_FAILED',
      `artifact.scope must be one of ${VALID_SCOPES.join(', ')}`,
    );
  }
  const status = assertString(record.status, 'artifact.status');
  if (!VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])) {
    throw new ManifestParseError(
      'SYNC_JSON_PARSE_FAILED',
      `artifact.status must be one of ${VALID_STATUSES.join(', ')}`,
    );
  }
  return {
    projectId: assertString(record.projectId, 'artifact.projectId'),
    sessionId: assertString(record.sessionId, 'artifact.sessionId'),
    scope: scope as ArtifactScope,
    relativePath: assertString(record.relativePath, 'artifact.relativePath'),
    sha256: assertString(record.sha256, 'artifact.sha256'),
    size: assertNumber(record.size, 'artifact.size'),
    status: status as ManifestArtifact['status'],
    ...collectExtras(record, [
      'projectId',
      'sessionId',
      'scope',
      'relativePath',
      'sha256',
      'size',
      'status',
    ]),
  } as unknown as ManifestArtifact;
}

function parseSyncRun(input: unknown): SyncRun {
  if (typeof input !== 'object' || input === null) {
    throw new ManifestParseError('SYNC_JSON_PARSE_FAILED', 'each syncRun must be an object');
  }
  const record = input as Record<string, unknown>;
  const trigger = assertString(record.trigger, 'syncRun.trigger');
  if (!VALID_TRIGGERS.includes(trigger as SyncTrigger)) {
    throw new ManifestParseError(
      'SYNC_JSON_PARSE_FAILED',
      `syncRun.trigger must be a known trigger`,
    );
  }
  return {
    trigger: trigger as SyncTrigger,
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
    ...collectExtras(record, [
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
    ]),
  } as unknown as SyncRun;
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

export function parseSyncManifest(json: unknown): SyncManifest {
  if (typeof json !== 'object' || json === null) {
    throw new ManifestParseError('SYNC_JSON_PARSE_FAILED', 'Sync manifest must be an object');
  }

  const record = json as Record<string, unknown>;

  if (record.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new ManifestParseError(
      'MANIFEST_UNSUPPORTED_SCHEMA',
      `${SYNC_ERROR_CATALOG.MANIFEST_UNSUPPORTED_SCHEMA.description} (expected ${MANIFEST_SCHEMA_VERSION})`,
    );
  }

  const knownTopLevel = [
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

  const manifest: SyncManifest = {
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

  if (!Array.isArray(record.artifacts)) {
    throw new ManifestParseError(
      'SYNC_JSON_PARSE_FAILED',
      'artifacts is required and must be an array',
    );
  }
  manifest.artifacts = record.artifacts.map((item, index) => {
    try {
      return parseArtifact(item);
    } catch (err) {
      if (err instanceof ManifestParseError) {
        throw new ManifestParseError(err.code, `artifact[${index}]: ${err.message}`);
      }
      throw err;
    }
  });

  if (!Array.isArray(record.syncRuns)) {
    throw new ManifestParseError(
      'SYNC_JSON_PARSE_FAILED',
      'syncRuns is required and must be an array',
    );
  }
  manifest.syncRuns = record.syncRuns.map((item, index) => {
    try {
      return parseSyncRun(item);
    } catch (err) {
      if (err instanceof ManifestParseError) {
        throw new ManifestParseError(err.code, `syncRun[${index}]: ${err.message}`);
      }
      throw err;
    }
  });

  for (const key of Object.keys(record)) {
    if (!knownTopLevel.includes(key)) {
      (manifest as unknown as Record<string, unknown>)[key] = record[key];
    }
  }

  return manifest;
}
