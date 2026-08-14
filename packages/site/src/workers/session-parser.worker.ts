/**
 * Session Parser Web Worker
 *
 * Detection router that inspects the payload schema (never the file
 * extension), routes to the matching format parser, and normalizes every
 * supported format into the standard DashboardSession shape.
 *
 * Supported formats: Claude Code, Agentic Pi, Antigravity, OpenCode/Codex,
 * Model Context Protocol (MCP), and Local Runner (Ollama/vLLM) logs.
 */

import { detectClaudeCode, parseSessionTranscript } from '@lucasschirm/sal-claude-session-parser';
import { toDashboardSession } from '../lib/claude-to-dashboard';
import type { DashboardSession, ParsedSession, SessionSource, ToolExecution } from '../types';
import {
  generateId,
  isAgentOrSkill,
  isAgentTool,
  isReadTool,
  isSkillTool,
  isWriteTool,
  SessionBuilder,
} from './session-builder';

export { isAgentOrSkill, isAgentTool, isReadTool, isSkillTool, isWriteTool };

// ==================== Worker message protocol ====================

export interface ParseRequest {
  type: 'parse';
  payload: string;
  projectId: string;
  title?: string;
}

export interface ParseResponse {
  type: 'result';
  result: ParsedSession;
}

export interface ParseErrorResponse {
  type: 'error';
  message: string;
}

function tryParseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ==================== Format detection ====================

/**
 * Identifies the session format by schema inspection only (the file
 * extension is deliberately ignored).
 */
export function detectFormat(content: string): SessionSource | 'unknown' {
  const trimmed = content.trim();
  if (!trimmed) return 'unknown';

  // Array payloads: Antigravity event arrays, or MCP as a JSON-RPC array.
  if (trimmed.startsWith('[')) {
    try {
      const data: unknown = JSON.parse(trimmed);
      if (Array.isArray(data)) {
        const items = data.filter((item): item is Record<string, unknown> =>
          Boolean(item && typeof item === 'object'),
        );
        if (items.some((item) => item.jsonrpc !== undefined)) return 'mcp';
        return 'antigravity';
      }
    } catch {
      // Not a valid JSON array - fall through to line-based detection.
    }
  }

  // Real Claude Code CLI transcripts: `user`/`assistant`/`system` turn
  // records interleaved with CLI-only bookkeeping lines - detected via the
  // parser package's own schema-based sniff (never the file extension).
  if (detectClaudeCode(trimmed)) return 'claude';

  const lines = trimmed.split('\n').filter((line) => line.trim());
  const sample: Array<Record<string, unknown>> = [];
  for (const line of lines.slice(0, 100)) {
    const parsed = tryParseJson(line);
    if (parsed) sample.push(parsed);
  }
  if (sample.length === 0) return 'unknown';

  if (
    sample.some((event) => event.type === 'session' && event.version !== undefined) ||
    sample.some((event) =>
      ['usage_snapshot', 'tool_execution_start', 'message_update'].includes(String(event.type)),
    )
  ) {
    return 'agentic_pi';
  }

  if (sample.some((event) => event.jsonrpc !== undefined)) return 'mcp';
  if (sample.some((event) => typeof event.action === 'string')) return 'opencode_codex';
  if (
    sample.some(
      (event) =>
        typeof event.model === 'string' &&
        (event.prompt_eval_count !== undefined ||
          event.eval_count !== undefined ||
          event.warning !== undefined),
    )
  ) {
    return 'local_runner';
  }

  return 'unknown';
}

// ==================== Parsers ====================
//
// Claude Code has its own dedicated pipeline: `detectClaudeCode` +
// `parseSessionTranscript` (from `@lucasschirm/sal-claude-session-parser`)
// followed by `toDashboardSession` (`../lib/claude-to-dashboard`) - see the
// 'claude' case in `parseSession` below. It's the only one of the six
// formats extracted into its own package so far; the other five keep
// parsing directly into `DashboardSession` here via `SessionBuilder`.

