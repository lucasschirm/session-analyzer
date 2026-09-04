import { mergeSessionHashes } from './session-watermark.js';
import { mergeToolCallStateHashes } from './tool-call-watermark.js';
import type {
  DevinJsonlLine,
  DevinSessionRow,
  DevinToolCallStateRow,
  DevinWatermarks,
} from './types.js';
import { EMPTY_WATERMARKS } from './types.js';

/**
 * Derives `DevinWatermarks` (plus a total line count, for `orderOffset`)
 * from a `devin-session-jsonl/v1` transcript file's own already-written
 * content, by parsing each line and reading its own `type`/`row_id`/`id`
 * fields back out — never from a separately persisted watermark record
 * (#286). Reading the file's own tail is self-healing by construction: it
 * cannot desync from what was actually written the way a sibling watermark
 * file could on a crash between two separate writes, and it automatically
 * absorbs every pre-existing transcript written by the prior full-rewrite
 * code with no migration step.
 *
 * This is a **read path** only, narrowly scoped to the four fields each
 * line type needs for watermark purposes. It must never be confused with,
 * or refactored into, the **write path** (`messageLine`/`toolCallLine`/
 * `sessionLine`/`promptLine` in `jsonl-writer.ts`), which continues to
 * spread each row's full raw content — `chat_message` included — into every
 * appended line. See `materializeSessionTranscript`'s doc comment.
 */
export interface DerivedWatermarkState {
  watermarks: DevinWatermarks;
  lineCount: number;
}

/**
 * A single malformed line is skipped (not fatal) and still counted toward
 * `lineCount`, so a later `orderOffset` never collides with a slot the bad
 * line already occupied. Only when the file yields *zero* usable lines
 * (empty content, or content that doesn't parse as JSONL at all) does this
 * fail safe to `{ watermarks: EMPTY_WATERMARKS, lineCount: 0 }` — a `0`-ish
 * watermark is never fabricated for "no data recoverable" any other way
 * (`missing-is-never-zero`).
 */
export function deriveWatermarksFromExistingLines(text: string): DerivedWatermarkState {
  const rawLines = text.split('\n').filter((line) => line.length > 0);
  const validLines = rawLines.map(parseJsonlLine).filter(isRecord);
  if (validLines.length === 0) {
    return { watermarks: EMPTY_WATERMARKS, lineCount: 0 };
  }
  return { watermarks: foldLines(validLines), lineCount: rawLines.length };
}

function parseJsonlLine(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strips the three wrapper fields every line construction function adds
 * (`type`, `ts`, `order`) so what's left is exactly the raw row content
 * `computeWatermarks`/`session-watermark.ts`/`tool-call-watermark.ts` would
 * have hashed, in the row's own original column order. */
function stripLineWrapper(line: Record<string, unknown>): Record<string, unknown> {
  const { type: _type, ts: _ts, order: _order, ...rest } = line;
  return rest;
}

function maxRowId(prior: number | null, raw: unknown): number | null {
  if (typeof raw !== 'number' || raw < 0) return prior;
  return prior === null ? raw : Math.max(prior, raw);
}

function isToolCallRow(row: Record<string, unknown>): row is DevinToolCallStateRow {
  return (
    typeof row.row_id === 'number' &&
    typeof row.session_id === 'string' &&
    typeof row.tool_call_id === 'string'
  );
}

function isSessionRow(row: Record<string, unknown>): row is DevinSessionRow {
  return typeof row.id === 'string';
}

function foldToolCallLine(state: DevinWatermarks, line: Record<string, unknown>): DevinWatermarks {
  const row = stripLineWrapper(line);
  if (!isToolCallRow(row)) return state;
  return {
    ...state,
    toolCallStateHashes: mergeToolCallStateHashes(state.toolCallStateHashes, [row]),
  };
}

function foldSessionLine(state: DevinWatermarks, line: Record<string, unknown>): DevinWatermarks {
  const row = stripLineWrapper(line);
  if (!isSessionRow(row)) return state;
  return {
    ...state,
    sessionsContentHashes: mergeSessionHashes(state.sessionsContentHashes, [row]),
  };
}

function foldLine(state: DevinWatermarks, line: Record<string, unknown>): DevinWatermarks {
  switch (line.type as DevinJsonlLine['type'] | undefined) {
    case 'message':
      return { ...state, messageNodesRowId: maxRowId(state.messageNodesRowId, line.row_id) };
    case 'prompt':
      return { ...state, promptHistoryId: maxRowId(state.promptHistoryId, line.id) };
    case 'tool_call':
      return foldToolCallLine(state, line);
    case 'session':
      return foldSessionLine(state, line);
    default:
      return state;
  }
}

function foldLines(lines: Record<string, unknown>[]): DevinWatermarks {
  let state = EMPTY_WATERMARKS;
  for (const line of lines) {
    state = foldLine(state, line);
  }
  return state;
}
