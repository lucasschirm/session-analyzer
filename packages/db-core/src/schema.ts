import {
  COMPONENT_ECOSYSTEM_DDL,
  COMPONENT_ECOSYSTEM_MIGRATIONS_FRAGMENT,
} from './component-ecosystem.js';
import {
  CREATE_ARTIFACT_BLOBS_TABLE,
  CREATE_ARTIFACT_REFERENCES_TABLE,
  CREATE_MANIFEST_ARTIFACTS_TABLE,
  CREATE_MANIFEST_COVERAGE_TABLE,
  CREATE_RETENTION_POLICIES_TABLE,
  CREATE_SOURCE_LOCATIONS_TABLE,
  CREATE_SOURCE_MANIFESTS_TABLE,
  CREATE_SOURCE_TOMBSTONES_TABLE,
  MANIFEST_MIGRATIONS_FRAGMENT,
} from './manifest.js';
import { METRICS_DDL, METRICS_MIGRATIONS_FRAGMENT } from './metrics.js';
import type { Migration } from './migrations.js';
import { ROLLUPS_DDL, ROLLUPS_MIGRATIONS_FRAGMENT } from './rollups.js';
import { SESSION_EVIDENCE_DDL, SESSION_EVIDENCE_MIGRATIONS_FRAGMENT } from './session-evidence.js';

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

/**
 * Canonical analytics schema name stored in `schema_metadata`.
 */
export const ANALYTICS_SCHEMA_NAME = 'sal-analytics';

const CREATE_SCHEMA_METADATA_TABLE = `
CREATE TABLE IF NOT EXISTS schema_metadata (
  schema_name TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  initialized_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
`;

