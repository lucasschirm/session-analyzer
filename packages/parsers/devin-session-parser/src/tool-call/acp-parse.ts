/**
 * Parses the ACP (Agent Client Protocol) `ToolCall` shape Devin persists in
 * `tool_call_state.tool_call_json`, and the status/update payload in
 * `tool_call_update_json`.
 *
 * `kind` (`edit|execute|search`) is preserved verbatim — never collapsed
 * into a generic "tool" bucket — per `analytics-domain-distinctions`: this
 * feeds DS-F7 (#149)'s domain-correct Tool invocation mapping.
 */

const KNOWN_KINDS = ['edit', 'execute', 'search'] as const;

export type AcpToolCallKind = (typeof KNOWN_KINDS)[number];
export type AcpNormalizedKind = AcpToolCallKind | 'unknown';

const INFERENCE_TOOL_NAME_META_KEY = 'cognition.ai/inferenceToolName';

export interface AcpToolCall {
  toolCallId: string;
  title: string | null;
  kind: AcpNormalizedKind;
  /** The raw `kind` string when present but unrecognized; `null` otherwise. */
  rawKind: string | null;
  content: unknown;
  rawInput: unknown;
  /**
   * `_meta["cognition.ai/inferenceToolName"]` on `tool_call_json` itself.
   * Devin stamps this `_meta` key on both `tool_call_json` and
   * `tool_call_update_json` when it is present at all, so this lets a
   * consumer resolve the domain-correct tool name even for a call whose
   * `tool_call_update_json` never arrived (e.g. an interrupted session) —
   * see `AcpToolCallUpdate.inferenceToolName` for the update-side twin.
   */
  inferenceToolName: string | null;
}

export interface AcpToolCallUpdate {
  status: string | null;
  /** `_meta["cognition.ai/inferenceToolName"]`, when present. */
  inferenceToolName: string | null;
  raw: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRecord(json: string | null): Record<string, unknown> | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeKind(value: unknown): { kind: AcpNormalizedKind; rawKind: string | null } {
  if (typeof value === 'string' && (KNOWN_KINDS as readonly string[]).includes(value)) {
    return { kind: value as AcpToolCallKind, rawKind: null };
  }
  return { kind: 'unknown', rawKind: typeof value === 'string' ? value : null };
}

/** Parses `tool_call_json` into a typed ACP `ToolCall`; `null` if absent/unparseable. */
export function parseAcpToolCall(json: string | null): AcpToolCall | null {
  const record = parseJsonRecord(json);
  if (record === null || typeof record.toolCallId !== 'string') {
    return null;
  }
  const { kind, rawKind } = normalizeKind(record.kind);
  return {
    toolCallId: record.toolCallId,
    title: typeof record.title === 'string' ? record.title : null,
    kind,
    rawKind,
    content: record.content ?? null,
    rawInput: record.rawInput ?? null,
    inferenceToolName: extractInferenceToolName(record),
  };
}

function extractInferenceToolName(record: Record<string, unknown>): string | null {
  const meta = record._meta;
  if (!isRecord(meta)) return null;
  const value = meta[INFERENCE_TOOL_NAME_META_KEY];
  return typeof value === 'string' ? value : null;
}

/** Parses `tool_call_update_json` into a typed status update; `null` if absent/unparseable. */
export function parseAcpToolCallUpdate(json: string | null): AcpToolCallUpdate | null {
  const record = parseJsonRecord(json);
  if (record === null) return null;
  return {
    status: typeof record.status === 'string' ? record.status : null,
    inferenceToolName: extractInferenceToolName(record),
    raw: record,
  };
}
