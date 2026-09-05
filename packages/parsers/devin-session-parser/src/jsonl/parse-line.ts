/**
 * Parses `devin-session-jsonl/v1` text (DS-F2 (#157)'s extractor output) into
 * typed lines. Any line that fails `JSON.parse` or shape validation is
 * recorded as a warning and skipped — this parser never throws on a single
 * bad line, matching the "never crash" contract shared with the upstream
 * extractor.
 */

import { mapDevinRole } from '../message/role-map.js';
import { parseAcpToolCall, parseAcpToolCallUpdate } from '../tool-call/acp-parse.js';
import type {
  DevinJsonlParseResult,
  DevinJsonlParseWarning,
  DevinMessageLine,
  DevinMessageNodeMetadata,
  DevinParsedLine,
  DevinPromptLine,
  DevinSessionLine,
  DevinSubagentExtensions,
  DevinToolCallLine,
  RawDevinJsonlLine,
} from './types.js';

const LINE_TYPES = ['session', 'message', 'tool_call', 'prompt'] as const;
const RAW_LINE_PREVIEW_LENGTH = 200;

type LineResult = { line: DevinParsedLine } | { reason: string };

function isKnownLineType(value: unknown): value is RawDevinJsonlLine['type'] & string {
  return typeof value === 'string' && (LINE_TYPES as readonly string[]).includes(value);
}

/** A missing `ts` key and an explicit `ts: null` both normalize to `null`; `ts: 0` stays `0`. */
function normalizeTs(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}

