/**
 * Raw JSON object -> `ClaudeCodeEntry` union member — spec §1.2.
 *
 * `parseEntry` is the single place that discriminates on a transcript line's
 * `type` field. It is deliberately defensive: `raw` is typed as
 * `Record<string, unknown>` by the frozen signature, but at runtime it can be
 * an array, a primitive, or missing every expected field (a malformed/partial
 * JSON line still parses as *valid JSON* — e.g. `42`, `"oops"`, `[1,2,3]` —
 * it just isn't a transcript entry). Every extraction below goes through
 * `isRecord`/`str`/`num`/`bool`/`strArr` guards rather than assuming shape,
 * so this function never throws.
 *
 * See spec: docs/superpowers/specs/2026-08-12-claude-session-parser-design.md
 */

import type { ParseError, ParseOptions } from '../types/common.js';
import type {
  AgentListingDeltaAttachment,
  AgentMentionAttachment,
  AgentNameEntry,
  AiTitleEntry,
  AssistantEntry,
  AttachmentEntry,
  AutoModeAttachment,
  AutoModeExitAttachment,
  BridgeSessionEntry,
  ClaudeAttachment,
  ClaudeCodeEntry,
  ClaudeCodeEntryBase,
  CommandPermissionsAttachment,
  CompactFileReferenceAttachment,
  CompactMetadata,
  ContentBlock,
  DateChangeAttachment,
  DeferredToolsDeltaAttachment,
  DiagnosticsAttachment,
  DynamicSkillAttachment,
  EditedTextFileAttachment,
  FileAttachment,
  FileHistoryDeltaEntry,
  FileHistorySnapshotEntry,
  HookAdditionalContextAttachment,
  HookNonBlockingErrorAttachment,
  HookSuccessAttachment,
  HookSystemMessageAttachment,
  InvokedSkillsAttachment,
  LastPromptEntry,
  MaxTurnsReachedAttachment,
  McpInstructionsDeltaAttachment,
  ModeEntry,
  ModelRefusalFallback,
  NestedMemoryAttachment,
  PermissionModeEntry,
  PlanModeAttachment,
  PlanModeExitAttachment,
  PrLinkEntry,
  QueuedCommandAttachment,
  QueueOperationEntry,
  ReadTruncationNoticeAttachment,
  RelocatedEntry,
  SkillListingAttachment,
  StructuredOutputAttachment,
  SummaryEntry,
  SystemEntry,
  TaskReminderAttachment,
  TodoReminderAttachment,
  ToolUseResult,
  TruncationSignal,
  UnknownEntry,
  UserEntry,
  WorktreeStateEntry,
} from '../types/session.js';
import { makeParseError } from '../utils/errors.js';
import { clampBlob } from '../utils/text.js';

export interface EntryParseOutcome {
  entry: ClaudeCodeEntry | null;
  errors: ParseError[];
  unknownType?: string;
}

// ---------------------------------------------------------------------------
// Small defensive extraction primitives
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function num(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function bool(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key];
  return typeof v === 'boolean' ? v : undefined;
}

function strArr(obj: Record<string, unknown>, key: string): string[] | undefined {
  const v = obj[key];
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string');
}

/** Placeholder key used to bucket entries whose `type` field is missing or
 *  not a string at all — distinct from a genuinely unrecognized *named*
 *  type, but still routed through the same `UnknownEntry`/`unknownType`
 *  mechanism rather than being dropped or throwing. */
const NO_TYPE_FIELD = '(missing type)';

// ---------------------------------------------------------------------------
// Shared: timestamp / base-field construction for ClaudeCodeEntryBase-derived
// entries (assistant, user, system, attachment)
// ---------------------------------------------------------------------------

/**
 * Parses `obj.timestamp` into `timestampMs`. Per the brief: an unparseable
 * (or missing) timestamp never throws and never blocks the entry from being
 * kept — it records a `ParseError` with a stable code and falls back to
 * `timestampMs: 0`. Two distinct codes are used so a caller can tell "the
 * field was absent" from "the field was present but garbage".
 */
function parseTimestamp(
  obj: Record<string, unknown>,
  lineNumber: number,
  uuid: string,
  errors: ParseError[],
): { timestamp: string; timestampMs: number } {
  const raw = obj.timestamp;
  if (typeof raw !== 'string' || raw.length === 0) {
    errors.push(
      makeParseError('missing_timestamp', 'Entry has no parseable timestamp field', {
        line: lineNumber,
        ...(uuid ? { uuid } : {}),
      }),
    );
    return { timestamp: typeof raw === 'string' ? raw : '', timestampMs: 0 };
  }
  const parsedMs = Date.parse(raw);
  if (Number.isNaN(parsedMs)) {
    errors.push(
      makeParseError('invalid_timestamp', `Unparseable timestamp: ${JSON.stringify(raw)}`, {
        line: lineNumber,
        ...(uuid ? { uuid } : {}),
      }),
    );
    return { timestamp: raw, timestampMs: 0 };
  }
  return { timestamp: raw, timestampMs: parsedMs };
}

/**
 * Builds the common `ClaudeCodeEntryBase` fields shared by assistant/user/
 * system/attachment entries. `session_id` (snake) and `sessionId` (camel)
 * are copied through independently — real transcripts carry both and they
 * are NOT guaranteed equal, so this never conflates or coalesces them.
 */
