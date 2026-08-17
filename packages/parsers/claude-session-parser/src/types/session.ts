/**
 * Native Claude Code session transcript types — spec §1.
 *
 * See spec: docs/superpowers/specs/2026-08-12-claude-session-parser-design.md
 */

import type { ParseError } from './common.js';
import type { ClaudeCodeSettings } from './config.js';
import type {
  AgentAvailabilityRecord,
  CompactionRecord,
  HookEventRecord,
  McpServerRecord,
  PermissionModeChange,
  PrLinkRecord,
  RuleRecord,
  SkillAvailabilityRecord,
  SubagentLaunchRecord,
  ToolAvailabilityRecord,
} from './timeline.js';

// ---------------------------------------------------------------------------
// 1.1 Session root
// ---------------------------------------------------------------------------

export interface ClaudeCodeSession {
  /** Singular root fields below (`sessionId`, `slug`, `agentName`, `cwd`,
   *  `gitBranch`, `agentId`) follow one rule: **first non-empty value seen
   *  wins**, and every later per-entry value remains available on the
   *  entries themselves. `sessionId` is safe as first-seen (verified: no
   *  real file in the 316-transcript corpus mixes `sessionId` values), but
   *  `cwd` (relocation) and `gitBranch` (checkouts) genuinely can change
   *  mid-session — callers needing the full history must walk `entries`,
   *  the root field is only the session's starting point. `aiTitle` is the
   *  one exception: **last** `ai-title` entry wins, since the CLI rewrites
   *  the title as the session evolves. `cliVersions` is already a
   *  deduplicated array of every `version` observed, in first-seen order. */
  sessionId?: string;
  aiTitle?: string;
  slug?: string;
  agentName?: string;
  cwd?: string;
  gitBranch?: string;
  cliVersions: string[];
  isSidechain: boolean;
  /** Present on subagent transcripts. */
  agentId?: string;

  entries: ClaudeCodeEntry[];

  /** Computed by summing message.usage across every assistant entry during
   *  the same parse pass — NOT sourced from any native "session total" event,
   *  because none exists (verified: no shutdown/stop-hook/summary event in
   *  316 real transcripts carries an aggregate; see spec §8 evaluation). */
  aggregateUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    models: Record<
      string,
      {
        inputTokens: number;
        outputTokens: number;
        cacheCreationTokens: number;
        cacheReadTokens: number;
      }
    >;
  };

  tools: ToolAvailabilityRecord[];
  skills: SkillAvailabilityRecord[];
  agents: AgentAvailabilityRecord[];
  rules: RuleRecord[];
  mcpServers: McpServerRecord[];
  permissionModes: PermissionModeChange[];
  hooks: HookEventRecord[];
  compactions: CompactionRecord[];
  prLinks: PrLinkRecord[];
  subagentLaunches: SubagentLaunchRecord[];

  parseErrors: ParseError[];
  /** Observability for unrecognized `type`/`attachment.type` values. */
  unknownTypes: Record<string, number>;

  /** Additive (T9): every `ClaudeCodeSettings` folded in via
   *  `ClaudeSessionBuilder.appendSettings`, in append order. Not populated
   *  by `parseSessionTranscript` itself (a transcript carries no settings
   *  data) — only the builder ever sets this. */
  settings?: ClaudeCodeSettings[];
  /** Additive (T9): sub-session transcripts folded in via
   *  `ClaudeSessionBuilder.appendSubAgent`, keyed by the same `agentId`
   *  used to join `SubagentLaunchRecord.agentId`. Not populated by
   *  `parseSessionTranscript` itself. */
  subagentSessions?: Record<string, ClaudeCodeSession>;
}

// ---------------------------------------------------------------------------
// 1.2 Entry union
// ---------------------------------------------------------------------------

export type ClaudeCodeEntry =
  | AssistantEntry
  | UserEntry
  | SystemEntry
  | AttachmentEntry
  | ModeEntry
  | PermissionModeEntry
  | AiTitleEntry
  | LastPromptEntry
  | AgentNameEntry
  | PrLinkEntry
  | BridgeSessionEntry
  | QueueOperationEntry
  | FileHistorySnapshotEntry
  | FileHistoryDeltaEntry
  | RelocatedEntry
  | WorktreeStateEntry
  | SummaryEntry
  | UnknownEntry;

