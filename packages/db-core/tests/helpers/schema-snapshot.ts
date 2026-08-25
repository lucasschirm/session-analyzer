import type { SqliteExecutor, SqliteValue } from '../../src/index.js';

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: SqliteValue;
  pk: number;
}

interface IndexInfo {
  name: string;
  unique: number;
  partial: number;
  columns: string[];
}

interface ForeignKeyInfo {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

interface TableSnapshot {
  name: string;
  sql: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
}

interface IndexSnapshot {
  name: string;
  tableName: string;
  sql: string;
}

export interface SchemaSnapshot {
  tables: TableSnapshot[];
  indexes: IndexSnapshot[];
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/if not exists /g, '');
}

export async function getSchemaSnapshot(executor: SqliteExecutor): Promise<SchemaSnapshot> {
  const tables: TableSnapshot[] = [];
  const indexes: IndexSnapshot[] = [];

  const { rows } = await executor.exec(
    "SELECT name, type, tbl_name, sql FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );

  for (const row of rows) {
    const type = String(row.type);
    const name = String(row.name);
    const tblName = String(row.tbl_name);
    const sql = String(row.sql ?? '');

    if (type === 'table') {
      const columns = (await executor.exec(`PRAGMA table_info(${quoteIdentifier(name)})`)).rows.map(
        (r) => ({
          name: String(r.name),
          type: String(r.type),
          notnull: Number(r.notnull),
          dflt_value: r.dflt_value ?? null,
          pk: Number(r.pk),
        }),
      );

      const indexesForTable: IndexInfo[] = [];
      const indexList = (await executor.exec(`PRAGMA index_list(${quoteIdentifier(name)})`)).rows;
      for (const idx of indexList) {
        const idxName = String(idx.name);
        const indexColumns = (
          await executor.exec(`PRAGMA index_info(${quoteIdentifier(idxName)})`)
        ).rows.map((r) => String(r.name));
        indexesForTable.push({
          name: idxName,
          unique: Number(idx.unique),
          partial: Number(idx.partial),
          columns: indexColumns,
        });
      }

      const foreignKeys = (
        await executor.exec(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`)
      ).rows.map((r) => ({
        id: Number(r.id),
        seq: Number(r.seq),
        table: String(r.table),
        from: String(r.from),
        to: String(r.to),
        on_update: String(r.on_update),
        on_delete: String(r.on_delete),
        match: String(r.match),
      }));

      tables.push({
        name,
        sql: normalizeSql(sql),
        columns,
        indexes: indexesForTable,
        foreignKeys,
      });
    } else if (type === 'index') {
      indexes.push({
        name,
        tableName: tblName,
        sql: normalizeSql(sql),
      });
    }
  }

  return { tables, indexes };
}

function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid identifier for schema snapshot: ${name}`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}