/**
 * Agentic Pi parser.
 *
 * Identification: JSONL starting with `{"type":"session","version":3,...}`,
 * followed by `message_update`, `tool_execution_start` and a final
 * `usage_snapshot`.
 * Key fields mapped: exact input/output tokens and `cost_usd` from
 * `usage_snapshot`, tool executions, transcript messages from message_update.
 * Limitations: events carry no timestamps in this format.
 */
export function parseAgenticPi(content: string, projectId: string, title = ''): ParsedSession {
  const builder = new SessionBuilder();
  const lines = content
    .trim()
    .split('\n')
    .filter((line) => line.trim());

  lines.forEach((line, index) => {
    const event = tryParseJson(line);
    if (!event) {
      builder.addError({
        line: index + 1,
        message: 'Failed to parse JSON line',
        raw_data: line.substring(0, 100),
      });
      return;
    }

    if (event.type === 'session') {
      builder.addEvent(
        'session_start',
        `Session ${String(event.id ?? '')} in ${String(event.cwd ?? '')}`,
        Date.now(),
        event,
      );
    } else if (event.type === 'message_update') {
      const role = event.role === 'assistant' ? 'assistant' : 'user';
      builder.addMessage(role, String(event.content ?? ''), Date.now());
    } else if (event.type === 'tool_execution_start') {
      builder.addTool(
        String(event.tool ?? 'unknown'),
        'tool_execution',
        event.target !== undefined ? String(event.target) : undefined,
        Date.now(),
      );
    } else if (event.type === 'usage_snapshot') {
      const tokens = event.tokens as Record<string, unknown> | undefined;
      builder.inputTokens = Number(tokens?.input ?? 0);
      builder.outputTokens = Number(tokens?.output ?? 0);
      if (typeof event.cost_usd === 'number') builder.costUsd = event.cost_usd;
      if (typeof event.model === 'string') builder.model = event.model;
      builder.addEvent('usage_snapshot', 'Final usage snapshot', Date.now(), event);
    }
  });

  return builder.finalize(projectId, 'agentic_pi', title);
}

/**
 * Antigravity parser.
 *
 * Identification: a top-level JSON array of sandbox events (`tool_exec`,
 * `file_write`, `context_compaction`, `request-review` policy overrides).
 * Key fields mapped: tool executions with ISO timestamps, context compaction
 * counts/tokens saved, policy override events.
 * Limitations: no token usage or transcript messages exist in this format.
 */
export function parseAntigravity(content: string, projectId: string, title = ''): ParsedSession {
  const builder = new SessionBuilder();

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (error) {
    builder.addError({ message: `Failed to parse JSON array: ${(error as Error).message}` });
    return builder.finalize(projectId, 'antigravity', title);
  }

  if (!Array.isArray(data)) {
    builder.addError({ message: 'Expected JSON array' });
    return builder.finalize(projectId, 'antigravity', title);
  }

  for (const rawItem of data) {
    if (!rawItem || typeof rawItem !== 'object') {
      builder.addError({
        message: 'Skipping non-object array item',
        raw_data: String(rawItem).substring(0, 100),
      });
      continue;
    }
    const item = rawItem as Record<string, unknown>;
    const timestamp = item.timestamp ? new Date(String(item.timestamp)).getTime() : Date.now();
    builder.observeTimestamp(timestamp);

    const eventType = String(item.event ?? 'unknown');
    builder.addEvent(eventType, `Event: ${eventType}`, timestamp, item);

    if (eventType === 'tool_exec') {
      builder.addTool(
        String(item.tool ?? 'unknown'),
        'bash',
        item.cmd !== undefined ? String(item.cmd) : undefined,
        timestamp,
      );
    } else if (eventType === 'file_write') {
      builder.addTool(
        'file_write',
        'file_system',
        item.file !== undefined ? String(item.file) : undefined,
        timestamp,
      );
    } else if (eventType === 'context_compaction') {
      builder.addCompaction(timestamp, Number(item.tokens_saved ?? 0), item);
    } else if (eventType === 'request-review' || eventType === 'request_review') {
      builder.addEvent(
        'policy_override',
        `Policy override: ${String(item.policy ?? 'request-review')}`,
        timestamp,
        item,
      );
    }
  }

  return builder.finalize(projectId, 'antigravity', title);
}

