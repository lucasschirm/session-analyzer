import type { SqliteExecutor, SqliteRow, SqliteTransaction } from './contract.js';
import { ANALYTICS_SCHEMA_NAME, CREATE_SCHEMA_CONTROL_TABLES_SQL } from './schema.js';

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface MigrationRecord {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
  readonly appliedAt: number;
}

/**
 * Applies forward, checksummed migrations through an executor-agnostic
 * {@link SqliteExecutor}. Each migration runs in its own transaction; any
 * failure rolls that transaction back so the database is never left in a
 * partially migrated state.
 */
export class MigrationRunner {
  constructor(
    private readonly executor: SqliteExecutor,
    private readonly migrations: readonly Migration[],
    private readonly schemaName: string = ANALYTICS_SCHEMA_NAME,
  ) {}

  /**
   * Ensures the migration bookkeeping tables exist and that a baseline
   * `schema_metadata` row is present. Safe to call repeatedly.
   */
  async initialize(): Promise<void> {
    await this.executor.exec(CREATE_SCHEMA_CONTROL_TABLES_SQL);
    const { rows } = await this.executor.exec(
      'SELECT schema_version FROM schema_metadata WHERE schema_name = ?',
      [this.schemaName],
    );
    if (rows.length === 0) {
      const now = Date.now();
      await this.executor.exec(
        'INSERT INTO schema_metadata (schema_name, schema_version, initialized_at, updated_at) VALUES (?, ?, ?, ?)',
        [this.schemaName, 0, now, now],
      );
    }
  }

  /**
   * Runs all pending migrations in order. Already-applied migrations are
   * verified against their stored checksums. The first checksum mismatch or
   * missing migration throws and leaves the database at the last successful
   * migration.
   */
  async migrate(): Promise<void> {
    await this.initialize();
    const applied = await this.getAppliedMigrations();
    const byId = new Map<number, { id: number; name: string; checksum: string }>(
      applied.map((row) => [
        Number(row.id),
        {
          id: Number(row.id),
          name: String(row.name),
          checksum: String(row.checksum),
        },
      ]),
    );
    const currentVersion = await this.getCurrentVersion();
    const pending = [...this.migrations].sort((a, b) => a.id - b.id);

    for (const migration of pending) {
      const record = byId.get(migration.id);
      if (record) {
        if (record.checksum !== migration.checksum) {
          throw new Error(
            `Migration checksum mismatch for ${migration.name} (${migration.id}). ` +
              `Stored: ${record.checksum}, expected: ${migration.checksum}`,
          );
        }
        continue;
      }

      if (migration.id <= currentVersion) {
        throw new Error(
          `Migration ${migration.id} (${migration.name}) is missing from schema_migrations ` +
            `but schema version is ${currentVersion}`,
        );
      }

      await this.applyMigration(migration);
    }
  }

  /** Returns the migration record stored for a given id, or undefined. */
  async getAppliedMigration(id: number): Promise<MigrationRecord | undefined> {
    const { rows } = await this.executor.exec(
      'SELECT id, name, sql, checksum, applied_at FROM schema_migrations WHERE id = ?',
      [id],
    );
    if (rows.length === 0) return undefined;
    const row = rows[0];
    return {
      id: Number(row.id),
      name: String(row.name),
      sql: String(row.sql),
      checksum: String(row.checksum),
      appliedAt: Number(row.applied_at),
    };
  }

  private async getAppliedMigrations(): Promise<readonly SqliteRow[]> {
    const { rows } = await this.executor.exec(
      'SELECT id, name, checksum FROM schema_migrations ORDER BY id',
    );
    return rows;
  }

  private async getCurrentVersion(): Promise<number> {
    const { rows } = await this.executor.exec(
      'SELECT schema_version FROM schema_metadata WHERE schema_name = ?',
      [this.schemaName],
    );
    return rows.length ? Number(rows[0].schema_version) : 0;
  }

  private async applyMigration(migration: Migration): Promise<void> {
    await this.executor.transaction(async (tx: SqliteTransaction) => {
      await tx.exec(migration.sql);
      await tx.exec(
        'INSERT INTO schema_migrations (id, name, sql, checksum, applied_at) VALUES (?, ?, ?, ?, ?)',
        [migration.id, migration.name, migration.sql, migration.checksum, Date.now()],
      );
      await tx.exec(
        'UPDATE schema_metadata SET schema_version = ?, updated_at = ? WHERE schema_name = ?',
        [migration.id, Date.now(), this.schemaName],
      );
    });
  }
}