function buildBase(
  obj: Record<string, unknown>,
  lineNumber: number,
  errors: ParseError[],
  options?: ParseOptions,
): ClaudeCodeEntryBase {
  const uuid = str(obj, 'uuid') ?? '';
  const { timestamp, timestampMs } = parseTimestamp(obj, lineNumber, uuid, errors);

  const base: ClaudeCodeEntryBase = {
    uuid,
    parentUuid: typeof obj.parentUuid === 'string' ? obj.parentUuid : null,
    timestamp,
    timestampMs,
    isSidechain: bool(obj, 'isSidechain') ?? false,
    sessionId: str(obj, 'sessionId') ?? '',
    lineNumber,
  };
  if (typeof obj.session_id === 'string') base.session_id = obj.session_id;
  const cwd = str(obj, 'cwd');
  if (cwd !== undefined) base.cwd = cwd;
  const version = str(obj, 'version');
  if (version !== undefined) base.version = version;
  const gitBranch = str(obj, 'gitBranch');
  if (gitBranch !== undefined) base.gitBranch = gitBranch;
  const slug = str(obj, 'slug');
  if (slug !== undefined) base.slug = slug;
  const userType = str(obj, 'userType');
  if (userType !== undefined) base.userType = userType;
  const entrypoint = str(obj, 'entrypoint');
  if (entrypoint !== undefined) base.entrypoint = entrypoint;
  const agentId = str(obj, 'agentId');
  if (agentId !== undefined) base.agentId = agentId;
  const ownerAccountUuid = str(obj, 'ownerAccountUuid');
  if (ownerAccountUuid !== undefined) base.ownerAccountUuid = ownerAccountUuid;
  const ownerOrganizationUuid = str(obj, 'ownerOrganizationUuid');
  if (ownerOrganizationUuid !== undefined) base.ownerOrganizationUuid = ownerOrganizationUuid;
  const isAbortedMidStream = bool(obj, 'isAbortedMidStream');
  if (isAbortedMidStream !== undefined) base.isAbortedMidStream = isAbortedMidStream;
  // Honour ParseOptions.retainRaw: attach the original object only when
  // asked (default false, for memory — see ParseOptions doc comment).
  if (options?.retainRaw) base.raw = obj;
  return base;
}

// ---------------------------------------------------------------------------
// Truncation signal detection — spec §1.2 TruncationSignal.
//
// This covers 3 of the 4 real forms named in the spec, as instructed by the
// task brief ("implement at minimum the inline_char_count one... plus
// file_token_cap and search_truncated"):
//   - inline_char_count: the literal "... [N characters truncated] ..."
//     marker, confirmed to appear both in the tool_result content block AND
//     mirrored verbatim inside toolUseResult (sometimes itself a plain
//     string in real data, not just the documented object shape).
//   - file_token_cap: toolUseResult.file.truncatedByTokenCap === true (Read).
//   - search_truncated: toolUseResult.truncated === true (Glob/Grep).
// NOT constructed here (documented, not a gap): 'read_truncation_notice' is
// already fully captured as its own ReadTruncationNoticeAttachment (banner +
// toolUseID); building a TruncationSignal for it would require correlating
// that toolUseID against a *different* entry's tool_result block, which is
// out of scope for a single-entry parser. 'mcp_instructions_truncated' is
// likewise captured in-place as a "… [truncated]" suffix on individual
// mcp_instructions_delta.addedBlocks entries (see that type's doc comment)
// rather than as a constructed TruncationSignal.
// ---------------------------------------------------------------------------

const INLINE_TRUNCATION_RE = /\.\.\. \[(\d+) characters truncated\] \.\.\./;

function inlineTruncationFromText(text: string): TruncationSignal | undefined {
  const match = INLINE_TRUNCATION_RE.exec(text);
  if (!match) return undefined;
  const droppedChars = Number(match[1]);
  return Number.isFinite(droppedChars)
    ? { kind: 'inline_char_count', droppedChars }
    : { kind: 'inline_char_count' };
}

function inlineTruncationFromBlockContent(content: unknown): TruncationSignal | undefined {
  if (typeof content === 'string') return inlineTruncationFromText(content);
  if (Array.isArray(content)) {
    for (const part of content) {
      if (isRecord(part) && typeof part.text === 'string') {
        const signal = inlineTruncationFromText(part.text);
        if (signal) return signal;
      }
    }
  }
  return undefined;
}

/**
 * Resolves the `TruncationSignal` for one `tool_result` content block, given
 * the sibling `toolUseResult` (Claude Code's own structured/mirrored copy of
 * the same result) as a fallback source. Returns `undefined` when no real
 * signal is present — callers must not invent one.
 */
function resolveTruncationSignal(
  blockContent: unknown,
  toolUseResult: unknown,
): TruncationSignal | undefined {
  const fromBlock = inlineTruncationFromBlockContent(blockContent);
  if (fromBlock) return fromBlock;

  if (typeof toolUseResult === 'string') {
    const fromString = inlineTruncationFromText(toolUseResult);
    if (fromString) return fromString;
    return undefined;
  }
  if (isRecord(toolUseResult)) {
    if (typeof toolUseResult.stdout === 'string') {
      const fromStdout = inlineTruncationFromText(toolUseResult.stdout);
      if (fromStdout) return fromStdout;
    }
    if (isRecord(toolUseResult.file) && toolUseResult.file.truncatedByTokenCap === true) {
      return { kind: 'file_token_cap' };
    }
    if (toolUseResult.truncated === true) {
      return { kind: 'search_truncated' };
    }
  }
  return undefined;
}

/** Preserves a content block "as-is" (per the brief) while populating
 *  `truncated` on `tool_result` blocks where a real signal exists. */