/**
 * OpenCode / Codex parser.
 *
 * Identification: JSONL whose lines carry an `action` field
 * (`user_command`, `cli_exec`).
 * Key fields mapped: CLI formatter commands (prettier/eslint/biome) as
 * formatter tool usage, `/undo` commands tracked as events, user commands
 * into the transcript.
 * Limitations: numeric timestamps are unix seconds and are converted to ms.
 */
export function parseOpenCodeCodex(content: string, projectId: string, title = ''): ParsedSession {
  const builder = new SessionBuilder();
  const lines = content
    .trim()
    .split('\n')
    .filter((line) => line.trim());

  lines.forEach((line, index) => {
    const event = tryParseJson(line);
    if (!event) {
      builder.addError({
        line: index + 1,
        message: 'Failed to parse JSON line',
        raw_data: line.substring(0, 100),
      });
      return;
    }

    const timestamp = toTimestamp(event.timestamp);
    builder.observeTimestamp(timestamp);

    if (event.action === 'cli_exec') {
      const command = String(event.command ?? '');
      const isFormatter = /(prettier|eslint|biome|format)/i.test(command);
      builder.addTool(isFormatter ? 'formatter' : 'cli', 'cli_exec', command, timestamp);
    } else if (event.action === 'user_command') {
      const text = String(event.text ?? '');
      builder.addMessage('user', text, timestamp);
      if (text.trim() === '/undo') {
        builder.addEvent('undo_command', '/undo', timestamp, event);
      }
    }
  });

  return builder.finalize(projectId, 'opencode_codex', title);
}

/**
 * Model Context Protocol (MCP) parser.
 *
 * Identification: JSON-RPC 2.0 trace messages (`jsonrpc: "2.0"`), either as
 * a JSON array or JSONL lines, with `tools/call` methods.
 * Key fields mapped: CallToolRequest -> tool executions, CallToolResult /
 * error responses -> success/failure events correlated by request id.
 * Limitations: trace logs carry no timestamps; request count is used for the
 * interactions metric.
 */
export function parseMCP(content: string, projectId: string, title = ''): ParsedSession {
  const builder = new SessionBuilder();
  const pendingCalls = new Map<unknown, ToolExecution>();

  let items: Array<Record<string, unknown>> = [];
  try {
    const parsed: unknown = JSON.parse(content);
    if (Array.isArray(parsed)) {
      items = parsed.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === 'object'),
      );
    } else if (parsed && typeof parsed === 'object') {
      items = [parsed as Record<string, unknown>];
    }
  } catch {
    // Not a single JSON document - treat as JSONL.
    const lines = content
      .trim()
      .split('\n')
      .filter((line) => line.trim());
    lines.forEach((line, index) => {
      const parsedLine = tryParseJson(line);
      if (parsedLine) {
        items.push(parsedLine);
      } else {
        builder.addError({
          line: index + 1,
          message: 'Failed to parse JSON-RPC line',
          raw_data: line.substring(0, 100),
        });
      }
    });
  }

  if (items.length === 0) {
    builder.addError({ message: 'No JSON-RPC messages found' });
  }

  for (const item of items) {
    const timestamp = toTimestamp(item.timestamp);
    builder.observeTimestamp(timestamp);

    if (item.method === 'tools/call') {
      const params = (item.params ?? {}) as Record<string, unknown>;
      const toolName = String(params.name ?? 'unknown');
      const execution = builder.addTool(
        toolName,
        'mcp_call',
        params.arguments !== undefined ? JSON.stringify(params.arguments) : undefined,
        timestamp,
      );
      if (item.id !== undefined) pendingCalls.set(item.id, execution);
      builder.turns++;
      builder.addEvent('CallToolRequest', `MCP tool call: ${toolName}`, timestamp, item);
    } else if (item.result !== undefined || item.error !== undefined) {
      const matched = item.id !== undefined ? pendingCalls.get(item.id) : undefined;
      if (matched) {
        matched.success = item.error === undefined;
        pendingCalls.delete(item.id);
      }
      builder.addEvent(
        item.error !== undefined ? 'CallToolError' : 'CallToolResult',
        item.error !== undefined
          ? `MCP tool error: ${JSON.stringify(item.error)}`
          : 'MCP tool result received',
        timestamp,
        item,
      );
    }
  }

  return builder.finalize(projectId, 'mcp', title);
}

