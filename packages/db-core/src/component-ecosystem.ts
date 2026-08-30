import type { SqliteExecutor, SqliteRow, SqliteTransaction, SqliteValue } from './contract.js';
import { deterministicId } from './identity.js';
import type { Migration } from './migrations.js';

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

type Queryable = SqliteExecutor | SqliteTransaction;

function asString(value: SqliteValue): string {
  return value === null || value === undefined ? '' : String(value);
}

function toOptionalString(value: SqliteValue): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toNumber(value: SqliteValue): number {
  return value === null || value === undefined ? 0 : Number(value);
}

export const COMPONENT_KINDS = [
  'tool',
  'skill',
  'agent',
  'rule',
  'mcp_server',
  'plugin',
  'setting',
  'model',
  'version',
] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export const COMPONENT_RELATIONSHIP_TYPES = [
  'mcp_to_tool',
  'plugin_to_contribution',
  'parent_child',
  'alias',
  'causation',
] as const;
export type ComponentRelationshipType = (typeof COMPONENT_RELATIONSHIP_TYPES)[number];

export const INSTALLATION_SCOPES = ['global', 'project', 'workspace', 'plugin'] as const;
export type InstallationScope = (typeof INSTALLATION_SCOPES)[number];

export const CONFIGURATION_SNAPSHOT_TEMPORAL_ROLES = [
  'pre_session',
  'runtime',
  'post_session',
  'capture_only',
] as const;
export type ConfigurationSnapshotTemporalRole =
  (typeof CONFIGURATION_SNAPSHOT_TEMPORAL_ROLES)[number];

export const SNAPSHOT_COMPLETENESS_STATUSES = [
  'complete',
  'partial',
  'unsupported',
  'failed',
  'skipped',
  'pending',
  'unknown',
] as const;
export type SnapshotCompletenessStatus = (typeof SNAPSHOT_COMPLETENESS_STATUSES)[number];

export const LIFECYCLE_EVENT_TYPES = ['baseline', 'added', 'updated', 'removed'] as const;
export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];

export const AVAILABILITY_EVENT_TYPES = [
  'offered',
  'deferred',
  'enabled',
  'disabled',
  'connected',
  'disconnected',
  'unavailable',
] as const;
export type AvailabilityEventType = (typeof AVAILABILITY_EVENT_TYPES)[number];

export const CONTEXT_EVENT_TYPES = [
  'listed',
  'loaded',
  'injected',
  'reinjected',
  'replaced',
  'compacted',
  'removed',
] as const;
export type ContextEventType = (typeof CONTEXT_EVENT_TYPES)[number];

export const SESSION_COMPONENT_EXPOSURE_STATUSES = [
  'unavailable',
  'not_applicable',
  'available_not_loaded',
  'loaded',
  'unknown',
] as const;
export type SessionComponentExposureStatus = (typeof SESSION_COMPONENT_EXPOSURE_STATUSES)[number];

export const CREATE_COMPONENT_IDENTITIES_TABLE = `
CREATE TABLE IF NOT EXISTS component_identities (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (${COMPONENT_KINDS.map((k) => `'${k}'`).join(', ')})),
  owner TEXT NOT NULL DEFAULT '',
  integration TEXT NOT NULL DEFAULT '',
  native_id TEXT NOT NULL DEFAULT '',
  canonical_source_identity TEXT NOT NULL,
  display_name TEXT,
  safe_metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (portfolio_id) REFERENCES portfolios (id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_component_identities_unique_identity
  ON component_identities (
    portfolio_id,
    kind,
    owner,
    integration,
    native_id,
    canonical_source_identity
  );

CREATE INDEX IF NOT EXISTS idx_component_identities_portfolio_kind
  ON component_identities (portfolio_id, kind);

CREATE INDEX IF NOT EXISTS idx_component_identities_display_name
  ON component_identities (display_name);
`;

export const CREATE_COMPONENT_ALIASES_TABLE = `
CREATE TABLE IF NOT EXISTS component_aliases (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL,
  source_component_id TEXT NOT NULL,
  target_component_id TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (portfolio_id) REFERENCES portfolios (id) ON DELETE CASCADE,
  FOREIGN KEY (source_component_id) REFERENCES component_identities (id) ON DELETE CASCADE,
  FOREIGN KEY (target_component_id) REFERENCES component_identities (id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_component_aliases_unique
  ON component_aliases (portfolio_id, source_component_id, target_component_id, source);

CREATE INDEX IF NOT EXISTS idx_component_aliases_source
  ON component_aliases (source_component_id);

CREATE INDEX IF NOT EXISTS idx_component_aliases_target
  ON component_aliases (target_component_id);
`;

export const CREATE_COMPONENT_VERSIONS_TABLE = `
CREATE TABLE IF NOT EXISTS component_versions (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL,
  generation_id TEXT,
  content_hash TEXT NOT NULL,
  config_hash TEXT NOT NULL DEFAULT '',
  schema_hash TEXT NOT NULL DEFAULT '',
  safe_metadata TEXT,
  source_pointer TEXT NOT NULL DEFAULT '',
  artifact_version_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (component_id) REFERENCES component_identities (id) ON DELETE CASCADE,
  FOREIGN KEY (generation_id) REFERENCES transformation_generations (id) ON DELETE SET NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_component_versions_unique
  ON component_versions (component_id, content_hash, config_hash, schema_hash);

CREATE INDEX IF NOT EXISTS idx_component_versions_component
  ON component_versions (component_id);
`;

export const CREATE_COMPONENT_RELATIONSHIPS_TABLE = `
CREATE TABLE IF NOT EXISTS component_relationships (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL,
  source_component_id TEXT NOT NULL,
  target_component_id TEXT NOT NULL,
  relationship_type TEXT NOT NULL CHECK (relationship_type IN (${COMPONENT_RELATIONSHIP_TYPES.map((k) => `'${k}'`).join(', ')})),
  source TEXT NOT NULL,
  confidence REAL,
  safe_metadata TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (portfolio_id) REFERENCES portfolios (id) ON DELETE CASCADE,
  FOREIGN KEY (source_component_id) REFERENCES component_identities (id) ON DELETE CASCADE,
  FOREIGN KEY (target_component_id) REFERENCES component_identities (id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_component_relationships_unique
  ON component_relationships (
    portfolio_id,
    source_component_id,
    target_component_id,
    relationship_type,
    source
  );

CREATE INDEX IF NOT EXISTS idx_component_relationships_source
  ON component_relationships (source_component_id);

CREATE INDEX IF NOT EXISTS idx_component_relationships_target
  ON component_relationships (target_component_id);

CREATE INDEX IF NOT EXISTS idx_component_relationships_type
  ON component_relationships (relationship_type);
`;

