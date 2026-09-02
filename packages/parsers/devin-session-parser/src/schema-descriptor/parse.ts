/**
 * Parses `native/schema-descriptor.json`: devin CLI version + refinery
 * migration history + per-table DDL checksums. Typed for later use by
 * DS-F7 (#149)'s degrade-gracefully-on-unknown-schema logic — this parser
 * only validates and normalizes; it makes no supported/unsupported decision
 * itself (that decision was already made upstream and is carried in
 * `supported`/`warnings`).
 *
 * This type structurally mirrors
 * `packages/plugins/devin-session-sync/src/extractor/types.ts`'s
 * `DevinSchemaDescriptor` (the shape that package serializes to this file)
 * without importing it — parser packages under `packages/parsers/*` stay
 * dependency-free and never depend on a `packages/plugins/*` package.
 */

export interface DevinRefineryMigration {
  version: number;
  name: string;
  appliedOn: string;
  checksum: string;
}

export interface DevinSchemaDescriptor {
  /** `null` when the devin CLI version could not be determined upstream. */
  devinCliVersion: string | null;
  refineryVersion: number;
  refineryMigrations: DevinRefineryMigration[];
  /** Per-table DDL checksum (sha256 of `sqlite_master.sql`); `null` if the table is absent. */
  tableChecksums: Record<string, string | null>;
  supported: boolean;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMigration(raw: unknown): DevinRefineryMigration | null {
  if (!isRecord(raw)) return null;
  const { version, name, appliedOn, checksum } = raw;
  if (
    typeof version !== 'number' ||
    typeof name !== 'string' ||
    typeof appliedOn !== 'string' ||
    typeof checksum !== 'string'
  ) {
    return null;
  }
  return { version, name, appliedOn, checksum };
}

function parseMigrations(raw: unknown): DevinRefineryMigration[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseMigration).filter((m): m is DevinRefineryMigration => m !== null);
}

function parseTableChecksums(raw: unknown): Record<string, string | null> {
  if (!isRecord(raw)) return {};
  const result: Record<string, string | null> = {};
  for (const [table, checksum] of Object.entries(raw)) {
    result[table] = typeof checksum === 'string' ? checksum : null;
  }
  return result;
}

function parseWarnings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((w): w is string => typeof w === 'string') : [];
}

/**
 * Parses a `native/schema-descriptor.json` payload. Returns `null` (never
 * throws) when the input isn't a JSON object or is missing the required
 * `refineryVersion`/`supported` fields.
 */
export function parseSchemaDescriptor(raw: unknown): DevinSchemaDescriptor | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.refineryVersion !== 'number' || typeof raw.supported !== 'boolean') {
    return null;
  }
  return {
    devinCliVersion: typeof raw.devinCliVersion === 'string' ? raw.devinCliVersion : null,
    refineryVersion: raw.refineryVersion,
    refineryMigrations: parseMigrations(raw.refineryMigrations),
    tableChecksums: parseTableChecksums(raw.tableChecksums),
    supported: raw.supported,
    warnings: parseWarnings(raw.warnings),
  };
}
