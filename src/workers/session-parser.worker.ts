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

import type {
  DashboardSession,
  MessageRole,
  ParsedSession,
  ParseError,
  SessionEvent,
  SessionSource,
  ToolExecution,
  TranscriptMessage,
} from '../types';

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

// ==================== Tool classification ====================

const READ_TOOL_PATTERN =
  /^(read_file|read|view|cat_file|cat|ls|list_dir|list_files|glob|grep|grep_search|search|search_files|find)$/i;
const WRITE_TOOL_PATTERN =
  /^(file_write|write_file|write|create_file|edit|str_replace|apply_patch|insert|replace|create_directory|write)$/i;
const AGENT_TOOL_PATTERN = /(agent|skill)/i;

export function isReadTool(toolName: string): boolean {
  return READ_TOOL_PATTERN.test(toolName);
}

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOL_PATTERN.test(toolName);
}

export function isAgentOrSkill(toolName: string): boolean {
  return AGENT_TOOL_PATTERN.test(toolName);
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function tryParseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ==================== Session builder ====================

/**
 * Accumulates normalized facts while a parser walks its source events, then
 * finalizes into an immutable DashboardSession.
 */
class SessionBuilder {
  readonly toolExecutions: ToolExecution[] = [];
  readonly events: SessionEvent[] = [];
  readonly messages: TranscriptMessage[] = [];
  readonly errors: ParseError[] = [];

  inputTokens = 0;
  outputTokens = 0;
  costUsd: number | undefined;
  model: string | undefined;
  contextCompactions = 0;
  turns = 0;
  startedAt = Number.MAX_SAFE_INTEGER;
  endedAt = 0;

  private readonly filesRead = new Set<string>();
  private readonly filesWritten = new Set<string>();
  private agentInvocations = 0;

  observeTimestamp(timestamp: number): void {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return;
    if (timestamp < this.startedAt) this.startedAt = timestamp;
    if (timestamp > this.endedAt) this.endedAt = timestamp;
  }

  addTool(
    toolName: string,
    toolType: string,
    target: string | undefined,
    timestamp: number,
    success = true
  ): ToolExecution {
    if (isReadTool(toolName) && target) this.filesRead.add(target);
    if (isWriteTool(toolName) && target) this.filesWritten.add(target);
    if (isAgentOrSkill(toolName)) this.agentInvocations++;

    const execution: ToolExecution = {
      id: generateId(),
      session_id: '',
      timestamp,
      tool_name: toolName || 'unknown',
      tool_type: toolType,
      target,
      success,
    };
    this.toolExecutions.push(execution);
    return execution;
  }

  addEvent(
    eventType: string,
    description: string,
    timestamp: number,
    metadata?: Record<string, unknown>
  ): void {
    this.events.push({
      id: generateId(),
      session_id: '',
      timestamp,
      event_type: eventType,
      description,
      metadata,
    });
  }

  addMessage(role: MessageRole, content: string, timestamp: number): void {
    if (!content) return;
    this.messages.push({
      id: generateId(),
      session_id: '',
      role,
      content,
      timestamp,
    });
    this.turns++;
  }

  addCompaction(timestamp: number, tokensSaved: number, metadata?: Record<string, unknown>): void {
    this.contextCompactions++;
    this.addEvent(
      'context_compaction',
      `Context compaction: ${tokensSaved} tokens saved`,
      timestamp,
      metadata
    );
  }

  addError(error: ParseError): void {
    this.errors.push(error);
  }

  finalize(projectId: string, source: SessionSource, title: string): ParsedSession {
    const now = Date.now();
    const session: DashboardSession = {
      id: generateId(),
      project_id: projectId,
      source,
      title,
      started_at: Number.isFinite(this.startedAt) ? this.startedAt : now,
      ended_at: Number.isFinite(this.endedAt) && this.endedAt > 0 ? this.endedAt : now,
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      total_tokens: this.inputTokens + this.outputTokens,
      cost_usd: this.costUsd,
      model: this.model,
      context_compactions: this.contextCompactions,
      total_turns: this.turns,
      files_read: this.filesRead.size,
      files_written: this.filesWritten.size,
      agent_invocations: this.agentInvocations,
      tool_executions: this.toolExecutions,
      events: this.events,
      messages: this.messages,
    };

    for (const tool of this.toolExecutions) tool.session_id = session.id;
    for (const event of this.events) event.session_id = session.id;
    for (const message of this.messages) message.session_id = session.id;

    return { session, parseErrors: this.errors };
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
          Boolean(item && typeof item === 'object')
        );
        if (items.some((item) => item.jsonrpc !== undefined)) return 'mcp';
        return 'antigravity';
      }
    } catch {
      // Not a valid JSON array - fall through to line-based detection.
    }
  }

  const lines = trimmed.split('\n').filter((line) => line.trim());
  const sample: Array<Record<string, unknown>> = [];
  for (const line of lines.slice(0, 100)) {
    const parsed = tryParseJson(line);
    if (parsed) sample.push(parsed);
  }
  if (sample.length === 0) return 'unknown';

  if (
    sample.some((event) =>
      ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'].includes(
        String(event.type)
      )
    )
  ) {
    return 'claude';
  }

  if (
    sample.some((event) => event.type === 'session' && event.version !== undefined) ||
    sample.some((event) =>
      ['usage_snapshot', 'tool_execution_start', 'message_update'].includes(String(event.type))
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
        (event.prompt_eval_count !== undefined || event.eval_count !== undefined || event.warning !== undefined)
    )
  ) {
    return 'local_runner';
  }

  return 'unknown';
}

// ==================== Parsers ====================