function buildContentBlock(item: Record<string, unknown>, toolUseResult: unknown): ContentBlock {
  if (item.type === 'tool_result') {
    const signal = resolveTruncationSignal(item.content, toolUseResult);
    const block: Record<string, unknown> = { ...item };
    if (signal) block.truncated = signal;
    return block as ContentBlock;
  }
  return { ...item } as ContentBlock;
}

function buildContentBlocks(raw: unknown, toolUseResult: unknown): ContentBlock[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((item) => buildContentBlock(item, toolUseResult));
}

// ---------------------------------------------------------------------------
// assistant
// ---------------------------------------------------------------------------

function buildAssistantUsage(
  raw: unknown,
): NonNullable<AssistantEntry['message']['usage']> | undefined {
  if (!isRecord(raw)) return undefined;
  const usage: NonNullable<AssistantEntry['message']['usage']> = {
    input_tokens: numOr0(raw.input_tokens),
    output_tokens: numOr0(raw.output_tokens),
    cache_creation_input_tokens: numOr0(raw.cache_creation_input_tokens),
    cache_read_input_tokens: numOr0(raw.cache_read_input_tokens),
  };
  if (isRecord(raw.cache_creation)) {
    const cacheCreation: NonNullable<
      NonNullable<AssistantEntry['message']['usage']>['cache_creation']
    > = {};
    if (typeof raw.cache_creation.ephemeral_1h_input_tokens === 'number') {
      cacheCreation.ephemeral_1h_input_tokens = raw.cache_creation.ephemeral_1h_input_tokens;
    }
    if (typeof raw.cache_creation.ephemeral_5m_input_tokens === 'number') {
      cacheCreation.ephemeral_5m_input_tokens = raw.cache_creation.ephemeral_5m_input_tokens;
    }
    usage.cache_creation = cacheCreation;
  }
  if (
    isRecord(raw.output_tokens_details) &&
    typeof raw.output_tokens_details.thinking_tokens === 'number'
  ) {
    usage.output_tokens_details = { thinking_tokens: raw.output_tokens_details.thinking_tokens };
  }
  // NOTE: `iterations` is retained verbatim for observability, but MUST NOT
  // be summed into aggregateUsage — see aggregate-usage.ts and the doc
  // comment on AssistantEntry.message.usage.iterations. It overlaps the
  // top-level fields above; summing both would double-count.
  if (Array.isArray(raw.iterations)) {
    usage.iterations = raw.iterations.filter(isRecord);
  }
  return usage;
}

function buildDiagnostics(raw: unknown): AssistantEntry['message']['diagnostics'] | undefined {
  if (!isRecord(raw)) return undefined;
  const diagnostics: NonNullable<AssistantEntry['message']['diagnostics']> = {};
  if (isRecord(raw.cache_miss_reason)) {
    const cacheMissReason: NonNullable<
      NonNullable<AssistantEntry['message']['diagnostics']>['cache_miss_reason']
    > = {};
    if (typeof raw.cache_miss_reason.type === 'string')
      cacheMissReason.type = raw.cache_miss_reason.type;
    if (typeof raw.cache_miss_reason.cache_missed_input_tokens === 'number') {
      cacheMissReason.cache_missed_input_tokens = raw.cache_miss_reason.cache_missed_input_tokens;
    }
    diagnostics.cache_miss_reason = cacheMissReason;
  }
  return diagnostics;
}

function parseAssistantEntry(
  obj: Record<string, unknown>,
  lineNumber: number,
  errors: ParseError[],
  options?: ParseOptions,
): AssistantEntry {
  const base = buildBase(obj, lineNumber, errors, options);
  const rawMessage = isRecord(obj.message) ? obj.message : {};

  const message: AssistantEntry['message'] = {
    role: 'assistant',
    content: buildContentBlocks(rawMessage.content, undefined),
  };
  const id = str(rawMessage, 'id');
  if (id !== undefined) message.id = id;
  const model = str(rawMessage, 'model');
  if (model !== undefined) message.model = model;
  const usage = buildAssistantUsage(rawMessage.usage);
  if (usage !== undefined) message.usage = usage;
  const stopReason = str(rawMessage, 'stop_reason');
  if (stopReason !== undefined) message.stop_reason = stopReason;
  const diagnostics = buildDiagnostics(rawMessage.diagnostics);
  if (diagnostics !== undefined) message.diagnostics = diagnostics;

  const entry: AssistantEntry = { ...base, type: 'assistant', message };
  const requestId = str(obj, 'requestId');
  if (requestId !== undefined) entry.requestId = requestId;
  const effort = str(obj, 'effort');
  if (effort !== undefined) entry.effort = effort;
  const attributionSkill = str(obj, 'attributionSkill');
  if (attributionSkill !== undefined) entry.attributionSkill = attributionSkill;
  const attributionPlugin = str(obj, 'attributionPlugin');
  if (attributionPlugin !== undefined) entry.attributionPlugin = attributionPlugin;
  const attributionMcpServer = str(obj, 'attributionMcpServer');
  if (attributionMcpServer !== undefined) entry.attributionMcpServer = attributionMcpServer;
  const attributionMcpTool = str(obj, 'attributionMcpTool');
  if (attributionMcpTool !== undefined) entry.attributionMcpTool = attributionMcpTool;
  const attributionAgent = str(obj, 'attributionAgent');
  if (attributionAgent !== undefined) entry.attributionAgent = attributionAgent;
  if ('error' in obj) entry.error = obj.error;
  const isApiErrorMessage = bool(obj, 'isApiErrorMessage');
  if (isApiErrorMessage !== undefined) entry.isApiErrorMessage = isApiErrorMessage;
  const apiErrorStatus = num(obj, 'apiErrorStatus');
  if (apiErrorStatus !== undefined) entry.apiErrorStatus = apiErrorStatus;
  return entry;
}

