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
  total_tokens: number;
  cost_usd?: number;
  model?: string;
  context_compactions: number;
  total_turns: number;
  files_read: number;
  files_written: number;
  agent_invocations: number;
  tool_executions: ToolExecution[];
  events: SessionEvent[];
  messages: TranscriptMessage[];
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
  | 'agents';

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