/**
 * Claude Code parser.
 *
 * Identification: JSONL whose lines are Claude API streaming events
 * (`message_start`, `content_block_*`, `message_delta`).
 * Key fields mapped: `message.usage` input/output tokens, tool_use content
 * blocks -> tool executions, text deltas -> assistant transcript messages.
 * Limitations: sample-format events carry no timestamps, so session start/end
 * fall back to the parse time.
 */
export function parseClaudeCode(content: string, projectId: string, title = ''): ParsedSession {
  const builder = new SessionBuilder();
  const lines = content.trim().split('\n').filter((line) => line.trim());
  const textBlocks = new Map<number, string>();

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

    const type = String(event.type ?? 'unknown');
    builder.addEvent(type, `Claude event: ${type}`, Date.now(), event);

    if (type === 'message_start') {
      const message = event.message as Record<string, unknown> | undefined;
      const usage = message?.usage as Record<string, unknown> | undefined;
      if (usage) {
        builder.inputTokens += Number(usage.input_tokens ?? 0);
        builder.outputTokens += Number(usage.output_tokens ?? 0);
      }
      builder.turns++;
    } else if (type === 'message_delta') {
      const usage = event.usage as Record<string, unknown> | undefined;
      if (usage) builder.outputTokens += Number(usage.output_tokens ?? 0);
    } else if (type === 'content_block_start') {
      const block = event.content_block as Record<string, unknown> | undefined;
      if (block?.type === 'tool_use') {
        const input = (block.input ?? {}) as Record<string, unknown>;
        const target =
          (input.path as string) ?? (input.file_path as string) ?? (input.target as string) ?? undefined;
        builder.addTool(String(block.name ?? 'unknown'), 'tool_use', target, Date.now());
      } else if (block?.type === 'text') {
        const blockIndex = Number(event.index ?? 0);
        textBlocks.set(blockIndex, '');
      }
    } else if (type === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        const blockIndex = Number(event.index ?? 0);
        textBlocks.set(blockIndex, (textBlocks.get(blockIndex) ?? '') + delta.text);
      }
    } else if (type === 'content_block_stop') {
      const blockIndex = Number(event.index ?? 0);
      const text = textBlocks.get(blockIndex);
      if (text) builder.addMessage('assistant', text, Date.now());
      textBlocks.delete(blockIndex);
    }
  });

  return builder.finalize(projectId, 'claude', title);
}

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
  const lines = content.trim().split('\n').filter((line) => line.trim());

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
      builder.addEvent('session_start', `Session ${String(event.id ?? '')} in ${String(event.cwd ?? '')}`, Date.now(), event);
    } else if (event.type === 'message_update') {
      const role = event.role === 'assistant' ? 'assistant' : 'user';
      builder.addMessage(role, String(event.content ?? ''), Date.now());
    } else if (event.type === 'tool_execution_start') {
      builder.addTool(
        String(event.tool ?? 'unknown'),
        'tool_execution',
        event.target !== undefined ? String(event.target) : undefined,
        Date.now()
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
      builder.addError({ message: 'Skipping non-object array item', raw_data: String(rawItem).substring(0, 100) });
      continue;
    }
    const item = rawItem as Record<string, unknown>;
    const timestamp = item.timestamp ? new Date(String(item.timestamp)).getTime() : Date.now();
    builder.observeTimestamp(timestamp);

    const eventType = String(item.event ?? 'unknown');
    builder.addEvent(eventType, `Event: ${eventType}`, timestamp, item);

    if (eventType === 'tool_exec') {
      builder.addTool(String(item.tool ?? 'unknown'), 'bash', item.cmd !== undefined ? String(item.cmd) : undefined, timestamp);
    } else if (eventType === 'file_write') {
      builder.addTool('file_write', 'file_system', item.file !== undefined ? String(item.file) : undefined, timestamp);
    } else if (eventType === 'context_compaction') {
      builder.addCompaction(timestamp, Number(item.tokens_saved ?? 0), item);
    } else if (eventType === 'request-review' || eventType === 'request_review') {
      builder.addEvent('policy_override', `Policy override: ${String(item.policy ?? 'request-review')}`, timestamp, item);
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
  const lines = content.trim().split('\n').filter((line) => line.trim());

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
      items = parsed.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
    } else if (parsed && typeof parsed === 'object') {
      items = [parsed as Record<string, unknown>];
    }
  } catch {
    // Not a single JSON document - treat as JSONL.
    const lines = content.trim().split('\n').filter((line) => line.trim());
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
        timestamp
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
        item.error !== undefined ? `MCP tool error: ${JSON.stringify(item.error)}` : 'MCP tool result received',
        timestamp,
        item
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
  const lines = content.trim().split('\n').filter((line) => line.trim());

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
      if (event.prompt_eval_count !== undefined) builder.inputTokens += Number(event.prompt_eval_count);
      if (event.eval_count !== undefined) builder.outputTokens += Number(event.eval_count);
      builder.turns++;
      builder.addEvent(
        'model_inference',
        `Model: ${event.model}, prompt evals: ${Number(event.prompt_eval_count ?? 0)}, evals: ${Number(event.eval_count ?? 0)}`,
        timestamp,
        event
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
  title = ''
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
    total_tokens: 0,
    context_compactions: 0,
    total_turns: 0,
    files_read: 0,
    files_written: 0,
    agent_invocations: 0,
    tool_executions: [],
    events: [],
    messages: [],
  };
}

// ==================== Main entry point ====================

export function parseSession(payload: string, projectId: string, title = ''): ParsedSession {
  const format = detectFormat(payload);

  switch (format) {
    case 'claude':
      return parseClaudeCode(payload, projectId, title);
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

export {};