// ---------------------------------------------------------------------------
// user
// ---------------------------------------------------------------------------

function parseUserEntry(
  obj: Record<string, unknown>,
  lineNumber: number,
  errors: ParseError[],
  options?: ParseOptions,
): UserEntry {
  const base = buildBase(obj, lineNumber, errors, options);
  const rawMessage = isRecord(obj.message) ? obj.message : {};

  // toolUseResult is documented as an object (ToolUseResult) but real data
  // confirms it can also arrive as a plain string (seen in real subagent
  // transcripts, e.g. raw Bash-ish passthrough) — only ever stored on the
  // entry when it matches the documented object shape, to stay honest about
  // the type contract; the raw value (object OR string) is still consulted
  // below for truncation-marker mirroring regardless of its shape.
  const rawToolUseResult = obj.toolUseResult;
  const toolUseResultRecord = isRecord(rawToolUseResult)
    ? (rawToolUseResult as ToolUseResult)
    : undefined;

  const rawContent = rawMessage.content;
  const content: string | ContentBlock[] =
    typeof rawContent === 'string' ? rawContent : buildContentBlocks(rawContent, rawToolUseResult);

  const entry: UserEntry = { ...base, type: 'user', message: { role: 'user', content } };
  const isMeta = bool(obj, 'isMeta');
  if (isMeta !== undefined) entry.isMeta = isMeta;
  const promptId = str(obj, 'promptId');
  if (promptId !== undefined) entry.promptId = promptId;
  const promptSource = str(obj, 'promptSource');
  if (promptSource !== undefined) entry.promptSource = promptSource;
  const origin = str(obj, 'origin');
  if (origin !== undefined) entry.origin = origin;
  const permissionMode = str(obj, 'permissionMode');
  if (permissionMode !== undefined) entry.permissionMode = permissionMode;
  if (toolUseResultRecord !== undefined) entry.toolUseResult = toolUseResultRecord;
  const sourceToolUseID = str(obj, 'sourceToolUseID');
  if (sourceToolUseID !== undefined) entry.sourceToolUseID = sourceToolUseID;
  const sourceToolAssistantUUID = str(obj, 'sourceToolAssistantUUID');
  if (sourceToolAssistantUUID !== undefined)
    entry.sourceToolAssistantUUID = sourceToolAssistantUUID;
  const toolDenialKind = str(obj, 'toolDenialKind');
  if (toolDenialKind !== undefined) entry.toolDenialKind = toolDenialKind;
  const toolEndsTurn = bool(obj, 'toolEndsTurn');
  if (toolEndsTurn !== undefined) entry.toolEndsTurn = toolEndsTurn;
  const isCompactSummary = bool(obj, 'isCompactSummary');
  if (isCompactSummary !== undefined) entry.isCompactSummary = isCompactSummary;
  const isVisibleInTranscriptOnly = bool(obj, 'isVisibleInTranscriptOnly');
  if (isVisibleInTranscriptOnly !== undefined)
    entry.isVisibleInTranscriptOnly = isVisibleInTranscriptOnly;
  const interruptedByShutdown = bool(obj, 'interruptedByShutdown');
  if (interruptedByShutdown !== undefined) entry.interruptedByShutdown = interruptedByShutdown;
  const interruptedMessageId = str(obj, 'interruptedMessageId');
  if (interruptedMessageId !== undefined) entry.interruptedMessageId = interruptedMessageId;
  if ('userFeedback' in obj) entry.userFeedback = obj.userFeedback;
  if ('queuePriority' in obj) entry.queuePriority = obj.queuePriority;
  if ('classifierMetaLines' in obj) entry.classifierMetaLines = obj.classifierMetaLines;
  return entry;
}

// ---------------------------------------------------------------------------
// system
// ---------------------------------------------------------------------------

function buildCompactMetadata(raw: unknown): CompactMetadata | undefined {
  if (!isRecord(raw)) return undefined;
  const metadata = {
    ...raw,
    trigger: (str(raw, 'trigger') ?? '') as CompactMetadata['trigger'],
    preTokens: numOr0(raw.preTokens),
    postTokens: numOr0(raw.postTokens),
    cumulativeDroppedTokens: numOr0(raw.cumulativeDroppedTokens),
    durationMs: numOr0(raw.durationMs),
  } as CompactMetadata;
  if (isRecord(raw.preservedSegment)) {
    metadata.preservedSegment = {
      headUuid: str(raw.preservedSegment, 'headUuid') ?? '',
      anchorUuid: str(raw.preservedSegment, 'anchorUuid') ?? '',
      tailUuid: str(raw.preservedSegment, 'tailUuid') ?? '',
    };
  }
  if (isRecord(raw.preservedMessages)) {
    metadata.preservedMessages = {
      anchorUuid: str(raw.preservedMessages, 'anchorUuid') ?? '',
      uuids: strArr(raw.preservedMessages, 'uuids') ?? [],
      allUuids: strArr(raw.preservedMessages, 'allUuids') ?? [],
    };
  }
  return metadata;
}

