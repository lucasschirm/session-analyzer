import type { ParseError, ParseOptions } from '../types/common.js';
import type { ClaudeCodeEntry } from '../types/session.js';

export interface EntryParseOutcome {
  entry: ClaudeCodeEntry | null;
  errors: ParseError[];
  unknownType?: string;
}

// TODO(T2): implement — see spec §1.2 (raw JSON object -> ClaudeCodeEntry)
export function parseEntry(raw: Record<string, unknown>, lineNumber: number, options?: ParseOptions): EntryParseOutcome {
  void raw;
  void lineNumber;
  void options;
  return { entry: null, errors: [] };
}
