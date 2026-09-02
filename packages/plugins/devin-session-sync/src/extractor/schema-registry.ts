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

/** Column lists per table, used to build explicit (never `SELECT *`) reads. */
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
  tool_call_state: [
    'row_id',
    'session_id',
    'tool_call_id',
    'tool_call_json',
    'tool_call_update_json',
  ],
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

/** Explicit `SELECT <columns>` column list for a table under a resolution. */
export function knownColumnsFor(table: string, resolution: SchemaResolution): string[] {
  if (!resolution.knownTables.includes(table)) {
    return [];
  }
  return KNOWN_TABLE_COLUMNS[table] ?? [];
}