function _buildModelRefusalFallback(
  raw: Record<string, unknown>,
): ModelRefusalFallback | undefined {
  const originalModel = str(raw, 'originalModel');
  const fallbackModel = str(raw, 'fallbackModel');
  if (originalModel === undefined && fallbackModel === undefined) return undefined;

  const fallback: ModelRefusalFallback = {
    originalModel: originalModel ?? '',
    fallbackModel: fallbackModel ?? '',
  };
  const direction = str(raw, 'direction');
  if (direction !== undefined) fallback.direction = direction;
  const scope = str(raw, 'scope');
  if (scope !== undefined) fallback.scope = scope;
  const trigger = str(raw, 'trigger');
  if (trigger !== undefined) fallback.trigger = trigger;
  const apiRefusalCategory = str(raw, 'apiRefusalCategory');
  if (apiRefusalCategory !== undefined) fallback.apiRefusalCategory = apiRefusalCategory;
  const apiRefusalExplanation = str(raw, 'apiRefusalExplanation');
  if (apiRefusalExplanation !== undefined) fallback.apiRefusalExplanation = apiRefusalExplanation;
  const retractedMessageUuids = strArr(raw, 'retractedMessageUuids');
  if (retractedMessageUuids !== undefined) fallback.retractedMessageUuids = retractedMessageUuids;
  const refusedUserMessageUuid = str(raw, 'refusedUserMessageUuid');
  if (refusedUserMessageUuid !== undefined)
    fallback.refusedUserMessageUuid = refusedUserMessageUuid;
  return fallback;
}

function parseSystemEntry(
  obj: Record<string, unknown>,
  lineNumber: number,
  errors: ParseError[],
  options?: ParseOptions,
): SystemEntry {
  const base = buildBase(obj, lineNumber, errors, options);
  const entry: SystemEntry = { ...base, type: 'system', subtype: str(obj, 'subtype') ?? '' };
  const content = str(obj, 'content');
  if (content !== undefined) entry.content = content;
  const level = str(obj, 'level');
  if (level !== undefined) entry.level = level;
  const isMeta = bool(obj, 'isMeta');
  if (isMeta !== undefined) entry.isMeta = isMeta;
  const toolUseID = str(obj, 'toolUseID');
  if (toolUseID !== undefined) entry.toolUseID = toolUseID;
  const durationMs = num(obj, 'durationMs');
  if (durationMs !== undefined) entry.durationMs = durationMs;
  const messageCount = num(obj, 'messageCount');
  if (messageCount !== undefined) entry.messageCount = messageCount;
  const hookCount = num(obj, 'hookCount');
  if (hookCount !== undefined) entry.hookCount = hookCount;
  if (Array.isArray(obj.hookInfos)) {
    entry.hookInfos = obj.hookInfos.filter(isRecord).map((h) => {
      const info: { command: string; durationMs?: number } = { command: str(h, 'command') ?? '' };
      const hDurationMs = num(h, 'durationMs');
      if (hDurationMs !== undefined) info.durationMs = hDurationMs;
      return info;
    });
  }
  if (Array.isArray(obj.hookErrors)) entry.hookErrors = obj.hookErrors;
  if (Array.isArray(obj.hookAdditionalContext))
    entry.hookAdditionalContext = obj.hookAdditionalContext;
  const preventedContinuation = bool(obj, 'preventedContinuation');
  if (preventedContinuation !== undefined) entry.preventedContinuation = preventedContinuation;
  const stopReason = str(obj, 'stopReason');
  if (stopReason !== undefined) entry.stopReason = stopReason;
  const hasOutput = bool(obj, 'hasOutput');
  if (hasOutput !== undefined) entry.hasOutput = hasOutput;
  const url = str(obj, 'url');
  if (url !== undefined) entry.url = url;
  const logicalParentUuid = str(obj, 'logicalParentUuid');
  if (logicalParentUuid !== undefined) entry.logicalParentUuid = logicalParentUuid;
  const compactMetadata = buildCompactMetadata(obj.compactMetadata);
  if (compactMetadata !== undefined) entry.compactMetadata = compactMetadata;
  const pendingBackgroundAgentCount = num(obj, 'pendingBackgroundAgentCount');
  if (pendingBackgroundAgentCount !== undefined)
    entry.pendingBackgroundAgentCount = pendingBackgroundAgentCount;
  return entry;
}

// ---------------------------------------------------------------------------
// attachment — dispatch on attachment.type
// ---------------------------------------------------------------------------