export const CREATE_COMPONENT_INSTALLATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS component_installations (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN (${INSTALLATION_SCOPES.map((k) => `'${k}'`).join(', ')})),
  project_id TEXT,
  workspace_id TEXT,
  plugin_component_id TEXT,
  effective_start_at INTEGER NOT NULL,
  effective_end_at INTEGER,
  safe_metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (component_id) REFERENCES component_identities (id) ON DELETE CASCADE,
  FOREIGN KEY (environment_id) REFERENCES environments (id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE SET NULL,
  FOREIGN KEY (plugin_component_id) REFERENCES component_identities (id) ON DELETE SET NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_component_installations_unique
  ON component_installations (
    component_id,
    environment_id,
    scope,
    COALESCE(project_id, ''),
    COALESCE(workspace_id, ''),
    COALESCE(plugin_component_id, ''),
    effective_start_at
  );

CREATE INDEX IF NOT EXISTS idx_component_installations_component
  ON component_installations (component_id);

CREATE INDEX IF NOT EXISTS idx_component_installations_environment
  ON component_installations (environment_id);

CREATE INDEX IF NOT EXISTS idx_component_installations_scope
  ON component_installations (scope, project_id, workspace_id, plugin_component_id);
`;

export const CREATE_CONFIGURATION_SNAPSHOTS_TABLE = `
CREATE TABLE IF NOT EXISTS configuration_snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  generation_id TEXT,
  ordering INTEGER NOT NULL,
  scope_chain TEXT,
  capture_time INTEGER NOT NULL,
  ingestion_time INTEGER NOT NULL,
  harness TEXT NOT NULL,
  temporal_role TEXT NOT NULL CHECK (temporal_role IN (${CONFIGURATION_SNAPSHOT_TEMPORAL_ROLES.map((k) => `'${k}'`).join(', ')})),
  source_manifest_id TEXT,
  environment_id TEXT NOT NULL,
  project_id TEXT,
  workspace_id TEXT,
  safe_metadata TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE SET NULL,
  FOREIGN KEY (generation_id) REFERENCES transformation_generations (id) ON DELETE SET NULL,
  FOREIGN KEY (environment_id) REFERENCES environments (id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE SET NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_configuration_snapshots_unique
  ON configuration_snapshots (
    environment_id,
    COALESCE(project_id, ''),
    COALESCE(workspace_id, ''),
    ordering,
    capture_time
  );

CREATE INDEX IF NOT EXISTS idx_configuration_snapshots_session
  ON configuration_snapshots (session_id);

CREATE INDEX IF NOT EXISTS idx_configuration_snapshots_environment
  ON configuration_snapshots (environment_id);

CREATE INDEX IF NOT EXISTS idx_configuration_snapshots_capture
  ON configuration_snapshots (capture_time);
`;

export const CREATE_SNAPSHOT_COMPLETENESS_TABLE = `
CREATE TABLE IF NOT EXISTS snapshot_completeness (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  component_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (${SNAPSHOT_COMPLETENESS_STATUSES.map((k) => `'${k}'`).join(', ')})),
  expected_count INTEGER,
  observed_count INTEGER,
  reason TEXT,
  safe_metadata TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (snapshot_id) REFERENCES configuration_snapshots (id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshot_completeness_unique
  ON snapshot_completeness (snapshot_id, component_kind);
`;

export const CREATE_SNAPSHOT_COMPONENTS_TABLE = `
CREATE TABLE IF NOT EXISTS snapshot_components (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  component_version_id TEXT NOT NULL,
  source_scope TEXT NOT NULL,
  source_pointer TEXT NOT NULL DEFAULT '',
  installation_id TEXT,
  safe_metadata TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (snapshot_id) REFERENCES configuration_snapshots (id) ON DELETE CASCADE,
  FOREIGN KEY (component_version_id) REFERENCES component_versions (id) ON DELETE CASCADE,
  FOREIGN KEY (installation_id) REFERENCES component_installations (id) ON DELETE SET NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshot_components_unique
  ON snapshot_components (
    snapshot_id,
    component_version_id,
    source_scope,
    source_pointer
  );

CREATE INDEX IF NOT EXISTS idx_snapshot_components_version
  ON snapshot_components (component_version_id);
`;

export const CREATE_COMPONENT_LIFECYCLE_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS component_lifecycle_events (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (${LIFECYCLE_EVENT_TYPES.map((k) => `'${k}'`).join(', ')})),
  before_version_id TEXT,
  after_version_id TEXT,
  concurrent_event_group_id TEXT,
  snapshot_id TEXT,
  generation_id TEXT,
  source TEXT,
  safe_metadata TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (component_id) REFERENCES component_identities (id) ON DELETE CASCADE,
  FOREIGN KEY (environment_id) REFERENCES environments (id) ON DELETE CASCADE,
  FOREIGN KEY (before_version_id) REFERENCES component_versions (id) ON DELETE SET NULL,
  FOREIGN KEY (after_version_id) REFERENCES component_versions (id) ON DELETE SET NULL,
  FOREIGN KEY (snapshot_id) REFERENCES configuration_snapshots (id) ON DELETE SET NULL,
  FOREIGN KEY (generation_id) REFERENCES transformation_generations (id) ON DELETE SET NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_component_lifecycle_events_component
  ON component_lifecycle_events (component_id);

CREATE INDEX IF NOT EXISTS idx_component_lifecycle_events_environment
  ON component_lifecycle_events (environment_id);

CREATE INDEX IF NOT EXISTS idx_component_lifecycle_events_type
  ON component_lifecycle_events (event_type);

CREATE INDEX IF NOT EXISTS idx_component_lifecycle_events_snapshot
  ON component_lifecycle_events (snapshot_id);

CREATE INDEX IF NOT EXISTS idx_component_lifecycle_events_concurrent
  ON component_lifecycle_events (concurrent_event_group_id);
`;

export const CREATE_COMPONENT_AVAILABILITY_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS component_availability_events (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  session_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN (${AVAILABILITY_EVENT_TYPES.map((k) => `'${k}'`).join(', ')})),
  snapshot_id TEXT,
  generation_id TEXT,
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  source TEXT,
  safe_metadata TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (component_id) REFERENCES component_identities (id) ON DELETE CASCADE,
  FOREIGN KEY (environment_id) REFERENCES environments (id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE SET NULL,
  FOREIGN KEY (snapshot_id) REFERENCES configuration_snapshots (id) ON DELETE SET NULL,
  FOREIGN KEY (generation_id) REFERENCES transformation_generations (id) ON DELETE SET NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_component_availability_events_component
  ON component_availability_events (component_id);

CREATE INDEX IF NOT EXISTS idx_component_availability_events_environment
  ON component_availability_events (environment_id);

CREATE INDEX IF NOT EXISTS idx_component_availability_events_type
  ON component_availability_events (event_type);

CREATE INDEX IF NOT EXISTS idx_component_availability_events_time
  ON component_availability_events (start_time, end_time);
`;

export const CREATE_COMPONENT_CONTEXT_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS component_context_events (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  session_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN (${CONTEXT_EVENT_TYPES.map((k) => `'${k}'`).join(', ')})),
  snapshot_id TEXT,
  generation_id TEXT,
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  source_pointer TEXT NOT NULL DEFAULT '',
  source TEXT,
  safe_metadata TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (component_id) REFERENCES component_identities (id) ON DELETE CASCADE,
  FOREIGN KEY (environment_id) REFERENCES environments (id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE SET NULL,
  FOREIGN KEY (snapshot_id) REFERENCES configuration_snapshots (id) ON DELETE SET NULL,
  FOREIGN KEY (generation_id) REFERENCES transformation_generations (id) ON DELETE SET NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_component_context_events_component
  ON component_context_events (component_id);

CREATE INDEX IF NOT EXISTS idx_component_context_events_environment
  ON component_context_events (environment_id);

CREATE INDEX IF NOT EXISTS idx_component_context_events_type
  ON component_context_events (event_type);

CREATE INDEX IF NOT EXISTS idx_component_context_events_time
  ON component_context_events (start_time, end_time);
`;

export const CREATE_SESSION_COMPONENT_EXPOSURES_TABLE = `
CREATE TABLE IF NOT EXISTS session_component_exposures (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  component_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (${SESSION_COMPONENT_EXPOSURE_STATUSES.map((k) => `'${k}'`).join(', ')})),
  start_sequence INTEGER NOT NULL,
  end_sequence INTEGER,
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  snapshot_id TEXT,
  generation_id TEXT,
  safe_metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
  FOREIGN KEY (component_id) REFERENCES component_identities (id) ON DELETE CASCADE,
  FOREIGN KEY (environment_id) REFERENCES environments (id) ON DELETE CASCADE,
  FOREIGN KEY (snapshot_id) REFERENCES configuration_snapshots (id) ON DELETE SET NULL,
  FOREIGN KEY (generation_id) REFERENCES transformation_generations (id) ON DELETE SET NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_component_exposures_unique
  ON session_component_exposures (session_id, component_id, start_sequence, status);

CREATE INDEX IF NOT EXISTS idx_session_component_exposures_session
  ON session_component_exposures (session_id);

CREATE INDEX IF NOT EXISTS idx_session_component_exposures_component
  ON session_component_exposures (component_id);
`;

export const ALTER_SESSION_COMPONENT_EXPOSURES_UNIQUE_GENERATION = `
DROP INDEX IF EXISTS idx_session_component_exposures_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_component_exposures_unique
  ON session_component_exposures (
    session_id,
    component_id,
    start_sequence,
    status,
    COALESCE(generation_id, '')
  );
`;

/**
 * Combined DDL for all component ecosystem tables and indexes. This can be
 * executed after the identity/sessions/control schema to set up the tables for
 * unit tests before the migration fragment is merged.
 */
export const COMPONENT_ECOSYSTEM_DDL = `
${CREATE_COMPONENT_IDENTITIES_TABLE}
${CREATE_COMPONENT_ALIASES_TABLE}
${CREATE_COMPONENT_VERSIONS_TABLE}
${CREATE_COMPONENT_RELATIONSHIPS_TABLE}
${CREATE_COMPONENT_INSTALLATIONS_TABLE}
${CREATE_CONFIGURATION_SNAPSHOTS_TABLE}
${CREATE_SNAPSHOT_COMPLETENESS_TABLE}
${CREATE_SNAPSHOT_COMPONENTS_TABLE}
${CREATE_COMPONENT_LIFECYCLE_EVENTS_TABLE}
${CREATE_COMPONENT_AVAILABILITY_EVENTS_TABLE}
${CREATE_COMPONENT_CONTEXT_EVENTS_TABLE}
${CREATE_SESSION_COMPONENT_EXPOSURES_TABLE}
${ALTER_SESSION_COMPONENT_EXPOSURES_UNIQUE_GENERATION}
`.trim();

/**
 * Forward migration fragment for the component ecosystem schema. The
 * orchestrator will merge this with the manifest fragment (ids 15-22) and the
 * existing migrations (ids 1-14) to produce the final migration history.
 */
export const COMPONENT_ECOSYSTEM_MIGRATIONS_FRAGMENT: readonly Migration[] = [
  {
    id: 23,
    name: 'create-component-identities',
    sql: CREATE_COMPONENT_IDENTITIES_TABLE,
    checksum: checksumOf(CREATE_COMPONENT_IDENTITIES_TABLE),
  },
  {
    id: 24,
    name: 'create-component-aliases',
    sql: CREATE_COMPONENT_ALIASES_TABLE,
    checksum: checksumOf(CREATE_COMPONENT_ALIASES_TABLE),
  },
  {
    id: 25,
    name: 'create-component-versions',
    sql: CREATE_COMPONENT_VERSIONS_TABLE,
    checksum: checksumOf(CREATE_COMPONENT_VERSIONS_TABLE),
  },
  {
    id: 26,
    name: 'create-component-relationships',
    sql: CREATE_COMPONENT_RELATIONSHIPS_TABLE,
    checksum: checksumOf(CREATE_COMPONENT_RELATIONSHIPS_TABLE),
  },
  {
    id: 27,
    name: 'create-component-installations',
    sql: CREATE_COMPONENT_INSTALLATIONS_TABLE,
    checksum: checksumOf(CREATE_COMPONENT_INSTALLATIONS_TABLE),
  },
  {
    id: 28,
    name: 'create-configuration-snapshots',
    sql: CREATE_CONFIGURATION_SNAPSHOTS_TABLE,
    checksum: checksumOf(CREATE_CONFIGURATION_SNAPSHOTS_TABLE),
  },
  {
    id: 29,
    name: 'create-snapshot-completeness',
    sql: CREATE_SNAPSHOT_COMPLETENESS_TABLE,
    checksum: checksumOf(CREATE_SNAPSHOT_COMPLETENESS_TABLE),
  },
  {
    id: 30,
    name: 'create-snapshot-components',
    sql: CREATE_SNAPSHOT_COMPONENTS_TABLE,
    checksum: checksumOf(CREATE_SNAPSHOT_COMPONENTS_TABLE),
  },
  {
    id: 31,
    name: 'create-component-lifecycle-events',
    sql: CREATE_COMPONENT_LIFECYCLE_EVENTS_TABLE,
    checksum: checksumOf(CREATE_COMPONENT_LIFECYCLE_EVENTS_TABLE),
  },
  {
    id: 32,
    name: 'create-component-availability-events',
    sql: CREATE_COMPONENT_AVAILABILITY_EVENTS_TABLE,
    checksum: checksumOf(CREATE_COMPONENT_AVAILABILITY_EVENTS_TABLE),
  },
  {
    id: 33,
    name: 'create-component-context-events',
    sql: CREATE_COMPONENT_CONTEXT_EVENTS_TABLE,
    checksum: checksumOf(CREATE_COMPONENT_CONTEXT_EVENTS_TABLE),
  },
  {
    id: 34,
    name: 'create-session-component-exposures',
    sql: CREATE_SESSION_COMPONENT_EXPOSURES_TABLE,
    checksum: checksumOf(CREATE_SESSION_COMPONENT_EXPOSURES_TABLE),
  },
  {
    id: 80,
    name: 'alter-session-component-exposures-unique-generation',
    sql: ALTER_SESSION_COMPONENT_EXPOSURES_UNIQUE_GENERATION,
    checksum: checksumOf(ALTER_SESSION_COMPONENT_EXPOSURES_UNIQUE_GENERATION),
  },
];

export function deterministicComponentIdentityId(
  portfolioId: string,
  kind: string,
  owner: string,
  integration: string,
  nativeId: string,
  canonicalSourceIdentity: string,
): string {
  return `comp-${deterministicId(
    'component-identity',
    portfolioId,
    kind,
    owner,
    integration,
    nativeId,
    canonicalSourceIdentity,
  )}`;
}

export function deterministicComponentVersionId(
  componentId: string,
  contentHash: string,
  configHash: string,
  schemaHash: string,
): string {
  return `cv-${deterministicId(
    'component-version',
    componentId,
    contentHash,
    configHash,
    schemaHash,
  )}`;
}

export function deterministicComponentAliasId(
  portfolioId: string,
  sourceComponentId: string,
  targetComponentId: string,
  source: string,
): string {
  return `cal-${deterministicId(
    'component-alias',
    portfolioId,
    sourceComponentId,
    targetComponentId,
    source,
  )}`;
}

export function deterministicComponentRelationshipId(
  portfolioId: string,
  sourceComponentId: string,
  targetComponentId: string,
  relationshipType: string,
  source: string,
): string {
  return `cr-${deterministicId(
    'component-relationship',
    portfolioId,
    sourceComponentId,
    targetComponentId,
    relationshipType,
    source,
  )}`;
}

export function deterministicComponentInstallationId(
  componentId: string,
  environmentId: string,
  scope: string,
  projectId: string | null,
  workspaceId: string | null,
  pluginComponentId: string | null,
  effectiveStartAt: number,
): string {
  return `ci-${deterministicId(
    'component-installation',
    componentId,
    environmentId,
    scope,
    projectId ?? '',
    workspaceId ?? '',
    pluginComponentId ?? '',
    String(effectiveStartAt),
  )}`;
}

export function deterministicConfigurationSnapshotId(
  environmentId: string,
  projectId: string | null,
  workspaceId: string | null,
  ordering: number,
  captureTime: number,
): string {
  return `cs-${deterministicId(
    'configuration-snapshot',
    environmentId,
    projectId ?? '',
    workspaceId ?? '',
    String(ordering),
    String(captureTime),
  )}`;
}

export function deterministicSnapshotCompletenessId(
  snapshotId: string,
  componentKind: string,
): string {
  return `scc-${deterministicId('snapshot-completeness', snapshotId, componentKind)}`;
}

export function deterministicSnapshotComponentId(
  snapshotId: string,
  componentVersionId: string,
  sourceScope: string,
  sourcePointer: string,
): string {
  return `sc-${deterministicId(
    'snapshot-component',
    snapshotId,
    componentVersionId,
    sourceScope,
    sourcePointer,
  )}`;
}

export interface ComponentIdentity {
  readonly id: string;
  readonly portfolioId: string;
  readonly kind: string;
  readonly owner: string;
  readonly integration: string;
  readonly nativeId: string;
  readonly canonicalSourceIdentity: string;
  readonly displayName: string | null;
  readonly safeMetadata: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertComponentIdentityInput {
  readonly id?: string;
  readonly portfolioId: string;
  readonly kind: string;
  readonly owner?: string | null;
  readonly integration?: string | null;
  readonly nativeId?: string | null;
  readonly canonicalSourceIdentity: string;
  readonly displayName?: string | null;
  readonly safeMetadata?: string | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed component ecosystem store
export class ComponentIdentityStore {
  static async insert(queryable: Queryable, input: InsertComponentIdentityInput): Promise<string> {
    const now = Date.now();
    const owner = input.owner ?? '';
    const integration = input.integration ?? '';
    const nativeId = input.nativeId ?? '';
    const id =
      input.id ??
      deterministicComponentIdentityId(
        input.portfolioId,
        input.kind,
        owner,
        integration,
        nativeId,
        input.canonicalSourceIdentity,
      );
    await queryable.exec(
      `INSERT INTO component_identities (
        id, portfolio_id, kind, owner, integration, native_id, canonical_source_identity,
        display_name, safe_metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.portfolioId,
        input.kind,
        owner,
        integration,
        nativeId,
        input.canonicalSourceIdentity,
        input.displayName ?? null,
        input.safeMetadata ?? null,
        input.createdAt ?? now,
        input.updatedAt ?? now,
      ],
    );
    return id;
  }

  static async getById(
    queryable: Queryable,
    portfolioId: string,
    id: string,
  ): Promise<ComponentIdentity | undefined> {
    const { rows } = await queryable.exec(
      `SELECT id, portfolio_id, kind, owner, integration, native_id, canonical_source_identity,
              display_name, safe_metadata, created_at, updated_at
       FROM component_identities WHERE id = ? AND portfolio_id = ?`,
      [id, portfolioId],
    );
    if (rows.length === 0) return undefined;
    return ComponentIdentityStore.rowToComponentIdentity(rows[0]);
  }

  static async getByUniqueIdentity(
    queryable: Queryable,
    portfolioId: string,
    input: {
      readonly kind: string;
      readonly owner: string;
      readonly integration: string;
      readonly nativeId: string;
      readonly canonicalSourceIdentity: string;
    },
  ): Promise<ComponentIdentity | undefined> {
    const { rows } = await queryable.exec(
      `SELECT id, portfolio_id, kind, owner, integration, native_id, canonical_source_identity,
              display_name, safe_metadata, created_at, updated_at
       FROM component_identities
       WHERE portfolio_id = ? AND kind = ? AND owner = ? AND integration = ? AND native_id = ?
         AND canonical_source_identity = ?`,
      [
        portfolioId,
        input.kind,
        input.owner,
        input.integration,
        input.nativeId,
        input.canonicalSourceIdentity,
      ],
    );
    if (rows.length === 0) return undefined;
    return ComponentIdentityStore.rowToComponentIdentity(rows[0]);
  }

  static async listByPortfolio(
    queryable: Queryable,
    portfolioId: string,
  ): Promise<readonly ComponentIdentity[]> {
    const { rows } = await queryable.exec(
      `SELECT id, portfolio_id, kind, owner, integration, native_id, canonical_source_identity,
              display_name, safe_metadata, created_at, updated_at
       FROM component_identities WHERE portfolio_id = ? ORDER BY kind, display_name, id`,
      [portfolioId],
    );
    return rows.map(ComponentIdentityStore.rowToComponentIdentity);
  }

  static async listByKind(
    queryable: Queryable,
    portfolioId: string,
    kind: string,
  ): Promise<readonly ComponentIdentity[]> {
    const { rows } = await queryable.exec(
      `SELECT id, portfolio_id, kind, owner, integration, native_id, canonical_source_identity,
              display_name, safe_metadata, created_at, updated_at
       FROM component_identities WHERE portfolio_id = ? AND kind = ? ORDER BY display_name, id`,
      [portfolioId, kind],
    );
    return rows.map(ComponentIdentityStore.rowToComponentIdentity);
  }

  static async update(
    queryable: Queryable,
    portfolioId: string,
    id: string,
    input: {
      readonly displayName?: string | null;
      readonly safeMetadata?: string | null;
      readonly updatedAt?: number;
    },
  ): Promise<void> {
    await queryable.exec(
      `UPDATE component_identities
       SET display_name = ?, safe_metadata = ?, updated_at = ?
       WHERE id = ? AND portfolio_id = ?`,
      [
        input.displayName ?? null,
        input.safeMetadata ?? null,
        input.updatedAt ?? Date.now(),
        id,
        portfolioId,
      ],
    );
  }

  static async delete(queryable: Queryable, portfolioId: string, id: string): Promise<void> {
    await queryable.exec('DELETE FROM component_identities WHERE id = ? AND portfolio_id = ?', [
      id,
      portfolioId,
    ]);
  }

  private static rowToComponentIdentity(row: SqliteRow): ComponentIdentity {
    return {
      id: asString(row.id),
      portfolioId: asString(row.portfolio_id),
      kind: asString(row.kind),
      owner: asString(row.owner),
      integration: asString(row.integration),
      nativeId: asString(row.native_id),
      canonicalSourceIdentity: asString(row.canonical_source_identity),
      displayName: toOptionalString(row.display_name),
      safeMetadata: toOptionalString(row.safe_metadata),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }
}

export interface ComponentAlias {
  readonly id: string;
  readonly portfolioId: string;
  readonly sourceComponentId: string;
  readonly targetComponentId: string;
  readonly source: string;
  readonly confidence: number;
  readonly reason: string | null;
  readonly createdAt: number;
}

export interface InsertComponentAliasInput {
  readonly id?: string;
  readonly portfolioId: string;
  readonly sourceComponentId: string;
  readonly targetComponentId: string;
  readonly source: string;
  readonly confidence: number;
  readonly reason?: string | null;
  readonly createdAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed component ecosystem store
export class ComponentAliasStore {
  static async insert(queryable: Queryable, input: InsertComponentAliasInput): Promise<string> {
    const now = Date.now();
    const id =
      input.id ??
      deterministicComponentAliasId(
        input.portfolioId,
        input.sourceComponentId,
        input.targetComponentId,
        input.source,
      );
    await queryable.exec(
      `INSERT INTO component_aliases (
        id, portfolio_id, source_component_id, target_component_id, source, confidence, reason,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.portfolioId,
        input.sourceComponentId,
        input.targetComponentId,
        input.source,
        input.confidence,
        input.reason ?? null,
        input.createdAt ?? now,
      ],
    );
    return id;
  }

  static async getById(
    queryable: Queryable,
    portfolioId: string,
    id: string,
  ): Promise<ComponentAlias | undefined> {
    const { rows } = await queryable.exec(
      `SELECT id, portfolio_id, source_component_id, target_component_id, source, confidence,
              reason, created_at
       FROM component_aliases WHERE id = ? AND portfolio_id = ?`,
      [id, portfolioId],
    );
    if (rows.length === 0) return undefined;
    return ComponentAliasStore.rowToComponentAlias(rows[0]);
  }

  static async listBySource(
    queryable: Queryable,
    portfolioId: string,
    sourceComponentId: string,
  ): Promise<readonly ComponentAlias[]> {
    const { rows } = await queryable.exec(
      `SELECT id, portfolio_id, source_component_id, target_component_id, source, confidence,
              reason, created_at
       FROM component_aliases
       WHERE portfolio_id = ? AND source_component_id = ?
       ORDER BY created_at`,
      [portfolioId, sourceComponentId],
    );
    return rows.map(ComponentAliasStore.rowToComponentAlias);
  }

  static async listByTarget(
    queryable: Queryable,
    portfolioId: string,
    targetComponentId: string,
  ): Promise<readonly ComponentAlias[]> {
    const { rows } = await queryable.exec(
      `SELECT id, portfolio_id, source_component_id, target_component_id, source, confidence,
              reason, created_at
       FROM component_aliases
       WHERE portfolio_id = ? AND target_component_id = ?
       ORDER BY created_at`,
      [portfolioId, targetComponentId],
    );
    return rows.map(ComponentAliasStore.rowToComponentAlias);
  }

  static async resolveAliases(
    queryable: Queryable,
    portfolioId: string,
    componentId: string,
    maxDepth = 3,
  ): Promise<readonly string[]> {
    const { rows } = await queryable.exec(
      `WITH RECURSIVE chain(source_component_id, target_component_id, depth) AS (
        SELECT source_component_id, target_component_id, 1
        FROM component_aliases
        WHERE portfolio_id = ? AND source_component_id = ?
        UNION ALL
        SELECT ca.source_component_id, ca.target_component_id, chain.depth + 1
        FROM component_aliases ca
        JOIN chain ON ca.source_component_id = chain.target_component_id
        WHERE ca.portfolio_id = ? AND chain.depth < ?
      )
      SELECT DISTINCT target_component_id AS component_id FROM chain`,
      [portfolioId, componentId, portfolioId, maxDepth],
    );
    return rows.map((row) => asString(row.component_id));
  }

  static async update(
    queryable: Queryable,
    portfolioId: string,
    id: string,
    input: {
      readonly confidence: number;
      readonly reason?: string | null;
    },
  ): Promise<void> {
    await queryable.exec(
      `UPDATE component_aliases
       SET confidence = ?, reason = ?
       WHERE id = ? AND portfolio_id = ?`,
      [input.confidence, input.reason ?? null, id, portfolioId],
    );
  }

  static async delete(queryable: Queryable, portfolioId: string, id: string): Promise<void> {
    await queryable.exec('DELETE FROM component_aliases WHERE id = ? AND portfolio_id = ?', [
      id,
      portfolioId,
    ]);
  }

  private static rowToComponentAlias(row: SqliteRow): ComponentAlias {
    return {
      id: asString(row.id),
      portfolioId: asString(row.portfolio_id),
      sourceComponentId: asString(row.source_component_id),
      targetComponentId: asString(row.target_component_id),
      source: asString(row.source),
      confidence: toNumber(row.confidence),
      reason: toOptionalString(row.reason),
      createdAt: toNumber(row.created_at),
    };
  }
}

export interface ComponentVersion {
  readonly id: string;
  readonly componentId: string;
  readonly generationId: string | null;
  readonly contentHash: string;
  readonly configHash: string;
  readonly schemaHash: string;
  readonly safeMetadata: string | null;
  readonly sourcePointer: string;
  readonly artifactVersionId: string | null;
  readonly createdAt: number;
}

export interface InsertComponentVersionInput {
  readonly id?: string;
  readonly componentId: string;
  readonly generationId?: string | null;
  readonly contentHash: string;
  readonly configHash?: string;
  readonly schemaHash?: string;
  readonly safeMetadata?: string | null;
  readonly sourcePointer?: string;
  readonly artifactVersionId?: string | null;
  readonly createdAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed component ecosystem store
export class ComponentVersionStore {
  static async insert(queryable: Queryable, input: InsertComponentVersionInput): Promise<string> {
    const now = Date.now();
    const configHash = input.configHash ?? '';
    const schemaHash = input.schemaHash ?? '';
    const id =
      input.id ??
      deterministicComponentVersionId(input.componentId, input.contentHash, configHash, schemaHash);
    await queryable.exec(
      `INSERT INTO component_versions (
        id, component_id, generation_id, content_hash, config_hash, schema_hash, safe_metadata,
        source_pointer, artifact_version_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.componentId,
        input.generationId ?? null,
        input.contentHash,
        configHash,
        schemaHash,
        input.safeMetadata ?? null,
        input.sourcePointer ?? '',
        input.artifactVersionId ?? null,
        input.createdAt ?? now,
      ],
    );
    return id;
  }

  static async getById(
    queryable: Queryable,
    componentId: string,
    id: string,
  ): Promise<ComponentVersion | undefined> {
    const { rows } = await queryable.exec(
      `SELECT id, component_id, generation_id, content_hash, config_hash, schema_hash,
              safe_metadata, source_pointer, artifact_version_id, created_at
       FROM component_versions WHERE id = ? AND component_id = ?`,
      [id, componentId],
    );
    if (rows.length === 0) return undefined;
    return ComponentVersionStore.rowToComponentVersion(rows[0]);
  }

  static async listByComponent(
    queryable: Queryable,
    componentId: string,
  ): Promise<readonly ComponentVersion[]> {
    const { rows } = await queryable.exec(
      `SELECT id, component_id, generation_id, content_hash, config_hash, schema_hash,
              safe_metadata, source_pointer, artifact_version_id, created_at
       FROM component_versions WHERE component_id = ? ORDER BY created_at`,
      [componentId],
    );
    return rows.map(ComponentVersionStore.rowToComponentVersion);
  }

  static async delete(queryable: Queryable, componentId: string, id: string): Promise<void> {
    await queryable.exec('DELETE FROM component_versions WHERE id = ? AND component_id = ?', [
      id,
      componentId,
    ]);
  }

  private static rowToComponentVersion(row: SqliteRow): ComponentVersion {
    return {
      id: asString(row.id),
      componentId: asString(row.component_id),
      generationId: toOptionalString(row.generation_id),
      contentHash: asString(row.content_hash),
      configHash: asString(row.config_hash),
      schemaHash: asString(row.schema_hash),
      safeMetadata: toOptionalString(row.safe_metadata),
      sourcePointer: asString(row.source_pointer),
      artifactVersionId: toOptionalString(row.artifact_version_id),
      createdAt: toNumber(row.created_at),
    };
  }
}

export interface ComponentRelationship {
  readonly id: string;
  readonly portfolioId: string;
  readonly sourceComponentId: string;
  readonly targetComponentId: string;
  readonly relationshipType: string;
  readonly source: string;
  readonly confidence: number | null;
  readonly safeMetadata: string | null;
  readonly createdAt: number;
}

export interface InsertComponentRelationshipInput {
  readonly id?: string;
  readonly portfolioId: string;
  readonly sourceComponentId: string;
  readonly targetComponentId: string;
  readonly relationshipType: string;
  readonly source: string;
  readonly confidence?: number | null;
  readonly safeMetadata?: string | null;
  readonly createdAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed component ecosystem store
export class ComponentRelationshipStore {
  static async insert(
    queryable: Queryable,
    input: InsertComponentRelationshipInput,
  ): Promise<string> {
    const now = Date.now();
    const id =
      input.id ??
      deterministicComponentRelationshipId(
        input.portfolioId,
        input.sourceComponentId,
        input.targetComponentId,
        input.relationshipType,
        input.source,
      );
    await queryable.exec(
      `INSERT INTO component_relationships (
        id, portfolio_id, source_component_id, target_component_id, relationship_type, source,
        confidence, safe_metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.portfolioId,
        input.sourceComponentId,
        input.targetComponentId,
        input.relationshipType,
        input.source,
        input.confidence ?? null,
        input.safeMetadata ?? null,
        input.createdAt ?? now,
      ],
    );
    return id;
  }

  static async getById(
    queryable: Queryable,
    portfolioId: string,
    id: string,
  ): Promise<ComponentRelationship | undefined> {
    const { rows } = await queryable.exec(
      `SELECT id, portfolio_id, source_component_id, target_component_id, relationship_type, source,
              confidence, safe_metadata, created_at
       FROM component_relationships WHERE id = ? AND portfolio_id = ?`,
      [id, portfolioId],
    );
    if (rows.length === 0) return undefined;
    return ComponentRelationshipStore.rowToComponentRelationship(rows[0]);
  }

  static async listBySource(
    queryable: Queryable,
    portfolioId: string,
    sourceComponentId: string,
  ): Promise<readonly ComponentRelationship[]> {
    const { rows } = await queryable.exec(
      `SELECT id, portfolio_id, source_component_id, target_component_id, relationship_type, source,
              confidence, safe_metadata, created_at
       FROM component_relationships
       WHERE portfolio_id = ? AND source_component_id = ?
       ORDER BY created_at`,
      [portfolioId, sourceComponentId],
    );
    return rows.map(ComponentRelationshipStore.rowToComponentRelationship);
  }

  static async listByTarget(
    queryable: Queryable,
    portfolioId: string,
    targetComponentId: string,
  ): Promise<readonly ComponentRelationship[]> {
    const { rows } = await queryable.exec(
      `SELECT id, portfolio_id, source_component_id, target_component_id, relationship_type, source,
              confidence, safe_metadata, created_at
       FROM component_relationships
       WHERE portfolio_id = ? AND target_component_id = ?
       ORDER BY created_at`,
      [portfolioId, targetComponentId],
    );
    return rows.map(ComponentRelationshipStore.rowToComponentRelationship);
  }

  static async listByType(
    queryable: Queryable,
    portfolioId: string,
    relationshipType: string,
  ): Promise<readonly ComponentRelationship[]> {
    const { rows } = await queryable.exec(
      `SELECT id, portfolio_id, source_component_id, target_component_id, relationship_type, source,
              confidence, safe_metadata, created_at
       FROM component_relationships
       WHERE portfolio_id = ? AND relationship_type = ?
       ORDER BY created_at`,
      [portfolioId, relationshipType],
    );
    return rows.map(ComponentRelationshipStore.rowToComponentRelationship);
  }

  static async update(
    queryable: Queryable,
    portfolioId: string,
    id: string,
    input: {
      readonly confidence?: number | null;
      readonly safeMetadata?: string | null;
    },
  ): Promise<void> {
    await queryable.exec(
      `UPDATE component_relationships
       SET confidence = ?, safe_metadata = ?
       WHERE id = ? AND portfolio_id = ?`,
      [input.confidence ?? null, input.safeMetadata ?? null, id, portfolioId],
    );
  }

  static async delete(queryable: Queryable, portfolioId: string, id: string): Promise<void> {
    await queryable.exec('DELETE FROM component_relationships WHERE id = ? AND portfolio_id = ?', [
      id,
      portfolioId,
    ]);
  }

  private static rowToComponentRelationship(row: SqliteRow): ComponentRelationship {
    return {
      id: asString(row.id),
      portfolioId: asString(row.portfolio_id),
      sourceComponentId: asString(row.source_component_id),
      targetComponentId: asString(row.target_component_id),
      relationshipType: asString(row.relationship_type),
      source: asString(row.source),
      confidence:
        row.confidence === null || row.confidence === undefined ? null : toNumber(row.confidence),
      safeMetadata: toOptionalString(row.safe_metadata),
      createdAt: toNumber(row.created_at),
    };
  }
}

export interface ComponentInstallation {
  readonly id: string;
  readonly componentId: string;
  readonly environmentId: string;
  readonly scope: string;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  readonly pluginComponentId: string | null;
  readonly effectiveStartAt: number;
  readonly effectiveEndAt: number | null;
  readonly safeMetadata: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertComponentInstallationInput {
  readonly id?: string;
  readonly componentId: string;
  readonly environmentId: string;
  readonly scope: string;
  readonly projectId?: string | null;
  readonly workspaceId?: string | null;
  readonly pluginComponentId?: string | null;
  readonly effectiveStartAt: number;
  readonly effectiveEndAt?: number | null;
  readonly safeMetadata?: string | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed component ecosystem store
export class ComponentInstallationStore {
  static async insert(
    queryable: Queryable,
    input: InsertComponentInstallationInput,
  ): Promise<string> {
    const now = Date.now();
    const id =
      input.id ??
      deterministicComponentInstallationId(
        input.componentId,
        input.environmentId,
        input.scope,
        input.projectId ?? null,
        input.workspaceId ?? null,
        input.pluginComponentId ?? null,
        input.effectiveStartAt,
      );
    await queryable.exec(
      `INSERT INTO component_installations (
        id, component_id, environment_id, scope, project_id, workspace_id, plugin_component_id,
        effective_start_at, effective_end_at, safe_metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.componentId,
        input.environmentId,
        input.scope,
        input.projectId ?? null,
        input.workspaceId ?? null,
        input.pluginComponentId ?? null,
        input.effectiveStartAt,
        input.effectiveEndAt ?? null,
        input.safeMetadata ?? null,
        input.createdAt ?? now,
        input.updatedAt ?? now,
      ],
    );
    return id;
  }

  static async getById(
    queryable: Queryable,
    componentId: string,
    id: string,
  ): Promise<ComponentInstallation | undefined> {
    const { rows } = await queryable.exec(
      `SELECT id, component_id, environment_id, scope, project_id, workspace_id, plugin_component_id,
              effective_start_at, effective_end_at, safe_metadata, created_at, updated_at
       FROM component_installations WHERE id = ? AND component_id = ?`,
      [id, componentId],
    );
    if (rows.length === 0) return undefined;
    return ComponentInstallationStore.rowToComponentInstallation(rows[0]);
  }

  static async listByComponent(
    queryable: Queryable,
    componentId: string,
  ): Promise<readonly ComponentInstallation[]> {
    const { rows } = await queryable.exec(
      `SELECT id, component_id, environment_id, scope, project_id, workspace_id, plugin_component_id,
              effective_start_at, effective_end_at, safe_metadata, created_at, updated_at
       FROM component_installations WHERE component_id = ? ORDER BY effective_start_at`,
      [componentId],
    );
    return rows.map(ComponentInstallationStore.rowToComponentInstallation);
  }

  static async listByEnvironment(
    queryable: Queryable,
    environmentId: string,
  ): Promise<readonly ComponentInstallation[]> {
    const { rows } = await queryable.exec(
      `SELECT id, component_id, environment_id, scope, project_id, workspace_id, plugin_component_id,
              effective_start_at, effective_end_at, safe_metadata, created_at, updated_at
       FROM component_installations WHERE environment_id = ? ORDER BY effective_start_at`,
      [environmentId],
    );
    return rows.map(ComponentInstallationStore.rowToComponentInstallation);
  }

  static async update(
    queryable: Queryable,
    componentId: string,
    id: string,
    input: {
      readonly effectiveEndAt?: number | null;
      readonly safeMetadata?: string | null;
      readonly updatedAt?: number;
    },
  ): Promise<void> {
    await queryable.exec(
      `UPDATE component_installations
       SET effective_end_at = ?, safe_metadata = ?, updated_at = ?
       WHERE id = ? AND component_id = ?`,
      [
        input.effectiveEndAt ?? null,
        input.safeMetadata ?? null,
        input.updatedAt ?? Date.now(),
        id,
        componentId,
      ],
    );
  }

  static async delete(queryable: Queryable, componentId: string, id: string): Promise<void> {
    await queryable.exec('DELETE FROM component_installations WHERE id = ? AND component_id = ?', [
      id,
      componentId,
    ]);
  }

  private static rowToComponentInstallation(row: SqliteRow): ComponentInstallation {
    return {
      id: asString(row.id),
      componentId: asString(row.component_id),
      environmentId: asString(row.environment_id),
      scope: asString(row.scope),
      projectId: toOptionalString(row.project_id),
      workspaceId: toOptionalString(row.workspace_id),
      pluginComponentId: toOptionalString(row.plugin_component_id),
      effectiveStartAt: toNumber(row.effective_start_at),
      effectiveEndAt:
        toOptionalString(row.effective_end_at) === null ? null : toNumber(row.effective_end_at),
      safeMetadata: toOptionalString(row.safe_metadata),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }
}

export interface ConfigurationSnapshot {
  readonly id: string;
  readonly sessionId: string | null;
  readonly generationId: string | null;
  readonly ordering: number;
  readonly scopeChain: string | null;
  readonly captureTime: number;
  readonly ingestionTime: number;
  readonly harness: string;
  readonly temporalRole: string;
  readonly sourceManifestId: string | null;
  readonly environmentId: string;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  readonly safeMetadata: string | null;
  readonly createdAt: number;
}

export interface InsertConfigurationSnapshotInput {
  readonly id?: string;
  readonly sessionId?: string | null;
  readonly generationId?: string | null;
  readonly ordering: number;
  readonly scopeChain?: string | null;
  readonly captureTime: number;
  readonly ingestionTime?: number;
  readonly harness: string;
  readonly temporalRole: string;
  readonly sourceManifestId?: string | null;
  readonly environmentId: string;
  readonly projectId?: string | null;
  readonly workspaceId?: string | null;
  readonly safeMetadata?: string | null;
  readonly createdAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed component ecosystem store
export class ConfigurationSnapshotStore {
  static async insert(
    queryable: Queryable,
    input: InsertConfigurationSnapshotInput,
  ): Promise<string> {
    const now = Date.now();
    const id =
      input.id ??
      deterministicConfigurationSnapshotId(
        input.environmentId,
        input.projectId ?? null,
        input.workspaceId ?? null,
        input.ordering,
        input.captureTime,
      );
    await queryable.exec(
      `INSERT INTO configuration_snapshots (
        id, session_id, generation_id, ordering, scope_chain, capture_time, ingestion_time, harness,
        temporal_role, source_manifest_id, environment_id, project_id, workspace_id, safe_metadata,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.sessionId ?? null,
        input.generationId ?? null,
        input.ordering,
        input.scopeChain ?? null,
        input.captureTime,
        input.ingestionTime ?? now,
        input.harness,
        input.temporalRole,
        input.sourceManifestId ?? null,
        input.environmentId,
        input.projectId ?? null,
        input.workspaceId ?? null,
        input.safeMetadata ?? null,
        input.createdAt ?? now,
      ],
    );
    return id;
  }

  static async getById(
    queryable: Queryable,
    environmentId: string,
    id: string,
  ): Promise<ConfigurationSnapshot | undefined> {
    const { rows } = await queryable.exec(
      `SELECT id, session_id, generation_id, ordering, scope_chain, capture_time, ingestion_time,
              harness, temporal_role, source_manifest_id, environment_id, project_id, workspace_id,
              safe_metadata, created_at
       FROM configuration_snapshots WHERE id = ? AND environment_id = ?`,
      [id, environmentId],
    );
    if (rows.length === 0) return undefined;
    return ConfigurationSnapshotStore.rowToConfigurationSnapshot(rows[0]);
  }

  static async listByEnvironment(
    queryable: Queryable,
    environmentId: string,
  ): Promise<readonly ConfigurationSnapshot[]> {
    const { rows } = await queryable.exec(
      `SELECT id, session_id, generation_id, ordering, scope_chain, capture_time, ingestion_time,
              harness, temporal_role, source_manifest_id, environment_id, project_id, workspace_id,
              safe_metadata, created_at
       FROM configuration_snapshots WHERE environment_id = ? ORDER BY ordering, capture_time`,
      [environmentId],
    );
    return rows.map(ConfigurationSnapshotStore.rowToConfigurationSnapshot);
  }

  static async listBySession(
    queryable: Queryable,
    sessionId: string,
  ): Promise<readonly ConfigurationSnapshot[]> {
    const { rows } = await queryable.exec(
      `SELECT id, session_id, generation_id, ordering, scope_chain, capture_time, ingestion_time,
              harness, temporal_role, source_manifest_id, environment_id, project_id, workspace_id,
              safe_metadata, created_at
       FROM configuration_snapshots WHERE session_id = ? ORDER BY ordering, capture_time`,
      [sessionId],
    );
    return rows.map(ConfigurationSnapshotStore.rowToConfigurationSnapshot);
  }

  static async delete(queryable: Queryable, environmentId: string, id: string): Promise<void> {
    await queryable.exec(
      'DELETE FROM configuration_snapshots WHERE id = ? AND environment_id = ?',
      [id, environmentId],
    );
  }

  private static rowToConfigurationSnapshot(row: SqliteRow): ConfigurationSnapshot {
    return {
      id: asString(row.id),
      sessionId: toOptionalString(row.session_id),
      generationId: toOptionalString(row.generation_id),
      ordering: toNumber(row.ordering),
      scopeChain: toOptionalString(row.scope_chain),
      captureTime: toNumber(row.capture_time),
      ingestionTime: toNumber(row.ingestion_time),
      harness: asString(row.harness),
      temporalRole: asString(row.temporal_role),
      sourceManifestId: toOptionalString(row.source_manifest_id),
      environmentId: asString(row.environment_id),
      projectId: toOptionalString(row.project_id),
      workspaceId: toOptionalString(row.workspace_id),
      safeMetadata: toOptionalString(row.safe_metadata),
      createdAt: toNumber(row.created_at),
    };
  }
}

export interface SnapshotCompleteness {
  readonly id: string;
  readonly snapshotId: string;
  readonly componentKind: string;
  readonly status: string;
  readonly expectedCount: number | null;
  readonly observedCount: number | null;
  readonly reason: string | null;
  readonly safeMetadata: string | null;
  readonly createdAt: number;
}

export interface InsertSnapshotCompletenessInput {
  readonly id?: string;
  readonly snapshotId: string;
  readonly componentKind: string;
  readonly status: string;
  readonly expectedCount?: number | null;
  readonly observedCount?: number | null;
  readonly reason?: string | null;
  readonly safeMetadata?: string | null;
  readonly createdAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed component ecosystem store
export class SnapshotCompletenessStore {
  static async insert(
    queryable: Queryable,
    input: InsertSnapshotCompletenessInput,
  ): Promise<string> {
    const now = Date.now();
    const id =
      input.id ?? deterministicSnapshotCompletenessId(input.snapshotId, input.componentKind);
    await queryable.exec(
      `INSERT INTO snapshot_completeness (
        id, snapshot_id, component_kind, status, expected_count, observed_count, reason,
        safe_metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.snapshotId,
        input.componentKind,
        input.status,
        input.expectedCount ?? null,
        input.observedCount ?? null,
        input.reason ?? null,
        input.safeMetadata ?? null,
        input.createdAt ?? now,
      ],
    );
    return id;
  }

  static async getById(
    queryable: Queryable,
    snapshotId: string,
    id: string,
  ): Promise<SnapshotCompleteness | undefined> {
    const { rows } = await queryable.exec(
      `SELECT id, snapshot_id, component_kind, status, expected_count, observed_count, reason,
              safe_metadata, created_at
       FROM snapshot_completeness WHERE id = ? AND snapshot_id = ?`,
      [id, snapshotId],
    );
    if (rows.length === 0) return undefined;
    return SnapshotCompletenessStore.rowToSnapshotCompleteness(rows[0]);
  }

  static async listBySnapshot(
    queryable: Queryable,
    snapshotId: string,
  ): Promise<readonly SnapshotCompleteness[]> {
    const { rows } = await queryable.exec(
      `SELECT id, snapshot_id, component_kind, status, expected_count, observed_count, reason,
              safe_metadata, created_at
       FROM snapshot_completeness WHERE snapshot_id = ? ORDER BY component_kind`,
      [snapshotId],
    );
    return rows.map(SnapshotCompletenessStore.rowToSnapshotCompleteness);
  }

  static async delete(queryable: Queryable, snapshotId: string, id: string): Promise<void> {
    await queryable.exec('DELETE FROM snapshot_completeness WHERE id = ? AND snapshot_id = ?', [
      id,
      snapshotId,
    ]);
  }

  private static rowToSnapshotCompleteness(row: SqliteRow): SnapshotCompleteness {
    return {
      id: asString(row.id),
      snapshotId: asString(row.snapshot_id),
      componentKind: asString(row.component_kind),
      status: asString(row.status),
      expectedCount:
        row.expected_count === null || row.expected_count === undefined
          ? null
          : toNumber(row.expected_count),
      observedCount:
        row.observed_count === null || row.observed_count === undefined
          ? null
          : toNumber(row.observed_count),
      reason: toOptionalString(row.reason),
      safeMetadata: toOptionalString(row.safe_metadata),
      createdAt: toNumber(row.created_at),
    };
  }
}

export interface SnapshotComponent {
  readonly id: string;
  readonly snapshotId: string;
  readonly componentVersionId: string;
  readonly sourceScope: string;
  readonly sourcePointer: string;
  readonly installationId: string | null;
  readonly safeMetadata: string | null;
  readonly createdAt: number;
}

export interface InsertSnapshotComponentInput {
  readonly id?: string;
  readonly snapshotId: string;
  readonly componentVersionId: string;
  readonly sourceScope: string;
  readonly sourcePointer?: string;
  readonly installationId?: string | null;
  readonly safeMetadata?: string | null;
  readonly createdAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed component ecosystem store
export class SnapshotComponentStore {
  static async insert(queryable: Queryable, input: InsertSnapshotComponentInput): Promise<string> {
    const now = Date.now();
    const id =
      input.id ??
      deterministicSnapshotComponentId(
        input.snapshotId,
        input.componentVersionId,
        input.sourceScope,
        input.sourcePointer ?? '',
      );
    await queryable.exec(
      `INSERT INTO snapshot_components (
        id, snapshot_id, component_version_id, source_scope, source_pointer, installation_id,
        safe_metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.snapshotId,
        input.componentVersionId,
        input.sourceScope,
        input.sourcePointer ?? '',
        input.installationId ?? null,
        input.safeMetadata ?? null,
        input.createdAt ?? now,
      ],
    );
    return id;
  }

  static async getById(
    queryable: Queryable,
    snapshotId: string,
    id: string,
  ): Promise<SnapshotComponent | undefined> {
    const { rows } = await queryable.exec(
      `SELECT id, snapshot_id, component_version_id, source_scope, source_pointer, installation_id,
              safe_metadata, created_at
       FROM snapshot_components WHERE id = ? AND snapshot_id = ?`,
      [id, snapshotId],
    );
    if (rows.length === 0) return undefined;
    return SnapshotComponentStore.rowToSnapshotComponent(rows[0]);
  }

  static async listBySnapshot(
    queryable: Queryable,
    snapshotId: string,
  ): Promise<readonly SnapshotComponent[]> {
    const { rows } = await queryable.exec(
      `SELECT id, snapshot_id, component_version_id, source_scope, source_pointer, installation_id,
              safe_metadata, created_at
       FROM snapshot_components WHERE snapshot_id = ? ORDER BY component_version_id`,
      [snapshotId],
    );
    return rows.map(SnapshotComponentStore.rowToSnapshotComponent);
  }

  static async listByComponentVersion(
    queryable: Queryable,
    componentVersionId: string,
  ): Promise<readonly SnapshotComponent[]> {
    const { rows } = await queryable.exec(
      `SELECT id, snapshot_id, component_version_id, source_scope, source_pointer, installation_id,
              safe_metadata, created_at
       FROM snapshot_components WHERE component_version_id = ? ORDER BY snapshot_id`,
      [componentVersionId],
    );
    return rows.map(SnapshotComponentStore.rowToSnapshotComponent);
  }

  static async delete(queryable: Queryable, snapshotId: string, id: string): Promise<void> {
    await queryable.exec('DELETE FROM snapshot_components WHERE id = ? AND snapshot_id = ?', [
      id,
      snapshotId,
    ]);
  }

  private static rowToSnapshotComponent(row: SqliteRow): SnapshotComponent {
    return {
      id: asString(row.id),
      snapshotId: asString(row.snapshot_id),
      componentVersionId: asString(row.component_version_id),
      sourceScope: asString(row.source_scope),
      sourcePointer: asString(row.source_pointer),
      installationId: toOptionalString(row.installation_id),
      safeMetadata: toOptionalString(row.safe_metadata),
      createdAt: toNumber(row.created_at),
    };
  }
}

export interface ComponentLifecycleEvent {
  readonly id: string;
  readonly componentId: string;
  readonly environmentId: string;
  readonly eventType: string;
  readonly beforeVersionId: string | null;
  readonly afterVersionId: string | null;
  readonly concurrentEventGroupId: string | null;
  readonly snapshotId: string | null;
  readonly generationId: string | null;
  readonly source: string | null;
  readonly safeMetadata: string | null;
  readonly createdAt: number;
}

export interface InsertComponentLifecycleEventInput {
  readonly id?: string;
  readonly componentId: string;
  readonly environmentId: string;
  readonly eventType: string;
  readonly beforeVersionId?: string | null;
  readonly afterVersionId?: string | null;
  readonly concurrentEventGroupId?: string | null;
  readonly snapshotId?: string | null;
  readonly generationId?: string | null;
  readonly source?: string | null;
  readonly safeMetadata?: string | null;
  readonly createdAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed component ecosystem store
export class ComponentLifecycleEventStore {
  static async insert(
    queryable: Queryable,
    input: InsertComponentLifecycleEventInput,
  ): Promise<string> {
    const now = Date.now();
    const id =
      input.id ??
      `cle-${deterministicId(
        'component-lifecycle-event',
        input.componentId,
        input.environmentId,
        input.eventType,
        input.beforeVersionId ?? '',
        input.afterVersionId ?? '',
        String(input.createdAt ?? now),
      )}`;
    await queryable.exec(
      `INSERT INTO component_lifecycle_events (
        id, component_id, environment_id, event_type, before_version_id, after_version_id,
        concurrent_event_group_id, snapshot_id, generation_id, source, safe_metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.componentId,
        input.environmentId,
        input.eventType,
        input.beforeVersionId ?? null,
        input.afterVersionId ?? null,
        input.concurrentEventGroupId ?? null,
        input.snapshotId ?? null,
        input.generationId ?? null,
        input.source ?? null,
        input.safeMetadata ?? null,
        input.createdAt ?? now,
      ],
    );
    return id;
  }

  static async getById(
    queryable: Queryable,
    componentId: string,
    id: string,
  ): Promise<ComponentLifecycleEvent | undefined> {
    const { rows } = await queryable.exec(
      `SELECT id, component_id, environment_id, event_type, before_version_id, after_version_id,
              concurrent_event_group_id, snapshot_id, generation_id, source, safe_metadata,
              created_at
       FROM component_lifecycle_events WHERE id = ? AND component_id = ?`,
      [id, componentId],
    );
    if (rows.length === 0) return undefined;
    return ComponentLifecycleEventStore.rowToComponentLifecycleEvent(rows[0]);
  }

  static async listByComponent(
    queryable: Queryable,
    componentId: string,
  ): Promise<readonly ComponentLifecycleEvent[]> {
    const { rows } = await queryable.exec(
      `SELECT id, component_id, environment_id, event_type, before_version_id, after_version_id,
              concurrent_event_group_id, snapshot_id, generation_id, source, safe_metadata,
              created_at
       FROM component_lifecycle_events
       WHERE component_id = ?
       ORDER BY created_at`,
      [componentId],
    );
    return rows.map(ComponentLifecycleEventStore.rowToComponentLifecycleEvent);
  }

  static async listByEnvironment(
    queryable: Queryable,
    environmentId: string,
  ): Promise<readonly ComponentLifecycleEvent[]> {
    const { rows } = await queryable.exec(
      `SELECT id, component_id, environment_id, event_type, before_version_id, after_version_id,
              concurrent_event_group_id, snapshot_id, generation_id, source, safe_metadata,
              created_at
       FROM component_lifecycle_events
       WHERE environment_id = ?
       ORDER BY created_at`,
      [environmentId],
    );
    return rows.map(ComponentLifecycleEventStore.rowToComponentLifecycleEvent);
  }

  static async delete(queryable: Queryable, componentId: string, id: string): Promise<void> {
    await queryable.exec(
      'DELETE FROM component_lifecycle_events WHERE id = ? AND component_id = ?',
      [id, componentId],
    );
  }

  private static rowToComponentLifecycleEvent(row: SqliteRow): ComponentLifecycleEvent {
    return {
      id: asString(row.id),
      componentId: asString(row.component_id),
      environmentId: asString(row.environment_id),
      eventType: asString(row.event_type),
      beforeVersionId: toOptionalString(row.before_version_id),
      afterVersionId: toOptionalString(row.after_version_id),
      concurrentEventGroupId: toOptionalString(row.concurrent_event_group_id),
      snapshotId: toOptionalString(row.snapshot_id),
      generationId: toOptionalString(row.generation_id),
      source: toOptionalString(row.source),
      safeMetadata: toOptionalString(row.safe_metadata),
      createdAt: toNumber(row.created_at),
    };
  }
}

export interface ComponentAvailabilityEvent {
  readonly id: string;
  readonly componentId: string;
  readonly environmentId: string;
  readonly sessionId: string | null;
  readonly eventType: string;
  readonly snapshotId: string | null;
  readonly generationId: string | null;
  readonly startTime: number;
  readonly endTime: number | null;
  readonly source: string | null;
  readonly safeMetadata: string | null;
  readonly createdAt: number;
}

export interface InsertComponentAvailabilityEventInput {
  readonly id?: string;
  readonly componentId: string;
  readonly environmentId: string;
  readonly sessionId?: string | null;
  readonly eventType: string;
  readonly snapshotId?: string | null;
  readonly generationId?: string | null;
  readonly startTime: number;
  readonly endTime?: number | null;
  readonly source?: string | null;
  readonly safeMetadata?: string | null;
  readonly createdAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed component ecosystem store
export class ComponentAvailabilityEventStore {
  static async insert(
    queryable: Queryable,
    input: InsertComponentAvailabilityEventInput,
  ): Promise<string> {
    const now = Date.now();
    const id =
      input.id ??
      `cae-${deterministicId(
        'component-availability-event',
        input.componentId,
        input.environmentId,
        input.eventType,
        String(input.startTime),
      )}`;
    await queryable.exec(
      `INSERT INTO component_availability_events (
        id, component_id, environment_id, session_id, event_type, snapshot_id, generation_id,
        start_time, end_time, source, safe_metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.componentId,
        input.environmentId,
        input.sessionId ?? null,
        input.eventType,
        input.snapshotId ?? null,
        input.generationId ?? null,
        input.startTime,
        input.endTime ?? null,
        input.source ?? null,
        input.safeMetadata ?? null,
        input.createdAt ?? now,
      ],
    );
    return id;
  }

  static async getById(
    queryable: Queryable,
    componentId: string,
    id: string,
  ): Promise<ComponentAvailabilityEvent | undefined> {
    const { rows } = await queryable.exec(
      `SELECT id, component_id, environment_id, session_id, event_type, snapshot_id, generation_id,
              start_time, end_time, source, safe_metadata, created_at
       FROM component_availability_events WHERE id = ? AND component_id = ?`,
      [id, componentId],
    );
    if (rows.length === 0) return undefined;
    return ComponentAvailabilityEventStore.rowToComponentAvailabilityEvent(rows[0]);
  }

  static async listByComponent(
    queryable: Queryable,
    componentId: string,
  ): Promise<readonly ComponentAvailabilityEvent[]> {
    const { rows } = await queryable.exec(
      `SELECT id, component_id, environment_id, session_id, event_type, snapshot_id, generation_id,
              start_time, end_time, source, safe_metadata, created_at
       FROM component_availability_events
       WHERE component_id = ?
       ORDER BY start_time`,
      [componentId],
    );
    return rows.map(ComponentAvailabilityEventStore.rowToComponentAvailabilityEvent);
  }

  static async listByEnvironment(
    queryable: Queryable,
    environmentId: string,
  ): Promise<readonly ComponentAvailabilityEvent[]> {
    const { rows } = await queryable.exec(
      `SELECT id, component_id, environment_id, session_id, event_type, snapshot_id, generation_id,
              start_time, end_time, source, safe_metadata, created_at
       FROM component_availability_events
       WHERE environment_id = ?
       ORDER BY start_time`,
      [environmentId],
    );
    return rows.map(ComponentAvailabilityEventStore.rowToComponentAvailabilityEvent);
  }

  static async delete(queryable: Queryable, componentId: string, id: string): Promise<void> {
    await queryable.exec(
      'DELETE FROM component_availability_events WHERE id = ? AND component_id = ?',
      [id, componentId],
    );
  }

  private static rowToComponentAvailabilityEvent(row: SqliteRow): ComponentAvailabilityEvent {
    return {
      id: asString(row.id),
      componentId: asString(row.component_id),
      environmentId: asString(row.environment_id),
      sessionId: toOptionalString(row.session_id),
      eventType: asString(row.event_type),
      snapshotId: toOptionalString(row.snapshot_id),
      generationId: toOptionalString(row.generation_id),
      startTime: toNumber(row.start_time),
      endTime: toOptionalString(row.end_time) === null ? null : toNumber(row.end_time),
      source: toOptionalString(row.source),
      safeMetadata: toOptionalString(row.safe_metadata),
      createdAt: toNumber(row.created_at),
    };
  }
}

export interface ComponentContextEvent {
  readonly id: string;
  readonly componentId: string;
  readonly environmentId: string;
  readonly sessionId: string | null;
  readonly eventType: string;
  readonly snapshotId: string | null;
  readonly generationId: string | null;
  readonly startTime: number;
  readonly endTime: number | null;
  readonly sourcePointer: string;
  readonly source: string | null;
  readonly safeMetadata: string | null;
  readonly createdAt: number;
}

export interface InsertComponentContextEventInput {
  readonly id?: string;
  readonly componentId: string;
  readonly environmentId: string;
  readonly sessionId?: string | null;
  readonly eventType: string;
  readonly snapshotId?: string | null;
  readonly generationId?: string | null;
  readonly startTime: number;
  readonly endTime?: number | null;
  readonly sourcePointer?: string;
  readonly source?: string | null;
  readonly safeMetadata?: string | null;
  readonly createdAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed component ecosystem store
export class ComponentContextEventStore {
  static async insert(
    queryable: Queryable,
    input: InsertComponentContextEventInput,
  ): Promise<string> {
    const now = Date.now();
    const id =
      input.id ??
      `cce-${deterministicId(
        'component-context-event',
        input.componentId,
        input.environmentId,
        input.eventType,
        String(input.startTime),
      )}`;
    await queryable.exec(
      `INSERT INTO component_context_events (
        id, component_id, environment_id, session_id, event_type, snapshot_id, generation_id,
        start_time, end_time, source_pointer, source, safe_metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.componentId,
        input.environmentId,
        input.sessionId ?? null,
        input.eventType,
        input.snapshotId ?? null,
        input.generationId ?? null,
        input.startTime,
        input.endTime ?? null,
        input.sourcePointer ?? '',
        input.source ?? null,
        input.safeMetadata ?? null,
        input.createdAt ?? now,
      ],
    );
    return id;
  }

  static async getById(
    queryable: Queryable,
    componentId: string,
    id: string,
  ): Promise<ComponentContextEvent | undefined> {
    const { rows } = await queryable.exec(
      `SELECT id, component_id, environment_id, session_id, event_type, snapshot_id, generation_id,
              start_time, end_time, source_pointer, source, safe_metadata, created_at
       FROM component_context_events WHERE id = ? AND component_id = ?`,
      [id, componentId],
    );
    if (rows.length === 0) return undefined;
    return ComponentContextEventStore.rowToComponentContextEvent(rows[0]);
  }

  static async listByComponent(
    queryable: Queryable,
    componentId: string,
  ): Promise<readonly ComponentContextEvent[]> {
    const { rows } = await queryable.exec(
      `SELECT id, component_id, environment_id, session_id, event_type, snapshot_id, generation_id,
              start_time, end_time, source_pointer, source, safe_metadata, created_at
       FROM component_context_events
       WHERE component_id = ?
       ORDER BY start_time`,
      [componentId],
    );
    return rows.map(ComponentContextEventStore.rowToComponentContextEvent);
  }

  static async listByEnvironment(
    queryable: Queryable,
    environmentId: string,
  ): Promise<readonly ComponentContextEvent[]> {
    const { rows } = await queryable.exec(
      `SELECT id, component_id, environment_id, session_id, event_type, snapshot_id, generation_id,
              start_time, end_time, source_pointer, source, safe_metadata, created_at
       FROM component_context_events
       WHERE environment_id = ?
       ORDER BY start_time`,
      [environmentId],
    );
    return rows.map(ComponentContextEventStore.rowToComponentContextEvent);
  }

  static async delete(queryable: Queryable, componentId: string, id: string): Promise<void> {
    await queryable.exec('DELETE FROM component_context_events WHERE id = ? AND component_id = ?', [
      id,
      componentId,
    ]);
  }

  private static rowToComponentContextEvent(row: SqliteRow): ComponentContextEvent {
    return {
      id: asString(row.id),
      componentId: asString(row.component_id),
      environmentId: asString(row.environment_id),
      sessionId: toOptionalString(row.session_id),
      eventType: asString(row.event_type),
      snapshotId: toOptionalString(row.snapshot_id),
      generationId: toOptionalString(row.generation_id),
      startTime: toNumber(row.start_time),
      endTime: toOptionalString(row.end_time) === null ? null : toNumber(row.end_time),
      sourcePointer: asString(row.source_pointer),
      source: toOptionalString(row.source),
      safeMetadata: toOptionalString(row.safe_metadata),
      createdAt: toNumber(row.created_at),
    };
  }
}

export interface SessionComponentExposure {
  readonly id: string;
  readonly sessionId: string;
  readonly componentId: string;
  readonly environmentId: string;
  readonly status: string;
  readonly startSequence: number;
  readonly endSequence: number | null;
  readonly startTime: number;
  readonly endTime: number | null;
  readonly snapshotId: string | null;
  readonly generationId: string | null;
  readonly safeMetadata: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertSessionComponentExposureInput {
  readonly id?: string;
  readonly sessionId: string;
  readonly componentId: string;
  readonly environmentId: string;
  readonly status: string;
  readonly startSequence: number;
  readonly endSequence?: number | null;
  readonly startTime: number;
  readonly endTime?: number | null;
  readonly snapshotId?: string | null;
  readonly generationId?: string | null;
  readonly safeMetadata?: string | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed component ecosystem store
export class SessionComponentExposureStore {
  static async insert(
    queryable: Queryable,
    input: InsertSessionComponentExposureInput,
  ): Promise<string> {
    const now = Date.now();
    const id =
      input.id ??
      `sce-${deterministicId(
        'session-component-exposure',
        input.sessionId,
        input.componentId,
        input.status,
        String(input.startSequence),
        String(input.generationId ?? ''),
      )}`;
    await queryable.exec(
      `INSERT INTO session_component_exposures (
        id, session_id, component_id, environment_id, status, start_sequence, end_sequence,
        start_time, end_time, snapshot_id, generation_id, safe_metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.sessionId,
        input.componentId,
        input.environmentId,
        input.status,
        input.startSequence,
        input.endSequence ?? null,
        input.startTime,
        input.endTime ?? null,
        input.snapshotId ?? null,
        input.generationId ?? null,
        input.safeMetadata ?? null,
        input.createdAt ?? now,
        input.updatedAt ?? now,
      ],
    );
    return id;
  }

  static async getById(
    queryable: Queryable,
    sessionId: string,
    id: string,
  ): Promise<SessionComponentExposure | undefined> {
    const { rows } = await queryable.exec(
      `SELECT id, session_id, component_id, environment_id, status, start_sequence, end_sequence,
              start_time, end_time, snapshot_id, generation_id, safe_metadata, created_at, updated_at
       FROM session_component_exposures WHERE id = ? AND session_id = ?`,
      [id, sessionId],
    );
    if (rows.length === 0) return undefined;
    return SessionComponentExposureStore.rowToSessionComponentExposure(rows[0]);
  }

  static async listBySession(
    queryable: Queryable,
    sessionId: string,
  ): Promise<readonly SessionComponentExposure[]> {
    const { rows } = await queryable.exec(
      `SELECT id, session_id, component_id, environment_id, status, start_sequence, end_sequence,
              start_time, end_time, snapshot_id, generation_id, safe_metadata, created_at, updated_at
       FROM session_component_exposures
       WHERE session_id = ?
       ORDER BY start_sequence`,
      [sessionId],
    );
    return rows.map(SessionComponentExposureStore.rowToSessionComponentExposure);
  }

  static async listByComponent(
    queryable: Queryable,
    componentId: string,
  ): Promise<readonly SessionComponentExposure[]> {
    const { rows } = await queryable.exec(
      `SELECT id, session_id, component_id, environment_id, status, start_sequence, end_sequence,
              start_time, end_time, snapshot_id, generation_id, safe_metadata, created_at, updated_at
       FROM session_component_exposures
       WHERE component_id = ?
       ORDER BY start_time`,
      [componentId],
    );
    return rows.map(SessionComponentExposureStore.rowToSessionComponentExposure);
  }

  static async update(
    queryable: Queryable,
    sessionId: string,
    id: string,
    input: {
      readonly endSequence?: number | null;
      readonly endTime?: number | null;
      readonly safeMetadata?: string | null;
      readonly updatedAt?: number;
    },
  ): Promise<void> {
    await queryable.exec(
      `UPDATE session_component_exposures
       SET end_sequence = ?, end_time = ?, safe_metadata = ?, updated_at = ?
       WHERE id = ? AND session_id = ?`,
      [
        input.endSequence ?? null,
        input.endTime ?? null,
        input.safeMetadata ?? null,
        input.updatedAt ?? Date.now(),
        id,
        sessionId,
      ],
    );
  }

  static async delete(queryable: Queryable, sessionId: string, id: string): Promise<void> {
    await queryable.exec(
      'DELETE FROM session_component_exposures WHERE id = ? AND session_id = ?',
      [id, sessionId],
    );
  }

  private static rowToSessionComponentExposure(row: SqliteRow): SessionComponentExposure {
    return {
      id: asString(row.id),
      sessionId: asString(row.session_id),
      componentId: asString(row.component_id),
      environmentId: asString(row.environment_id),
      status: asString(row.status),
      startSequence: toNumber(row.start_sequence),
      endSequence: toOptionalString(row.end_sequence) === null ? null : toNumber(row.end_sequence),
      startTime: toNumber(row.start_time),
      endTime: toOptionalString(row.end_time) === null ? null : toNumber(row.end_time),
      snapshotId: toOptionalString(row.snapshot_id),
      generationId: toOptionalString(row.generation_id),
      safeMetadata: toOptionalString(row.safe_metadata),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }
}