export interface ClaudeCodeEntryBase {
  uuid: string;
  parentUuid: string | null;
  /** Raw ISO-8601 as recorded. */
  timestamp: string;
  /** Parsed. */
  timestampMs: number;
  isSidechain: boolean;
  sessionId: string;
  /** NOTE: distinct field from `sessionId`, can differ from it — keep both, never conflate. */
  session_id?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  slug?: string;
  userType?: string;
  entrypoint?: string;
  /** Sidechain only. */
  agentId?: string;
  /** 1-based; entries without uuid/timestamp still get this. */
  lineNumber: number;
  /** Rare (1-3 occurrences corpus-wide) but real top-level fields — kept
   *  optional rather than dropped, since silently discarding known real
   *  fields would make `raw`/`unknownTypes` fallbacks lie about coverage. */
  ownerAccountUuid?: string;
  ownerOrganizationUuid?: string;
  isAbortedMidStream?: boolean;
  /** Present only when `ParseOptions.retainRaw` is true — the original
   *  parsed JSON object for this entry, verbatim. Omitted by default
   *  (memory) — see `ParseOptions.retainRaw`. Uuid-less bookkeeping entries
   *  (ModeEntry, AiTitleEntry, …) don't get this field: they're already
   *  small enough that their typed shape loses nothing. */
  raw?: Record<string, unknown>;
}

export interface AssistantEntry extends ClaudeCodeEntryBase {
  type: 'assistant';
  requestId?: string;
  effort?: string;
  message: {
    id?: string;
    model?: string;
    role: 'assistant';
    content: ContentBlock[];
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
      cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
      output_tokens_details?: { thinking_tokens?: number };
      /** Per-iteration usage on interleaved-thinking retries. Overlaps the
       *  top-level totals above — do NOT additionally sum these into
       *  `aggregateUsage`, that would double-count (confirmed real, 21k+
       *  occurrences; the top-level fields are already the session's view). */
      iterations?: Array<Record<string, unknown>>;
    };
    stop_reason?: string;
    diagnostics?: { cache_miss_reason?: { type?: string; cache_missed_input_tokens?: number } };
  };
  /** "acme:root-cause-analysis" */
  attributionSkill?: string;
  /** "acme" */
  attributionPlugin?: string;
  /** "acme:mcp" */
  attributionMcpServer?: string;
  /** "validate_record" */
  attributionMcpTool?: string;
  /** Set on sidechain entries. */
  attributionAgent?: string;
  error?: unknown;
  isApiErrorMessage?: boolean;
  apiErrorStatus?: number;
}

export interface UserEntry extends ClaudeCodeEntryBase {
  type: 'user';
  message: { role: 'user'; content: string | ContentBlock[] };
  /** CLI-injected — includes skill-body expansions; do not blanket-drop. */
  isMeta?: boolean;
  promptId?: string;
  promptSource?: string;
  origin?: string;
  permissionMode?: string;
  toolUseResult?: ToolUseResult;
  sourceToolUseID?: string;
  sourceToolAssistantUUID?: string;
  toolDenialKind?: string;
  toolEndsTurn?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  interruptedByShutdown?: boolean;
  interruptedMessageId?: string;
  userFeedback?: unknown;
  queuePriority?: unknown;
  classifierMetaLines?: unknown;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking?: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: unknown;
      is_error?: boolean;
      truncated?: TruncationSignal;
    }
  // Forward-compatible catch-all.
  | { type: string; [k: string]: unknown };

/** Claude Code truncates content in several distinct, differently-shaped
 *  real forms (confirmed: 37 inline markers, 20 read_truncation_notice
 *  banners, 20 Read truncatedByTokenCap flags, 20 Glob/Grep truncated
 *  flags). `kind` records which real signal produced this record; the
 *  optional fields vary by kind rather than forcing every shape into one
 *  schema. `droppedChars` comes from parsing the inline
 *  `"... [N characters truncated] ..."` marker found in `tool_result`
 *  content and mirrored onto `toolUseResult`. */
export interface TruncationSignal {
  kind:
    | 'inline_char_count'
    | 'read_truncation_notice'
    | 'file_token_cap'
    | 'search_truncated'
    | 'mcp_instructions_truncated';
  droppedChars?: number;
  shownLines?: number;
  totalLines?: number;
  banner?: string;
}

/** Real, observed shape of `toolUseResult` — varies by which tool produced
 *  it; kept as one type with mostly-optional fields plus a catch-all rather
 *  than a per-tool union, since the discriminant (which tool ran) lives on
 *  the *paired* tool_use block, not on the result itself. */
