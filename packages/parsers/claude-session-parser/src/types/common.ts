/**
 * Shared primitives used across every parser in this package.
 *
 * See spec: docs/superpowers/specs/2026-08-12-claude-session-parser-design.md
 */

/**
 * Every `parseX` function in this package is designed to never throw on
 * malformed input — problems go into a `parseErrors: ParseError[]` array on
 * the relevant result, always using this shape.
 */
export interface ParseError {
  line?: number;
  uuid?: string;
  /** Stable machine-readable reason, e.g. "invalid_json", "unknown_entry_type". */
  code: string;
  message: string;
  rawSnippet?: string;
}

/**
 * Shared timeline envelope. `entryUuid` is the transcript entry's own
 * `uuid`; `lineNumber` is a fallback that covers entries which carry no
 * `uuid` (several bookkeeping entry types don't — see `lineNumber` on
 * `ClaudeCodeEntryBase` and the uuid-less entry interfaces in session.ts).
 */
export interface AvailabilityEvent<A extends string> {
  action: A;
  entryUuid?: string;
  lineNumber: number;
  timestampMs?: number;
  isInitial?: boolean;
}

/**
 * Where a piece of `.claude` configuration was found. `'plugin'` covers
 * config shipped inside an installed plugin (as opposed to a user/project/
 * local/managed root); `'unknown'` is the honest fallback when scope cannot
 * be determined from the caller-supplied source path.
 */
export type ClaudeScope = 'user' | 'project' | 'local' | 'managed' | 'plugin' | 'unknown';

/**
 * Options accepted by every `parseX` function that can produce large
 * retained blobs or timeline derivations.
 */
export interface ParseOptions {
  /** Keep every raw JSON line per entry (default false — memory). */
  retainRaw?: boolean;
  /** Cap retained blob sizes (nested_memory.rawContent, invoked_skills.content, hook stdout, addedLines). */
  maxBlobBytes?: number;
  /** Fast structural-only parse, no timeline derivation. */
  skipTimelines?: boolean;
}