function parseAttachment(
  raw: Record<string, unknown>,
  type: string,
  options?: ParseOptions,
): { attachment: ClaudeAttachment; unknownType?: string } {
  const maxBlobBytes = options?.maxBlobBytes;
  const clampEach = (arr: string[]): string[] => arr.map((line) => clampBlob(line, maxBlobBytes));

  switch (type) {
    case 'deferred_tools_delta': {
      const attachment: DeferredToolsDeltaAttachment = {
        type,
        addedNames: strArr(raw, 'addedNames') ?? [],
        addedLines: clampEach(strArr(raw, 'addedLines') ?? []),
        removedNames: strArr(raw, 'removedNames') ?? [],
      };
      const readdedNames = strArr(raw, 'readdedNames');
      if (readdedNames !== undefined) attachment.readdedNames = readdedNames;
      const pendingMcpServers = strArr(raw, 'pendingMcpServers');
      if (pendingMcpServers !== undefined) attachment.pendingMcpServers = pendingMcpServers;
      const needsAuthMcpServers = strArr(raw, 'needsAuthMcpServers');
      if (needsAuthMcpServers !== undefined) attachment.needsAuthMcpServers = needsAuthMcpServers;
      return { attachment };
    }
    case 'agent_listing_delta': {
      const attachment: AgentListingDeltaAttachment = {
        type,
        addedTypes: strArr(raw, 'addedTypes') ?? [],
        addedLines: strArr(raw, 'addedLines') ?? [],
        removedTypes: strArr(raw, 'removedTypes') ?? [],
        isInitial: bool(raw, 'isInitial') ?? false,
      };
      const showConcurrencyNote = bool(raw, 'showConcurrencyNote');
      if (showConcurrencyNote !== undefined) attachment.showConcurrencyNote = showConcurrencyNote;
      return { attachment };
    }
    case 'skill_listing': {
      const attachment: SkillListingAttachment = {
        type,
        names: strArr(raw, 'names') ?? [],
        content: clampBlob(str(raw, 'content') ?? '', maxBlobBytes),
        skillCount: num(raw, 'skillCount') ?? 0,
        isInitial: bool(raw, 'isInitial') ?? false,
      };
      return { attachment };
    }
    case 'dynamic_skill': {
      const attachment: DynamicSkillAttachment = {
        type,
        skillDir: str(raw, 'skillDir') ?? '',
        skillNames: strArr(raw, 'skillNames') ?? [],
        displayPath: str(raw, 'displayPath') ?? '',
      };
      return { attachment };
    }
    case 'invoked_skills': {
      const skills = Array.isArray(raw.skills)
        ? raw.skills.filter(isRecord).map((s) => ({
            name: str(s, 'name') ?? '',
            path: str(s, 'path') ?? '',
            content: clampBlob(str(s, 'content') ?? '', maxBlobBytes),
          }))
        : [];
      const attachment: InvokedSkillsAttachment = { type, skills };
      return { attachment };
    }
    case 'mcp_instructions_delta': {
      const attachment: McpInstructionsDeltaAttachment = {
        type,
        addedNames: strArr(raw, 'addedNames') ?? [],
        addedBlocks: clampEach(strArr(raw, 'addedBlocks') ?? []),
        removedNames: strArr(raw, 'removedNames') ?? [],
      };
      return { attachment };
    }
    case 'command_permissions': {
      const attachment: CommandPermissionsAttachment = {
        type,
        allowedTools: strArr(raw, 'allowedTools') ?? [],
      };
      return { attachment };
    }
    case 'nested_memory': {
      const rawContent = isRecord(raw.content) ? raw.content : {};
      const attachment: NestedMemoryAttachment = {
        type,
        path: str(raw, 'path') ?? '',
        content: {
          path: str(rawContent, 'path') ?? '',
          type: (str(rawContent, 'type') ?? 'Unknown') as NestedMemoryAttachment['content']['type'],
          content: clampBlob(str(rawContent, 'content') ?? '', maxBlobBytes),
          contentDiffersFromDisk: bool(rawContent, 'contentDiffersFromDisk') ?? false,
          rawContent: clampBlob(str(rawContent, 'rawContent') ?? '', maxBlobBytes),
        },
      };
      const globs = strArr(rawContent, 'globs');
      if (globs !== undefined) attachment.content.globs = globs;
      return { attachment };
    }
    case 'compact_file_reference': {
      const attachment: CompactFileReferenceAttachment = {
        type,
        filename: str(raw, 'filename') ?? '',
        displayPath: str(raw, 'displayPath') ?? '',
      };
      return { attachment };
    }
    case 'hook_success': {
      const attachment: HookSuccessAttachment = {
        type,
        hookName: str(raw, 'hookName') ?? '',
        hookEvent: str(raw, 'hookEvent') ?? '',
        toolUseID: str(raw, 'toolUseID') ?? '',
        content: clampBlob(str(raw, 'content') ?? '', maxBlobBytes),
        stdout: clampBlob(str(raw, 'stdout') ?? '', maxBlobBytes),
        stderr: clampBlob(str(raw, 'stderr') ?? '', maxBlobBytes),
        exitCode: num(raw, 'exitCode') ?? 0,
        command: str(raw, 'command') ?? '',
        durationMs: num(raw, 'durationMs') ?? 0,
      };
      return { attachment };
    }
    case 'hook_additional_context': {
      const attachment: HookAdditionalContextAttachment = {
        type,
        content: clampEach(strArr(raw, 'content') ?? []),
        hookName: str(raw, 'hookName') ?? '',
        hookEvent: str(raw, 'hookEvent') ?? '',
        toolUseID: str(raw, 'toolUseID') ?? '',
      };
      return { attachment };
    }
    case 'read_truncation_notice': {
      const attachment: ReadTruncationNoticeAttachment = {
        type,
        banner: str(raw, 'banner') ?? '',
        toolUseID: str(raw, 'toolUseID') ?? '',
      };
      return { attachment };
    }
    case 'task_reminder': {
      const attachment: TaskReminderAttachment = { ...raw, type } as TaskReminderAttachment;
      return { attachment };
    }
    case 'todo_reminder': {
      const attachment: TodoReminderAttachment = { ...raw, type } as TodoReminderAttachment;
      return { attachment };
    }
    case 'file': {
      const attachment: FileAttachment = { ...raw, type } as FileAttachment;
      return { attachment };
    }
    case 'edited_text_file': {
      const attachment: EditedTextFileAttachment = { ...raw, type } as EditedTextFileAttachment;
      return { attachment };
    }
    case 'diagnostics': {
      const attachment: DiagnosticsAttachment = { ...raw, type } as DiagnosticsAttachment;
      return { attachment };
    }
    case 'structured_output': {
      const attachment: StructuredOutputAttachment = { ...raw, type } as StructuredOutputAttachment;
      return { attachment };
    }
    case 'queued_command': {
      const attachment: QueuedCommandAttachment = { ...raw, type } as QueuedCommandAttachment;
      return { attachment };
    }
    case 'plan_mode': {
      const attachment: PlanModeAttachment = { ...raw, type } as PlanModeAttachment;
      return { attachment };
    }
    case 'plan_mode_exit': {
      const attachment: PlanModeExitAttachment = { ...raw, type } as PlanModeExitAttachment;
      return { attachment };
    }
    case 'auto_mode': {
      const attachment: AutoModeAttachment = { ...raw, type } as AutoModeAttachment;
      return { attachment };
    }
    case 'auto_mode_exit': {
      const attachment: AutoModeExitAttachment = { ...raw, type } as AutoModeExitAttachment;
      return { attachment };
    }
    case 'agent_mention': {
      const attachment: AgentMentionAttachment = { ...raw, type } as AgentMentionAttachment;
      return { attachment };
    }
    case 'date_change': {
      const attachment: DateChangeAttachment = { ...raw, type } as DateChangeAttachment;
      return { attachment };
    }
    case 'max_turns_reached': {
      const attachment: MaxTurnsReachedAttachment = { ...raw, type } as MaxTurnsReachedAttachment;
      return { attachment };
    }
    case 'hook_non_blocking_error': {
      const attachment: HookNonBlockingErrorAttachment = {
        ...raw,
        type,
      } as HookNonBlockingErrorAttachment;
      return { attachment };
    }
    case 'hook_system_message': {
      const attachment: HookSystemMessageAttachment = {
        ...raw,
        type,
      } as HookSystemMessageAttachment;
      return { attachment };
    }
    default: {
      const attachment: ClaudeAttachment = { ...raw, type } as ClaudeAttachment;
      return { attachment, unknownType: type || undefined };
    }
  }
}