export interface ToolUseResult {
  // Read
  file?: {
    filePath: string;
    content: string;
    numLines: number;
    totalLines: number;
    startLine?: number;
    truncatedByTokenCap?: boolean;
  };
  // Glob / Grep
  truncated?: boolean;
  countIsComplete?: boolean;
  numFiles?: number;
  totalMatches?: number;
  filenames?: string[];
  // Bash — real structured git signal, confirmed (commit.sha, push.branch, pr.number/url/action)
  gitOperation?: {
    commit?: { sha: string; kind: string };
    push?: { branch: string };
    pr?: { number: number; url: string; action: string };
  };
  stdout?: string;
  stderr?: string;
  interrupted?: boolean;
  // Agent (subagent launch result) — see SubagentLaunchRecord
  isAsync?: boolean;
  status?: string;
  agentId?: string;
  description?: string;
  resolvedModel?: string;
  prompt?: string;
  /** Real per-subagent aggregate, confirmed (e.g. 77668). */
  totalTokens?: number;
  usage?: Record<string, unknown>;
  // MCP tool result passthrough
  _meta?: Record<string, unknown>;
  structuredContent?: unknown;
  /** Forward-compatible — real payload shape varies per tool. */
  [k: string]: unknown;
}

export interface ModelRefusalFallback {
  originalModel: string;
  fallbackModel: string;
  direction?: string;
  scope?: string;
  trigger?: string;
  apiRefusalCategory?: string;
  apiRefusalExplanation?: string;
  retractedMessageUuids?: string[];
  refusedUserMessageUuid?: string;
}

export interface SystemEntry extends ClaudeCodeEntryBase {
  type: 'system';
  subtype:
    | 'turn_duration'
    | 'stop_hook_summary'
    | 'away_summary'
    | 'local_command'
    | 'bridge_status'
    | 'compact_boundary'
    | 'scheduled_task_fire'
    | 'agents_killed'
    | 'model_refusal_fallback'
    | (string & {});
  content?: string;
  level?: string;
  isMeta?: boolean;
  toolUseID?: string;
  requestId?: string;
  durationMs?: number;
  messageCount?: number;
  hookCount?: number;
  hookInfos?: Array<{ command: string; durationMs?: number }>;
  hookErrors?: unknown[];
  hookAdditionalContext?: unknown[];
  preventedContinuation?: boolean;
  stopReason?: string;
  hasOutput?: boolean;
  url?: string;
  logicalParentUuid?: string;
  compactMetadata?: CompactMetadata;
  pendingBackgroundAgentCount?: number;
  modelRefusalFallback?: ModelRefusalFallback;
}

export interface CompactMetadata {
  trigger: 'manual' | 'auto' | (string & {});
  preTokens: number;
  postTokens: number;
  cumulativeDroppedTokens: number;
  durationMs: number;
  preservedSegment?: { headUuid: string; anchorUuid: string; tailUuid: string };
  preservedMessages?: { anchorUuid: string; uuids: string[]; allUuids: string[] };
}

export interface AttachmentEntry extends ClaudeCodeEntryBase {
  type: 'attachment';
  attachment: ClaudeAttachment;
}

export type ClaudeAttachment =
  | DeferredToolsDeltaAttachment
  | AgentListingDeltaAttachment
  | SkillListingAttachment
  | DynamicSkillAttachment
  | InvokedSkillsAttachment
  | McpInstructionsDeltaAttachment
  | CommandPermissionsAttachment
  | NestedMemoryAttachment
  | CompactFileReferenceAttachment
  | HookSuccessAttachment
  | HookNonBlockingErrorAttachment
  | HookAdditionalContextAttachment
  | HookSystemMessageAttachment
  | TaskReminderAttachment
  | TodoReminderAttachment
  | FileAttachment
  | EditedTextFileAttachment
  | DiagnosticsAttachment
  | StructuredOutputAttachment
  | QueuedCommandAttachment
  | PlanModeAttachment
  | PlanModeExitAttachment
  | AutoModeAttachment
  | AutoModeExitAttachment
  | AgentMentionAttachment
  | DateChangeAttachment
  | ReadTruncationNoticeAttachment
  | MaxTurnsReachedAttachment
  | { type: string; [k: string]: unknown };

export interface DeferredToolsDeltaAttachment {
  type: 'deferred_tools_delta';
  addedNames: string[];
  addedLines: string[];
  removedNames: string[];
  readdedNames?: string[];
  pendingMcpServers?: string[];
  needsAuthMcpServers?: string[];
}

export interface AgentListingDeltaAttachment {
  type: 'agent_listing_delta';
  addedTypes: string[];
  /** "- <name>: <description…> (Tools: All tools)" */
  addedLines: string[];
  removedTypes: string[];
  isInitial: boolean;
  showConcurrencyNote?: boolean;
}