/**
 * Local Runner (Ollama / vLLM) parser.
 *
 * Identification: JSONL server request logs carrying a `model` field plus
 * `prompt_eval_count` / `eval_count` metrics or hardware warnings.
 * Key fields mapped: prompt eval counts -> input tokens, eval counts ->
 * output tokens, models used, generation warnings (e.g. VRAM pressure).
 * Limitations: no tool usage exists in this format.
 */
export function parseLocalRunner(content: string, projectId: string, title = ''): ParsedSession {
  const builder = new SessionBuilder();
  const lines = content
    .trim()
    .split('\n')
    .filter((line) => line.trim());

  lines.forEach((line, index) => {
    const event = tryParseJson(line);
    if (!event) {
      builder.addError({
        line: index + 1,
        message: 'Failed to parse JSON line',
        raw_data: line.substring(0, 100),
      });
      return;
    }

    const timestamp = toTimestamp(event.timestamp);
    builder.observeTimestamp(timestamp);

    if (typeof event.model === 'string') {
      builder.model = event.model;
      if (event.prompt_eval_count !== undefined)
        builder.inputTokens += Number(event.prompt_eval_count);
      if (event.eval_count !== undefined) builder.outputTokens += Number(event.eval_count);
      builder.turns++;
      builder.addEvent(
        'model_inference',
        `Model: ${event.model}, prompt evals: ${Number(event.prompt_eval_count ?? 0)}, evals: ${Number(event.eval_count ?? 0)}`,
        timestamp,
        event,
      );
    }

    if (event.warning !== undefined) {
      builder.addEvent('warning', String(event.warning), timestamp, event);
    }
  });

  return builder.finalize(projectId, 'local_runner', title);
}

function toTimestamp(value: unknown): number {
  if (typeof value === 'number') {
    // Heuristic: values below 1e12 are unix seconds.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

export function createEmptySession(
  projectId: string,
  source: SessionSource,
  title = '',
): DashboardSession {
  const now = Date.now();
  return {
    id: generateId(),
    project_id: projectId,
    source,
    title,
    started_at: now,
    ended_at: now,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
    models: [],
    context_compactions: 0,
    total_turns: 0,
    files_read: 0,
    files_written: 0,
    agent_invocations: 0,
    tool_executions: [],
    events: [],
    messages: [],
    tasks: [],
    subagents: [],
  };
}

// ==================== Main entry point ====================

export function parseSession(payload: string, projectId: string, title = ''): ParsedSession {
  const format = detectFormat(payload);

  switch (format) {
    case 'claude':
      return toDashboardSession(parseSessionTranscript(payload), projectId, title);
    case 'agentic_pi':
      return parseAgenticPi(payload, projectId, title);
    case 'antigravity':
      return parseAntigravity(payload, projectId, title);
    case 'opencode_codex':
      return parseOpenCodeCodex(payload, projectId, title);
    case 'mcp':
      return parseMCP(payload, projectId, title);
    case 'local_runner':
      return parseLocalRunner(payload, projectId, title);
    default:
      return {
        session: createEmptySession(projectId, 'claude', title),
        parseErrors: [
          { message: `Unknown format detected. Raw content preview: ${payload.substring(0, 200)}` },
        ],
      };
  }
}

// ==================== Worker message handler ====================

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  const { type, payload, projectId, title } = event.data;

  if (type !== 'parse') return;

  try {
    const result = parseSession(payload, projectId, title);
    const response: ParseResponse = { type: 'result', result };
    self.postMessage(response);
  } catch (error) {
    const response: ParseErrorResponse = {
      type: 'error',
      message: `Parser error: ${(error as Error).message}`,
    };
    self.postMessage(response);
  }
};