function parseAttachmentEntry(
  obj: Record<string, unknown>,
  lineNumber: number,
  errors: ParseError[],
  options?: ParseOptions,
): { entry: AttachmentEntry; unknownType?: string } {
  const base = buildBase(obj, lineNumber, errors, options);
  const rawAttachment = isRecord(obj.attachment) ? obj.attachment : {};
  const attachmentType = typeof rawAttachment.type === 'string' ? rawAttachment.type : '';
  const { attachment, unknownType } = parseAttachment(rawAttachment, attachmentType, options);
  return { entry: { ...base, type: 'attachment', attachment }, unknownType };
}

// ---------------------------------------------------------------------------
// Uuid-less bookkeeping entries — each carries `lineNumber` explicitly and
// none of them run through `buildBase` (they don't extend
// ClaudeCodeEntryBase; see the doc comment on these interfaces in
// types/session.ts).
// ---------------------------------------------------------------------------

function parseModeEntry(obj: Record<string, unknown>, lineNumber: number): ModeEntry {
  return {
    type: 'mode',
    mode: str(obj, 'mode') ?? '',
    sessionId: str(obj, 'sessionId') ?? '',
    lineNumber,
  };
}

function parsePermissionModeEntry(
  obj: Record<string, unknown>,
  lineNumber: number,
): PermissionModeEntry {
  return {
    type: 'permission-mode',
    permissionMode: (str(obj, 'permissionMode') ?? '') as PermissionModeEntry['permissionMode'],
    sessionId: str(obj, 'sessionId') ?? '',
    lineNumber,
  };
}

function parseAiTitleEntry(obj: Record<string, unknown>, lineNumber: number): AiTitleEntry {
  return {
    type: 'ai-title',
    aiTitle: str(obj, 'aiTitle') ?? '',
    sessionId: str(obj, 'sessionId') ?? '',
    lineNumber,
  };
}

function parseLastPromptEntry(obj: Record<string, unknown>, lineNumber: number): LastPromptEntry {
  return {
    type: 'last-prompt',
    lastPrompt: str(obj, 'lastPrompt') ?? '',
    leafUuid: str(obj, 'leafUuid') ?? '',
    sessionId: str(obj, 'sessionId') ?? '',
    lineNumber,
  };
}

function parseAgentNameEntry(obj: Record<string, unknown>, lineNumber: number): AgentNameEntry {
  return {
    type: 'agent-name',
    agentName: str(obj, 'agentName') ?? '',
    sessionId: str(obj, 'sessionId') ?? '',
    lineNumber,
  };
}

function parsePrLinkEntry(obj: Record<string, unknown>, lineNumber: number): PrLinkEntry {
  return {
    type: 'pr-link',
    sessionId: str(obj, 'sessionId') ?? '',
    prNumber: num(obj, 'prNumber') ?? 0,
    prUrl: str(obj, 'prUrl') ?? '',
    prRepository: str(obj, 'prRepository') ?? '',
    timestamp: str(obj, 'timestamp') ?? '',
    lineNumber,
  };
}

function parseBridgeSessionEntry(
  obj: Record<string, unknown>,
  lineNumber: number,
): BridgeSessionEntry {
  return {
    type: 'bridge-session',
    sessionId: str(obj, 'sessionId') ?? '',
    bridgeSessionId: str(obj, 'bridgeSessionId') ?? '',
    lastSequenceNum: num(obj, 'lastSequenceNum') ?? 0,
    lineNumber,
  };
}

function parseQueueOperationEntry(
  obj: Record<string, unknown>,
  lineNumber: number,
): QueueOperationEntry {
  return {
    type: 'queue-operation',
    operation: (str(obj, 'operation') ?? '') as QueueOperationEntry['operation'],
    timestamp: str(obj, 'timestamp') ?? '',
    sessionId: str(obj, 'sessionId') ?? '',
    content: str(obj, 'content') ?? '',
    lineNumber,
  };
}

