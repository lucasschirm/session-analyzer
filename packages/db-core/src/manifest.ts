import type { SqliteExecutor, SqliteRow, SqliteTransaction, SqliteValue } from './contract.js';
import { deterministicId } from './identity.js';
import type { Migration } from './migrations.js';

type Queryable = SqliteExecutor | SqliteTransaction;

/**
 * Pure-JS FNV-1a 64-bit checksum used for migration integrity. It does not
 * import a runtime crypto implementation, so it keeps `db-core` free of
 * forbidden Node/DOM/Worker dependencies.
 */
function fnv1a64(input: string): bigint {
  let hash = 14695981039346656037n;
  const prime = 1099511628211n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash;
}

function checksumOf(sql: string): string {
  return fnv1a64(sql).toString(16).padStart(16, '0');
}

function asString(value: SqliteValue): string {
  return value === null || value === undefined ? '' : String(value);
}

function toOptionalString(value: SqliteValue): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toNumber(value: SqliteValue): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function toOptionalNumber(value: SqliteValue): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function toBoolean(value: SqliteValue): boolean {
  return value === 1 || value === true;
}

function toBlob(value: SqliteValue): Uint8Array | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return value;
  return null;
}

export const MANIFEST_FINALITIES = ['final', 'partial', 'superseded'] as const;
export type ManifestFinality = (typeof MANIFEST_FINALITIES)[number];

export const REPROCESSING_STATUSES = ['local', 'remote_reacquirable', 'unavailable'] as const;
export type ReprocessingStatus = (typeof REPROCESSING_STATUSES)[number];

export const DISCOVERY_COMPLETENESS = ['complete', 'partial', 'unsupported', 'unknown'] as const;
export type DiscoveryCompleteness = (typeof DISCOVERY_COMPLETENESS)[number];

export const TEMPORAL_ROLES = ['pre_session', 'runtime', 'post_session', 'capture_only'] as const;
export type TemporalRole = (typeof TEMPORAL_ROLES)[number];

export const ARTIFACT_SCOPES = ['session', 'workspace', 'global', 'runtime'] as const;
export type ArtifactScope = (typeof ARTIFACT_SCOPES)[number];

export const ARTIFACT_STATUSES = ['uploaded', 'failed', 'skipped', 'pending'] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export const ARTIFACT_COLLECTION_OUTCOMES = [
  'collected',
  'failed',
  'skipped',
  'pending',
  'unsupported',
] as const;
export type ArtifactCollectionOutcome = (typeof ARTIFACT_COLLECTION_OUTCOMES)[number];

export const ARTIFACT_RETENTION_CLASSES = [
  'transcript',
  'subagent',
  'configuration',
  'secret_digest',
  'user_controlled',
  'retained',
  'transient',
] as const;
export type ArtifactRetentionClass = (typeof ARTIFACT_RETENTION_CLASSES)[number];

export const REACQUISITION_STATUSES = ['available', 'unavailable', 'unknown'] as const;
export type ReacquisitionStatus = (typeof REACQUISITION_STATUSES)[number];

export const ARTIFACT_REFERENCE_RELATIONSHIPS = [
  'contains',
  'extracted_from',
  'alias',
  'canonicalized',
] as const;
export type ArtifactReferenceRelationship = (typeof ARTIFACT_REFERENCE_RELATIONSHIPS)[number];

export const CASE_SENSITIVITY = ['sensitive', 'insensitive', 'unknown'] as const;
export type CaseSensitivity = (typeof CASE_SENSITIVITY)[number];

export interface ArtifactDescriptor {
  readonly manifestProjectId: string;
  readonly manifestSessionId: string;
  readonly harness: string;
  readonly harnessVersion: string;
  readonly manifestSchemaVersion: number;
  readonly scope: ArtifactScope;
  readonly relativePath: string;
  readonly sha256: string;
  readonly size: number;
  readonly status: ArtifactStatus;
}