export interface SkillListingAttachment {
  type: 'skill_listing';
  names: string[];
  /** "- <name>: <description>\n- …" */
  content: string;
  skillCount: number;
  isInitial: boolean;
}

export interface DynamicSkillAttachment {
  type: 'dynamic_skill';
  skillDir: string;
  skillNames: string[];
  displayPath: string;
}

export interface InvokedSkillsAttachment {
  type: 'invoked_skills';
  skills: Array<{ name: string; path: string; content: string }>;
}

/** `addedBlocks[]` entries can individually end with a literal
 *  `"… [truncated]"` suffix (confirmed, 5 occurrences) — this is free text
 *  truncation inside an already-free-text block, not a separate field. */
export interface McpInstructionsDeltaAttachment {
  type: 'mcp_instructions_delta';
  addedNames: string[];
  /** "## <server>\n<instructions markdown>" */
  addedBlocks: string[];
  removedNames: string[];
}

export interface NestedMemoryAttachment {
  type: 'nested_memory';
  path: string;
  content: {
    path: string;
    type: 'Project' | 'User' | 'Local' | 'Managed' | (string & {});
    /** Frontmatter-stripped body actually injected. */
    content: string;
    globs?: string[];
    contentDiffersFromDisk: boolean;
    /** Full file including YAML frontmatter. */
    rawContent: string;
  };
}

export interface CompactFileReferenceAttachment {
  type: 'compact_file_reference';
  filename: string;
  displayPath: string;
}

export interface HookSuccessAttachment {
  type: 'hook_success';
  hookName: string;
  hookEvent: string;
  toolUseID: string;
  content: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
  durationMs: number;
}

export interface HookAdditionalContextAttachment {
  type: 'hook_additional_context';
  content: string[];
  hookName: string;
  hookEvent: string;
  toolUseID: string;
}

export interface CommandPermissionsAttachment {
  type: 'command_permissions';
  allowedTools: string[];
}

/** Confirmed real (20 occurrences); the banner is dense structured text
 *  worth parsing (file path, shown/total line range, token estimate, token
 *  cap) — a `parseTruncationBanner(banner)` helper is a nice-to-have, not
 *  required for v1. */
export interface ReadTruncationNoticeAttachment {
  type: 'read_truncation_notice';
  banner: string;
  toolUseID: string;
}

// ---------------------------------------------------------------------------
// Remaining attachment shapes — carry lower-priority data (existing
// `task_reminder` handling stays as today). Modeled minimally per spec §1.2:
// a discriminant `type` plus the real field names confirmed against the
// corpus, plus an index signature so the union member is discriminable
// without over-modelling and stays forward-compatible.
// ---------------------------------------------------------------------------

export interface TaskReminderAttachment {
  type: 'task_reminder';
  content?: unknown[];
  itemCount?: number;
  [k: string]: unknown;
}

/** Not observed in this machine's corpus (zero occurrences) — modeled by
 *  analogy with the confirmed-real `TaskReminderAttachment` shape, same as
 *  `SummaryEntry` elsewhere in this file. */
export interface TodoReminderAttachment {
  type: 'todo_reminder';
  [k: string]: unknown;
}

export interface FileAttachment {
  type: 'file';
  filename?: string;
  content?: unknown;
  [k: string]: unknown;
}

export interface EditedTextFileAttachment {
  type: 'edited_text_file';
  filename?: string;
  snippet?: string;
  [k: string]: unknown;
}

export interface DiagnosticsAttachment {
  type: 'diagnostics';
  files?: unknown[];
  isNew?: boolean;
  [k: string]: unknown;
}

export interface StructuredOutputAttachment {
  type: 'structured_output';
  data?: unknown;
  toolUseID?: string;
  [k: string]: unknown;
}

export interface QueuedCommandAttachment {
  type: 'queued_command';
  prompt?: string;
  commandMode?: string;
  timestamp?: string;
  [k: string]: unknown;
}

export interface PlanModeAttachment {
  type: 'plan_mode';
  reminderType?: string;
  isSubAgent?: boolean;
  planFilePath?: string;
  planExists?: boolean;
  [k: string]: unknown;
}

export interface PlanModeExitAttachment {
  type: 'plan_mode_exit';
  planFilePath?: string;
  planExists?: boolean;
  [k: string]: unknown;
}

export interface AutoModeAttachment {
  type: 'auto_mode';
  autoModeConsentFlow?: boolean;
  bashFirst?: boolean;
  steerOnly?: boolean;
  [k: string]: unknown;
}