function isValidOrder(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function num(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Integer field that the real schema stores as INTEGER but older synthetic
 * transcripts (and defensive callers) may carry as a numeric string (#324:
 * `main_chain_id` is INTEGER in every observed sessions.db; coercing it
 * through `str()` nulled the authoritative main-chain signal on all real
 * data). Non-integer and non-numeric values stay null — never guessed.
 */
function intOrNull(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}

type SessionFields = Omit<DevinSessionLine, 'type' | 'ts' | 'order' | 'id'>;

function sessionFields(row: RawDevinJsonlLine): SessionFields {
  return {
    workingDirectory: str(row, 'working_directory'),
    backendType: str(row, 'backend_type'),
    model: str(row, 'model'),
    agentMode: str(row, 'agent_mode'),
    createdAt: num(row, 'created_at'),
    lastActivityAt: num(row, 'last_activity_at'),
    title: str(row, 'title'),
    mainChainId: intOrNull(row, 'main_chain_id'),
    cogsJson: str(row, 'cogs_json'),
    workspaceDirs: str(row, 'workspace_dirs'),
    hidden: num(row, 'hidden'),
    metadata: str(row, 'metadata'),
  };
}

function buildSessionLine(row: RawDevinJsonlLine, ts: number | null, order: number): LineResult {
  if (typeof row.id !== 'string') return { reason: 'session line missing string id' };
  const line: DevinSessionLine = { type: 'session', ts, order, id: row.id, ...sessionFields(row) };
  return { line };
}

function parseChatMessage(raw: unknown): { chatMessage: unknown; role: string | null } {
  if (typeof raw !== 'string') return { chatMessage: null, role: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    const role =
      typeof parsed === 'object' && parsed !== null && 'role' in parsed
        ? (parsed as { role: unknown }).role
        : null;
    return { chatMessage: parsed, role: typeof role === 'string' ? role : null };
  } catch {
    return { chatMessage: null, role: null };
  }
}

/** `message_nodes.metadata` is JSON-object-shaped `{summarized_from, num_tokens_preceding,
 * is_system_prefix, ...extensions}`. Never throws: malformed/non-object JSON degrades
 * to `null`, mirroring `parseChatMessage`'s never-crash posture. */
function parseMessageNodeMetadata(raw: string | null): DevinMessageNodeMetadata | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const { summarized_from, num_tokens_preceding, is_system_prefix, ...rest } = record;
  return {
    summarizedFrom: typeof summarized_from === 'number' ? summarized_from : null,
    numTokensPreceding: typeof num_tokens_preceding === 'number' ? num_tokens_preceding : null,
    isSystemPrefix: typeof is_system_prefix === 'boolean' ? is_system_prefix : null,
    extensions: Object.keys(rest).length > 0 ? rest : undefined,
  };
}

/**
 * Parses `chat_message.metadata.extensions`' four `subagent/*` keys
 * (DS-B28 (#294) design item 1) — a **different namespace** from the
 * row-level `message_nodes.metadata` column `parseMessageNodeMetadata`
 * handles above (see `DevinSubagentExtensions`'s own doc comment). Never
 * throws: a non-object `chatMessage`, or one with no `metadata.extensions`
 * object, degrades to `null`. Returns `null` (not a mostly-null object) when
 * none of the four keys are present, so callers can treat `subagent !== null`
 * as "this node is subagent-tagged" without inspecting every field.
 */
function parseSubagentExtensions(chatMessage: unknown): DevinSubagentExtensions | null {
  if (typeof chatMessage !== 'object' || chatMessage === null) return null;
  const metadata = (chatMessage as Record<string, unknown>).metadata;
  if (typeof metadata !== 'object' || metadata === null) return null;
  const extensions = (metadata as Record<string, unknown>).extensions;
  if (typeof extensions !== 'object' || extensions === null) return null;
  const ext = extensions as Record<string, unknown>;
  const agentId =
    typeof ext['subagent/agent_id'] === 'string' ? (ext['subagent/agent_id'] as string) : null;
  const profileName =
    typeof ext['subagent/profile_name'] === 'string'
      ? (ext['subagent/profile_name'] as string)
      : null;
  const model =
    typeof ext['subagent/model'] === 'string' ? (ext['subagent/model'] as string) : null;
  const chainNodeId =
    typeof ext['subagent/chain_node_id'] === 'number'
      ? (ext['subagent/chain_node_id'] as number)
      : null;
  if (agentId === null && profileName === null && model === null && chainNodeId === null) {
    return null;
  }
  return { agentId, profileName, model, chainNodeId };
}

type MessageFields = Omit<DevinMessageLine, 'type' | 'ts' | 'order' | 'sessionId' | 'nodeId'>;

function messageFields(row: RawDevinJsonlLine): MessageFields {
  const { chatMessage, role } = parseChatMessage(row.chat_message);
  const normalizedRole = mapDevinRole(role);
  const metadata = str(row, 'metadata');
  return {
    rowId: num(row, 'row_id') ?? 0,
    parentNodeId: num(row, 'parent_node_id'),
    role: normalizedRole,
    rawRole: normalizedRole === 'unknown' ? role : null,
    chatMessage,
    createdAt: num(row, 'created_at'),
    metadata,
    parsedMetadata: parseMessageNodeMetadata(metadata),
    subagent: parseSubagentExtensions(chatMessage),
  };
}

function buildMessageLine(row: RawDevinJsonlLine, order: number): LineResult {
  if (typeof row.session_id !== 'string' || typeof row.node_id !== 'number') {
    return { reason: 'message line missing session_id/node_id' };
  }
  const line: DevinMessageLine = {
    type: 'message',
    ts: null,
    order,
    sessionId: row.session_id,
    nodeId: row.node_id,
    ...messageFields(row),
  };
  return { line };
}

function buildToolCallLine(row: RawDevinJsonlLine, order: number): LineResult {
  if (typeof row.session_id !== 'string' || typeof row.tool_call_id !== 'string') {
    return { reason: 'tool_call line missing session_id/tool_call_id' };
  }
  const line: DevinToolCallLine = {
    type: 'tool_call',
    ts: null,
    order,
    rowId: num(row, 'row_id') ?? 0,
    sessionId: row.session_id,
    toolCallId: row.tool_call_id,
    call: parseAcpToolCall(str(row, 'tool_call_json')),
    update: parseAcpToolCallUpdate(str(row, 'tool_call_update_json')),
  };
  return { line };
}

function buildPromptLine(row: RawDevinJsonlLine, ts: number | null, order: number): LineResult {
  if (typeof row.id !== 'number' || typeof row.session_id !== 'string') {
    return { reason: 'prompt line missing id/session_id' };
  }
  const line: DevinPromptLine = {
    type: 'prompt',
    ts,
    order,
    id: row.id,
    sessionId: row.session_id,
    content: str(row, 'content'),
    isShell: typeof row.is_shell === 'number' ? row.is_shell !== 0 : null,
  };
  return { line };
}

function buildLine(row: RawDevinJsonlLine, ts: number | null, order: number): LineResult {
  switch (row.type) {
    case 'session':
      return buildSessionLine(row, ts, order);
    case 'message':
      return buildMessageLine(row, order);
    case 'tool_call':
      return buildToolCallLine(row, order);
    case 'prompt':
      return buildPromptLine(row, ts, order);
    default:
      return { reason: `unreachable line type ${String(row.type)}` };
  }
}

/**
 * Parses one `devin-session-jsonl/v1` line. Returns the typed line on
 * success, or a warning (never a throw) when the line is malformed JSON or
 * fails shape validation.
 */
export function parseDevinJsonlLine(
  rawText: string,
  lineNumber: number,
): { line: DevinParsedLine } | { warning: DevinJsonlParseWarning } {
  const preview = rawText.slice(0, RAW_LINE_PREVIEW_LENGTH);
  let row: unknown;
  try {
    row = JSON.parse(rawText);
  } catch {
    return { warning: { lineNumber, reason: 'invalid JSON', rawLine: preview } };
  }
  return validateAndBuild(row, lineNumber, preview);
}

function warn(
  lineNumber: number,
  reason: string,
  rawLine: string,
): { warning: DevinJsonlParseWarning } {
  return { warning: { lineNumber, reason, rawLine } };
}

/** Validates `type`/`order`/`ts`; returns a failure reason or the normalized `ts`. */
function validateLineFields(record: RawDevinJsonlLine): { ts: number | null } | { reason: string } {
  if (!isKnownLineType(record.type)) {
    return { reason: `unknown type ${String(record.type)}` };
  }
  if (!isValidOrder(record.order)) {
    return { reason: 'order is not a valid integer' };
  }
  const ts = normalizeTs(record.ts);
  if (typeof ts === 'number' && Number.isNaN(ts)) {
    return { reason: 'ts is not a number or null' };
  }
  return { ts };
}

function validateAndBuild(
  row: unknown,
  lineNumber: number,
  preview: string,
): { line: DevinParsedLine } | { warning: DevinJsonlParseWarning } {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    return warn(lineNumber, 'line is not a JSON object', preview);
  }
  const record = row as RawDevinJsonlLine;
  const validated = validateLineFields(record);
  if ('reason' in validated) return warn(lineNumber, validated.reason, preview);
  const result = buildLine(record, validated.ts, record.order as number);
  return 'line' in result ? { line: result.line } : warn(lineNumber, result.reason, preview);
}

/** Parses a full `devin-session-jsonl/v1` text blob: one JSON object per line. */
export function parseDevinJsonlText(text: string): DevinJsonlParseResult {
  const lines: DevinParsedLine[] = [];
  const warnings: DevinJsonlParseWarning[] = [];
  const rawLines = text.split('\n').filter((rawLine) => rawLine.trim().length > 0);
  rawLines.forEach((rawLine, index) => {
    const result = parseDevinJsonlLine(rawLine, index + 1);
    'line' in result ? lines.push(result.line) : warnings.push(result.warning);
  });
  return { lines, warnings };
}