export interface SourceManifest {
  readonly id: string;
  readonly ingestionSourceId: string;
  readonly environmentId: string | null;
  readonly sourceProjectId: string | null;
  readonly sessionId: string | null;
  readonly workspaceId: string | null;
  readonly manifestSchemaVersion: number;
  readonly finality: ManifestFinality;
  readonly occurrenceTime: number | null;
  readonly captureTime: number | null;
  readonly ingestionTime: number | null;
  readonly sequenceNumber: number | null;
  readonly nativeProjectId: string | null;
  readonly nativeSessionId: string | null;
  readonly nativeWorkspaceId: string | null;
  readonly repositoryId: string | null;
  readonly scopeChain: string | null;
  readonly collectorVersion: string | null;
  readonly sanitizationPolicyVersion: string | null;
  readonly syncVersion: string | null;
  readonly pluginVersion: string | null;
  readonly harness: string;
  readonly harnessVersion: string;
  readonly model: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly endReason: string | null;
  readonly transcriptsCaptured: boolean;
  readonly mainTranscriptRelativePath: string | null;
  readonly rawMetadata: string | null;
  readonly manifestHash: string;
  readonly reprocessingStatus: ReprocessingStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertSourceManifestInput {
  readonly id?: string;
  readonly ingestionSourceId: string;
  readonly environmentId?: string | null;
  readonly sourceProjectId?: string | null;
  readonly sessionId?: string | null;
  readonly workspaceId?: string | null;
  readonly manifestSchemaVersion: number;
  readonly finality: ManifestFinality;
  readonly occurrenceTime?: number | null;
  readonly captureTime?: number | null;
  readonly ingestionTime?: number | null;
  readonly sequenceNumber?: number | null;
  readonly nativeProjectId?: string | null;
  readonly nativeSessionId?: string | null;
  readonly nativeWorkspaceId?: string | null;
  readonly repositoryId?: string | null;
  readonly scopeChain?: string | null;
  readonly collectorVersion?: string | null;
  readonly sanitizationPolicyVersion?: string | null;
  readonly syncVersion?: string | null;
  readonly pluginVersion?: string | null;
  readonly harness: string;
  readonly harnessVersion: string;
  readonly model?: string | null;
  readonly startedAt?: string | null;
  readonly endedAt?: string | null;
  readonly durationMs?: number | null;
  readonly endReason?: string | null;
  readonly transcriptsCaptured?: boolean;
  readonly mainTranscriptRelativePath?: string | null;
  readonly rawMetadata?: string | null;
  readonly manifestHash: string;
  readonly reprocessingStatus?: ReprocessingStatus;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

export interface ManifestCoverage {
  readonly id: string;
  readonly sourceManifestId: string;
  readonly category: string;
  readonly isExpected: boolean;
  readonly discoveryCompleteness: DiscoveryCompleteness;
  readonly temporalRole: TemporalRole | null;
  readonly authority: string | null;
  readonly failureReason: string | null;
  readonly exclusionReason: string | null;
  readonly createdAt: number;
}

export interface InsertManifestCoverageInput {
  readonly id?: string;
  readonly sourceManifestId: string;
  readonly category: string;
  readonly isExpected?: boolean;
  readonly discoveryCompleteness: DiscoveryCompleteness;
  readonly temporalRole?: TemporalRole | null;
  readonly authority?: string | null;
  readonly failureReason?: string | null;
  readonly exclusionReason?: string | null;
  readonly createdAt?: number;
}

export interface ManifestArtifact extends ArtifactDescriptor {
  readonly id: string;
  readonly sourceManifestId: string;
  readonly role: string | null;
  readonly mediaType: string | null;
  readonly encoding: string | null;
  readonly collectionOutcome: ArtifactCollectionOutcome | null;
  readonly collectionReason: string | null;
  readonly remoteSourceReference: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertManifestArtifactInput extends ArtifactDescriptor {
  readonly sourceManifestId: string;
  readonly id?: string;
  readonly role?: string | null;
  readonly mediaType?: string | null;
  readonly encoding?: string | null;
  readonly collectionOutcome?: ArtifactCollectionOutcome | null;
  readonly collectionReason?: string | null;
  readonly remoteSourceReference?: string | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

export interface ArtifactBlob {
  readonly sha256: string;
  readonly mediaType: string | null;
  readonly retentionClass: ArtifactRetentionClass;
  readonly content: Uint8Array | null;
  readonly size: number;
  readonly redactionScheme: string | null;
  readonly keyDomainId: string | null;
  readonly sensitiveDigest: string | null;
  readonly redactionChangeMarker: number;
  readonly isRedacted: boolean;
  readonly verifiedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertArtifactBlobInput {
  readonly sha256: string;
  readonly mediaType?: string | null;
  readonly retentionClass: ArtifactRetentionClass;
  readonly content?: Uint8Array | null;
  readonly size: number;
  readonly redactionScheme?: string | null;
  readonly keyDomainId?: string | null;
  readonly sensitiveDigest?: string | null;
  readonly redactionChangeMarker?: boolean;
  readonly isRedacted?: boolean;
  readonly verifiedAt?: number | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

export interface ArtifactReference {
  readonly id: string;
  readonly sourceManifestId: string;
  readonly manifestArtifactId: string;
  readonly blobSha256: string | null;
  readonly observingSessionId: string | null;
  readonly componentKind: string | null;
  readonly componentId: string | null;
  readonly componentVersion: string | null;
  readonly sourcePointer: string | null;
  readonly rawSha256: string | null;
  readonly normalizedSha256: string | null;
  readonly behaviorSha256: string | null;
  readonly canonicalizationVersion: string | null;
  readonly classifierVersion: string | null;
  readonly rulesApplied: string | null;
  readonly caseSensitivity: CaseSensitivity | null;
  readonly relationship: ArtifactReferenceRelationship;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertArtifactReferenceInput {
  readonly id?: string;
  readonly sourceManifestId: string;
  readonly manifestArtifactId: string;
  readonly blobSha256?: string | null;
  readonly observingSessionId?: string | null;
  readonly componentKind?: string | null;
  readonly componentId?: string | null;
  readonly componentVersion?: string | null;
  readonly sourcePointer?: string | null;
  readonly rawSha256?: string | null;
  readonly normalizedSha256?: string | null;
  readonly behaviorSha256?: string | null;
  readonly canonicalizationVersion?: string | null;
  readonly classifierVersion?: string | null;
  readonly rulesApplied?: string | null;
  readonly caseSensitivity?: CaseSensitivity | null;
  readonly relationship?: ArtifactReferenceRelationship;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

export interface SourceLocation {
  readonly id: string;
  readonly ingestionSourceId: string;
  readonly sourceManifestId: string | null;
  readonly manifestArtifactId: string | null;
  readonly blobSha256: string | null;
  readonly locationType: string;
  readonly safePath: string;
  readonly retrievalHints: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly contentLength: number | null;
  readonly reacquisitionStatus: ReacquisitionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertSourceLocationInput {
  readonly id?: string;
  readonly ingestionSourceId: string;
  readonly sourceManifestId?: string | null;
  readonly manifestArtifactId?: string | null;
  readonly blobSha256?: string | null;
  readonly locationType: string;
  readonly safePath: string;
  readonly retrievalHints?: string | null;
  readonly etag?: string | null;
  readonly lastModified?: string | null;
  readonly contentLength?: number | null;
  readonly reacquisitionStatus?: ReacquisitionStatus;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

export interface RetentionPolicy {
  readonly id: string;
  readonly portfolioId: string | null;
  readonly environmentId: string | null;
  readonly projectId: string | null;
  readonly retentionClass: ArtifactRetentionClass;
  readonly mediaTypePattern: string | null;
  readonly retainForSeconds: number | null;
  readonly keepMinimum: number;
  readonly allowAutoPurge: boolean;
  readonly privacyErasureAction: string | null;
  readonly policyMetadata: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertRetentionPolicyInput {
  readonly id?: string;
  readonly portfolioId?: string | null;
  readonly environmentId?: string | null;
  readonly projectId?: string | null;
  readonly retentionClass: ArtifactRetentionClass;
  readonly mediaTypePattern?: string | null;
  readonly retainForSeconds?: number | null;
  readonly keepMinimum?: number;
  readonly allowAutoPurge?: boolean;
  readonly privacyErasureAction?: string | null;
  readonly policyMetadata?: string | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

export interface SourceTombstone {
  readonly id: string;
  readonly ingestionSourceId: string;
  readonly environmentId: string | null;
  readonly sourceProjectId: string | null;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly deletedAt: number;
  readonly reason: string | null;
  readonly tombstoneAuthority: string;
  readonly createdAt: number;
}

export interface InsertSourceTombstoneInput {
  readonly id?: string;
  readonly ingestionSourceId: string;
  readonly environmentId?: string | null;
  readonly sourceProjectId?: string | null;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly deletedAt?: number;
  readonly reason?: string | null;
  readonly tombstoneAuthority: string;
  readonly createdAt?: number;
}

export function deterministicSourceManifestId(
  ingestionSourceId: string,
  nativeId: string,
  sequenceNumber: number,
): string {
  return `sm-${deterministicId('source-manifest', ingestionSourceId, nativeId, String(sequenceNumber))}`;
}

export function deterministicManifestCoverageId(
  sourceManifestId: string,
  category: string,
): string {
  return `mc-${deterministicId('manifest-coverage', sourceManifestId, category)}`;
}

export function deterministicManifestArtifactId(
  sourceManifestId: string,
  scope: string,
  relativePath: string,
): string {
  return `ma-${deterministicId('manifest-artifact', sourceManifestId, scope, relativePath)}`;
}

export function deterministicArtifactReferenceId(
  manifestArtifactId: string,
  componentId: string,
  blobSha256: string,
): string {
  return `ar-${deterministicId('artifact-reference', manifestArtifactId, componentId, blobSha256)}`;
}

export function deterministicSourceLocationId(
  ingestionSourceId: string,
  blobSha256: string,
  safePath: string,
): string {
  return `sl-${deterministicId('source-location', ingestionSourceId, blobSha256, safePath)}`;
}

export function deterministicRetentionPolicyId(
  scopeType: string,
  scopeId: string,
  retentionClass: string,
  mediaTypePattern: string,
): string {
  return `rp-${deterministicId('retention-policy', scopeType, scopeId, retentionClass, mediaTypePattern)}`;
}

export function deterministicSourceTombstoneId(
  ingestionSourceId: string,
  sourceType: string,
  sourceId: string,
): string {
  return `st-${deterministicId('source-tombstone', ingestionSourceId, sourceType, sourceId)}`;
}

export const CREATE_SOURCE_MANIFESTS_TABLE = `
CREATE TABLE IF NOT EXISTS source_manifests (
  id TEXT PRIMARY KEY,
  ingestion_source_id TEXT NOT NULL,
  environment_id TEXT,
  source_project_id TEXT,
  session_id TEXT,
  workspace_id TEXT,
  manifest_schema_version INTEGER NOT NULL,
  finality TEXT NOT NULL CHECK(finality IN ('final', 'partial', 'superseded')),
  occurrence_time INTEGER,
  capture_time INTEGER,
  ingestion_time INTEGER,
  sequence_number INTEGER,
  native_project_id TEXT,
  native_session_id TEXT,
  native_workspace_id TEXT,
  repository_id TEXT,
  scope_chain TEXT,
  collector_version TEXT,
  sanitization_policy_version TEXT,
  sync_version TEXT,
  plugin_version TEXT,
  harness TEXT NOT NULL,
  harness_version TEXT NOT NULL,
  model TEXT,
  started_at TEXT,
  ended_at TEXT,
  duration_ms INTEGER,
  end_reason TEXT,
  transcripts_captured INTEGER NOT NULL DEFAULT 0,
  main_transcript_relative_path TEXT,
  raw_metadata TEXT,
  manifest_hash TEXT NOT NULL,
  reprocessing_status TEXT NOT NULL DEFAULT 'local'
    CHECK(reprocessing_status IN ('local', 'remote_reacquirable', 'unavailable')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (ingestion_source_id) REFERENCES ingestion_sources(id) ON DELETE CASCADE,
  FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE SET NULL,
  FOREIGN KEY (source_project_id) REFERENCES source_projects(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_source_manifests_ingestion
  ON source_manifests(ingestion_source_id);

CREATE INDEX IF NOT EXISTS idx_source_manifests_environment
  ON source_manifests(environment_id);

CREATE INDEX IF NOT EXISTS idx_source_manifests_project
  ON source_manifests(source_project_id);

CREATE INDEX IF NOT EXISTS idx_source_manifests_session
  ON source_manifests(session_id);

CREATE INDEX IF NOT EXISTS idx_source_manifests_finality
  ON source_manifests(finality);

CREATE INDEX IF NOT EXISTS idx_source_manifests_capture
  ON source_manifests(capture_time);
`;

export const CREATE_MANIFEST_COVERAGE_TABLE = `
CREATE TABLE IF NOT EXISTS manifest_coverage (
  id TEXT PRIMARY KEY,
  source_manifest_id TEXT NOT NULL,
  category TEXT NOT NULL,
  is_expected INTEGER NOT NULL DEFAULT 1,
  discovery_completeness TEXT NOT NULL
    CHECK(discovery_completeness IN ('complete', 'partial', 'unsupported', 'unknown')),
  temporal_role TEXT CHECK(temporal_role IN ('pre_session', 'runtime', 'post_session', 'capture_only')),
  authority TEXT,
  failure_reason TEXT,
  exclusion_reason TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (source_manifest_id) REFERENCES source_manifests(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_manifest_coverage_manifest
  ON manifest_coverage(source_manifest_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_manifest_coverage_manifest_category
  ON manifest_coverage(source_manifest_id, category);
`;

export const CREATE_MANIFEST_ARTIFACTS_TABLE = `
CREATE TABLE IF NOT EXISTS manifest_artifacts (
  id TEXT PRIMARY KEY,
  source_manifest_id TEXT NOT NULL,
  manifest_project_id TEXT NOT NULL,
  manifest_session_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  harness_version TEXT NOT NULL,
  manifest_schema_version INTEGER NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('session', 'workspace', 'global', 'runtime')),
  relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('uploaded', 'failed', 'skipped', 'pending')),
  role TEXT,
  media_type TEXT,
  encoding TEXT,
  collection_outcome TEXT CHECK(collection_outcome IN ('collected', 'failed', 'skipped', 'pending', 'unsupported')),
  collection_reason TEXT,
  remote_source_reference TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (source_manifest_id) REFERENCES source_manifests(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_manifest_artifacts_manifest
  ON manifest_artifacts(source_manifest_id);

CREATE INDEX IF NOT EXISTS idx_manifest_artifacts_hash
  ON manifest_artifacts(sha256);

CREATE UNIQUE INDEX IF NOT EXISTS idx_manifest_artifacts_manifest_scope_path
  ON manifest_artifacts(source_manifest_id, scope, relative_path);
`;

export const CREATE_ARTIFACT_BLOBS_TABLE = `
CREATE TABLE IF NOT EXISTS artifact_blobs (
  sha256 TEXT PRIMARY KEY,
  media_type TEXT,
  retention_class TEXT NOT NULL
    CHECK(retention_class IN ('transcript', 'subagent', 'configuration', 'secret_digest', 'user_controlled', 'retained', 'transient')),
  content BLOB,
  size INTEGER NOT NULL,
  redaction_scheme TEXT,
  key_domain_id TEXT,
  sensitive_digest TEXT,
  redaction_change_marker INTEGER NOT NULL DEFAULT 0,
  is_redacted INTEGER NOT NULL DEFAULT 0,
  verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_artifact_blobs_retention_class
  ON artifact_blobs(retention_class);

CREATE INDEX IF NOT EXISTS idx_artifact_blobs_key_domain
  ON artifact_blobs(key_domain_id);
`;

export const CREATE_ARTIFACT_REFERENCES_TABLE = `
CREATE TABLE IF NOT EXISTS artifact_references (
  id TEXT PRIMARY KEY,
  source_manifest_id TEXT NOT NULL,
  manifest_artifact_id TEXT NOT NULL,
  blob_sha256 TEXT,
  observing_session_id TEXT,
  component_kind TEXT,
  component_id TEXT,
  component_version TEXT,
  source_pointer TEXT,
  raw_sha256 TEXT,
  normalized_sha256 TEXT,
  behavior_sha256 TEXT,
  canonicalization_version TEXT,
  classifier_version TEXT,
  rules_applied TEXT,
  case_sensitivity TEXT,
  relationship TEXT NOT NULL DEFAULT 'contains'
    CHECK(relationship IN ('contains', 'extracted_from', 'alias', 'canonicalized')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (source_manifest_id) REFERENCES source_manifests(id) ON DELETE CASCADE,
  FOREIGN KEY (manifest_artifact_id) REFERENCES manifest_artifacts(id) ON DELETE CASCADE,
  FOREIGN KEY (blob_sha256) REFERENCES artifact_blobs(sha256) ON DELETE SET NULL,
  FOREIGN KEY (observing_session_id) REFERENCES sessions(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_artifact_references_manifest
  ON artifact_references(source_manifest_id);

CREATE INDEX IF NOT EXISTS idx_artifact_references_artifact
  ON artifact_references(manifest_artifact_id);

CREATE INDEX IF NOT EXISTS idx_artifact_references_blob
  ON artifact_references(blob_sha256);

CREATE INDEX IF NOT EXISTS idx_artifact_references_component
  ON artifact_references(component_id, component_version);
`;

export const CREATE_SOURCE_LOCATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS source_locations (
  id TEXT PRIMARY KEY,
  ingestion_source_id TEXT NOT NULL,
  source_manifest_id TEXT,
  manifest_artifact_id TEXT,
  blob_sha256 TEXT,
  location_type TEXT NOT NULL,
  safe_path TEXT NOT NULL,
  retrieval_hints TEXT,
  etag TEXT,
  last_modified TEXT,
  content_length INTEGER,
  reacquisition_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK(reacquisition_status IN ('available', 'unavailable', 'unknown')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (ingestion_source_id) REFERENCES ingestion_sources(id) ON DELETE CASCADE,
  FOREIGN KEY (source_manifest_id) REFERENCES source_manifests(id) ON DELETE SET NULL,
  FOREIGN KEY (manifest_artifact_id) REFERENCES manifest_artifacts(id) ON DELETE SET NULL,
  FOREIGN KEY (blob_sha256) REFERENCES artifact_blobs(sha256) ON DELETE SET NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_source_locations_ingestion
  ON source_locations(ingestion_source_id);

CREATE INDEX IF NOT EXISTS idx_source_locations_blob
  ON source_locations(blob_sha256);

CREATE INDEX IF NOT EXISTS idx_source_locations_manifest
  ON source_locations(source_manifest_id);
`;

export const CREATE_RETENTION_POLICIES_TABLE = `
CREATE TABLE IF NOT EXISTS retention_policies (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT,
  environment_id TEXT,
  project_id TEXT,
  retention_class TEXT NOT NULL
    CHECK(retention_class IN ('transcript', 'subagent', 'configuration', 'secret_digest', 'user_controlled', 'retained', 'transient')),
  media_type_pattern TEXT,
  retain_for_seconds INTEGER,
  keep_minimum INTEGER NOT NULL DEFAULT 0,
  allow_auto_purge INTEGER NOT NULL DEFAULT 0,
  privacy_erasure_action TEXT,
  policy_metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE,
  FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CHECK (
    (portfolio_id IS NOT NULL) + (environment_id IS NOT NULL) + (project_id IS NOT NULL) = 1
  )
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_retention_policies_portfolio_class
  ON retention_policies(portfolio_id, retention_class, media_type_pattern)
  WHERE portfolio_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_retention_policies_environment_class
  ON retention_policies(environment_id, retention_class, media_type_pattern)
  WHERE environment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_retention_policies_project_class
  ON retention_policies(project_id, retention_class, media_type_pattern)
  WHERE project_id IS NOT NULL;
`;

export const CREATE_SOURCE_TOMBSTONES_TABLE = `
CREATE TABLE IF NOT EXISTS source_tombstones (
  id TEXT PRIMARY KEY,
  ingestion_source_id TEXT NOT NULL,
  environment_id TEXT,
  source_project_id TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  reason TEXT,
  tombstone_authority TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (ingestion_source_id) REFERENCES ingestion_sources(id) ON DELETE CASCADE,
  FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE SET NULL,
  FOREIGN KEY (source_project_id) REFERENCES source_projects(id) ON DELETE CASCADE,
  UNIQUE(ingestion_source_id, source_type, source_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_source_tombstones_ingestion
  ON source_tombstones(ingestion_source_id);

CREATE INDEX IF NOT EXISTS idx_source_tombstones_source
  ON source_tombstones(ingestion_source_id, source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_source_tombstones_deleted
  ON source_tombstones(deleted_at);
`;

export const MANIFEST_MIGRATIONS_FRAGMENT: readonly Migration[] = [
  {
    id: 15,
    name: 'create-source-manifests',
    sql: CREATE_SOURCE_MANIFESTS_TABLE,
    checksum: checksumOf(CREATE_SOURCE_MANIFESTS_TABLE),
  },
  {
    id: 16,
    name: 'create-manifest-coverage',
    sql: CREATE_MANIFEST_COVERAGE_TABLE,
    checksum: checksumOf(CREATE_MANIFEST_COVERAGE_TABLE),
  },
  {
    id: 17,
    name: 'create-manifest-artifacts',
    sql: CREATE_MANIFEST_ARTIFACTS_TABLE,
    checksum: checksumOf(CREATE_MANIFEST_ARTIFACTS_TABLE),
  },
  {
    id: 18,
    name: 'create-artifact-blobs',
    sql: CREATE_ARTIFACT_BLOBS_TABLE,
    checksum: checksumOf(CREATE_ARTIFACT_BLOBS_TABLE),
  },
  {
    id: 19,
    name: 'create-artifact-references',
    sql: CREATE_ARTIFACT_REFERENCES_TABLE,
    checksum: checksumOf(CREATE_ARTIFACT_REFERENCES_TABLE),
  },
  {
    id: 20,
    name: 'create-source-locations',
    sql: CREATE_SOURCE_LOCATIONS_TABLE,
    checksum: checksumOf(CREATE_SOURCE_LOCATIONS_TABLE),
  },
  {
    id: 21,
    name: 'create-retention-policies',
    sql: CREATE_RETENTION_POLICIES_TABLE,
    checksum: checksumOf(CREATE_RETENTION_POLICIES_TABLE),
  },
  {
    id: 22,
    name: 'create-source-tombstones',
    sql: CREATE_SOURCE_TOMBSTONES_TABLE,
    checksum: checksumOf(CREATE_SOURCE_TOMBSTONES_TABLE),
  },
];

// biome-ignore lint/complexity/noStaticOnlyClass: typed manifest store
export class SourceManifestStore {
  static async insert(
    queryable: Queryable,
    portfolioId: string,
    input: InsertSourceManifestInput,
  ): Promise<string> {
    const now = Date.now();
    const nativeId = input.nativeSessionId || input.nativeProjectId || 'inventory';
    const id =
      input.id ??
      deterministicSourceManifestId(input.ingestionSourceId, nativeId, input.sequenceNumber ?? 0);
    const { changes } = await queryable.exec(
      `INSERT INTO source_manifests (
        id, ingestion_source_id, environment_id, source_project_id, session_id, workspace_id,
        manifest_schema_version, finality, occurrence_time, capture_time, ingestion_time, sequence_number,
        native_project_id, native_session_id, native_workspace_id, repository_id, scope_chain,
        collector_version, sanitization_policy_version, sync_version, plugin_version,
        harness, harness_version, model, started_at, ended_at, duration_ms, end_reason,
        transcripts_captured, main_transcript_relative_path, raw_metadata, manifest_hash,
        reprocessing_status, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM ingestion_sources WHERE id = ? AND portfolio_id = ?)`,
      [
        id,
        input.ingestionSourceId,
        input.environmentId ?? null,
        input.sourceProjectId ?? null,
        input.sessionId ?? null,
        input.workspaceId ?? null,
        input.manifestSchemaVersion,
        input.finality,
        input.occurrenceTime ?? null,
        input.captureTime ?? null,
        input.ingestionTime ?? null,
        input.sequenceNumber ?? null,
        input.nativeProjectId ?? null,
        input.nativeSessionId ?? null,
        input.nativeWorkspaceId ?? null,
        input.repositoryId ?? null,
        input.scopeChain ?? null,
        input.collectorVersion ?? null,
        input.sanitizationPolicyVersion ?? null,
        input.syncVersion ?? null,
        input.pluginVersion ?? null,
        input.harness,
        input.harnessVersion,
        input.model ?? null,
        input.startedAt ?? null,
        input.endedAt ?? null,
        input.durationMs ?? null,
        input.endReason ?? null,
        input.transcriptsCaptured ? 1 : 0,
        input.mainTranscriptRelativePath ?? null,
        input.rawMetadata ?? null,
        input.manifestHash,
        input.reprocessingStatus ?? 'local',
        input.createdAt ?? now,
        input.updatedAt ?? now,
        input.ingestionSourceId,
        portfolioId,
      ],
    );
    if (changes === 0) {
      throw new Error(
        `Source manifest not inserted: ingestion source not in portfolio ${portfolioId}`,
      );
    }
    return id;
  }

  static async getById(
    queryable: Queryable,
    portfolioId: string,
    id: string,
  ): Promise<SourceManifest | undefined> {
    const { rows } = await queryable.exec(
      `SELECT m.*
       FROM source_manifests m
       JOIN ingestion_sources src ON src.id = m.ingestion_source_id
       WHERE m.id = ? AND src.portfolio_id = ?`,
      [id, portfolioId],
    );
    if (rows.length === 0) return undefined;
    return SourceManifestStore.rowToSourceManifest(rows[0]);
  }

  static async listByPortfolio(
    queryable: Queryable,
    portfolioId: string,
  ): Promise<readonly SourceManifest[]> {
    const { rows } = await queryable.exec(
      `SELECT m.*
       FROM source_manifests m
       JOIN ingestion_sources src ON src.id = m.ingestion_source_id
       WHERE src.portfolio_id = ?
       ORDER BY m.capture_time, m.id`,
      [portfolioId],
    );
    return rows.map(SourceManifestStore.rowToSourceManifest);
  }

  static async listByIngestionSource(
    queryable: Queryable,
    portfolioId: string,
    ingestionSourceId: string,
  ): Promise<readonly SourceManifest[]> {
    const { rows } = await queryable.exec(
      `SELECT m.*
       FROM source_manifests m
       JOIN ingestion_sources src ON src.id = m.ingestion_source_id
       WHERE m.ingestion_source_id = ? AND src.portfolio_id = ?
       ORDER BY m.sequence_number, m.capture_time, m.id`,
      [ingestionSourceId, portfolioId],
    );
    return rows.map(SourceManifestStore.rowToSourceManifest);
  }

  static async updateFinality(
    queryable: Queryable,
    portfolioId: string,
    id: string,
    finality: ManifestFinality,
    reprocessingStatus?: ReprocessingStatus,
  ): Promise<void> {
    await queryable.exec(
      `UPDATE source_manifests
       SET finality = ?, reprocessing_status = COALESCE(?, reprocessing_status), updated_at = ?
       WHERE id = ?
         AND EXISTS (
           SELECT 1 FROM ingestion_sources
           WHERE id = source_manifests.ingestion_source_id AND portfolio_id = ?
         )`,
      [finality, reprocessingStatus ?? null, Date.now(), id, portfolioId],
    );
  }

  private static rowToSourceManifest(row: SqliteRow): SourceManifest {
    return {
      id: asString(row.id),
      ingestionSourceId: asString(row.ingestion_source_id),
      environmentId: toOptionalString(row.environment_id),
      sourceProjectId: toOptionalString(row.source_project_id),
      sessionId: toOptionalString(row.session_id),
      workspaceId: toOptionalString(row.workspace_id),
      manifestSchemaVersion: toNumber(row.manifest_schema_version),
      finality: asString(row.finality) as ManifestFinality,
      occurrenceTime: toOptionalNumber(row.occurrence_time),
      captureTime: toOptionalNumber(row.capture_time),
      ingestionTime: toOptionalNumber(row.ingestion_time),
      sequenceNumber: toOptionalNumber(row.sequence_number),
      nativeProjectId: toOptionalString(row.native_project_id),
      nativeSessionId: toOptionalString(row.native_session_id),
      nativeWorkspaceId: toOptionalString(row.native_workspace_id),
      repositoryId: toOptionalString(row.repository_id),
      scopeChain: toOptionalString(row.scope_chain),
      collectorVersion: toOptionalString(row.collector_version),
      sanitizationPolicyVersion: toOptionalString(row.sanitization_policy_version),
      syncVersion: toOptionalString(row.sync_version),
      pluginVersion: toOptionalString(row.plugin_version),
      harness: asString(row.harness),
      harnessVersion: asString(row.harness_version),
      model: toOptionalString(row.model),
      startedAt: toOptionalString(row.started_at),
      endedAt: toOptionalString(row.ended_at),
      durationMs: toOptionalNumber(row.duration_ms),
      endReason: toOptionalString(row.end_reason),
      transcriptsCaptured: toBoolean(row.transcripts_captured),
      mainTranscriptRelativePath: toOptionalString(row.main_transcript_relative_path),
      rawMetadata: toOptionalString(row.raw_metadata),
      manifestHash: asString(row.manifest_hash),
      reprocessingStatus: asString(row.reprocessing_status) as ReprocessingStatus,
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed manifest store
export class ManifestCoverageStore {
  static async insert(
    queryable: Queryable,
    portfolioId: string,
    input: InsertManifestCoverageInput,
  ): Promise<string> {
    const now = Date.now();
    const id = input.id ?? deterministicManifestCoverageId(input.sourceManifestId, input.category);
    const { changes } = await queryable.exec(
      `INSERT INTO manifest_coverage (
        id, source_manifest_id, category, is_expected, discovery_completeness,
        temporal_role, authority, failure_reason, exclusion_reason, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM source_manifests m
        JOIN ingestion_sources src ON src.id = m.ingestion_source_id
        WHERE m.id = ? AND src.portfolio_id = ?
      )`,
      [
        id,
        input.sourceManifestId,
        input.category,
        input.isExpected ? 1 : 0,
        input.discoveryCompleteness,
        input.temporalRole ?? null,
        input.authority ?? null,
        input.failureReason ?? null,
        input.exclusionReason ?? null,
        input.createdAt ?? now,
        input.sourceManifestId,
        portfolioId,
      ],
    );
    if (changes === 0) {
      throw new Error(`Manifest coverage not inserted: manifest not in portfolio ${portfolioId}`);
    }
    return id;
  }

  static async listByManifest(
    queryable: Queryable,
    portfolioId: string,
    sourceManifestId: string,
  ): Promise<readonly ManifestCoverage[]> {
    const { rows } = await queryable.exec(
      `SELECT c.*
       FROM manifest_coverage c
       JOIN source_manifests m ON m.id = c.source_manifest_id
       JOIN ingestion_sources src ON src.id = m.ingestion_source_id
       WHERE c.source_manifest_id = ? AND src.portfolio_id = ?
       ORDER BY c.category`,
      [sourceManifestId, portfolioId],
    );
    return rows.map(ManifestCoverageStore.rowToManifestCoverage);
  }

  private static rowToManifestCoverage(row: SqliteRow): ManifestCoverage {
    return {
      id: asString(row.id),
      sourceManifestId: asString(row.source_manifest_id),
      category: asString(row.category),
      isExpected: toBoolean(row.is_expected),
      discoveryCompleteness: asString(row.discovery_completeness) as DiscoveryCompleteness,
      temporalRole: toOptionalString(row.temporal_role) as TemporalRole | null,
      authority: toOptionalString(row.authority),
      failureReason: toOptionalString(row.failure_reason),
      exclusionReason: toOptionalString(row.exclusion_reason),
      createdAt: toNumber(row.created_at),
    };
  }
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed manifest store
export class ManifestArtifactStore {
  static async insert(
    queryable: Queryable,
    portfolioId: string,
    input: InsertManifestArtifactInput,
  ): Promise<string> {
    const now = Date.now();
    const id =
      input.id ??
      deterministicManifestArtifactId(input.sourceManifestId, input.scope, input.relativePath);
    const { changes } = await queryable.exec(
      `INSERT INTO manifest_artifacts (
        id, source_manifest_id, manifest_project_id, manifest_session_id, harness, harness_version,
        manifest_schema_version, scope, relative_path, sha256, size, status,
        role, media_type, encoding, collection_outcome, collection_reason, remote_source_reference,
        created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM source_manifests m
        JOIN ingestion_sources src ON src.id = m.ingestion_source_id
        WHERE m.id = ? AND src.portfolio_id = ?
      )`,
      [
        id,
        input.sourceManifestId,
        input.manifestProjectId,
        input.manifestSessionId,
        input.harness,
        input.harnessVersion,
        input.manifestSchemaVersion,
        input.scope,
        input.relativePath,
        input.sha256,
        input.size,
        input.status,
        input.role ?? null,
        input.mediaType ?? null,
        input.encoding ?? null,
        input.collectionOutcome ?? null,
        input.collectionReason ?? null,
        input.remoteSourceReference ?? null,
        input.createdAt ?? now,
        input.updatedAt ?? now,
        input.sourceManifestId,
        portfolioId,
      ],
    );
    if (changes === 0) {
      throw new Error(`Manifest artifact not inserted: manifest not in portfolio ${portfolioId}`);
    }
    return id;
  }

  static async getById(
    queryable: Queryable,
    portfolioId: string,
    id: string,
  ): Promise<ManifestArtifact | undefined> {
    const { rows } = await queryable.exec(
      `SELECT a.*
       FROM manifest_artifacts a
       JOIN source_manifests m ON m.id = a.source_manifest_id
       JOIN ingestion_sources src ON src.id = m.ingestion_source_id
       WHERE a.id = ? AND src.portfolio_id = ?`,
      [id, portfolioId],
    );
    if (rows.length === 0) return undefined;
    return ManifestArtifactStore.rowToManifestArtifact(rows[0]);
  }

  static async listByManifest(
    queryable: Queryable,
    portfolioId: string,
    sourceManifestId: string,
  ): Promise<readonly ManifestArtifact[]> {
    const { rows } = await queryable.exec(
      `SELECT a.*
       FROM manifest_artifacts a
       JOIN source_manifests m ON m.id = a.source_manifest_id
       JOIN ingestion_sources src ON src.id = m.ingestion_source_id
       WHERE a.source_manifest_id = ? AND src.portfolio_id = ?
       ORDER BY a.relative_path`,
      [sourceManifestId, portfolioId],
    );
    return rows.map(ManifestArtifactStore.rowToManifestArtifact);
  }

  static async verifyBlobHash(
    queryable: Queryable,
    portfolioId: string,
    manifestArtifactId: string,
    blobSha256: string,
  ): Promise<boolean> {
    const { rows } = await queryable.exec(
      `SELECT 1
       FROM manifest_artifacts a
       JOIN source_manifests m ON m.id = a.source_manifest_id
       JOIN ingestion_sources src ON src.id = m.ingestion_source_id
       JOIN artifact_blobs b ON b.sha256 = a.sha256
       WHERE a.id = ? AND a.sha256 = ? AND src.portfolio_id = ?`,
      [manifestArtifactId, blobSha256, portfolioId],
    );
    return rows.length > 0;
  }

  private static rowToManifestArtifact(row: SqliteRow): ManifestArtifact {
    return {
      id: asString(row.id),
      sourceManifestId: asString(row.source_manifest_id),
      manifestProjectId: asString(row.manifest_project_id),
      manifestSessionId: asString(row.manifest_session_id),
      harness: asString(row.harness),
      harnessVersion: asString(row.harness_version),
      manifestSchemaVersion: toNumber(row.manifest_schema_version),
      scope: asString(row.scope) as ArtifactScope,
      relativePath: asString(row.relative_path),
      sha256: asString(row.sha256),
      size: toNumber(row.size),
      status: asString(row.status) as ArtifactStatus,
      role: toOptionalString(row.role),
      mediaType: toOptionalString(row.media_type),
      encoding: toOptionalString(row.encoding),
      collectionOutcome: toOptionalString(
        row.collection_outcome,
      ) as ArtifactCollectionOutcome | null,
      collectionReason: toOptionalString(row.collection_reason),
      remoteSourceReference: toOptionalString(row.remote_source_reference),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed manifest store
export class ArtifactBlobStore {
  static async insert(queryable: Queryable, input: InsertArtifactBlobInput): Promise<void> {
    const now = Date.now();
    await queryable.exec(
      `INSERT INTO artifact_blobs (
        sha256, media_type, retention_class, content, size, redaction_scheme, key_domain_id,
        sensitive_digest, redaction_change_marker, is_redacted, verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.sha256,
        input.mediaType ?? null,
        input.retentionClass,
        input.content ?? null,
        input.size,
        input.redactionScheme ?? null,
        input.keyDomainId ?? null,
        input.sensitiveDigest ?? null,
        input.redactionChangeMarker ? 1 : 0,
        input.isRedacted ? 1 : 0,
        input.verifiedAt ?? null,
        input.createdAt ?? now,
        input.updatedAt ?? now,
      ],
    );
  }

  static async getBySha256(
    queryable: Queryable,
    sha256: string,
  ): Promise<ArtifactBlob | undefined> {
    const { rows } = await queryable.exec(
      `SELECT sha256, media_type, retention_class, content, size, redaction_scheme, key_domain_id,
              sensitive_digest, redaction_change_marker, is_redacted, verified_at, created_at, updated_at
       FROM artifact_blobs WHERE sha256 = ?`,
      [sha256],
    );
    if (rows.length === 0) return undefined;
    return ArtifactBlobStore.rowToArtifactBlob(rows[0]);
  }

  static async listByRetentionClass(
    queryable: Queryable,
    retentionClass: ArtifactRetentionClass,
  ): Promise<readonly ArtifactBlob[]> {
    const { rows } = await queryable.exec(
      `SELECT sha256, media_type, retention_class, content, size, redaction_scheme, key_domain_id,
              sensitive_digest, redaction_change_marker, is_redacted, verified_at, created_at, updated_at
       FROM artifact_blobs WHERE retention_class = ? ORDER BY created_at`,
      [retentionClass],
    );
    return rows.map(ArtifactBlobStore.rowToArtifactBlob);
  }

  static async verify(
    queryable: Queryable,
    sha256: string,
    expectedSize: number,
  ): Promise<boolean> {
    const { rows } = await queryable.exec(
      'SELECT 1 FROM artifact_blobs WHERE sha256 = ? AND size = ?',
      [sha256, expectedSize],
    );
    return rows.length > 0;
  }

  private static rowToArtifactBlob(row: SqliteRow): ArtifactBlob {
    return {
      sha256: asString(row.sha256),
      mediaType: toOptionalString(row.media_type),
      retentionClass: asString(row.retention_class) as ArtifactRetentionClass,
      content: toBlob(row.content),
      size: toNumber(row.size),
      redactionScheme: toOptionalString(row.redaction_scheme),
      keyDomainId: toOptionalString(row.key_domain_id),
      sensitiveDigest: toOptionalString(row.sensitive_digest),
      redactionChangeMarker: toNumber(row.redaction_change_marker),
      isRedacted: toBoolean(row.is_redacted),
      verifiedAt: toOptionalNumber(row.verified_at),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed manifest store
export class ArtifactReferenceStore {
  static async insert(
    queryable: Queryable,
    portfolioId: string,
    input: InsertArtifactReferenceInput,
  ): Promise<string> {
    const now = Date.now();
    const componentId = input.componentId ?? '';
    const blobSha256 = input.blobSha256 ?? '';
    const id =
      input.id ??
      deterministicArtifactReferenceId(input.manifestArtifactId, componentId, blobSha256);
    const { changes } = await queryable.exec(
      `INSERT INTO artifact_references (
        id, source_manifest_id, manifest_artifact_id, blob_sha256, observing_session_id,
        component_kind, component_id, component_version, source_pointer,
        raw_sha256, normalized_sha256, behavior_sha256, canonicalization_version,
        classifier_version, rules_applied, case_sensitivity, relationship, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM manifest_artifacts a
        JOIN source_manifests m ON m.id = a.source_manifest_id
        JOIN ingestion_sources src ON src.id = m.ingestion_source_id
        WHERE a.id = ? AND a.source_manifest_id = ? AND src.portfolio_id = ?
      )`,
      [
        id,
        input.sourceManifestId,
        input.manifestArtifactId,
        input.blobSha256 ?? null,
        input.observingSessionId ?? null,
        input.componentKind ?? null,
        input.componentId ?? null,
        input.componentVersion ?? null,
        input.sourcePointer ?? null,
        input.rawSha256 ?? null,
        input.normalizedSha256 ?? null,
        input.behaviorSha256 ?? null,
        input.canonicalizationVersion ?? null,
        input.classifierVersion ?? null,
        input.rulesApplied ?? null,
        input.caseSensitivity ?? null,
        input.relationship ?? 'contains',
        input.createdAt ?? now,
        input.updatedAt ?? now,
        input.manifestArtifactId,
        input.sourceManifestId,
        portfolioId,
      ],
    );
    if (changes === 0) {
      throw new Error(`Artifact reference not inserted: artifact not in portfolio ${portfolioId}`);
    }
    return id;
  }

  static async getById(
    queryable: Queryable,
    portfolioId: string,
    id: string,
  ): Promise<ArtifactReference | undefined> {
    const { rows } = await queryable.exec(
      `SELECT r.*
       FROM artifact_references r
       JOIN manifest_artifacts a ON a.id = r.manifest_artifact_id
       JOIN source_manifests m ON m.id = a.source_manifest_id
       JOIN ingestion_sources src ON src.id = m.ingestion_source_id
       WHERE r.id = ? AND src.portfolio_id = ?`,
      [id, portfolioId],
    );
    if (rows.length === 0) return undefined;
    return ArtifactReferenceStore.rowToArtifactReference(rows[0]);
  }

  static async listByManifestArtifact(
    queryable: Queryable,
    portfolioId: string,
    manifestArtifactId: string,
  ): Promise<readonly ArtifactReference[]> {
    const { rows } = await queryable.exec(
      `SELECT r.*
       FROM artifact_references r
       JOIN manifest_artifacts a ON a.id = r.manifest_artifact_id
       JOIN source_manifests m ON m.id = a.source_manifest_id
       JOIN ingestion_sources src ON src.id = m.ingestion_source_id
       WHERE r.manifest_artifact_id = ? AND src.portfolio_id = ?
       ORDER BY r.id`,
      [manifestArtifactId, portfolioId],
    );
    return rows.map(ArtifactReferenceStore.rowToArtifactReference);
  }

  private static rowToArtifactReference(row: SqliteRow): ArtifactReference {
    return {
      id: asString(row.id),
      sourceManifestId: asString(row.source_manifest_id),
      manifestArtifactId: asString(row.manifest_artifact_id),
      blobSha256: toOptionalString(row.blob_sha256),
      observingSessionId: toOptionalString(row.observing_session_id),
      componentKind: toOptionalString(row.component_kind),
      componentId: toOptionalString(row.component_id),
      componentVersion: toOptionalString(row.component_version),
      sourcePointer: toOptionalString(row.source_pointer),
      rawSha256: toOptionalString(row.raw_sha256),
      normalizedSha256: toOptionalString(row.normalized_sha256),
      behaviorSha256: toOptionalString(row.behavior_sha256),
      canonicalizationVersion: toOptionalString(row.canonicalization_version),
      classifierVersion: toOptionalString(row.classifier_version),
      rulesApplied: toOptionalString(row.rules_applied),
      caseSensitivity: toOptionalString(row.case_sensitivity) as CaseSensitivity | null,
      relationship: asString(row.relationship) as ArtifactReferenceRelationship,
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed manifest store
export class SourceLocationStore {
  static async insert(
    queryable: Queryable,
    portfolioId: string,
    input: InsertSourceLocationInput,
  ): Promise<string> {
    const now = Date.now();
    const id =
      input.id ??
      deterministicSourceLocationId(
        input.ingestionSourceId,
        input.blobSha256 ?? '',
        input.safePath,
      );
    const { changes } = await queryable.exec(
      `INSERT INTO source_locations (
        id, ingestion_source_id, source_manifest_id, manifest_artifact_id, blob_sha256,
        location_type, safe_path, retrieval_hints, etag, last_modified, content_length,
        reacquisition_status, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM ingestion_sources WHERE id = ? AND portfolio_id = ?)`,
      [
        id,
        input.ingestionSourceId,
        input.sourceManifestId ?? null,
        input.manifestArtifactId ?? null,
        input.blobSha256 ?? null,
        input.locationType,
        input.safePath,
        input.retrievalHints ?? null,
        input.etag ?? null,
        input.lastModified ?? null,
        input.contentLength ?? null,
        input.reacquisitionStatus ?? 'unknown',
        input.createdAt ?? now,
        input.updatedAt ?? now,
        input.ingestionSourceId,
        portfolioId,
      ],
    );
    if (changes === 0) {
      throw new Error(
        `Source location not inserted: ingestion source not in portfolio ${portfolioId}`,
      );
    }
    return id;
  }

  static async listByBlob(
    queryable: Queryable,
    portfolioId: string,
    blobSha256: string,
  ): Promise<readonly SourceLocation[]> {
    const { rows } = await queryable.exec(
      `SELECT l.*
       FROM source_locations l
       JOIN ingestion_sources src ON src.id = l.ingestion_source_id
       WHERE l.blob_sha256 = ? AND src.portfolio_id = ?
       ORDER BY l.created_at`,
      [blobSha256, portfolioId],
    );
    return rows.map(SourceLocationStore.rowToSourceLocation);
  }

  private static rowToSourceLocation(row: SqliteRow): SourceLocation {
    return {
      id: asString(row.id),
      ingestionSourceId: asString(row.ingestion_source_id),
      sourceManifestId: toOptionalString(row.source_manifest_id),
      manifestArtifactId: toOptionalString(row.manifest_artifact_id),
      blobSha256: toOptionalString(row.blob_sha256),
      locationType: asString(row.location_type),
      safePath: asString(row.safe_path),
      retrievalHints: toOptionalString(row.retrieval_hints),
      etag: toOptionalString(row.etag),
      lastModified: toOptionalString(row.last_modified),
      contentLength: toOptionalNumber(row.content_length),
      reacquisitionStatus: asString(row.reacquisition_status) as ReacquisitionStatus,
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed manifest store
export class RetentionPolicyStore {
  static async insert(queryable: Queryable, input: InsertRetentionPolicyInput): Promise<string> {
    const now = Date.now();
    const scopeCount =
      (input.portfolioId ? 1 : 0) + (input.environmentId ? 1 : 0) + (input.projectId ? 1 : 0);
    if (scopeCount !== 1) {
      throw new Error(
        'Retention policy requires exactly one of portfolioId, environmentId, or projectId',
      );
    }
    const scopeType = input.projectId
      ? 'project'
      : input.environmentId
        ? 'environment'
        : 'portfolio';
    const scopeId = (input.projectId ?? input.environmentId ?? input.portfolioId) as string;
    const id =
      input.id ??
      deterministicRetentionPolicyId(
        scopeType,
        scopeId,
        input.retentionClass,
        input.mediaTypePattern ?? '',
      );
    await queryable.exec(
      `INSERT INTO retention_policies (
        id, portfolio_id, environment_id, project_id, retention_class, media_type_pattern,
        retain_for_seconds, keep_minimum, allow_auto_purge, privacy_erasure_action,
        policy_metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.portfolioId ?? null,
        input.environmentId ?? null,
        input.projectId ?? null,
        input.retentionClass,
        input.mediaTypePattern ?? null,
        input.retainForSeconds ?? null,
        input.keepMinimum ?? 0,
        input.allowAutoPurge ? 1 : 0,
        input.privacyErasureAction ?? null,
        input.policyMetadata ?? null,
        input.createdAt ?? now,
        input.updatedAt ?? now,
      ],
    );
    return id;
  }

  static async resolvePolicy(
    queryable: Queryable,
    options: {
      readonly retentionClass: ArtifactRetentionClass;
      readonly portfolioId?: string;
      readonly environmentId?: string;
      readonly projectId?: string;
      readonly mediaType?: string | null;
    },
  ): Promise<RetentionPolicy | undefined> {
    const { rows } = await queryable.exec(
      `SELECT id, portfolio_id, environment_id, project_id, retention_class, media_type_pattern,
              retain_for_seconds, keep_minimum, allow_auto_purge, privacy_erasure_action,
              policy_metadata, created_at, updated_at
       FROM retention_policies
       WHERE retention_class = ?
         AND (media_type_pattern IS NULL OR ? LIKE media_type_pattern)
         AND (project_id = ? OR environment_id = ? OR portfolio_id = ?)
       ORDER BY CASE
         WHEN project_id IS NOT NULL THEN 0
         WHEN environment_id IS NOT NULL THEN 1
         ELSE 2
       END
       LIMIT 1`,
      [
        options.retentionClass,
        options.mediaType ?? '',
        options.projectId ?? null,
        options.environmentId ?? null,
        options.portfolioId ?? null,
      ],
    );
    if (rows.length === 0) return undefined;
    return RetentionPolicyStore.rowToRetentionPolicy(rows[0]);
  }

  private static rowToRetentionPolicy(row: SqliteRow): RetentionPolicy {
    return {
      id: asString(row.id),
      portfolioId: toOptionalString(row.portfolio_id),
      environmentId: toOptionalString(row.environment_id),
      projectId: toOptionalString(row.project_id),
      retentionClass: asString(row.retention_class) as ArtifactRetentionClass,
      mediaTypePattern: toOptionalString(row.media_type_pattern),
      retainForSeconds: toOptionalNumber(row.retain_for_seconds),
      keepMinimum: toNumber(row.keep_minimum),
      allowAutoPurge: toBoolean(row.allow_auto_purge),
      privacyErasureAction: toOptionalString(row.privacy_erasure_action),
      policyMetadata: toOptionalString(row.policy_metadata),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed manifest store
export class SourceTombstoneStore {
  static async recordTombstone(
    queryable: Queryable,
    portfolioId: string,
    input: InsertSourceTombstoneInput,
  ): Promise<string> {
    const now = Date.now();
    const id =
      input.id ??
      deterministicSourceTombstoneId(input.ingestionSourceId, input.sourceType, input.sourceId);
    const { changes } = await queryable.exec(
      `INSERT INTO source_tombstones (
        id, ingestion_source_id, environment_id, source_project_id, source_type,
        source_id, deleted_at, reason, tombstone_authority, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM ingestion_sources WHERE id = ? AND portfolio_id = ?)`,
      [
        id,
        input.ingestionSourceId,
        input.environmentId ?? null,
        input.sourceProjectId ?? null,
        input.sourceType,
        input.sourceId,
        input.deletedAt ?? now,
        input.reason ?? null,
        input.tombstoneAuthority,
        input.createdAt ?? now,
        input.ingestionSourceId,
        portfolioId,
      ],
    );
    if (changes === 0) {
      throw new Error(
        `Source tombstone not recorded: ingestion source not in portfolio ${portfolioId}`,
      );
    }
    return id;
  }

  static async isTombstoned(
    queryable: Queryable,
    portfolioId: string,
    ingestionSourceId: string,
    sourceType: string,
    sourceId: string,
  ): Promise<boolean> {
    const { rows } = await queryable.exec(
      `SELECT 1
       FROM source_tombstones st
       JOIN ingestion_sources src ON src.id = st.ingestion_source_id
       WHERE st.ingestion_source_id = ? AND st.source_type = ? AND st.source_id = ? AND src.portfolio_id = ?`,
      [ingestionSourceId, sourceType, sourceId, portfolioId],
    );
    return rows.length > 0;
  }

  static async getTombstone(
    queryable: Queryable,
    portfolioId: string,
    ingestionSourceId: string,
    sourceType: string,
    sourceId: string,
  ): Promise<SourceTombstone | undefined> {
    const { rows } = await queryable.exec(
      `SELECT st.*
       FROM source_tombstones st
       JOIN ingestion_sources src ON src.id = st.ingestion_source_id
       WHERE st.ingestion_source_id = ? AND st.source_type = ? AND st.source_id = ? AND src.portfolio_id = ?`,
      [ingestionSourceId, sourceType, sourceId, portfolioId],
    );
    if (rows.length === 0) return undefined;
    return SourceTombstoneStore.rowToSourceTombstone(rows[0]);
  }

  private static rowToSourceTombstone(row: SqliteRow): SourceTombstone {
    return {
      id: asString(row.id),
      ingestionSourceId: asString(row.ingestion_source_id),
      environmentId: toOptionalString(row.environment_id),
      sourceProjectId: toOptionalString(row.source_project_id),
      sourceType: asString(row.source_type),
      sourceId: asString(row.source_id),
      deletedAt: toNumber(row.deleted_at),
      reason: toOptionalString(row.reason),
      tombstoneAuthority: asString(row.tombstone_authority),
      createdAt: toNumber(row.created_at),
    };
  }
}
