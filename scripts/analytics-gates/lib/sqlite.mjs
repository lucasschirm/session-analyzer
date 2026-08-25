import { DatabaseSync } from 'node:sqlite';

let FRESH_SCHEMA_SQL = null;

export async function getFreshSchemaSql() {
  if (FRESH_SCHEMA_SQL) return FRESH_SCHEMA_SQL;
  const schemaUrl = new URL('../../../packages/db-core/dist/schema.js', import.meta.url);
  const mod = await import(schemaUrl);
  FRESH_SCHEMA_SQL = mod.FRESH_SCHEMA_SQL;
  if (!FRESH_SCHEMA_SQL) throw new Error('FRESH_SCHEMA_SQL not exported from db-core dist');
  return FRESH_SCHEMA_SQL;
}

export async function openFreshDb() {
  const sql = await getFreshSchemaSql();
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(sql);
  return db;
}

export function explainPlan(db, sql, ...params) {
  const stmt = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
  return stmt.all(...params);
}