export interface AutoModeExitAttachment {
  type: 'auto_mode_exit';
  [k: string]: unknown;
}

export interface AgentMentionAttachment {
  type: 'agent_mention';
  agentType?: string;
  [k: string]: unknown;
}

export interface DateChangeAttachment {
  type: 'date_change';
  newDate?: string;
  [k: string]: unknown;
}

export interface MaxTurnsReachedAttachment {
  type: 'max_turns_reached';
  maxTurns?: number;
  turnCount?: number;
  [k: string]: unknown;
}

export interface HookNonBlockingErrorAttachment {
  type: 'hook_non_blocking_error';
  hookName?: string;
  hookEvent?: string;
  toolUseID?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  command?: string;
  durationMs?: number;
  [k: string]: unknown;
}

export interface HookSystemMessageAttachment {
  type: 'hook_system_message';
  content?: string;
  hookName?: string;
  hookEvent?: string;
  toolUseID?: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Uuid-less bookkeeping entries
// ---------------------------------------------------------------------------

/** Bookkeeping entries don't extend ClaudeCodeEntryBase (the real lines
 *  carry no `uuid`/`parentUuid`/`timestamp`), but every one of them DOES
 *  carry `lineNumber` explicitly — the timeline envelope's `lineNumber`
 *  fallback depends on exactly these uuid-less types, so it can't be
 *  optional here. */
export interface ModeEntry {
  type: 'mode';
  mode: string;
  sessionId: string;
  lineNumber: number;
}

export interface PermissionModeEntry {
  type: 'permission-mode';
  permissionMode: 'plan' | 'normal' | 'acceptEdits' | 'bypassPermissions' | (string & {});
  sessionId: string;
  lineNumber: number;
}

export interface AiTitleEntry {
  type: 'ai-title';
  aiTitle: string;
  sessionId: string;
  lineNumber: number;
}

export interface LastPromptEntry {
  type: 'last-prompt';
  lastPrompt: string;
  leafUuid: string;
  sessionId: string;
  lineNumber: number;
}

export interface AgentNameEntry {
  type: 'agent-name';
  agentName: string;
  sessionId: string;
  lineNumber: number;
}

export interface PrLinkEntry {
  type: 'pr-link';
  sessionId: string;
  prNumber: number;
  prUrl: string;
  prRepository: string;
  timestamp: string;
  lineNumber: number;
}

export interface BridgeSessionEntry {
  type: 'bridge-session';
  sessionId: string;
  bridgeSessionId: string;
  lastSequenceNum: number;
  lineNumber: number;
}

export interface QueueOperationEntry {
  type: 'queue-operation';
  operation: 'enqueue' | 'remove' | (string & {});
  timestamp: string;
  sessionId: string;
  content: string;
  lineNumber: number;
}

export interface FileHistorySnapshotEntry {
  type: 'file-history-snapshot';
  messageId: string;
  snapshot: unknown;
  isSnapshotUpdate: boolean;
  lineNumber: number;
}

export interface FileHistoryDeltaEntry {
  type: 'file-history-delta';
  messageId: string;
  snapshotMessageId: string;
  trackingPath: string;
  backup: {
    backupFileName: string | null;
    version: number;
    backupTime: string;
    realParentDir: string;
  };
  timestamp: string;
  lineNumber: number;
}

export interface RelocatedEntry {
  type: 'relocated';
  sessionId: string;
  relocatedCwd: string;
  lineNumber: number;
}

export interface WorktreeStateEntry {
  type: 'worktree-state';
  worktreeSession: {
    originalCwd: string;
    preEnterOriginalCwd: string;
    worktreePath: string;
    worktreeName: string;
    worktreeBranch: string;
    originalBranch: string;
    originalHeadCommit: string;
    [k: string]: unknown;
  };
  lineNumber: number;
}

/** Historical type written by older Claude Code versions: a conversation
 *  summary pointing at the leaf entry it summarizes. Zero occurrences in
 *  this machine's 316-transcript corpus (verified) — this is the one known
 *  blind spot of the corpus-evidence method, which can't see formats this
 *  machine never produced. Modeled anyway because other users' corpora do
 *  contain it and the package is meant to be reusable; without this it
 *  would degrade gracefully into UnknownEntry, but one small interface is
 *  cheap insurance. */
export interface SummaryEntry {
  type: 'summary';
  summary: string;
  leafUuid: string;
  lineNumber: number;
}

export interface UnknownEntry {
  type: string;
  raw: Record<string, unknown>;
  lineNumber: number;
}
