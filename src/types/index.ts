/**
 * Core types for the Agentic Session Dashboard
 */

export type SessionSource =
  | 'claude'
  | 'agentic_pi'
  | 'antigravity'
  | 'opencode_codex'
  | 'mcp'
  | 'local_runner';

export interface DashboardSession {
  id: string;
  project_id: string;
  source: SessionSource;
  title: string;
  started_at: number;
  ended_at: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cost_usd?: number;
  model?: string;
  models: ModelTokenUsage[];
  context_compactions: number;
  total_turns: number;
  files_read: number;
  files_written: number;
  agent_invocations: number;
  tool_executions: ToolExecution[];
  events: SessionEvent[];
  messages: TranscriptMessage[];
  tasks: SessionTask[];
  /**
   * The raw source-format session id (Claude Code's `sessionId`), when
   * available - a stable natural key used to (a) detect that a re-upload of
   * the same session should update this row instead of creating a
   * duplicate, and (b) match a folder of subagent transcripts uploaded
   * separately (e.g. from the session page) back to the right session.
   */
  external_id?: string;
  subagents: SubagentUsage[];
}

/**
 * Aggregated usage for one subagent (Claude Code `Task`/`Agent` tool
 * invocation), parsed from its own `subagents/agent-<id>.jsonl` transcript
 * and paired `.meta.json` sidecar. Its tokens/cache/models are folded into
 * the parent session's totals; this record keeps the per-agent breakdown.
 */
export interface SubagentUsage {
  agent_id: string;
  agent_type?: string;
  /** From the meta sidecar - doubles as the subagent's display title. */
  description?: string;
  model?: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  tool_call_count: number;
  started_at?: number;
  ended_at?: number;
  /**
   * This subagent's own transcript messages, parsed the same way as a main
   * session's `messages` (from its `subagents/agent-<id>.jsonl` file).
   * Optional/defaults to empty for older persisted rows written before this
   * field existed and for callers that only need the aggregate stats.
   */
  messages?: TranscriptMessage[];
}

/** Per-model token usage breakdown (a session may use more than one model). */
export interface ModelTokenUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
}

/**
 * A task from Claude Code's `task_reminder` attachments, deduped by `id`
 * across every snapshot seen in the session (each attachment carries the
 * *full current* task list, not a delta).
 */
export interface SessionTask {
  id: string;
  subject: string;
  description: string;
  status: string;
  /** Timestamp of the earliest reminder in which this task id appeared. */
  first_seen_at: number;
  /** Timestamp of the earliest reminder in which this task was 'completed'. */
  completed_at?: number;
}

export interface ToolExecution {
  id: string;
  session_id: string;
  timestamp: number;
  tool_name: string;
  tool_type: string;
  target?: string;
  success: boolean;
  duration_ms?: number;
  /** Raw parameters the tool/skill was invoked with (e.g. tool_use input). */
  parameters?: Record<string, unknown>;
  /**
   * The tool_result's content, normalized to a string. `tool_result.content`
   * is usually a plain string, but can be an array of content blocks - text
   * blocks are joined, other shapes are JSON-stringified.
   */
  result?: string;
}

export interface SessionEvent {
  id: string;
  session_id: string;
  timestamp: number;
  event_type: string;
  description: string;
  metadata?: Record<string, unknown>;
}

export type MessageRole = 'user' | 'assistant' | 'system';

export interface TranscriptMessage {
  id: string;
  session_id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  /** Source-format message id (e.g. Claude Code's `uuid`), when available. */
  uuid?: string;
  /** The `uuid` of this message's parent turn, when available. */
  parent_uuid?: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  created_at: number;
  updated_at: number;
  session_count: number;
}

export interface SessionMetrics {
  total_sessions: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  total_tool_executions: number;
  avg_session_duration_ms: number;
  models_used: string[];
}

/** Drill-down indicator keys supported by the Indicator Details page. */
export type IndicatorKey =
  | 'tokens'
  | 'compactions'
  | 'turns'
  | 'tools'
  | 'files_read'
  | 'files_written'
  | 'agents'
  | 'diagnostics'
  | 'tasks';

// Parser types
export interface ParsedSession {
  session: DashboardSession;
  parseErrors: ParseError[];
}

export interface ParseError {
  line?: number;
  message: string;
  raw_data?: string;
}

export interface ParserResult {
  sessions: ParsedSession[];
  summary: {
    total_parsed: number;
    total_errors: number;
  };
}