function parseFileHistorySnapshotEntry(
  obj: Record<string, unknown>,
  lineNumber: number,
): FileHistorySnapshotEntry {
  return {
    type: 'file-history-snapshot',
    messageId: str(obj, 'messageId') ?? '',
    snapshot: obj.snapshot,
    isSnapshotUpdate: bool(obj, 'isSnapshotUpdate') ?? false,
    lineNumber,
  };
}

function parseFileHistoryDeltaEntry(
  obj: Record<string, unknown>,
  lineNumber: number,
): FileHistoryDeltaEntry {
  const backupRaw = isRecord(obj.backup) ? obj.backup : {};
  return {
    type: 'file-history-delta',
    messageId: str(obj, 'messageId') ?? '',
    snapshotMessageId: str(obj, 'snapshotMessageId') ?? '',
    trackingPath: str(obj, 'trackingPath') ?? '',
    backup: {
      backupFileName:
        typeof backupRaw.backupFileName === 'string' ? backupRaw.backupFileName : null,
      version: num(backupRaw, 'version') ?? 0,
      backupTime: str(backupRaw, 'backupTime') ?? '',
      realParentDir: str(backupRaw, 'realParentDir') ?? '',
    },
    timestamp: str(obj, 'timestamp') ?? '',
    lineNumber,
  };
}

function parseRelocatedEntry(obj: Record<string, unknown>, lineNumber: number): RelocatedEntry {
  return {
    type: 'relocated',
    sessionId: str(obj, 'sessionId') ?? '',
    relocatedCwd: str(obj, 'relocatedCwd') ?? '',
    lineNumber,
  };
}

function parseWorktreeStateEntry(
  obj: Record<string, unknown>,
  lineNumber: number,
): WorktreeStateEntry {
  const ws = isRecord(obj.worktreeSession) ? obj.worktreeSession : {};
  return {
    type: 'worktree-state',
    worktreeSession: {
      ...ws,
      originalCwd: str(ws, 'originalCwd') ?? '',
      preEnterOriginalCwd: str(ws, 'preEnterOriginalCwd') ?? '',
      worktreePath: str(ws, 'worktreePath') ?? '',
      worktreeName: str(ws, 'worktreeName') ?? '',
      worktreeBranch: str(ws, 'worktreeBranch') ?? '',
      originalBranch: str(ws, 'originalBranch') ?? '',
      originalHeadCommit: str(ws, 'originalHeadCommit') ?? '',
    },
    lineNumber,
  };
}

function parseSummaryEntry(obj: Record<string, unknown>, lineNumber: number): SummaryEntry {
  return {
    type: 'summary',
    summary: str(obj, 'summary') ?? '',
    leafUuid: str(obj, 'leafUuid') ?? '',
    lineNumber,
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function parseEntry(
  raw: Record<string, unknown>,
  lineNumber: number,
  options?: ParseOptions,
): EntryParseOutcome {
  const errors: ParseError[] = [];
  // `raw` is typed as Record<string, unknown> by the frozen signature, but a
  // JSON-valid line can still deserialize to an array/primitive/null — never
  // assume it is actually an object.
  const obj: Record<string, unknown> = isRecord(raw) ? raw : {};
  const rawType = obj.type;
  const type = typeof rawType === 'string' ? rawType : '';

  switch (type) {
    case 'assistant':
      return { entry: parseAssistantEntry(obj, lineNumber, errors, options), errors };
    case 'user':
      return { entry: parseUserEntry(obj, lineNumber, errors, options), errors };
    case 'system':
      return { entry: parseSystemEntry(obj, lineNumber, errors, options), errors };
    case 'attachment': {
      const { entry, unknownType } = parseAttachmentEntry(obj, lineNumber, errors, options);
      return { entry, errors, unknownType };
    }
    case 'mode':
      return { entry: parseModeEntry(obj, lineNumber), errors };
    case 'permission-mode':
      return { entry: parsePermissionModeEntry(obj, lineNumber), errors };
    case 'ai-title':
      return { entry: parseAiTitleEntry(obj, lineNumber), errors };
    case 'last-prompt':
      return { entry: parseLastPromptEntry(obj, lineNumber), errors };
    case 'agent-name':
      return { entry: parseAgentNameEntry(obj, lineNumber), errors };
    case 'pr-link':
      return { entry: parsePrLinkEntry(obj, lineNumber), errors };
    case 'bridge-session':
      return { entry: parseBridgeSessionEntry(obj, lineNumber), errors };
    case 'queue-operation':
      return { entry: parseQueueOperationEntry(obj, lineNumber), errors };
    case 'file-history-snapshot':
      return { entry: parseFileHistorySnapshotEntry(obj, lineNumber), errors };
    case 'file-history-delta':
      return { entry: parseFileHistoryDeltaEntry(obj, lineNumber), errors };
    case 'relocated':
      return { entry: parseRelocatedEntry(obj, lineNumber), errors };
    case 'worktree-state':
      return { entry: parseWorktreeStateEntry(obj, lineNumber), errors };
    case 'summary':
      return { entry: parseSummaryEntry(obj, lineNumber), errors };
    default: {
      const resolvedType = type || NO_TYPE_FIELD;
      const entry: UnknownEntry = { type: resolvedType, raw: obj, lineNumber };
      return { entry, errors, unknownType: resolvedType };
    }
  }
}
