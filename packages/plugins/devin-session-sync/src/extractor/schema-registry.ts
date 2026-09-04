/**
 * Maps the `sessions.db` refinery migration ledger version
 * (`refinery_schema_history`, max `version` = schema version — the
 * authoritative source; `app_state.schema_compat_version` is separate and
 * `PRAGMA user_version` is unused by Devin CLI) to the table/column shapes
 * this extractor knows how to read.
 *
 * Only one Devin CLI schema version has been verified on-machine so far
 * (devin 3000.6.7, refinery version 16). Any other observed version — older
 * or newer — is treated as unrecognized: extraction never throws, it
 * degrades to a reduced, verified-stable table set and surfaces a warning
 * DS-F3 (#158) threads into the manifest's `collectionOutcome`.
 */

export const KNOWN_REFINERY_VERSION = 16;

/**
 * Column lists per table — informational only (#298). `reader.ts` reads
 * every table via `SELECT *`/dynamic column discovery unconditionally, so
 * this list is never used to build a read's projection anymore (it
 * previously was, and silently dropped `sessions.shell_last_seen_index` as
 * a result — see `detectUnknownColumns` below, which now exists precisely
 * so a future gap like that one is surfaced as a warning instead of
 * discovered by hand again). What remains: `resolveDegradedSchema`'s
 * unrecognized-schema-version warning path, and `computeSchemaDescriptor`'s
 * per-table DDL checksums (`reader.ts`).
 */
export const KNOWN_TABLE_COLUMNS: Record<string, string[]> = {
  sessions: [
    'id',
    'working_directory',
    'backend_type',
    'model',
    'agent_mode',
    'created_at',
    'last_activity_at',
    'title',
    'main_chain_id',
    'cogs_json',
    'workspace_dirs',
    'hidden',
    'metadata',
  ],
  message_nodes: [
    'row_id',
    'session_id',
    'node_id',
    'parent_node_id',
    'chat_message',
    'created_at',
    'metadata',
  ],
  prompt_history: ['id', 'content', 'timestamp', 'session_id', 'is_shell'],
  // `tool_call_state` has no explicit autoincrement column — SQLite's
  // implicit `rowid` is used instead (aliased `AS row_id` by the reader).
  // It is deliberately absent here since it isn't a real column name; a
  // literal `SELECT row_id ...` against this table would fail.
  tool_call_state: ['session_id', 'tool_call_id', 'tool_call_json', 'tool_call_update_json'],
};

/** Tables that degrade gracefully — `tool_call_state` has no explicit PK
 * and no verified-stable shape across unrecognized versions, so it is the
 * first table dropped in degraded mode. */
const DEGRADED_MODE_TABLES = ['sessions', 'message_nodes', 'prompt_history'];

export interface SchemaResolution {
  observedVersion: number;
  supported: boolean;
  knownTables: string[];
  warnings: string[];
}

/**
 * Resolves an observed `refinery_schema_history` max version against the
 * known Devin CLI schema. Never throws.
 */
export function resolveDevinSchema(observedVersion: number): SchemaResolution {
  if (observedVersion === KNOWN_REFINERY_VERSION) {
    return {
      observedVersion,
      supported: true,
      knownTables: Object.keys(KNOWN_TABLE_COLUMNS),
      warnings: [],
    };
  }
  return resolveDegradedSchema(observedVersion);
}

function resolveDegradedSchema(observedVersion: number): SchemaResolution {
  const direction = observedVersion > KNOWN_REFINERY_VERSION ? 'newer' : 'older';
  const warnings = [
    `Unrecognized Devin sessions.db schema: refinery version ${observedVersion} is ${direction} ` +
      `than the last verified version (${KNOWN_REFINERY_VERSION}). Degrading to best-effort ` +
      `extraction of ${DEGRADED_MODE_TABLES.join(', ')}; tool_call_state is skipped.`,
  ];
  return { observedVersion, supported: false, knownTables: [...DEGRADED_MODE_TABLES], warnings };
}

/**
 * The curated column list for a table under a resolution — informational
 * only (see `KNOWN_TABLE_COLUMNS`'s doc comment); no longer used to build a
 * `SELECT` projection anywhere in this package.
 */
export function knownColumnsFor(table: string, resolution: SchemaResolution): string[] {
  if (!resolution.knownTables.includes(table)) {
    return [];
  }
  return KNOWN_TABLE_COLUMNS[table] ?? [];
}

/**
 * Real columns (from a live `PRAGMA table_info`) that aren't in
 * `KNOWN_TABLE_COLUMNS` for this table — i.e. a schema drift like the
 * `sessions.shell_last_seen_index` gap this issue closes. Never affects
 * what gets read (that's unconditional `SELECT *`); only feeds a
 * proactive warning (`reader.ts`'s `computeSchemaDescriptor`) so a future
 * drift is surfaced instead of found by hand.
 */
export function detectUnknownColumns(table: string, realColumns: string[]): string[] {
  const known = new Set(KNOWN_TABLE_COLUMNS[table] ?? []);
  return realColumns.filter((column) => !known.has(column));
}
