import type {
  MaybePromise,
  SqliteExecutor,
  SqliteRow,
  SqliteTransaction,
  SqliteValue,
} from './contract.js';

/**
 * Pure-JS FNV-1a 64-bit hash used for deterministic identity ids.
 *
 * db-core must not import a runtime crypto or SQLite implementation, so this
 * is kept self-contained.
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

function toHex(value: bigint): string {
  return value.toString(16).padStart(16, '0');
}

export function deterministicId(...parts: readonly string[]): string {
  return toHex(fnv1a64(parts.join('\x00')));
}

export function deterministicPortfolioId(tenantId: string, name: string): string {
  return `pf-${deterministicId('portfolio', tenantId, name)}`;
}

export function deterministicIngestionSourceId(
  portfolioId: string,
  nativeSourceId: string,
): string {
  return `src-${deterministicId('ingestion-source', portfolioId, nativeSourceId)}`;
}

export function deterministicEnvironmentId(
  ingestionSourceId: string,
  nativeEnvironmentId: string,
): string {
  return `env-${deterministicId('environment', ingestionSourceId, nativeEnvironmentId)}`;
}

export function deterministicSourceProjectId(
  ingestionSourceId: string,
  nativeProjectId: string,
): string {
  return `sp-${deterministicId('source-project', ingestionSourceId, nativeProjectId)}`;
}

export function deterministicProjectMappingId(...parts: readonly string[]): string {
  return `pm-${deterministicId('project-mapping', ...parts)}`;
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

function toBoolean(value: SqliteValue): boolean {
  return value === 1 || value === true;
}

export interface Tenant {
  readonly id: string;
  readonly name: string;
  readonly trustedAuthority: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertTenantInput {
  readonly id: string;
  readonly name: string;
  readonly trustedAuthority?: string | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed identity store
export class TenantStore {
  static async insert(queryable: Queryable, input: InsertTenantInput): Promise<void> {
    const now = Date.now();
    await queryable.exec(
      `INSERT INTO tenants (id, name, trusted_authority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        input.id,
        input.name,
        input.trustedAuthority ?? null,
        input.createdAt ?? now,
        input.updatedAt ?? now,
      ],
    );
  }

  static async getById(queryable: Queryable, id: string): Promise<Tenant | undefined> {
    const { rows } = await queryable.exec('SELECT * FROM tenants WHERE id = ?', [id]);
    if (rows.length === 0) return undefined;
    return TenantStore.rowToTenant(rows[0]);
  }

  static async list(queryable: Queryable): Promise<readonly Tenant[]> {
    const { rows } = await queryable.exec('SELECT * FROM tenants ORDER BY name');
    return rows.map(TenantStore.rowToTenant);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: {
      readonly name: string;
      readonly trustedAuthority?: string | null;
      readonly updatedAt?: number;
    },
  ): Promise<void> {
    await queryable.exec(
      'UPDATE tenants SET name = ?, trusted_authority = ?, updated_at = ? WHERE id = ?',
      [input.name, input.trustedAuthority ?? null, input.updatedAt ?? Date.now(), id],
    );
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM tenants WHERE id = ?', [id]);
  }

  private static rowToTenant(row: SqliteRow): Tenant {
    return {
      id: asString(row.id),
      name: asString(row.name),
      trustedAuthority: toOptionalString(row.trusted_authority),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }
}

export interface Portfolio {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertPortfolioInput {
  readonly id?: string;
  readonly tenantId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed identity store
export class PortfolioStore {
  static async insert(queryable: Queryable, input: InsertPortfolioInput): Promise<string> {
    const now = Date.now();
    const id = input.id ?? deterministicPortfolioId(input.tenantId, input.name);
    await queryable.exec(
      `INSERT INTO portfolios (id, tenant_id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.tenantId,
        input.name,
        input.description ?? null,
        input.createdAt ?? now,
        input.updatedAt ?? now,
      ],
    );
    return id;
  }

  static async getById(
    queryable: Queryable,
    tenantId: string,
    id: string,
  ): Promise<Portfolio | undefined> {
    const { rows } = await queryable.exec(
      'SELECT * FROM portfolios WHERE id = ? AND tenant_id = ?',
      [id, tenantId],
    );
    if (rows.length === 0) return undefined;
    return PortfolioStore.rowToPortfolio(rows[0]);
  }

  static async listByTenant(queryable: Queryable, tenantId: string): Promise<readonly Portfolio[]> {
    const { rows } = await queryable.exec(
      'SELECT * FROM portfolios WHERE tenant_id = ? ORDER BY name',
      [tenantId],
    );
    return rows.map(PortfolioStore.rowToPortfolio);
  }

  static async update(
    queryable: Queryable,
    tenantId: string,
    id: string,
    input: {
      readonly name: string;
      readonly description?: string | null;
      readonly updatedAt?: number;
    },
  ): Promise<void> {
    await queryable.exec(
      'UPDATE portfolios SET name = ?, description = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
      [input.name, input.description ?? null, input.updatedAt ?? Date.now(), id, tenantId],
    );
  }

  static async delete(queryable: Queryable, tenantId: string, id: string): Promise<void> {
    await queryable.exec('DELETE FROM portfolios WHERE id = ? AND tenant_id = ?', [id, tenantId]);
  }

  private static rowToPortfolio(row: SqliteRow): Portfolio {
    return {
      id: asString(row.id),
      tenantId: asString(row.tenant_id),
      name: asString(row.name),
      description: toOptionalString(row.description),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }
}

export interface IngestionSource {
  readonly id: string;
  readonly portfolioId: string;
  readonly nativeSourceId: string;
  readonly displayName: string;
  readonly type: string;
  readonly authority: string;
  readonly supportsCursor: boolean;
  readonly supportsCheckpoint: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertIngestionSourceInput {
  readonly id?: string;
  readonly portfolioId: string;
  readonly nativeSourceId: string;
  readonly displayName: string;
  readonly type: string;
  readonly authority: string;
  readonly supportsCursor?: boolean;
  readonly supportsCheckpoint?: boolean;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed identity store
export class IngestionSourceStore {
  static async insert(queryable: Queryable, input: InsertIngestionSourceInput): Promise<string> {
    const now = Date.now();
    const id = input.id ?? deterministicIngestionSourceId(input.portfolioId, input.nativeSourceId);
    await queryable.exec(
      `INSERT INTO ingestion_sources (
        id, portfolio_id, native_source_id, display_name, type, authority,
        supports_cursor, supports_checkpoint, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.portfolioId,
        input.nativeSourceId,
        input.displayName,
        input.type,
        input.authority,
        input.supportsCursor ? 1 : 0,
        input.supportsCheckpoint ? 1 : 0,
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
  ): Promise<IngestionSource | undefined> {
    const { rows } = await queryable.exec(
      `SELECT id, portfolio_id, native_source_id, display_name, type, authority,
              supports_cursor, supports_checkpoint, created_at, updated_at
       FROM ingestion_sources WHERE id = ? AND portfolio_id = ?`,
      [id, portfolioId],
    );
    if (rows.length === 0) return undefined;
    return IngestionSourceStore.rowToIngestionSource(rows[0]);
  }

  static async getByNativeId(
    queryable: Queryable,
    portfolioId: string,
    nativeSourceId: string,
  ): Promise<IngestionSource | undefined> {
    const { rows } = await queryable.exec(
      `SELECT id, portfolio_id, native_source_id, display_name, type, authority,
              supports_cursor, supports_checkpoint, created_at, updated_at
       FROM ingestion_sources WHERE portfolio_id = ? AND native_source_id = ?`,
      [portfolioId, nativeSourceId],
    );
    if (rows.length === 0) return undefined;
    return IngestionSourceStore.rowToIngestionSource(rows[0]);
  }

  static async listByPortfolio(
    queryable: Queryable,
    portfolioId: string,
  ): Promise<readonly IngestionSource[]> {
    const { rows } = await queryable.exec(
      `SELECT id, portfolio_id, native_source_id, display_name, type, authority,
              supports_cursor, supports_checkpoint, created_at, updated_at
       FROM ingestion_sources WHERE portfolio_id = ? ORDER BY display_name`,
      [portfolioId],
    );
    return rows.map(IngestionSourceStore.rowToIngestionSource);
  }

  static async update(
    queryable: Queryable,
    portfolioId: string,
    id: string,
    input: {
      readonly nativeSourceId: string;
      readonly displayName: string;
      readonly type: string;
      readonly authority: string;
      readonly supportsCursor?: boolean;
      readonly supportsCheckpoint?: boolean;
      readonly updatedAt?: number;
    },
  ): Promise<void> {
    await queryable.exec(
      `UPDATE ingestion_sources
       SET native_source_id = ?, display_name = ?, type = ?, authority = ?,
           supports_cursor = ?, supports_checkpoint = ?, updated_at = ?
       WHERE id = ? AND portfolio_id = ?`,
      [
        input.nativeSourceId,
        input.displayName,
        input.type,
        input.authority,
        input.supportsCursor ? 1 : 0,
        input.supportsCheckpoint ? 1 : 0,
        input.updatedAt ?? Date.now(),
        id,
        portfolioId,
      ],
    );
  }

  static async delete(queryable: Queryable, portfolioId: string, id: string): Promise<void> {
    await queryable.exec('DELETE FROM ingestion_sources WHERE id = ? AND portfolio_id = ?', [
      id,
      portfolioId,
    ]);
  }

  private static rowToIngestionSource(row: SqliteRow): IngestionSource {
    return {
      id: asString(row.id),
      portfolioId: asString(row.portfolio_id),
      nativeSourceId: asString(row.native_source_id),
      displayName: asString(row.display_name),
      type: asString(row.type),
      authority: asString(row.authority),
      supportsCursor: toBoolean(row.supports_cursor),
      supportsCheckpoint: toBoolean(row.supports_checkpoint),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }
}

export interface Environment {
  readonly id: string;
  readonly ingestionSourceId: string;
  readonly nativeEnvironmentId: string | null;
  readonly userProfile: string | null;
  readonly deviceProfile: string | null;
  readonly harnessHome: string | null;
  readonly configRoot: string | null;
  readonly integrationInstallation: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertEnvironmentInput {
  readonly id?: string;
  readonly ingestionSourceId: string;
  readonly nativeEnvironmentId?: string | null;
  readonly userProfile?: string | null;
  readonly deviceProfile?: string | null;
  readonly harnessHome?: string | null;
  readonly configRoot?: string | null;
  readonly integrationInstallation?: string | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed identity store
export class EnvironmentStore {
  static async insert(
    queryable: Queryable,
    portfolioId: string,
    input: InsertEnvironmentInput,
  ): Promise<string> {
    const now = Date.now();
    if (!input.id && !input.nativeEnvironmentId) {
      throw new Error('Environment id or nativeEnvironmentId is required');
    }
    const id =
      input.id ??
      (input.nativeEnvironmentId
        ? deterministicEnvironmentId(input.ingestionSourceId, input.nativeEnvironmentId)
        : undefined);
    if (!id) throw new Error('Could not determine environment id');
    const { changes } = await queryable.exec(
      `INSERT INTO environments (
        id, ingestion_source_id, native_environment_id, user_profile, device_profile,
        harness_home, config_root, integration_installation, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM ingestion_sources WHERE id = ? AND portfolio_id = ?)`,
      [
        id,
        input.ingestionSourceId,
        input.nativeEnvironmentId ?? null,
        input.userProfile ?? null,
        input.deviceProfile ?? null,
        input.harnessHome ?? null,
        input.configRoot ?? null,
        input.integrationInstallation ?? null,
        input.createdAt ?? now,
        input.updatedAt ?? now,
        input.ingestionSourceId,
        portfolioId,
      ],
    );
    if (changes === 0) {
      throw new Error(
        `Environment ${id} not inserted: ingestion source not in portfolio ${portfolioId}`,
      );
    }
    return id;
  }

  static async getById(
    queryable: Queryable,
    portfolioId: string,
    id: string,
  ): Promise<Environment | undefined> {
    const { rows } = await queryable.exec(
      `SELECT e.id, e.ingestion_source_id, e.native_environment_id, e.user_profile,
              e.device_profile, e.harness_home, e.config_root, e.integration_installation,
              e.created_at, e.updated_at
       FROM environments e
       JOIN ingestion_sources src ON src.id = e.ingestion_source_id
       WHERE e.id = ? AND src.portfolio_id = ?`,
      [id, portfolioId],
    );
    if (rows.length === 0) return undefined;
    return EnvironmentStore.rowToEnvironment(rows[0]);
  }

  static async listByPortfolio(
    queryable: Queryable,
    portfolioId: string,
  ): Promise<readonly Environment[]> {
    const { rows } = await queryable.exec(
      `SELECT e.id, e.ingestion_source_id, e.native_environment_id, e.user_profile,
              e.device_profile, e.harness_home, e.config_root, e.integration_installation,
              e.created_at, e.updated_at
       FROM environments e
       JOIN ingestion_sources src ON src.id = e.ingestion_source_id
       WHERE src.portfolio_id = ?
       ORDER BY e.id`,
      [portfolioId],
    );
    return rows.map(EnvironmentStore.rowToEnvironment);
  }

  static async listByIngestionSource(
    queryable: Queryable,
    portfolioId: string,
    ingestionSourceId: string,
  ): Promise<readonly Environment[]> {
    const { rows } = await queryable.exec(
      `SELECT e.id, e.ingestion_source_id, e.native_environment_id, e.user_profile,
              e.device_profile, e.harness_home, e.config_root, e.integration_installation,
              e.created_at, e.updated_at
       FROM environments e
       JOIN ingestion_sources src ON src.id = e.ingestion_source_id
       WHERE src.portfolio_id = ? AND e.ingestion_source_id = ?
       ORDER BY e.id`,
      [portfolioId, ingestionSourceId],
    );
    return rows.map(EnvironmentStore.rowToEnvironment);
  }

  static async update(
    queryable: Queryable,
    portfolioId: string,
    id: string,
    input: {
      readonly nativeEnvironmentId?: string | null;
      readonly userProfile?: string | null;
      readonly deviceProfile?: string | null;
      readonly harnessHome?: string | null;
      readonly configRoot?: string | null;
      readonly integrationInstallation?: string | null;
      readonly updatedAt?: number;
    },
  ): Promise<void> {
    const { rows } = await queryable.exec(
      `SELECT native_environment_id, user_profile, device_profile, harness_home, config_root,
              integration_installation
       FROM environments
       WHERE id = ? AND EXISTS (SELECT 1 FROM ingestion_sources WHERE id = environments.ingestion_source_id AND portfolio_id = ?)`,
      [id, portfolioId],
    );
    if (rows.length === 0) {
      throw new Error(`Environment ${id} not found in portfolio ${portfolioId}`);
    }
    const current = rows[0];
    await queryable.exec(
      `UPDATE environments
       SET native_environment_id = ?, user_profile = ?, device_profile = ?, harness_home = ?,
           config_root = ?, integration_installation = ?, updated_at = ?
       WHERE id = ? AND EXISTS (SELECT 1 FROM ingestion_sources WHERE id = environments.ingestion_source_id AND portfolio_id = ?)`,
      [
        input.nativeEnvironmentId !== undefined
          ? input.nativeEnvironmentId
          : toOptionalString(current.native_environment_id),
        input.userProfile !== undefined
          ? input.userProfile
          : toOptionalString(current.user_profile),
        input.deviceProfile !== undefined
          ? input.deviceProfile
          : toOptionalString(current.device_profile),
        input.harnessHome !== undefined
          ? input.harnessHome
          : toOptionalString(current.harness_home),
        input.configRoot !== undefined ? input.configRoot : toOptionalString(current.config_root),
        input.integrationInstallation !== undefined
          ? input.integrationInstallation
          : toOptionalString(current.integration_installation),
        input.updatedAt ?? Date.now(),
        id,
        portfolioId,
      ],
    );
  }

  static async delete(queryable: Queryable, portfolioId: string, id: string): Promise<void> {
    await queryable.exec(
      `DELETE FROM environments
       WHERE id = ? AND EXISTS (SELECT 1 FROM ingestion_sources WHERE id = environments.ingestion_source_id AND portfolio_id = ?)`,
      [id, portfolioId],
    );
  }

  private static rowToEnvironment(row: SqliteRow): Environment {
    return {
      id: asString(row.id),
      ingestionSourceId: asString(row.ingestion_source_id),
      nativeEnvironmentId: toOptionalString(row.native_environment_id),
      userProfile: toOptionalString(row.user_profile),
      deviceProfile: toOptionalString(row.device_profile),
      harnessHome: toOptionalString(row.harness_home),
      configRoot: toOptionalString(row.config_root),
      integrationInstallation: toOptionalString(row.integration_installation),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }
}

export interface Project {
  readonly id: string;
  readonly portfolioId: string;
  readonly name: string;
  readonly displayName: string | null;
  readonly metadata: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertProjectInput {
  readonly id: string;
  readonly portfolioId: string;
  readonly name: string;
  readonly displayName?: string | null;
  readonly metadata?: string | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed identity store
export class ProjectStore {
  static async insert(queryable: Queryable, input: InsertProjectInput): Promise<void> {
    const now = Date.now();
    await queryable.exec(
      `INSERT INTO projects (id, portfolio_id, name, display_name, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.portfolioId,
        input.name,
        input.displayName ?? null,
        input.metadata ?? null,
        input.createdAt ?? now,
        input.updatedAt ?? now,
      ],
    );
  }

  static async getById(
    queryable: Queryable,
    portfolioId: string,
    id: string,
  ): Promise<Project | undefined> {
    const { rows } = await queryable.exec(
      `SELECT id, portfolio_id, name, display_name, metadata, created_at, updated_at
       FROM projects WHERE id = ? AND portfolio_id = ?`,
      [id, portfolioId],
    );
    if (rows.length === 0) return undefined;
    return ProjectStore.rowToProject(rows[0]);
  }

  static async getByName(
    queryable: Queryable,
    portfolioId: string,
    name: string,
  ): Promise<Project | undefined> {
    const { rows } = await queryable.exec(
      `SELECT id, portfolio_id, name, display_name, metadata, created_at, updated_at
       FROM projects WHERE portfolio_id = ? AND name = ?`,
      [portfolioId, name],
    );
    if (rows.length === 0) return undefined;
    return ProjectStore.rowToProject(rows[0]);
  }

  static async listByPortfolio(
    queryable: Queryable,
    portfolioId: string,
  ): Promise<readonly Project[]> {
    const { rows } = await queryable.exec(
      `SELECT id, portfolio_id, name, display_name, metadata, created_at, updated_at
       FROM projects WHERE portfolio_id = ? ORDER BY name`,
      [portfolioId],
    );
    return rows.map(ProjectStore.rowToProject);
  }

  static async update(
    queryable: Queryable,
    portfolioId: string,
    id: string,
    input: {
      readonly name: string;
      readonly displayName?: string | null;
      readonly metadata?: string | null;
      readonly updatedAt?: number;
    },
  ): Promise<void> {
    await queryable.exec(
      'UPDATE projects SET name = ?, display_name = ?, metadata = ?, updated_at = ? WHERE id = ? AND portfolio_id = ?',
      [
        input.name,
        input.displayName ?? null,
        input.metadata ?? null,
        input.updatedAt ?? Date.now(),
        id,
        portfolioId,
      ],
    );
  }

  static async delete(queryable: Queryable, portfolioId: string, id: string): Promise<void> {
    await queryable.exec('DELETE FROM projects WHERE id = ? AND portfolio_id = ?', [
      id,
      portfolioId,
    ]);
  }

  private static rowToProject(row: SqliteRow): Project {
    return {
      id: asString(row.id),
      portfolioId: asString(row.portfolio_id),
      name: asString(row.name),
      displayName: toOptionalString(row.display_name),
      metadata: toOptionalString(row.metadata),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }
}

export interface SourceProject {
  readonly id: string;
  readonly projectId: string;
  readonly ingestionSourceId: string;
  readonly nativeProjectId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertSourceProjectInput {
  readonly id?: string;
  readonly projectId: string;
  readonly ingestionSourceId: string;
  readonly nativeProjectId: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed identity store
export class SourceProjectStore {
  static async insert(
    queryable: Queryable,
    portfolioId: string,
    input: InsertSourceProjectInput,
  ): Promise<string> {
    const now = Date.now();
    const id =
      input.id ?? deterministicSourceProjectId(input.ingestionSourceId, input.nativeProjectId);
    const { changes } = await queryable.exec(
      `INSERT INTO source_projects (id, project_id, ingestion_source_id, native_project_id, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND portfolio_id = ?)
         AND EXISTS (SELECT 1 FROM ingestion_sources WHERE id = ? AND portfolio_id = ?)`,
      [
        id,
        input.projectId,
        input.ingestionSourceId,
        input.nativeProjectId,
        input.createdAt ?? now,
        input.updatedAt ?? now,
        input.projectId,
        portfolioId,
        input.ingestionSourceId,
        portfolioId,
      ],
    );
    if (changes === 0) {
      throw new Error(
        `Source project ${id} not inserted: project or ingestion source not in portfolio ${portfolioId}`,
      );
    }
    return id;
  }

  static async getById(
    queryable: Queryable,
    portfolioId: string,
    id: string,
  ): Promise<SourceProject | undefined> {
    const { rows } = await queryable.exec(
      `SELECT sp.id, sp.project_id, sp.ingestion_source_id, sp.native_project_id,
              sp.created_at, sp.updated_at
       FROM source_projects sp
       JOIN projects p ON p.id = sp.project_id
       WHERE sp.id = ? AND p.portfolio_id = ?`,
      [id, portfolioId],
    );
    if (rows.length === 0) return undefined;
    return SourceProjectStore.rowToSourceProject(rows[0]);
  }

  static async getByNativeId(
    queryable: Queryable,
    portfolioId: string,
    ingestionSourceId: string,
    nativeProjectId: string,
  ): Promise<SourceProject | undefined> {
    const { rows } = await queryable.exec(
      `SELECT sp.id, sp.project_id, sp.ingestion_source_id, sp.native_project_id,
              sp.created_at, sp.updated_at
       FROM source_projects sp
       JOIN ingestion_sources src ON src.id = sp.ingestion_source_id
       WHERE sp.ingestion_source_id = ? AND sp.native_project_id = ? AND src.portfolio_id = ?`,
      [ingestionSourceId, nativeProjectId, portfolioId],
    );
    if (rows.length === 0) return undefined;
    return SourceProjectStore.rowToSourceProject(rows[0]);
  }

  static async listByPortfolio(
    queryable: Queryable,
    portfolioId: string,
  ): Promise<readonly SourceProject[]> {
    const { rows } = await queryable.exec(
      `SELECT sp.id, sp.project_id, sp.ingestion_source_id, sp.native_project_id,
              sp.created_at, sp.updated_at
       FROM source_projects sp
       JOIN projects p ON p.id = sp.project_id
       WHERE p.portfolio_id = ?
       ORDER BY sp.id`,
      [portfolioId],
    );
    return rows.map(SourceProjectStore.rowToSourceProject);
  }

  static async listByProject(
    queryable: Queryable,
    portfolioId: string,
    projectId: string,
  ): Promise<readonly SourceProject[]> {
    const { rows } = await queryable.exec(
      `SELECT sp.id, sp.project_id, sp.ingestion_source_id, sp.native_project_id,
              sp.created_at, sp.updated_at
       FROM source_projects sp
       JOIN projects p ON p.id = sp.project_id
       WHERE p.portfolio_id = ? AND sp.project_id = ?
       ORDER BY sp.id`,
      [portfolioId, projectId],
    );
    return rows.map(SourceProjectStore.rowToSourceProject);
  }

  static async listByIngestionSource(
    queryable: Queryable,
    portfolioId: string,
    ingestionSourceId: string,
  ): Promise<readonly SourceProject[]> {
    const { rows } = await queryable.exec(
      `SELECT sp.id, sp.project_id, sp.ingestion_source_id, sp.native_project_id,
              sp.created_at, sp.updated_at
       FROM source_projects sp
       JOIN ingestion_sources src ON src.id = sp.ingestion_source_id
       WHERE src.portfolio_id = ? AND sp.ingestion_source_id = ?
       ORDER BY sp.id`,
      [portfolioId, ingestionSourceId],
    );
    return rows.map(SourceProjectStore.rowToSourceProject);
  }

  static async update(
    queryable: Queryable,
    portfolioId: string,
    id: string,
    input: {
      readonly nativeProjectId: string;
      readonly updatedAt?: number;
    },
  ): Promise<void> {
    await queryable.exec(
      `UPDATE source_projects
       SET native_project_id = ?, updated_at = ?
       WHERE id = ? AND EXISTS (SELECT 1 FROM projects WHERE id = source_projects.project_id AND portfolio_id = ?)`,
      [input.nativeProjectId, input.updatedAt ?? Date.now(), id, portfolioId],
    );
  }

  static async delete(queryable: Queryable, portfolioId: string, id: string): Promise<void> {
    await queryable.exec(
      `DELETE FROM source_projects
       WHERE id = ? AND EXISTS (SELECT 1 FROM projects WHERE id = source_projects.project_id AND portfolio_id = ?)`,
      [id, portfolioId],
    );
  }

  private static rowToSourceProject(row: SqliteRow): SourceProject {
    return {
      id: asString(row.id),
      projectId: asString(row.project_id),
      ingestionSourceId: asString(row.ingestion_source_id),
      nativeProjectId: asString(row.native_project_id),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }
}

export const PROJECT_MAPPING_TYPES = ['create', 'merge', 'split', 'reassign'] as const;
export type ProjectMappingType = (typeof PROJECT_MAPPING_TYPES)[number];

export interface ProjectMapping {
  readonly id: string;
  readonly projectId: string;
  readonly priorProjectId: string | null;
  readonly sourceProjectId: string | null;
  readonly ingestionSourceId: string;
  readonly nativeProjectId: string;
  readonly mappingType: ProjectMappingType;
  readonly actor: string | null;
  readonly reason: string | null;
  readonly createdAt: number;
}

export interface InsertProjectMappingInput {
  readonly id?: string;
  readonly projectId: string;
  readonly priorProjectId?: string | null;
  readonly sourceProjectId?: string | null;
  readonly ingestionSourceId: string;
  readonly nativeProjectId: string;
  readonly mappingType: ProjectMappingType;
  readonly actor?: string | null;
  readonly reason?: string | null;
  readonly createdAt?: number;
}

export interface ReassignmentHooks {
  readonly rebuildContributions: (
    tx: SqliteTransaction,
    sourceProjectId: string,
    fromProjectId: string,
    toProjectId: string,
  ) => MaybePromise<void>;
  readonly rebuildLifecycle: (
    tx: SqliteTransaction,
    sourceProjectId: string,
    fromProjectId: string,
    toProjectId: string,
  ) => MaybePromise<void>;
  readonly rebuildExposure: (
    tx: SqliteTransaction,
    sourceProjectId: string,
    fromProjectId: string,
    toProjectId: string,
  ) => MaybePromise<void>;
  readonly rebuildCohorts: (
    tx: SqliteTransaction,
    sourceProjectId: string,
    fromProjectId: string,
    toProjectId: string,
  ) => MaybePromise<void>;
}

export const NO_OP_REASSIGNMENT_HOOKS: ReassignmentHooks = {
  rebuildContributions: () => undefined,
  rebuildLifecycle: () => undefined,
  rebuildExposure: () => undefined,
  rebuildCohorts: () => undefined,
};

export interface ReassignProjectOptions {
  readonly reason?: string;
  readonly mappingId?: string;
  readonly hooks?: ReassignmentHooks;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed identity store
export class ProjectMappingStore {
  static async recordMapping(
    queryable: Queryable,
    portfolioId: string,
    input: InsertProjectMappingInput,
  ): Promise<string> {
    const now = input.createdAt ?? Date.now();
    const id =
      input.id ??
      deterministicProjectMappingId(
        input.projectId,
        input.nativeProjectId,
        input.mappingType,
        String(now),
      );
    const { changes } = await queryable.exec(
      `INSERT INTO project_mappings (
        id, project_id, prior_project_id, source_project_id, ingestion_source_id,
        native_project_id, mapping_type, actor, reason, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND portfolio_id = ?)
        AND EXISTS (SELECT 1 FROM ingestion_sources WHERE id = ? AND portfolio_id = ?)`,
      [
        id,
        input.projectId,
        input.priorProjectId ?? null,
        input.sourceProjectId ?? null,
        input.ingestionSourceId,
        input.nativeProjectId,
        input.mappingType,
        input.actor ?? null,
        input.reason ?? null,
        now,
        input.projectId,
        portfolioId,
        input.ingestionSourceId,
        portfolioId,
      ],
    );
    if (changes === 0) {
      throw new Error(`Project mapping not inserted: not in portfolio ${portfolioId}`);
    }
    return id;
  }

  static async reassignProject(
    executor: SqliteExecutor,
    portfolioId: string,
    sourceProjectId: string,
    toProjectId: string,
    options: ReassignProjectOptions = {},
  ): Promise<void> {
    const hooks = options.hooks ?? NO_OP_REASSIGNMENT_HOOKS;
    await executor.transaction(async (tx) => {
      const now = Date.now();
      const { rows: toRows } = await tx.exec(
        'SELECT id FROM projects WHERE id = ? AND portfolio_id = ?',
        [toProjectId, portfolioId],
      );
      if (toRows.length === 0) {
        throw new Error(`Target project ${toProjectId} not found in portfolio ${portfolioId}`);
      }

      const { rows: sourceRows } = await tx.exec(
        `SELECT sp.id, sp.project_id, sp.ingestion_source_id, sp.native_project_id
         FROM source_projects sp
         JOIN projects p ON p.id = sp.project_id
         WHERE sp.id = ? AND p.portfolio_id = ?`,
        [sourceProjectId, portfolioId],
      );
      if (sourceRows.length === 0) {
        throw new Error(`Source project ${sourceProjectId} not found in portfolio ${portfolioId}`);
      }

      const fromProjectId = asString(sourceRows[0].project_id);
      if (fromProjectId === toProjectId) {
        throw new Error('Cannot reassign a source project to its current project');
      }

      const ingestionSourceId = asString(sourceRows[0].ingestion_source_id);
      const nativeProjectId = asString(sourceRows[0].native_project_id);

      await tx.exec('UPDATE source_projects SET project_id = ?, updated_at = ? WHERE id = ?', [
        toProjectId,
        now,
        sourceProjectId,
      ]);

      await ProjectMappingStore.recordMapping(tx, portfolioId, {
        id: options.mappingId,
        projectId: toProjectId,
        priorProjectId: fromProjectId,
        sourceProjectId,
        ingestionSourceId,
        nativeProjectId,
        mappingType: 'reassign',
        reason: options.reason,
        createdAt: now,
      });

      await hooks.rebuildContributions(tx, sourceProjectId, fromProjectId, toProjectId);
      await hooks.rebuildLifecycle(tx, sourceProjectId, fromProjectId, toProjectId);
      await hooks.rebuildExposure(tx, sourceProjectId, fromProjectId, toProjectId);
      await hooks.rebuildCohorts(tx, sourceProjectId, fromProjectId, toProjectId);
    });
  }

  static async getById(
    queryable: Queryable,
    portfolioId: string,
    id: string,
  ): Promise<ProjectMapping | undefined> {
    const { rows } = await queryable.exec(
      `SELECT m.id, m.project_id, m.prior_project_id, m.source_project_id, m.ingestion_source_id,
              m.native_project_id, m.mapping_type, m.actor, m.reason, m.created_at
       FROM project_mappings m
       JOIN projects p ON p.id = m.project_id
       WHERE m.id = ? AND p.portfolio_id = ?`,
      [id, portfolioId],
    );
    if (rows.length === 0) return undefined;
    return ProjectMappingStore.rowToProjectMapping(rows[0]);
  }

  static async listByPortfolio(
    queryable: Queryable,
    portfolioId: string,
  ): Promise<readonly ProjectMapping[]> {
    const { rows } = await queryable.exec(
      `SELECT m.id, m.project_id, m.prior_project_id, m.source_project_id, m.ingestion_source_id,
              m.native_project_id, m.mapping_type, m.actor, m.reason, m.created_at
       FROM project_mappings m
       JOIN projects p ON p.id = m.project_id
       WHERE p.portfolio_id = ?
       ORDER BY m.created_at DESC`,
      [portfolioId],
    );
    return rows.map(ProjectMappingStore.rowToProjectMapping);
  }

  static async listByProject(
    queryable: Queryable,
    portfolioId: string,
    projectId: string,
  ): Promise<readonly ProjectMapping[]> {
    const { rows } = await queryable.exec(
      `SELECT m.id, m.project_id, m.prior_project_id, m.source_project_id, m.ingestion_source_id,
              m.native_project_id, m.mapping_type, m.actor, m.reason, m.created_at
       FROM project_mappings m
       JOIN projects p ON p.id = m.project_id
       WHERE p.portfolio_id = ? AND m.project_id = ?
       ORDER BY m.created_at DESC`,
      [portfolioId, projectId],
    );
    return rows.map(ProjectMappingStore.rowToProjectMapping);
  }

  private static rowToProjectMapping(row: SqliteRow): ProjectMapping {
    return {
      id: asString(row.id),
      projectId: asString(row.project_id),
      priorProjectId: toOptionalString(row.prior_project_id),
      sourceProjectId: toOptionalString(row.source_project_id),
      ingestionSourceId: asString(row.ingestion_source_id),
      nativeProjectId: asString(row.native_project_id),
      mappingType: asString(row.mapping_type) as ProjectMappingType,
      actor: toOptionalString(row.actor),
      reason: toOptionalString(row.reason),
      createdAt: toNumber(row.created_at),
    };
  }
}

export interface Repository {
  readonly id: string;
  readonly projectId: string;
  readonly remoteUrlSafe: string | null;
  readonly vcsKind: string | null;
  readonly defaultBranch: string | null;
  readonly safeMetadata: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertRepositoryInput {
  readonly id: string;
  readonly projectId: string;
  readonly remoteUrlSafe?: string | null;
  readonly vcsKind?: string | null;
  readonly defaultBranch?: string | null;
  readonly safeMetadata?: string | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed identity store
export class RepositoryStore {
  static async insert(
    queryable: Queryable,
    portfolioId: string,
    input: InsertRepositoryInput,
  ): Promise<void> {
    const now = Date.now();
    const { changes } = await queryable.exec(
      `INSERT INTO repositories (id, project_id, remote_url_safe, vcs_kind, default_branch, safe_metadata, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND portfolio_id = ?)`,
      [
        input.id,
        input.projectId,
        input.remoteUrlSafe ?? null,
        input.vcsKind ?? null,
        input.defaultBranch ?? null,
        input.safeMetadata ?? null,
        input.createdAt ?? now,
        input.updatedAt ?? now,
        input.projectId,
        portfolioId,
      ],
    );
    if (changes === 0) {
      throw new Error(
        `Repository ${input.id} not inserted: project not in portfolio ${portfolioId}`,
      );
    }
  }

  static async getById(
    queryable: Queryable,
    portfolioId: string,
    id: string,
  ): Promise<Repository | undefined> {
    const { rows } = await queryable.exec(
      `SELECT r.id, r.project_id, r.remote_url_safe, r.vcs_kind, r.default_branch,
              r.safe_metadata, r.created_at, r.updated_at
       FROM repositories r
       JOIN projects p ON p.id = r.project_id
       WHERE r.id = ? AND p.portfolio_id = ?`,
      [id, portfolioId],
    );
    if (rows.length === 0) return undefined;
    return RepositoryStore.rowToRepository(rows[0]);
  }

  static async listByPortfolio(
    queryable: Queryable,
    portfolioId: string,
  ): Promise<readonly Repository[]> {
    const { rows } = await queryable.exec(
      `SELECT r.id, r.project_id, r.remote_url_safe, r.vcs_kind, r.default_branch,
              r.safe_metadata, r.created_at, r.updated_at
       FROM repositories r
       JOIN projects p ON p.id = r.project_id
       WHERE p.portfolio_id = ?
       ORDER BY r.id`,
      [portfolioId],
    );
    return rows.map(RepositoryStore.rowToRepository);
  }

  static async listByProject(
    queryable: Queryable,
    portfolioId: string,
    projectId: string,
  ): Promise<readonly Repository[]> {
    const { rows } = await queryable.exec(
      `SELECT r.id, r.project_id, r.remote_url_safe, r.vcs_kind, r.default_branch,
              r.safe_metadata, r.created_at, r.updated_at
       FROM repositories r
       JOIN projects p ON p.id = r.project_id
       WHERE p.portfolio_id = ? AND r.project_id = ?
       ORDER BY r.id`,
      [portfolioId, projectId],
    );
    return rows.map(RepositoryStore.rowToRepository);
  }

  static async update(
    queryable: Queryable,
    portfolioId: string,
    id: string,
    input: {
      readonly projectId: string;
      readonly remoteUrlSafe?: string | null;
      readonly vcsKind?: string | null;
      readonly defaultBranch?: string | null;
      readonly safeMetadata?: string | null;
      readonly updatedAt?: number;
    },
  ): Promise<void> {
    await queryable.exec(
      `UPDATE repositories
       SET project_id = ?, remote_url_safe = ?, vcs_kind = ?, default_branch = ?, safe_metadata = ?, updated_at = ?
       WHERE id = ? AND EXISTS (SELECT 1 FROM projects WHERE id = repositories.project_id AND portfolio_id = ?)
         AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND portfolio_id = ?)`,
      [
        input.projectId,
        input.remoteUrlSafe ?? null,
        input.vcsKind ?? null,
        input.defaultBranch ?? null,
        input.safeMetadata ?? null,
        input.updatedAt ?? Date.now(),
        id,
        portfolioId,
        input.projectId,
        portfolioId,
      ],
    );
  }

  static async delete(queryable: Queryable, portfolioId: string, id: string): Promise<void> {
    await queryable.exec(
      `DELETE FROM repositories
       WHERE id = ? AND EXISTS (SELECT 1 FROM projects WHERE id = repositories.project_id AND portfolio_id = ?)`,
      [id, portfolioId],
    );
  }

  private static rowToRepository(row: SqliteRow): Repository {
    return {
      id: asString(row.id),
      projectId: asString(row.project_id),
      remoteUrlSafe: toOptionalString(row.remote_url_safe),
      vcsKind: toOptionalString(row.vcs_kind),
      defaultBranch: toOptionalString(row.default_branch),
      safeMetadata: toOptionalString(row.safe_metadata),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }
}

export interface Workspace {
  readonly id: string;
  readonly projectId: string;
  readonly repositoryId: string | null;
  readonly nativeWorkspaceId: string | null;
  readonly scopeChain: string | null;
  readonly path: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertWorkspaceInput {
  readonly id: string;
  readonly projectId: string;
  readonly repositoryId?: string | null;
  readonly nativeWorkspaceId?: string | null;
  readonly scopeChain?: string | null;
  readonly path?: string | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed identity store
export class WorkspaceStore {
  static async insert(
    queryable: Queryable,
    portfolioId: string,
    input: InsertWorkspaceInput,
  ): Promise<void> {
    const now = Date.now();
    const { changes } = await queryable.exec(
      `INSERT INTO workspaces (id, project_id, repository_id, native_workspace_id, scope_chain, path, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND portfolio_id = ?)
         AND (? IS NULL OR EXISTS (SELECT 1 FROM repositories WHERE id = ? AND project_id = ?))`,
      [
        input.id,
        input.projectId,
        input.repositoryId ?? null,
        input.nativeWorkspaceId ?? null,
        input.scopeChain ?? null,
        input.path ?? null,
        input.createdAt ?? now,
        input.updatedAt ?? now,
        input.projectId,
        portfolioId,
        input.repositoryId ?? null,
        input.repositoryId ?? null,
        input.projectId,
      ],
    );
    if (changes === 0) {
      throw new Error(
        `Workspace ${input.id} not inserted: project not in portfolio ${portfolioId}`,
      );
    }
  }

  static async getById(
    queryable: Queryable,
    portfolioId: string,
    id: string,
  ): Promise<Workspace | undefined> {
    const { rows } = await queryable.exec(
      `SELECT w.id, w.project_id, w.repository_id, w.native_workspace_id, w.scope_chain, w.path,
              w.created_at, w.updated_at
       FROM workspaces w
       JOIN projects p ON p.id = w.project_id
       WHERE w.id = ? AND p.portfolio_id = ?`,
      [id, portfolioId],
    );
    if (rows.length === 0) return undefined;
    return WorkspaceStore.rowToWorkspace(rows[0]);
  }

  static async listByPortfolio(
    queryable: Queryable,
    portfolioId: string,
  ): Promise<readonly Workspace[]> {
    const { rows } = await queryable.exec(
      `SELECT w.id, w.project_id, w.repository_id, w.native_workspace_id, w.scope_chain, w.path,
              w.created_at, w.updated_at
       FROM workspaces w
       JOIN projects p ON p.id = w.project_id
       WHERE p.portfolio_id = ?
       ORDER BY w.id`,
      [portfolioId],
    );
    return rows.map(WorkspaceStore.rowToWorkspace);
  }

  static async listByProject(
    queryable: Queryable,
    portfolioId: string,
    projectId: string,
  ): Promise<readonly Workspace[]> {
    const { rows } = await queryable.exec(
      `SELECT w.id, w.project_id, w.repository_id, w.native_workspace_id, w.scope_chain, w.path,
              w.created_at, w.updated_at
       FROM workspaces w
       JOIN projects p ON p.id = w.project_id
       WHERE p.portfolio_id = ? AND w.project_id = ?
       ORDER BY w.id`,
      [portfolioId, projectId],
    );
    return rows.map(WorkspaceStore.rowToWorkspace);
  }

  static async listByRepository(
    queryable: Queryable,
    portfolioId: string,
    repositoryId: string,
  ): Promise<readonly Workspace[]> {
    const { rows } = await queryable.exec(
      `SELECT w.id, w.project_id, w.repository_id, w.native_workspace_id, w.scope_chain, w.path,
              w.created_at, w.updated_at
       FROM workspaces w
       JOIN projects p ON p.id = w.project_id
       WHERE p.portfolio_id = ? AND w.repository_id = ?
       ORDER BY w.id`,
      [portfolioId, repositoryId],
    );
    return rows.map(WorkspaceStore.rowToWorkspace);
  }

  static async update(
    queryable: Queryable,
    portfolioId: string,
    id: string,
    input: {
      readonly projectId: string;
      readonly repositoryId?: string | null;
      readonly nativeWorkspaceId?: string | null;
      readonly scopeChain?: string | null;
      readonly path?: string | null;
      readonly updatedAt?: number;
    },
  ): Promise<void> {
    await queryable.exec(
      `UPDATE workspaces
       SET project_id = ?, repository_id = ?, native_workspace_id = ?, scope_chain = ?, path = ?, updated_at = ?
       WHERE id = ? AND EXISTS (SELECT 1 FROM projects WHERE id = workspaces.project_id AND portfolio_id = ?)
         AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND portfolio_id = ?)`,
      [
        input.projectId,
        input.repositoryId ?? null,
        input.nativeWorkspaceId ?? null,
        input.scopeChain ?? null,
        input.path ?? null,
        input.updatedAt ?? Date.now(),
        id,
        portfolioId,
        input.projectId,
        portfolioId,
      ],
    );
  }

  static async delete(queryable: Queryable, portfolioId: string, id: string): Promise<void> {
    await queryable.exec(
      `DELETE FROM workspaces
       WHERE id = ? AND EXISTS (SELECT 1 FROM projects WHERE id = workspaces.project_id AND portfolio_id = ?)`,
      [id, portfolioId],
    );
  }

  private static rowToWorkspace(row: SqliteRow): Workspace {
    return {
      id: asString(row.id),
      projectId: asString(row.project_id),
      repositoryId: toOptionalString(row.repository_id),
      nativeWorkspaceId: toOptionalString(row.native_workspace_id),
      scopeChain: toOptionalString(row.scope_chain),
      path: toOptionalString(row.path),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }
}
