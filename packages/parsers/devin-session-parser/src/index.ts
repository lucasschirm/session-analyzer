/**
 * Public API barrel for `@lucasschirm/sal-devin-session-parser` — the pure
 * parser for `devin-session-jsonl/v1` (DS-F2 (#157)), ATIF v1.7 native
 * transcripts, `models.json`, and `schema-descriptor.json`. Consumed by
 * `devin-transformer` (DS-F7 (#149)); this package never opens/writes SQLite
 * and never depends on `db-core`/`db` (`transformers-never-write-sqlite`,
 * `sql-only-in-db-core`).
 */

export type { AtifFinalMetrics, AtifStep, AtifTranscript, ParseAtifResult } from './atif/parse.js';
// ---- ATIF v1.7 native transcript parsing ---------------------------------
export { ATIF_SCHEMA_VERSION, parseAtifTranscript } from './atif/parse.js';
export type {
  DevinCog,
  DevinCogLifetime,
  DevinCogPermission,
  DevinCogPermissionTarget,
  DevinCogToolAvailability,
  ParseDevinCogsResult,
} from './cogs/parse-cogs.js';
// ---- sessions.cogs_json parsing (DS-F11 (#288)) --------------------------
export { parseDevinCogsJson } from './cogs/parse-cogs.js';
export type { DevinCompactionBoundary, DevinPrunedRange } from './jsonl/compaction.js';
// ---- compaction (`/compact`) boundary detection --------------------------
export {
  computePrunedNodeIds,
  detectCompactionBoundaries,
} from './jsonl/compaction.js';

// ---- devin-session-jsonl/v1 line parsing ---------------------------------
export { parseDevinJsonlLine, parseDevinJsonlText } from './jsonl/parse-line.js';
export type {
  DevinJsonlLineType,
  DevinJsonlParseResult,
  DevinJsonlParseWarning,
  DevinMessageLine,
  DevinMessageNodeMetadata,
  DevinParsedLine,
  DevinPromptLine,
  DevinSessionLine,
  DevinToolCallLine,
  RawDevinJsonlLine,
} from './jsonl/types.js';
export type { DevinKnownRole, DevinNormalizedRole } from './message/role-map.js';
// ---- chat_message.role normalization -------------------------------------
export { isKnownDevinRole, mapDevinRole } from './message/role-map.js';
export type {
  DevinModelPricing,
  DevinModelRecord,
  ParseDevinModelsResult,
} from './models/parse.js';
// ---- models.json parsing (DS-F4 (#153) forward-compatible shape) --------
export { parseDevinModelsJson } from './models/parse.js';
export type { DevinRefineryMigration, DevinSchemaDescriptor } from './schema-descriptor/parse.js';
// ---- schema-descriptor.json parsing --------------------------------------
export { parseSchemaDescriptor } from './schema-descriptor/parse.js';
export type {
  AcpNormalizedKind,
  AcpToolCall,
  AcpToolCallKind,
  AcpToolCallUpdate,
} from './tool-call/acp-parse.js';
// ---- ACP tool_call parsing ------------------------------------------------
export { parseAcpToolCall, parseAcpToolCallUpdate } from './tool-call/acp-parse.js';