const CREATE_SCHEMA_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sql TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
) STRICT;
`;

const CREATE_ANALYSIS_RELEASES_TABLE = `
CREATE TABLE IF NOT EXISTS analysis_releases (
  id TEXT PRIMARY KEY,
  ontology_version TEXT NOT NULL,
  metric_registry_version TEXT NOT NULL,
  statistical_policy_version TEXT NOT NULL,
  rollup_policy_version TEXT NOT NULL,
  mapping_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_releases_default
  ON analysis_releases(is_default) WHERE is_default = 1;

CREATE INDEX IF NOT EXISTS idx_analysis_releases_created
  ON analysis_releases(created_at);
`;

const CREATE_TRANSFORMATION_GENERATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS transformation_generations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  analysis_release_id TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  transformer_version TEXT NOT NULL,
  ontology_version TEXT NOT NULL,
  metric_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'failed', 'superseded')),
  source_availability TEXT NOT NULL CHECK (source_availability IN ('local', 'remote_reacquirable', 'unavailable')),
  created_at INTEGER NOT NULL,
  committed_at INTEGER,
  superseded_by_id TEXT,
  superseded_at INTEGER,
  FOREIGN KEY (analysis_release_id) REFERENCES analysis_releases(id),
  FOREIGN KEY (superseded_by_id) REFERENCES transformation_generations(id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_transformation_generations_session
  ON transformation_generations(session_id);

CREATE INDEX IF NOT EXISTS idx_transformation_generations_status
  ON transformation_generations(status);

CREATE INDEX IF NOT EXISTS idx_transformation_generations_session_status
  ON transformation_generations(session_id, status);

CREATE INDEX IF NOT EXISTS idx_transformation_generations_superseded
  ON transformation_generations(superseded_by_id);
`;

const CREATE_INGESTION_ISSUES_TABLE = `
CREATE TABLE IF NOT EXISTS ingestion_issues (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('fatal', 'recoverable')),
  issue_code TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (generation_id) REFERENCES transformation_generations(id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ingestion_issues_generation
  ON ingestion_issues(generation_id);

CREATE INDEX IF NOT EXISTS idx_ingestion_issues_code
  ON ingestion_issues(issue_code);

CREATE INDEX IF NOT EXISTS idx_ingestion_issues_entity
  ON ingestion_issues(entity_type, entity_id);
`;

const CREATE_SESSIONS_TABLE = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  ingestion_source_id TEXT NOT NULL,
  environment_id TEXT,
  harness TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  current_generation_id TEXT,
  occurrence_time INTEGER,
  finality TEXT NOT NULL DEFAULT 'open' CHECK (finality IN ('open', 'final', 'censored')),
  mode TEXT,
  task_cohort TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (current_generation_id) REFERENCES transformation_generations(id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_sessions_project
  ON sessions(project_id);

CREATE INDEX IF NOT EXISTS idx_sessions_current_generation
  ON sessions(current_generation_id);

CREATE INDEX IF NOT EXISTS idx_sessions_native
  ON sessions(ingestion_source_id, native_session_id);
`;

const CREATE_TENANTS_TABLE = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  trusted_authority TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tenants_name ON tenants(name);
`;

const CREATE_PORTFOLIOS_TABLE = `
CREATE TABLE IF NOT EXISTS portfolios (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolios_tenant_name ON portfolios(tenant_id, name);
CREATE INDEX IF NOT EXISTS idx_portfolios_name ON portfolios(name);
`;

const CREATE_INGESTION_SOURCES_TABLE = `
CREATE TABLE IF NOT EXISTS ingestion_sources (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL,
  native_source_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  type TEXT NOT NULL,
  authority TEXT NOT NULL,
  supports_cursor INTEGER NOT NULL DEFAULT 0,
  supports_checkpoint INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ingestion_sources_portfolio_native ON ingestion_sources(portfolio_id, native_source_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_sources_type ON ingestion_sources(type);
`;

const CREATE_ENVIRONMENTS_TABLE = `
CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  ingestion_source_id TEXT NOT NULL,
  native_environment_id TEXT,
  user_profile TEXT,
  device_profile TEXT,
  harness_home TEXT,
  config_root TEXT,
  integration_installation TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (ingestion_source_id) REFERENCES ingestion_sources(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_environments_ingestion_native
  ON environments(ingestion_source_id, native_environment_id) WHERE native_environment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_environments_ingestion ON environments(ingestion_source_id);
`;

const CREATE_PROJECTS_TABLE = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_portfolio_name ON projects(portfolio_id, name);
CREATE INDEX IF NOT EXISTS idx_projects_portfolio ON projects(portfolio_id);
`;

const CREATE_SOURCE_PROJECTS_TABLE = `
CREATE TABLE IF NOT EXISTS source_projects (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  ingestion_source_id TEXT NOT NULL,
  native_project_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (ingestion_source_id) REFERENCES ingestion_sources(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_source_projects_native ON source_projects(ingestion_source_id, native_project_id);
CREATE INDEX IF NOT EXISTS idx_source_projects_project ON source_projects(project_id);
`;

const CREATE_PROJECT_MAPPINGS_TABLE = `
CREATE TABLE IF NOT EXISTS project_mappings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  prior_project_id TEXT,
  source_project_id TEXT,
  ingestion_source_id TEXT NOT NULL,
  native_project_id TEXT NOT NULL,
  mapping_type TEXT NOT NULL CHECK (mapping_type IN ('create', 'merge', 'split', 'reassign')),
  actor TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (prior_project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY (source_project_id) REFERENCES source_projects(id) ON DELETE SET NULL,
  FOREIGN KEY (ingestion_source_id) REFERENCES ingestion_sources(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_project_mappings_project ON project_mappings(project_id);
CREATE INDEX IF NOT EXISTS idx_project_mappings_prior ON project_mappings(prior_project_id);
CREATE INDEX IF NOT EXISTS idx_project_mappings_source ON project_mappings(source_project_id);
CREATE INDEX IF NOT EXISTS idx_project_mappings_type ON project_mappings(mapping_type);
CREATE INDEX IF NOT EXISTS idx_project_mappings_created ON project_mappings(created_at);
`;

const CREATE_REPOSITORIES_TABLE = `
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  remote_url_safe TEXT,
  vcs_kind TEXT,
  default_branch TEXT,
  safe_metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_repositories_project ON repositories(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_repositories_project_url
  ON repositories(project_id, remote_url_safe) WHERE remote_url_safe IS NOT NULL;
`;

const CREATE_WORKSPACES_TABLE = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  repository_id TEXT,
  native_workspace_id TEXT,
  scope_chain TEXT,
  path TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_workspaces_project ON workspaces(project_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_repository ON workspaces(repository_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_project_native
  ON workspaces(project_id, native_workspace_id) WHERE native_workspace_id IS NOT NULL;
`;

/**
 * Forward migration history for the analytics schema.
 *
 * Each migration is a named, ordered, checksummed DDL block. The
 * {@link MigrationRunner} applies pending migrations one at a time inside a
 * transaction and records each one in `schema_migrations`. Running all
 * migrations in order on an empty database produces the current schema.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'create-schema-control-tables',
    sql: `${CREATE_SCHEMA_METADATA_TABLE}\n${CREATE_SCHEMA_MIGRATIONS_TABLE}`,
    checksum: checksumOf(`${CREATE_SCHEMA_METADATA_TABLE}\n${CREATE_SCHEMA_MIGRATIONS_TABLE}`),
  },
  {
    id: 2,
    name: 'create-analysis-releases',
    sql: CREATE_ANALYSIS_RELEASES_TABLE,
    checksum: checksumOf(CREATE_ANALYSIS_RELEASES_TABLE),
  },
  {
    id: 3,
    name: 'create-transformation-generations',
    sql: CREATE_TRANSFORMATION_GENERATIONS_TABLE,
    checksum: checksumOf(CREATE_TRANSFORMATION_GENERATIONS_TABLE),
  },
  {
    id: 4,
    name: 'create-ingestion-issues',
    sql: CREATE_INGESTION_ISSUES_TABLE,
    checksum: checksumOf(CREATE_INGESTION_ISSUES_TABLE),
  },
  {
    id: 5,
    name: 'create-sessions-generation-authority',
    sql: CREATE_SESSIONS_TABLE,
    checksum: checksumOf(CREATE_SESSIONS_TABLE),
  },
  {
    id: 6,
    name: 'create-tenants',
    sql: CREATE_TENANTS_TABLE,
    checksum: checksumOf(CREATE_TENANTS_TABLE),
  },
  {
    id: 7,
    name: 'create-portfolios',
    sql: CREATE_PORTFOLIOS_TABLE,
    checksum: checksumOf(CREATE_PORTFOLIOS_TABLE),
  },
  {
    id: 8,
    name: 'create-ingestion-sources',
    sql: CREATE_INGESTION_SOURCES_TABLE,
    checksum: checksumOf(CREATE_INGESTION_SOURCES_TABLE),
  },
  {
    id: 9,
    name: 'create-environments',
    sql: CREATE_ENVIRONMENTS_TABLE,
    checksum: checksumOf(CREATE_ENVIRONMENTS_TABLE),
  },
  {
    id: 10,
    name: 'create-projects',
    sql: CREATE_PROJECTS_TABLE,
    checksum: checksumOf(CREATE_PROJECTS_TABLE),
  },
  {
    id: 11,
    name: 'create-source-projects',
    sql: CREATE_SOURCE_PROJECTS_TABLE,
    checksum: checksumOf(CREATE_SOURCE_PROJECTS_TABLE),
  },
  {
    id: 12,
    name: 'create-project-mappings',
    sql: CREATE_PROJECT_MAPPINGS_TABLE,
    checksum: checksumOf(CREATE_PROJECT_MAPPINGS_TABLE),
  },
  {
    id: 13,
    name: 'create-repositories',
    sql: CREATE_REPOSITORIES_TABLE,
    checksum: checksumOf(CREATE_REPOSITORIES_TABLE),
  },
  {
    id: 14,
    name: 'create-workspaces',
    sql: CREATE_WORKSPACES_TABLE,
    checksum: checksumOf(CREATE_WORKSPACES_TABLE),
  },
  ...MANIFEST_MIGRATIONS_FRAGMENT,
  ...COMPONENT_ECOSYSTEM_MIGRATIONS_FRAGMENT,
  ...SESSION_EVIDENCE_MIGRATIONS_FRAGMENT,
  ...METRICS_MIGRATIONS_FRAGMENT,
  ...ROLLUPS_MIGRATIONS_FRAGMENT,
].sort((a, b) => a.id - b.id);

/**
 * Full current schema as a single DDL script. This is the target state used by
 * the "fresh schema equals sequentially upgraded schema" parity test. It must
 * produce the same tables, indexes, and constraints as {@link MIGRATIONS}.
 */
export const FRESH_SCHEMA_SQL = `
${CREATE_SCHEMA_METADATA_TABLE}
${CREATE_SCHEMA_MIGRATIONS_TABLE}
${CREATE_ANALYSIS_RELEASES_TABLE}
${CREATE_TRANSFORMATION_GENERATIONS_TABLE}
${CREATE_INGESTION_ISSUES_TABLE}
${CREATE_SESSIONS_TABLE}
${CREATE_TENANTS_TABLE}
${CREATE_PORTFOLIOS_TABLE}
${CREATE_INGESTION_SOURCES_TABLE}
${CREATE_ENVIRONMENTS_TABLE}
${CREATE_PROJECTS_TABLE}
${CREATE_SOURCE_PROJECTS_TABLE}
${CREATE_PROJECT_MAPPINGS_TABLE}
${CREATE_REPOSITORIES_TABLE}
${CREATE_WORKSPACES_TABLE}
${CREATE_SOURCE_MANIFESTS_TABLE}
${CREATE_MANIFEST_COVERAGE_TABLE}
${CREATE_MANIFEST_ARTIFACTS_TABLE}
${CREATE_ARTIFACT_BLOBS_TABLE}
${CREATE_ARTIFACT_REFERENCES_TABLE}
${CREATE_SOURCE_LOCATIONS_TABLE}
${CREATE_RETENTION_POLICIES_TABLE}
${CREATE_SOURCE_TOMBSTONES_TABLE}
${COMPONENT_ECOSYSTEM_DDL}
${SESSION_EVIDENCE_DDL}
${METRICS_DDL}
${ROLLUPS_DDL}
`;

/** SQL that creates just the migration-control tables. */
export const CREATE_SCHEMA_CONTROL_TABLES_SQL = `
${CREATE_SCHEMA_METADATA_TABLE}
${CREATE_SCHEMA_MIGRATIONS_TABLE}
`;
