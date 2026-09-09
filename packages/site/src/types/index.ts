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
  /**
   * Count of context-compaction events for this session, when known. `null`
   * means "no compaction capability recorded for this harness/session yet"
   * (e.g. a sync stub written before parsed content lands) - distinct from
   * a confirmed `0` compactions. Never coerce a missing count to `0` here;
   * render it as "—"/"N/A", per `missing-is-never-zero`.
   */
  context_compactions: number | null;
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
  /** Remote sync session id, when this session came from a sync run. */
  sync_session_id?: string;
  /** Sync status, when this session came from a sync run. */
  sync_status?: SessionSyncStatus;
  /** Detail text for a failed sync. */
  sync_details?: string;
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
  /**
   * The `uuid` of the raw transcript entry carrying this tool's `tool_result`
   * block (Claude Code format only). Lets a caller walk the transcript
   * forward - e.g. finding messages whose `parent_uuid` matches this value -
   * to recover content the model produced right after the tool_result, such
   * as a Skill invocation's expanded instructions.
   */
  result_uuid?: string;
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
  /** URL-safe local slug; mirrors the remote bucket folder name. */
  readable_id?: string;
  /** Sync state, when the project is part of an active connection. */
  sync_status?: ProjectSyncStatus;
  /** Owning connection, when the project is synced. */
  connection_id?: string;
}

/** Project-level sync state: idle (NULL), currently syncing, or fully in sync. */
export type ProjectSyncStatus = 'in_sync' | 'syncing';

/** Session-level sync state. */
export type SessionSyncStatus =
  | 'pending'
  | 'processing'
  | 'in_sync'
  | 'failed'
  | 'transcript_unavailable';

/**
 * A remote storage connection (currently S3). One project may reference one
 * connection through `Project.connection_id`.
 */
export interface Connection {
  id: string;
  name: string;
  storage_type: 's3';
  sync_only_new: boolean;
  last_sync_at?: number;
  created_at: number;
  updated_at: number;
}

/** S3 credential material stored encrypted at rest. */
export interface StoredS3Credentials {
  connection_id: string;
  region: string;
  endpoint?: string;
  bucket: string;
  access_key_id: string;
  secret_access_key_ct: string;
  secret_access_key_iv: string;
  session_token_ct?: string;
  session_token_iv?: string;
  created_at: number;
  updated_at: number;
}

/** Singleton passkey-backed vault state, constrained to row id = 1. */
export interface PasskeyState {
  id: 1;
  kdf_salt: string;
  verifier_iv: string;
  verifier_ct: string;
  webauthn_credential_id?: string;
  webauthn_wrapped_key?: string;
  webauthn_expires_at?: number;
  created_at: number;
}

/**
 * Minimal local structural stand-in for the SyncManifest type that will
 * eventually be imported from @lucasschirm/sal-sync-core. It contains only
 * the fields needed to write the sync mirror columns on `sessions`.
 */
export interface SyncManifest {
  sessionId: string;
  schemaVersion: number;
  harness?: string;
  harnessVersion?: string;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  endReason?: string;
  syncVersion?: string;
  pluginVersion?: string;
  transcriptsCaptured?: number | boolean;
  mainTranscriptRelativePath?: string;
  artifacts: unknown[];
  syncRuns: unknown[];
}

/**
 * A placeholder session created from a sync manifest before its transcript has
 * been downloaded and parsed. All metric columns default to 0 when written.
 */
export interface SessionStub {
  id: string;
  project_id: string;
  source: string;
  title: string;
  started_at: string;
  ended_at: string;
  sync_session_id: string;
  sync_status: 'pending';
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
  model?: string;
  model_usage?: string;
  tasks?: string;
  external_id?: string;
  subagents?: string;
  context_compactions?: number;
  total_turns?: number;
  files_read?: number;
  files_written?: number;
  agent_invocations?: number;
}

/** A file record for downloaded/processed session-scope artifacts. */
export interface SessionFileRecord {
  id: string;
  project_id: string;
  session_id: string;
  path: string;
  scope: 'session' | 'workspace' | 'global' | 'runtime';
  sha256: string;
  etag?: string;
  size: number;
  status: 'downloaded' | 'processed' | 'failed';
  updated_at: number;
}
