import type {
  AssistantEntry,
  AttachmentEntry,
  ClaudeAttachment,
  ClaudeCodeEntry,
  ClaudeCodeSession,
  CompactionRecord,
  ContentBlock,
  HookEventRecord,
  PermissionModeChange,
  PrLinkRecord,
  RuleRecord,
  ToolUseResult,
  UserEntry,
} from '@lucasschirm/sal-claude-session-parser';
import {
  isAgentTool,
  isSkillTool,
  mcpServerNameToNamespace,
  splitMcpToolName,
} from '@lucasschirm/sal-claude-session-parser';
import type {
  ComponentSummary,
  NormalizedEvidenceRecord,
  Provenance,
  TransformContext,
} from '@lucasschirm/sal-transformer-shared';

/**
 * Evidence context for the Claude Code transformer.  It extends the generic
 * `TransformContext` with the canonical `sessionId` / `rootSessionId` already
 * derived by `claude-code.ts`, so every record id stays deterministic.
 */
export interface ClaudeCodeEvidenceContext extends TransformContext {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly parentSessionId?: string;
  readonly artifactId?: string;
  /** Whether raw parameters/results (file contents, stdout/stderr, etc.) are
   *  allowed to be retained in payloads.  Default is false. */
  readonly includeRawContent?: boolean;
}

// ---------------------------------------------------------------------------
// Public payload shapes — these are the typed contents of `payload` on the
// `NormalizedEvidenceRecord`s returned by this module.
// ---------------------------------------------------------------------------

export interface TaskRecordPayload {
  readonly taskId: string;
  readonly nativeTaskId: string;
  readonly subject: string;
  readonly description: string;
  readonly status: string;
  readonly firstSeenAtMs?: number;
  readonly lastSeenAtMs?: number;
  readonly completedAtMs?: number;
  readonly finality: 'open' | 'completed' | 'unknown';
}

export interface TaskEventRecordPayload {
  readonly taskId: string;
  readonly nativeTaskId: string;
  readonly eventType: string;
  readonly status: string;
  readonly subject?: string;
  readonly timestampMs: number;
  readonly sourceEventId: string;
}

export type ValidationType =
  | 'test'
  | 'lint'
  | 'build'
  | 'typecheck'
  | 'mcp_validation'
  | 'custom'
  | 'unknown';

export interface ValidationRecordPayload {
  readonly validationId: string;
  readonly validationType: ValidationType;
  readonly command?: string;
  readonly resultStatus: 'success' | 'failure' | 'warning' | 'interrupted' | 'unknown';
  readonly exitCode?: number;
  readonly stdoutLength?: number;
  readonly stderrLength?: number;
  readonly stdoutSummary?: string;
  readonly stderrSummary?: string;
  readonly durationMs?: number;
  readonly timestampMs: number;
  readonly editCycleTarget?: string;
  readonly editCycleFileOperationId?: string;
  readonly sourceEventId: string;
}

export type FileOperationType =
  | 'read'
  | 'write'
  | 'edit'
  | 'create'
  | 'delete'
  | 'rename'
  | 'revert';

export type PathCategory =
  | 'source'
  | 'config'
  | 'test'
  | 'documentation'
  | 'build'
  | 'dependency'
  | 'data'
  | 'unknown';

export interface FileOperationRecordPayload {
  readonly operationId: string;
  readonly operationType: FileOperationType;
  readonly toolName: string;
  readonly normalizedPath: string;
  readonly pathCategory: PathCategory;
  readonly oldPath?: string;
  readonly extension?: string;
  readonly contentLength?: number;
  readonly hasContent: boolean;
  readonly content?: string;
  readonly numLines?: number;
  readonly totalLines?: number;
  readonly truncated?: boolean;
  readonly success?: boolean;
  readonly resultSummary?: string;
  readonly timestampMs: number;
  readonly sourceEventId: string;
}

export type CommandCategory =
  | 'git'
  | 'test'
  | 'lint'
  | 'build'
  | 'typecheck'
  | 'package_manager'
  | 'shell'
  | 'unknown';

export interface CommandExecutionRecordPayload {
  readonly commandId: string;
  readonly category: CommandCategory;
  readonly command: string;
  readonly exitCode?: number;
  readonly status: 'success' | 'failure' | 'interrupted' | 'warning' | 'unknown';
  readonly stdoutLength?: number;
  readonly stderrLength?: number;
  readonly stdoutSummary?: string;
  readonly stderrSummary?: string;
  readonly durationMs?: number;
  readonly gitPrNumber?: number;
  readonly gitPrRepository?: string;
  readonly gitPushBranch?: string;
  readonly gitCommitSha?: string;
  readonly hookName?: string;
  readonly hookEvent?: string;
  readonly timestampMs: number;
  readonly sourceEventId: string;
}

export interface NormalizedEventRecordPayload {
  readonly eventId: string;
  readonly version: number;
  readonly category: string;
  readonly eventType: string;
  readonly timestampMs: number;
  readonly sourceEventId: string;
  readonly lineNumber: number;
  readonly summary?: string;
  // compaction
  readonly trigger?: string;
  readonly preTokens?: number;
  readonly postTokens?: number;
  readonly cumulativeDroppedTokens?: number;
  readonly compactionDurationMs?: number;
  // pr_link
  readonly prNumber?: number;
  readonly prRepository?: string;
  // permission_mode / mode
  readonly mode?: string;
  // queue_operation
  readonly operation?: string;
  // relocated
  readonly relocatedCwd?: string;
  // worktree_state
  readonly worktreeName?: string;
  readonly worktreeBranch?: string;
  // file_history
  readonly trackingPath?: string;
  readonly backupVersion?: number;
  // bridge_session
  readonly bridgeSessionId?: string;
  // summary / ai_title / agent_name / last_prompt
  readonly text?: string;
  readonly leafUuid?: string;
  // system
  readonly subtype?: string;
  // hook
  readonly hookName?: string;
  readonly hookEvent?: string;
  readonly hookOutcome?: string;
  // attachment (generic)
  readonly attachmentType?: string;
  readonly attachmentNames?: string[];
  readonly attachmentCount?: number;
  readonly allowedTools?: string[];
  readonly filePath?: string;
  readonly displayPath?: string;
}

export interface ComponentEvidenceLinkRecordPayload {
  readonly linkId: string;
  readonly componentId: string;
  readonly grainType: string;
  readonly grainId: string;
  readonly applicability: string;
  readonly startSequence?: number;
  readonly endSequence?: number;
  readonly availabilityCompleteness?: 'complete' | 'partial' | 'unavailable';
  readonly injectionCompleteness?: 'complete' | 'partial' | 'unavailable';
  readonly state?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
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

function strArr(obj: Record<string, unknown>, key: string): string[] | undefined {
  const v = obj[key];
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string');
}

/** Deterministic id that mirrors the `stableId` helper in `claude-code.ts`. */
function stableId(
  namespace: string,
  parts: Record<string, string | number | boolean | null | undefined>,
): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(parts).sort()) {
    const value = parts[key];
    if (value !== undefined) ordered[key] = value;
  }
  return `${namespace}:${JSON.stringify(ordered)}`;
}

function entryTimestampMs(entry: ClaudeCodeEntry | undefined): number {
  if (!entry) return 0;
  if (
    'timestampMs' in entry &&
    typeof (entry as { timestampMs?: unknown }).timestampMs === 'number'
  ) {
    const ms = (entry as { timestampMs: number }).timestampMs;
    if (Number.isFinite(ms)) return ms;
  }
  if ('timestamp' in entry && typeof (entry as { timestamp?: unknown }).timestamp === 'string') {
    const parsed = Date.parse((entry as { timestamp: string }).timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function entryUuidOrLine(entry: ClaudeCodeEntry): string {
  if ('uuid' in entry && typeof (entry as { uuid?: unknown }).uuid === 'string') {
    const uuid = (entry as { uuid: string }).uuid;
    if (uuid) return uuid;
  }
  return `line-${entry.lineNumber}`;
}

function provenanceFor(
  context: ClaudeCodeEvidenceContext,
  sourceEventId: string,
  sourceField?: string,
): Provenance {
  if (sourceField) {
    return {
      artifactId: context.artifactId ?? context.sourceFingerprint,
      sourceEventId,
      sourceField,
    };
  }
  return {
    artifactId: context.artifactId ?? context.sourceFingerprint,
    sourceEventId,
  };
}

function turnIdFor(context: ClaudeCodeEvidenceContext, entryId: string): string {
  return stableId('turn', { session: context.sessionId, uuid: entryId });
}

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>;
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>;

function isAssistantEntry(entry: ClaudeCodeEntry): entry is AssistantEntry {
  return entry.type === 'assistant' && 'message' in entry;
}

function isUserEntry(entry: ClaudeCodeEntry): entry is UserEntry {
  return entry.type === 'user' && 'message' in entry;
}

function isAttachmentEntry(entry: ClaudeCodeEntry): entry is AttachmentEntry {
  return entry.type === 'attachment' && 'attachment' in entry;
}

function asToolUse(block: ContentBlock): ToolUseBlock | undefined {
  if (block.type !== 'tool_use') return undefined;
  const raw = block as unknown as Record<string, unknown>;
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || !isRecord(raw.input))
    return undefined;
  return block as ToolUseBlock;
}

function asToolResult(block: ContentBlock): ToolResultBlock | undefined {
  if (block.type !== 'tool_result') return undefined;
  const raw = block as unknown as Record<string, unknown>;
  if (typeof raw.tool_use_id !== 'string') return undefined;
  return block as ToolResultBlock;
}

function textFromToolResultContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return undefined;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (isRecord(part) && typeof part.text === 'string') return part.text;
        return undefined;
      })
      .filter((t): t is string => typeof t === 'string');
    if (parts.length > 0) return parts.join('\n');
    return JSON.stringify(content);
  }
  return JSON.stringify(content);
}

function toolResultTextForToolUseId(
  user: UserEntry | undefined,
  toolUseId: string,
): string | undefined {
  if (!user) return undefined;
  const { content } = user.message;
  if (typeof content === 'string') return undefined;
  for (const block of content) {
    const tr = asToolResult(block);
    if (tr && tr.tool_use_id === toolUseId) {
      return textFromToolResultContent(tr.content);
    }
  }
  return undefined;
}

function toolResultIsErrorForToolUseId(
  user: UserEntry | undefined,
  toolUseId: string,
): boolean | undefined {
  if (!user) return undefined;
  const { content } = user.message;
  if (typeof content === 'string') return undefined;
  for (const block of content) {
    const tr = asToolResult(block);
    if (tr && tr.tool_use_id === toolUseId) {
      if (typeof tr.is_error === 'boolean') return tr.is_error;
      return undefined;
    }
  }
  return undefined;
}

function toolUseResultForToolUseId(
  user: UserEntry | undefined,
  toolUseId: string,
): ToolUseResult | undefined {
  if (!user) return undefined;
  // The structured copy is at the user-entry level, not the content block.
  if (user.sourceToolUseID === toolUseId && user.toolUseResult) {
    return user.toolUseResult;
  }
  const { content } = user.message;
  if (typeof content === 'string') return undefined;
  for (const block of content) {
    const tr = asToolResult(block);
    if (tr && tr.tool_use_id === toolUseId) {
      // There is no structured ToolUseResult on the block; the user entry's
      // `toolUseResult` is the source of truth.
      return user.toolUseResult;
    }
  }
  return undefined;
}

function findUserEntryForToolUseId(
  session: ClaudeCodeSession,
  toolUseId: string,
): UserEntry | undefined {
  for (const entry of session.entries) {
    if (!isUserEntry(entry)) continue;
    const { content } = entry.message;
    if (typeof content === 'string') {
      if (entry.sourceToolUseID === toolUseId) return entry;
      continue;
    }
    for (const block of content) {
      const tr = asToolResult(block);
      if (tr && tr.tool_use_id === toolUseId) return entry;
    }
    if (entry.sourceToolUseID === toolUseId) return entry;
  }
  return undefined;
}

interface ToolUseContext {
  readonly assistant: AssistantEntry;
  readonly block: ToolUseBlock;
  readonly sourceEventId: string;
  readonly parentTurnId: string;
  readonly timestampMs: number;
}

function buildToolUseIndex(
  session: ClaudeCodeSession,
  context: ClaudeCodeEvidenceContext,
): Map<string, ToolUseContext> {
  const index = new Map<string, ToolUseContext>();
  for (const entry of session.entries) {
    if (!isAssistantEntry(entry)) continue;
    const turnId = turnIdFor(context, entry.uuid);
    const content = entry.message.content;
    if (typeof content === 'string') continue;
    for (const raw of content) {
      const block = asToolUse(raw);
      if (!block) continue;
      index.set(block.id, {
        assistant: entry,
        block,
        sourceEventId: block.id,
        parentTurnId: turnId,
        timestampMs: entryTimestampMs(entry),
      });
    }
  }
  return index;
}

function buildEntryByUuid(session: ClaudeCodeSession): Map<string, ClaudeCodeEntry> {
  const map = new Map<string, ClaudeCodeEntry>();
  for (const entry of session.entries) {
    if ('uuid' in entry && typeof (entry as { uuid?: unknown }).uuid === 'string') {
      const uuid = (entry as { uuid: string }).uuid;
      if (uuid) map.set(uuid, entry);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Path / command privacy helpers
// ---------------------------------------------------------------------------

function normalizeSlashes(input: string): string {
  return input.replace(/\\/g, '/');
}

function replaceHomePrefix(input: string): string {
  return input
    .replace(/^\/Users\/[^/]+/i, '~')
    .replace(/^\/home\/[^/]+/i, '~')
    .replace(/^[A-Za-z]:\/Users\/[^/]+/i, '~');
}

function sanitizePath(input: string | undefined, cwd?: string): string {
  if (!input) return '';
  let p = normalizeSlashes(input).trim();
  if (p === '') return '';
  p = replaceHomePrefix(p);
  if (cwd) {
    let n = normalizeSlashes(cwd).trim();
    if (n === '') n = (cwd as string) || '';
    n = replaceHomePrefix(n);
    if (n && (p === n || p.startsWith(`${n}/`))) {
      p = `<cwd>${p.slice(n.length)}`;
    } else if (n && !p.startsWith('/') && !p.startsWith('<cwd>') && !p.startsWith('~')) {
      p = `<cwd>/${p.replace(/^\.?\//, '')}`;
    }
  }
  return p;
}

function basenameOf(path: string): string {
  const p = normalizeSlashes(path);
  const slash = p.lastIndexOf('/');
  return slash === -1 ? p : p.slice(slash + 1);
}

function extensionOf(path: string): string | undefined {
  const base = basenameOf(path);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return base.slice(dot + 1);
}

function pathCategory(path: string): PathCategory {
  const p = normalizeSlashes(path).toLowerCase();
  if (p.includes('/.claude/') || /(^|\/)(claude|agents)\.md$/i.test(p) || p.endsWith('.mcp.json'))
    return 'config';
  if (
    p.includes('/node_modules/') ||
    p.includes('/.next/') ||
    p.includes('/dist/') ||
    p.includes('/build/')
  )
    return 'build';
  if (p.includes('/src/')) return 'source';
  if (
    p.includes('/test/') ||
    p.includes('/tests/') ||
    /\.(test|spec)\.(ts|js|tsx|jsx|py|rs|go)$/i.test(p)
  )
    return 'test';
  if (p.includes('/docs/') || p.includes('/doc/')) return 'documentation';
  if (p.endsWith('package.json') || p.endsWith('pnpm-lock.yaml') || p.includes('tsconfig'))
    return 'config';
  if (p.includes('/data/') || /\.(csv|tsv|parquet|db)$/i.test(p)) return 'data';
  return 'unknown';
}

function hasPathShape(token: string): boolean {
  return token.includes('/') || token.includes('\\') || token.startsWith('.');
}

function sanitizeCommand(input: string | undefined, cwd?: string): string {
  if (!input) return '';
  return input
    .split(/\s+/)
    .map((token) => {
      if (hasPathShape(token) && !token.startsWith('-')) return sanitizePath(token, cwd);
      return token;
    })
    .join(' ');
}

function repoFromPrUrl(url: string): string | undefined {
  const match = url.match(/\/([^/]+\/[^/]+)\/pull\/\d+/);
  return match ? match[1] : undefined;
}

function commandCategory(input: string | undefined): CommandCategory {
  if (!input) return 'unknown';
  const cmd = input.trim().toLowerCase();
  if (cmd.startsWith('git ') || cmd.startsWith('gh ')) return 'git';
  if (
    cmd.includes('test') ||
    cmd.includes('pytest') ||
    cmd.includes('jest') ||
    cmd.includes('vitest') ||
    cmd.includes('mocha') ||
    cmd.includes('cargo test') ||
    cmd.includes('go test') ||
    /^\s*(npm|pnpm|yarn)\s+(test|run\s+test)\b/.test(cmd)
  )
    return 'test';
  if (
    cmd.includes('lint') ||
    cmd.includes('eslint') ||
    cmd.includes('prettier') ||
    cmd.includes('biome') ||
    cmd.includes('flake8')
  )
    return 'lint';
  if (
    cmd.includes('build') ||
    cmd.includes('tsc') ||
    cmd.includes('vite build') ||
    cmd.includes('webpack') ||
    cmd.includes('esbuild') ||
    cmd.includes('make') ||
    /^\s*(npm|pnpm|yarn)\s+(run\s+build|build)\b/.test(cmd)
  )
    return 'build';
  if (cmd.includes('typecheck') || cmd.includes('type-check') || cmd === 'tsc --noemit')
    return 'typecheck';
  if (/^\s*(npm|pnpm|yarn|pip|pipenv|poetry|cargo|go|gradle)\s/.test(cmd)) return 'package_manager';
  return 'shell';
}

function firstNonEmptyLine(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function sanitizeText(text: string, cwd?: string): string {
  let t = text;
  t = t.replace(/\/Users\/[^/\s]+/gi, '~');
  t = t.replace(/\/home\/[^/\s]+/gi, '~');
  t = t.replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, '~');
  if (cwd) {
    const n = replaceHomePrefix(normalizeSlashes(cwd));
    if (n && n !== '~') {
      t = t.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<cwd>');
    }
  }
  return t;
}

function allowlistedOutput(
  text: string | undefined,
  cwd?: string,
  maxChars = 200,
): string | undefined {
  if (!text) return undefined;
  const line = firstNonEmptyLine(text) ?? text;
  const sanitized = sanitizeText(line, cwd);
  return sanitized.length > maxChars ? sanitized.slice(0, maxChars) : sanitized;
}

function validationStatusFromResult(
  category: ValidationType,
  resultText: string | undefined,
  isError?: boolean,
  interrupted?: boolean,
  exitCode?: number,
): ValidationRecordPayload['resultStatus'] {
  if (interrupted) return 'interrupted';
  if (exitCode !== undefined && exitCode !== 0) return 'failure';
  if (isError) return 'failure';
  if (!resultText) return 'unknown';
  const t = resultText.toLowerCase();
  if (t.includes('failed') || t.includes('error:') || t.includes('fail') || t.includes('exit code'))
    return 'failure';
  if (category === 'test' || category === 'lint' || category === 'build') {
    if (t.includes('passed') || t.includes('pass') || t.includes('succeeded') || t.includes('ok'))
      return 'success';
    if (/(?:warning|warn)s?\b/.test(t) && !/(?:^|\s)(?:0|no)\s+(?:warning|warn)s?\b/.test(t))
      return 'warning';
  }
  return 'unknown';
}

function extractPathToken(command: string): string | undefined {
  const tokens = command.split(/\s+/).filter((t) => t.length > 0);
  for (const token of tokens) {
    if (token.startsWith('-')) continue;
    if (hasPathShape(token)) return token;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

interface TaskState {
  readonly recordId: string;
  readonly nativeTaskId: string;
  subject: string;
  description: string;
  finalStatus: string;
  firstSeenAtMs?: number;
  lastSeenAtMs?: number;
  completedAtMs?: number;
  sourceEventId: string;
}

export function normalizeTasks(
  session: ClaudeCodeSession,
  context: ClaudeCodeEvidenceContext,
): NormalizedEvidenceRecord[] {
  const records: NormalizedEvidenceRecord[] = [];
  const tasks = new Map<string, TaskState>();

  function getOrCreateTask(recordId: string, nativeTaskId: string, subject: string): TaskState {
    let state = tasks.get(recordId);
    if (!state) {
      state = {
        recordId,
        nativeTaskId,
        subject,
        description: '',
        finalStatus: 'pending',
        sourceEventId: nativeTaskId,
      };
      tasks.set(recordId, state);
    }
    return state;
  }

  function updateTaskFromState(
    state: TaskState,
    status: string,
    subject: string,
    description: string,
    timestampMs: number,
    sourceEventId: string,
  ): void {
    if (subject) state.subject = subject;
    if (description) state.description = description;
    state.finalStatus = status;
    state.sourceEventId = sourceEventId;
    if (state.firstSeenAtMs === undefined) state.firstSeenAtMs = timestampMs;
    state.lastSeenAtMs = timestampMs;
    if (status === 'completed' && state.completedAtMs === undefined)
      state.completedAtMs = timestampMs;
  }

  function emitTaskEvent(
    state: TaskState,
    eventType: string,
    status: string,
    timestampMs: number,
    sourceEventId: string,
    sourceField: string,
  ): void {
    records.push({
      recordId: stableId('task_event', {
        session: context.sessionId,
        task: state.recordId,
        type: eventType,
        timestamp: timestampMs,
        source: sourceEventId,
      }),
      recordType: 'task_event',
      sessionId: context.sessionId,
      parentId: state.recordId,
      sourceEventId,
      sourceField,
      provenance: provenanceFor(context, sourceEventId, sourceField),
      payload: {
        taskId: state.recordId,
        nativeTaskId: state.nativeTaskId,
        eventType,
        status,
        subject: state.subject,
        timestampMs,
        sourceEventId,
      } satisfies TaskEventRecordPayload,
    });
  }

  // 1. `task_reminder` attachment snapshots.
  for (const entry of session.entries) {
    if (!isAttachmentEntry(entry)) continue;
    const attachment = entry.attachment as ClaudeAttachment;
    if (attachment.type !== 'task_reminder') continue;
    const items = (attachment as { content?: unknown }).content;
    if (!Array.isArray(items)) continue;
    const sourceEventId = entryUuidOrLine(entry);
    const timestampMs = entryTimestampMs(entry);
    for (let idx = 0; idx < items.length; idx++) {
      const item = isRecord(items[idx]) ? items[idx] : {};
      const nativeId =
        str(item, 'id') ??
        str(item, 'task') ??
        str(item, 'subject') ??
        str(item, 'title') ??
        `reminder-${idx}`;
      const subject = str(item, 'subject') ?? str(item, 'title') ?? str(item, 'task') ?? nativeId;
      const description = str(item, 'description') ?? '';
      const status = str(item, 'status') ?? 'pending';
      const taskRecordId = stableId('task', { session: context.sessionId, id: nativeId });
      const state = getOrCreateTask(taskRecordId, nativeId, subject);
      updateTaskFromState(state, status, subject, description, timestampMs, sourceEventId);
      emitTaskEvent(state, 'observed', status, timestampMs, sourceEventId, 'attachment.content');
    }
  }

  // 2. Task* tool invocations.
  const toolUseIndex = buildToolUseIndex(session, context);
  const taskToolPattern = /^(TaskCreate|TaskUpdate|TaskGet|TaskList|TaskOutput|TaskStop)$/;
  for (const [toolUseId, tool] of toolUseIndex) {
    if (!taskToolPattern.test(tool.block.name)) continue;
    const user = findUserEntryForToolUseId(session, toolUseId);
    const input = tool.block.input;
    const nativeId =
      str(input, 'id') ??
      str(input, 'task_id') ??
      str(input, 'title') ??
      str(input, 'name') ??
      toolUseId;
    const subject =
      str(input, 'title') ??
      str(input, 'subject') ??
      str(input, 'name') ??
      str(input, 'id') ??
      toolUseId;
    const description = str(input, 'description') ?? '';
    const inputStatus = str(input, 'status') ?? 'active';
    const eventType =
      {
        TaskCreate: 'created',
        TaskUpdate: 'updated',
        TaskGet: 'retrieved',
        TaskList: 'listed',
        TaskOutput: 'output',
        TaskStop: 'stopped',
      }[tool.block.name] ?? 'observed';
    const resultText = toolResultTextForToolUseId(user, toolUseId);
    const isError = toolResultIsErrorForToolUseId(user, toolUseId);
    let status = inputStatus;
    if (eventType === 'stopped' || eventType === 'output') {
      if (isError) status = 'failed';
      else if (resultText?.toLowerCase().includes('completed')) status = 'completed';
    }
    const taskRecordId = stableId('task', { session: context.sessionId, id: nativeId });
    const state = getOrCreateTask(taskRecordId, nativeId, subject);
    updateTaskFromState(state, status, subject, description, tool.timestampMs, toolUseId);
    emitTaskEvent(
      state,
      eventType,
      status,
      tool.timestampMs,
      toolUseId,
      'message.content.tool_use',
    );
  }

  // 3. Emit one `task` record per observed identity.
  for (const state of tasks.values()) {
    const finality: TaskRecordPayload['finality'] =
      state.completedAtMs !== undefined
        ? 'completed'
        : state.finalStatus === 'completed'
          ? 'completed'
          : 'open';
    records.push({
      recordId: state.recordId,
      recordType: 'task',
      sessionId: context.sessionId,
      sourceEventId: state.sourceEventId,
      provenance: provenanceFor(context, state.sourceEventId),
      payload: {
        taskId: state.recordId,
        nativeTaskId: state.nativeTaskId,
        subject: state.subject,
        description: state.description,
        status: state.finalStatus,
        firstSeenAtMs: state.firstSeenAtMs,
        lastSeenAtMs: state.lastSeenAtMs,
        completedAtMs: state.completedAtMs,
        finality,
      } satisfies TaskRecordPayload,
    });
  }

  return records;
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

function operationTypeForToolName(name: string): FileOperationType | undefined {
  if (name === 'Read') return 'read';
  if (name === 'Write' || name === 'Create') return 'write';
  if (
    name === 'Edit' ||
    name === 'MultiEdit' ||
    name === 'NotebookEdit' ||
    name === 'StrReplace' ||
    name === 'ApplyPatch' ||
    name === 'Insert'
  )
    return 'edit';
  if (name === 'Delete') return 'delete';
  if (name === 'Rename') return 'rename';
  if (name === 'Revert') return 'revert';
  return undefined;
}

function targetPathForFileOperation(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (toolName === 'Rename') {
    return (
      str(input, 'new_path') ??
      str(input, 'newPath') ??
      str(input, 'destination') ??
      str(input, 'dest') ??
      str(input, 'file_path') ??
      str(input, 'path') ??
      str(input, 'filename') ??
      undefined
    );
  }
  return (
    str(input, 'file_path') ??
    str(input, 'path') ??
    str(input, 'filename') ??
    str(input, 'filePath') ??
    str(input, 'target') ??
    undefined
  );
}

function oldPathForFileOperation(input: Record<string, unknown>): string | undefined {
  return (
    str(input, 'old_path') ??
    str(input, 'oldPath') ??
    str(input, 'source_path') ??
    str(input, 'sourcePath') ??
    undefined
  );
}

export function normalizeFileOperations(
  session: ClaudeCodeSession,
  context: ClaudeCodeEvidenceContext,
): NormalizedEvidenceRecord[] {
  const records: NormalizedEvidenceRecord[] = [];
  const toolUseIndex = buildToolUseIndex(session, context);
  const cwd = session.cwd ?? toolUseIndex.values().next().value?.assistant.cwd;

  for (const [toolUseId, tool] of toolUseIndex) {
    const opType = operationTypeForToolName(tool.block.name);
    if (!opType) continue;

    const targetPath = targetPathForFileOperation(tool.block.name, tool.block.input);
    if (!targetPath) continue;

    const oldPath = opType === 'rename' ? oldPathForFileOperation(tool.block.input) : undefined;
    const user = findUserEntryForToolUseId(session, toolUseId);
    const isError = toolResultIsErrorForToolUseId(user, toolUseId);
    const resultText = toolResultTextForToolUseId(user, toolUseId);
    const toolResult = toolUseResultForToolUseId(user, toolUseId);

    let success: boolean | undefined = isError === undefined ? undefined : !isError;
    if (isError === undefined && resultText !== undefined) {
      const t = resultText.toLowerCase();
      success = !t.includes('fail') && !t.includes('error') && !t.includes(' not ');
    }
    if (toolResult?.interrupted) {
      success = false;
    }

    let numLines: number | undefined;
    let totalLines: number | undefined;
    let truncated: boolean | undefined;
    let resultSummary: string | undefined;
    let contentLength: number | undefined;
    let hasContent = false;
    let content: string | undefined;

    if (opType === 'read' && toolResult?.file) {
      const f = toolResult.file;
      if (typeof f.numLines === 'number') numLines = f.numLines;
      if (typeof f.totalLines === 'number') totalLines = f.totalLines;
      if (f.truncatedByTokenCap) truncated = true;
      if (typeof f.content === 'string') {
        contentLength = f.content.length;
        hasContent = f.content.length > 0;
        if (context.includeRawContent) content = f.content;
      }
      resultSummary = allowlistedOutput(resultText, cwd, 120);
    }

    if (opType === 'write' || opType === 'edit' || opType === 'create') {
      const rawContent = str(tool.block.input, 'content');
      if (rawContent !== undefined) {
        contentLength = rawContent.length;
        hasContent = rawContent.length > 0;
        if (context.includeRawContent) content = rawContent;
      }
      resultSummary = allowlistedOutput(resultText, cwd, 120);
    }

    if (opType === 'delete' || opType === 'rename' || opType === 'revert') {
      resultSummary = allowlistedOutput(resultText, cwd, 120);
    }

    const normalizedPath = sanitizePath(targetPath, cwd);
    const oldNormalizedPath = oldPath ? sanitizePath(oldPath, cwd) : undefined;

    records.push({
      recordId: stableId('file_operation', { session: context.sessionId, toolUseId }),
      recordType: 'file_operation',
      sessionId: context.sessionId,
      parentId: tool.parentTurnId,
      sourceEventId: toolUseId,
      sourceField: 'message.content.tool_use',
      provenance: provenanceFor(context, toolUseId, 'message.content.tool_use'),
      payload: {
        operationId: stableId('file_operation', { session: context.sessionId, toolUseId }),
        operationType: opType,
        toolName: tool.block.name,
        normalizedPath,
        pathCategory: pathCategory(normalizedPath),
        oldPath: oldNormalizedPath,
        extension: extensionOf(normalizedPath),
        contentLength,
        hasContent,
        content,
        numLines,
        totalLines,
        truncated,
        success,
        resultSummary,
        timestampMs: tool.timestampMs,
        sourceEventId: toolUseId,
      } satisfies FileOperationRecordPayload,
    });
  }

  return records;
}

// ---------------------------------------------------------------------------
// Command executions
// ---------------------------------------------------------------------------

function buildCommandExecutionPayload(
  context: ClaudeCodeEvidenceContext,
  sourceEventId: string,
  command: string,
  cwd: string | undefined,
  timestampMs: number,
  parentTurnId: string | undefined,
  toolResult: ToolUseResult | undefined,
  isError: boolean | undefined,
  hookName?: string,
  hookEvent?: string,
  exitCode?: number,
  durationMs?: number,
): NormalizedEvidenceRecord {
  const category = commandCategory(command);
  const sanitized = sanitizeCommand(command, cwd);
  let status: CommandExecutionRecordPayload['status'] = 'unknown';
  if (exitCode !== undefined && exitCode !== 0) status = 'failure';
  else if (isError === true) status = 'failure';
  else if (toolResult?.interrupted) status = 'interrupted';
  else if (exitCode === 0 || isError === false) status = 'success';

  const stdout = typeof toolResult?.stdout === 'string' ? toolResult.stdout : undefined;
  const stderr = typeof toolResult?.stderr === 'string' ? toolResult.stderr : undefined;

  if (status === 'unknown' && (stdout?.trim() || stderr?.trim())) {
    const text = `${stdout ?? ''}\n${stderr ?? ''}`.toLowerCase();
    if (text.includes('fail') || text.includes('error') || text.includes('exception'))
      status = 'failure';
    else status = 'success';
  }

  const stdoutSummary = allowlistedOutput(stdout, cwd, 160);
  const stderrSummary = allowlistedOutput(stderr, cwd, 160);

  const g = toolResult?.gitOperation;
  const gitRepo = g?.pr && typeof g.pr.url === 'string' ? repoFromPrUrl(g.pr.url) : undefined;

  const commandId = stableId('command_execution', {
    session: context.sessionId,
    source: sourceEventId,
  });

  const payload: Record<string, unknown> = {
    commandId,
    category,
    command: sanitized,
    exitCode,
    status,
    stdoutLength: stdout?.length,
    stderrLength: stderr?.length,
    stdoutSummary,
    stderrSummary,
    durationMs,
    timestampMs,
    sourceEventId,
  };

  if (g?.commit && typeof g.commit.sha === 'string') payload.gitCommitSha = g.commit.sha;
  if (g?.push && typeof g.push.branch === 'string') payload.gitPushBranch = g.push.branch;
  if (g?.pr && typeof g.pr.number === 'number') {
    payload.gitPrNumber = g.pr.number;
  }
  if (gitRepo) payload.gitPrRepository = gitRepo;
  if (hookName) payload.hookName = hookName;
  if (hookEvent) payload.hookEvent = hookEvent;

  return {
    recordId: commandId,
    recordType: 'command_execution',
    sessionId: context.sessionId,
    parentId: parentTurnId,
    sourceEventId,
    sourceField: hookName ? 'attachment.hook' : 'message.content.tool_use',
    provenance: provenanceFor(
      context,
      sourceEventId,
      hookName ? 'attachment.hook' : 'message.content.tool_use',
    ),
    payload,
  };
}

export function normalizeCommandExecutions(
  session: ClaudeCodeSession,
  context: ClaudeCodeEvidenceContext,
): NormalizedEvidenceRecord[] {
  const records: NormalizedEvidenceRecord[] = [];
  const toolUseIndex = buildToolUseIndex(session, context);
  const cwd = session.cwd ?? toolUseIndex.values().next().value?.assistant.cwd;

  for (const [toolUseId, tool] of toolUseIndex) {
    if (tool.block.name !== 'Bash') continue;
    const command = str(tool.block.input, 'command');
    if (!command) continue;
    const user = findUserEntryForToolUseId(session, toolUseId);
    const toolResult = user?.toolUseResult;
    const isError = toolResultIsErrorForToolUseId(user, toolUseId);
    records.push(
      buildCommandExecutionPayload(
        context,
        toolUseId,
        command,
        cwd,
        tool.timestampMs,
        tool.parentTurnId,
        toolResult,
        isError,
      ),
    );
  }

  for (const hook of session.hooks) {
    if (!hook.command) continue;
    const user = findUserEntryForToolUseId(session, hook.entryUuid);
    records.push(
      buildCommandExecutionPayload(
        context,
        hook.entryUuid,
        hook.command,
        cwd,
        hook.timestampMs,
        undefined,
        user?.toolUseResult,
        undefined,
        hook.hookName,
        hook.hookEvent,
        hook.exitCode,
        hook.durationMs,
      ),
    );
  }

  return records;
}

// ---------------------------------------------------------------------------
// Validations
// ---------------------------------------------------------------------------

function isValidationCategory(
  category: CommandCategory,
): category is 'test' | 'lint' | 'build' | 'typecheck' {
  return (
    category === 'test' || category === 'lint' || category === 'build' || category === 'typecheck'
  );
}

function validationTypeFromCommandCategory(category: CommandCategory): ValidationType | undefined {
  if (isValidationCategory(category)) return category;
  return undefined;
}

function validationTypeFromToolName(name: string): ValidationType | undefined {
  const lower = name.toLowerCase();
  if (lower.includes('validate') || lower.includes('verify') || lower.includes('check')) {
    if (lower.includes('lint')) return 'lint';
    if (lower.includes('test')) return 'test';
    if (lower.includes('type')) return 'typecheck';
    if (lower.includes('build')) return 'build';
    return 'custom';
  }
  return undefined;
}

export function normalizeValidations(
  session: ClaudeCodeSession,
  context: ClaudeCodeEvidenceContext,
): NormalizedEvidenceRecord[] {
  const records: NormalizedEvidenceRecord[] = [];
  const toolUseIndex = buildToolUseIndex(session, context);
  const cwd = session.cwd ?? toolUseIndex.values().next().value?.assistant.cwd;

  for (const [toolUseId, tool] of toolUseIndex) {
    const name = tool.block.name;
    let validationType: ValidationType | undefined;
    let command: string | undefined;

    if (name === 'Bash') {
      command = str(tool.block.input, 'command');
      if (!command) continue;
      const category = commandCategory(command);
      validationType = validationTypeFromCommandCategory(category);
      if (!validationType) continue;
    } else if (name.startsWith('mcp__') || tool.assistant.attributionMcpTool) {
      validationType =
        validationTypeFromToolName(name) ??
        (tool.assistant.attributionMcpTool
          ? validationTypeFromToolName(tool.assistant.attributionMcpTool)
          : undefined);
      if (!validationType) continue;
      command = name;
    } else {
      validationType = validationTypeFromToolName(name);
      if (!validationType) continue;
      command = name;
    }

    const user = findUserEntryForToolUseId(session, toolUseId);
    const toolResult = toolUseResultForToolUseId(user, toolUseId);
    const resultText = toolResultTextForToolUseId(user, toolUseId);
    const isError = toolResultIsErrorForToolUseId(user, toolUseId);
    const status = validationStatusFromResult(
      validationType,
      resultText,
      isError,
      toolResult?.interrupted,
    );

    const stdout = typeof toolResult?.stdout === 'string' ? toolResult.stdout : undefined;
    const stderr = typeof toolResult?.stderr === 'string' ? toolResult.stderr : undefined;

    const commandPath = command ? extractPathToken(command) : undefined;
    const editCycleTarget = commandPath ? sanitizePath(commandPath, cwd) : undefined;

    const validationId = stableId('validation', { session: context.sessionId, source: toolUseId });
    const payload: Record<string, unknown> = {
      validationId,
      validationType,
      command: command ? sanitizeCommand(command, cwd) : undefined,
      resultStatus: status,
      stdoutLength: stdout?.length,
      stderrLength: stderr?.length,
      stdoutSummary: allowlistedOutput(stdout, cwd, 160),
      stderrSummary: allowlistedOutput(stderr, cwd, 160),
      timestampMs: tool.timestampMs,
      editCycleTarget,
      sourceEventId: toolUseId,
    };

    records.push({
      recordId: validationId,
      recordType: 'validation',
      sessionId: context.sessionId,
      parentId: tool.parentTurnId,
      sourceEventId: toolUseId,
      sourceField: 'message.content.tool_use',
      provenance: provenanceFor(context, toolUseId, 'message.content.tool_use'),
      payload,
    });
  }

  // Hook commands that are validation-like.
  for (const hook of session.hooks) {
    if (!hook.command) continue;
    const category = commandCategory(hook.command);
    const fromHookName = validationTypeFromToolName(hook.hookName);
    if (!isValidationCategory(category) && !fromHookName) continue;
    const validationType: ValidationType =
      fromHookName ?? validationTypeFromCommandCategory(category) ?? 'custom';

    const stdout = hook.stdout;
    const stderr = hook.stderr;
    const resultText = stdout ?? stderr ?? '';
    const status = validationStatusFromResult(
      validationType,
      resultText,
      undefined,
      undefined,
      hook.exitCode,
    );

    const validationId = stableId('validation', {
      session: context.sessionId,
      entry: hook.entryUuid,
      hook: hook.hookName,
    });
    const payload: Record<string, unknown> = {
      validationId,
      validationType,
      command: sanitizeCommand(hook.command, cwd),
      resultStatus: status,
      exitCode: hook.exitCode,
      stdoutLength: stdout?.length,
      stderrLength: stderr?.length,
      stdoutSummary: allowlistedOutput(stdout, cwd, 160),
      stderrSummary: allowlistedOutput(stderr, cwd, 160),
      durationMs: hook.durationMs,
      timestampMs: hook.timestampMs,
      sourceEventId: hook.entryUuid,
    };

    records.push({
      recordId: validationId,
      recordType: 'validation',
      sessionId: context.sessionId,
      sourceEventId: hook.entryUuid,
      sourceField: 'attachment.hook',
      provenance: provenanceFor(context, hook.entryUuid, 'attachment.hook'),
      payload,
    });
  }

  return records;
}

// ---------------------------------------------------------------------------
// Normalized events
// ---------------------------------------------------------------------------

function normalizedEventPayload(
  context: ClaudeCodeEvidenceContext,
  category: string,
  eventType: string,
  timestampMs: number,
  sourceEventId: string,
  lineNumber: number,
  base: Omit<
    NormalizedEventRecordPayload,
    | 'eventId'
    | 'version'
    | 'category'
    | 'eventType'
    | 'timestampMs'
    | 'sourceEventId'
    | 'lineNumber'
  >,
): NormalizedEvidenceRecord {
  const recordId = stableId('normalized_event', {
    session: context.sessionId,
    category,
    source: sourceEventId,
  });
  const payload: NormalizedEventRecordPayload = {
    eventId: recordId,
    version: 1,
    category,
    eventType,
    timestampMs,
    sourceEventId,
    lineNumber,
    ...base,
  };
  return {
    recordId,
    recordType: 'normalized_event',
    sessionId: context.sessionId,
    sourceEventId,
    provenance: provenanceFor(context, sourceEventId),
    payload,
  };
}

function attachmentPayloadFromType(
  attachment: ClaudeAttachment,
): Partial<NormalizedEventRecordPayload> {
  const base = attachment as unknown as Record<string, unknown>;
  switch (attachment.type) {
    case 'deferred_tools_delta': {
      return {
        attachmentType: 'deferred_tools_delta',
        attachmentNames: [
          ...(strArr(base, 'addedNames') ?? []),
          ...(strArr(base, 'removedNames') ?? []),
        ],
      };
    }
    case 'agent_listing_delta': {
      return {
        attachmentType: 'agent_listing_delta',
        attachmentNames: [
          ...(strArr(base, 'addedTypes') ?? []),
          ...(strArr(base, 'removedTypes') ?? []),
        ],
        attachmentCount:
          (strArr(base, 'addedTypes')?.length ?? 0) + (strArr(base, 'removedTypes')?.length ?? 0),
      };
    }
    case 'skill_listing': {
      return {
        attachmentType: 'skill_listing',
        attachmentNames: strArr(base, 'names') ?? [],
        attachmentCount: num(base, 'skillCount'),
      };
    }
    case 'dynamic_skill': {
      return {
        attachmentType: 'dynamic_skill',
        attachmentNames: strArr(base, 'skillNames') ?? [],
        filePath: sanitizePath(str(base, 'skillDir'), undefined),
        displayPath: str(base, 'displayPath'),
      };
    }
    case 'invoked_skills': {
      const skills = base.skills;
      const names = Array.isArray(skills)
        ? skills
            .filter((s): s is Record<string, unknown> => isRecord(s))
            .map((s) => str(s, 'name'))
            .filter((n): n is string => typeof n === 'string')
        : [];
      return { attachmentType: 'invoked_skills', attachmentNames: names };
    }
    case 'mcp_instructions_delta': {
      return {
        attachmentType: 'mcp_instructions_delta',
        attachmentNames: [
          ...(strArr(base, 'addedNames') ?? []),
          ...(strArr(base, 'removedNames') ?? []),
        ],
      };
    }
    case 'command_permissions': {
      return {
        attachmentType: 'command_permissions',
        allowedTools: strArr(base, 'allowedTools') ?? [],
      };
    }
    case 'nested_memory': {
      const content = base.content as unknown as Record<string, unknown> | undefined;
      return {
        attachmentType: 'nested_memory',
        filePath: sanitizePath(str(base, 'path'), undefined),
        displayPath: content ? sanitizePath(str(content, 'path'), undefined) : undefined,
      };
    }
    case 'compact_file_reference': {
      return {
        attachmentType: 'compact_file_reference',
        filePath: sanitizePath(str(base, 'filename'), undefined),
        displayPath: str(base, 'displayPath'),
      };
    }
    case 'read_truncation_notice': {
      return {
        attachmentType: 'read_truncation_notice',
        filePath: sanitizePath(str(base, 'banner'), undefined),
      };
    }
    case 'queued_command': {
      return {
        attachmentType: 'queued_command',
        operation: str(base, 'commandMode'),
        text: str(base, 'prompt'),
      };
    }
    case 'plan_mode':
    case 'plan_mode_exit':
    case 'auto_mode':
    case 'auto_mode_exit':
    case 'agent_mention':
    case 'date_change':
    case 'max_turns_reached':
    case 'file':
    case 'edited_text_file':
    case 'diagnostics':
    case 'structured_output':
    case 'todo_reminder':
    case 'hook_success':
    case 'hook_non_blocking_error':
    case 'hook_additional_context':
    case 'hook_system_message':
    case 'task_reminder': {
      return { attachmentType: attachment.type };
    }
    default: {
      return { attachmentType: attachment.type };
    }
  }
}

function compactPayload(
  record: CompactionRecord,
  context: ClaudeCodeEvidenceContext,
): NormalizedEvidenceRecord {
  const m = record.metadata;
  const sourceEventId = record.entryUuid || `line-${record.timestampMs}`;
  return normalizedEventPayload(
    context,
    'compaction',
    'compact_boundary',
    record.timestampMs || 0,
    sourceEventId,
    0,
    {
      summary: `Context compaction (${m.trigger})`,
      trigger: m.trigger,
      preTokens: m.preTokens,
      postTokens: m.postTokens,
      cumulativeDroppedTokens: m.cumulativeDroppedTokens,
      compactionDurationMs: m.durationMs,
    },
  );
}

function prLinkPayload(
  record: PrLinkRecord,
  context: ClaudeCodeEvidenceContext,
): NormalizedEvidenceRecord {
  const sourceEventId = `pr-${record.prNumber}@${record.prRepository}`;
  return normalizedEventPayload(
    context,
    'pr_link',
    'pr_link',
    record.timestampMs || 0,
    sourceEventId,
    0,
    {
      summary: `PR #${record.prNumber} in ${record.prRepository}`,
      prNumber: record.prNumber,
      prRepository: record.prRepository,
    },
  );
}

function permissionModePayload(
  record: PermissionModeChange,
  context: ClaudeCodeEvidenceContext,
): NormalizedEvidenceRecord {
  const sourceEventId = `perm-${record.lineNumber}`;
  return normalizedEventPayload(
    context,
    'permission_mode',
    record.mode,
    record.timestampMs || 0,
    sourceEventId,
    record.lineNumber,
    { summary: `Permission mode: ${record.mode}`, mode: record.mode },
  );
}

function hookEventPayload(
  record: HookEventRecord,
  context: ClaudeCodeEvidenceContext,
): NormalizedEvidenceRecord {
  const sourceEventId = record.entryUuid || `hook-${record.timestampMs}`;
  return normalizedEventPayload(
    context,
    'hook',
    record.outcome,
    record.timestampMs || 0,
    sourceEventId,
    0,
    {
      summary: `${record.hookName} / ${record.hookEvent} = ${record.outcome}`,
      hookName: record.hookName,
      hookEvent: record.hookEvent,
      hookOutcome: record.outcome,
    },
  );
}

export function normalizeNormalizedEvents(
  session: ClaudeCodeSession,
  context: ClaudeCodeEvidenceContext,
): NormalizedEvidenceRecord[] {
  const records: NormalizedEvidenceRecord[] = [];
  const cwd = session.cwd;

  // Low-volume derived timeline records are emitted first.
  for (const record of session.compactions) records.push(compactPayload(record, context));
  for (const record of session.prLinks) records.push(prLinkPayload(record, context));
  for (const record of session.permissionModes)
    records.push(permissionModePayload(record, context));
  for (const record of session.hooks) records.push(hookEventPayload(record, context));

  // Walk raw entries for the remaining low-volume native evidence.
  for (const entry of session.entries) {
    const sourceEventId = entryUuidOrLine(entry);
    const timestampMs = entryTimestampMs(entry);
    const lineNumber = entry.lineNumber;

    if (entry.type === 'queue-operation') {
      const raw = entry as unknown as Record<string, unknown>;
      records.push(
        normalizedEventPayload(
          context,
          'queue_operation',
          str(raw, 'operation') ?? 'unknown',
          timestampMs,
          sourceEventId,
          lineNumber,
          { operation: str(raw, 'operation'), text: str(raw, 'content') },
        ),
      );
      continue;
    }

    if (entry.type === 'relocated') {
      const raw = entry as unknown as Record<string, unknown>;
      records.push(
        normalizedEventPayload(
          context,
          'relocated',
          'relocated',
          timestampMs,
          sourceEventId,
          lineNumber,
          { relocatedCwd: sanitizePath(str(raw, 'relocatedCwd'), cwd) },
        ),
      );
      continue;
    }

    if (entry.type === 'worktree-state') {
      const raw = entry as unknown as Record<string, unknown>;
      const ws = isRecord(raw.worktreeSession) ? raw.worktreeSession : {};
      records.push(
        normalizedEventPayload(
          context,
          'worktree_state',
          'worktree_state',
          timestampMs,
          sourceEventId,
          lineNumber,
          {
            worktreeName: str(ws, 'worktreeName'),
            worktreeBranch: str(ws, 'worktreeBranch'),
          },
        ),
      );
      continue;
    }

    if (entry.type === 'file-history-snapshot' || entry.type === 'file-history-delta') {
      const raw = entry as unknown as Record<string, unknown>;
      const backup = isRecord(raw.backup) ? raw.backup : {};
      records.push(
        normalizedEventPayload(
          context,
          'file_history',
          entry.type,
          timestampMs,
          sourceEventId,
          lineNumber,
          {
            trackingPath: sanitizePath(str(raw, 'trackingPath'), cwd),
            backupVersion: num(backup, 'version'),
          },
        ),
      );
      continue;
    }

    if (entry.type === 'bridge-session') {
      const raw = entry as unknown as Record<string, unknown>;
      records.push(
        normalizedEventPayload(
          context,
          'bridge_session',
          'bridge_session',
          timestampMs,
          sourceEventId,
          lineNumber,
          { bridgeSessionId: str(raw, 'bridgeSessionId') },
        ),
      );
      continue;
    }

    if (entry.type === 'summary') {
      const raw = entry as unknown as Record<string, unknown>;
      records.push(
        normalizedEventPayload(
          context,
          'summary',
          'summary',
          timestampMs,
          sourceEventId,
          lineNumber,
          { text: str(raw, 'summary'), leafUuid: str(raw, 'leafUuid') },
        ),
      );
      continue;
    }

    if (entry.type === 'ai-title') {
      const raw = entry as unknown as Record<string, unknown>;
      records.push(
        normalizedEventPayload(
          context,
          'ai_title',
          'ai_title',
          timestampMs,
          sourceEventId,
          lineNumber,
          { text: str(raw, 'aiTitle') },
        ),
      );
      continue;
    }

    if (entry.type === 'agent-name') {
      const raw = entry as unknown as Record<string, unknown>;
      records.push(
        normalizedEventPayload(
          context,
          'agent_name',
          'agent_name',
          timestampMs,
          sourceEventId,
          lineNumber,
          { text: str(raw, 'agentName') },
        ),
      );
      continue;
    }

    if (entry.type === 'last-prompt') {
      const raw = entry as unknown as Record<string, unknown>;
      records.push(
        normalizedEventPayload(
          context,
          'last_prompt',
          'last_prompt',
          timestampMs,
          sourceEventId,
          lineNumber,
          { text: str(raw, 'lastPrompt'), leafUuid: str(raw, 'leafUuid') },
        ),
      );
      continue;
    }

    if (entry.type === 'mode') {
      const raw = entry as unknown as Record<string, unknown>;
      records.push(
        normalizedEventPayload(
          context,
          'mode',
          str(raw, 'mode') ?? 'unknown',
          timestampMs,
          sourceEventId,
          lineNumber,
          { mode: str(raw, 'mode') },
        ),
      );
      continue;
    }

    if (entry.type === 'permission-mode') {
      // Already emitted from `session.permissionModes`, which is the
      // deduplicated/collapsed signal; skip the raw bookkeeping entry.
      continue;
    }

    if (entry.type === 'system') {
      const raw = entry as unknown as Record<string, unknown>;
      const subtype = str(raw, 'subtype') ?? 'unknown';
      if (subtype === 'compact_boundary') continue; // handled by `compactions` timeline
      records.push(
        normalizedEventPayload(context, 'system', subtype, timestampMs, sourceEventId, lineNumber, {
          subtype,
          text: str(raw, 'content'),
        }),
      );
      continue;
    }

    if (entry.type === 'attachment') {
      const att = (entry as AttachmentEntry).attachment;
      const alreadyHandled = new Set<string>([
        'task_reminder',
        'hook_success',
        'hook_non_blocking_error',
        'hook_additional_context',
        'hook_system_message',
        'plan_mode',
        'auto_mode',
        'plan_mode_exit',
        'auto_mode_exit',
      ]);
      if (alreadyHandled.has(att.type)) continue;
      records.push(
        normalizedEventPayload(
          context,
          'attachment',
          att.type,
          timestampMs,
          sourceEventId,
          lineNumber,
          attachmentPayloadFromType(att),
        ),
      );
      continue;
    }

    if (entry.type === 'unknown') {
      records.push(
        normalizedEventPayload(
          context,
          'unknown',
          entry.type,
          timestampMs,
          sourceEventId,
          lineNumber,
          { text: entry.type },
        ),
      );
      continue;
    }

    // Unknown / forward-compatible entry types.
    records.push(
      normalizedEventPayload(
        context,
        'unknown',
        entry.type,
        timestampMs,
        sourceEventId,
        lineNumber,
        { text: entry.type },
      ),
    );
  }

  return records;
}

// ---------------------------------------------------------------------------
// Component evidence links
// ---------------------------------------------------------------------------

interface ComponentIndex {
  byId: Map<string, ComponentSummary>;
  byNativeId: Map<string, ComponentSummary[]>;
  byDisplayName: Map<string, ComponentSummary[]>;
  byKind: Map<string, ComponentSummary[]>;
}

function buildComponentIndex(components: readonly ComponentSummary[]): ComponentIndex {
  const byId = new Map<string, ComponentSummary>();
  const byNativeId = new Map<string, ComponentSummary[]>();
  const byDisplayName = new Map<string, ComponentSummary[]>();
  const byKind = new Map<string, ComponentSummary[]>();

  for (const c of components) {
    byId.set(c.componentId, c);

    const push = (map: Map<string, ComponentSummary[]>, key: string): void => {
      const list = map.get(key) ?? [];
      list.push(c);
      map.set(key, list);
    };

    if (c.identity.nativeId) {
      push(byNativeId, c.identity.nativeId.toLowerCase());
    }
    if (c.identity.displayName) {
      push(byDisplayName, c.identity.displayName.toLowerCase());
    }
    push(byKind, c.kind);
  }

  return { byId, byNativeId, byDisplayName, byKind };
}

function componentsForSkillName(
  index: ComponentIndex,
  name: string | undefined,
): ComponentSummary[] {
  if (!name) return [];
  const lower = name.toLowerCase();
  const exact = index.byNativeId.get(lower) ?? index.byDisplayName.get(lower) ?? [];
  const bare = name.includes(':') ? name.split(':').pop()?.toLowerCase() : lower;
  if (!bare) return exact;
  const bareMatches = index.byNativeId.get(bare) ?? index.byDisplayName.get(bare) ?? [];
  const seen = new Set(exact.map((c) => c.componentId));
  for (const c of bareMatches) if (!seen.has(c.componentId)) exact.push(c);
  return exact.filter((c) => c.kind === 'skill');
}

function componentsForAgentType(
  index: ComponentIndex,
  agentType: string | undefined,
): ComponentSummary[] {
  if (!agentType) return [];
  const lower = agentType.toLowerCase();
  const exact = index.byNativeId.get(lower) ?? index.byDisplayName.get(lower) ?? [];
  const bare = agentType.includes(':') ? agentType.split(':').pop()?.toLowerCase() : lower;
  if (!bare) return exact;
  const bareMatches = index.byNativeId.get(bare) ?? index.byDisplayName.get(bare) ?? [];
  const seen = new Set(exact.map((c) => c.componentId));
  for (const c of bareMatches) if (!seen.has(c.componentId)) exact.push(c);
  return exact.filter((c) => c.kind === 'agent');
}

function componentsForMcpServer(
  index: ComponentIndex,
  server: string | undefined,
): ComponentSummary[] {
  if (!server) return [];
  const lower = server.toLowerCase();
  const ns = mcpServerNameToNamespace(server).toLowerCase();
  const matches = new Map<string, ComponentSummary>();
  for (const c of index.byKind.get('mcp') ?? []) {
    const nativeId = c.identity.nativeId?.toLowerCase();
    const displayName = c.identity.displayName?.toLowerCase();
    const provider = c.identity.provider?.toLowerCase();
    if (nativeId === lower || displayName === lower || provider === lower) {
      matches.set(c.componentId, c);
    }
    if (nativeId === ns || displayName === ns || provider === ns) {
      matches.set(c.componentId, c);
    }
  }
  return Array.from(matches.values());
}

function ruleMatchesPath(glob: string, rawPath: string): boolean {
  const p = rawPath.replace(/^<cwd>\//, '').toLowerCase();
  const g = glob.replace(/^<cwd>\//, '').toLowerCase();
  const re = new RegExp(
    '^' +
      g
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '<<GLOBSTAR>>')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '.')
        .replace(/<<GLOBSTAR>>/g, '.*') +
      '$',
    'i',
  );
  return re.test(p);
}

function componentsForRuleGlobMatch(
  index: ComponentIndex,
  rules: readonly RuleRecord[],
  rawPath: string,
): ComponentSummary[] {
  const matches = new Map<string, ComponentSummary>();
  for (const rule of rules) {
    for (const glob of rule.globs ?? []) {
      if (ruleMatchesPath(glob, rawPath)) {
        for (const c of componentsForRulePath(index, rule.displayPath ?? rule.path)) {
          matches.set(c.componentId, c);
        }
      }
    }
  }
  return Array.from(matches.values());
}

function componentsForRulePath(
  index: ComponentIndex,
  rawPath: string | undefined,
): ComponentSummary[] {
  if (!rawPath) return [];
  const normalized = normalizeSlashes(rawPath).toLowerCase();
  const base = basenameOf(rawPath).toLowerCase();
  const matches: ComponentSummary[] = [];
  const seen = new Set<string>();
  for (const c of index.byKind.get('rule') ?? []) {
    const sourcePath = c.sourcePointer?.path?.toLowerCase();
    const nativeId = c.identity.nativeId?.toLowerCase();
    const title = c.identity.displayName?.toLowerCase();
    if (sourcePath && (normalized.endsWith(sourcePath) || sourcePath.endsWith(base))) {
      if (!seen.has(c.componentId)) {
        seen.add(c.componentId);
        matches.push(c);
      }
    }
    if (nativeId && (normalized.includes(nativeId) || base.includes(nativeId))) {
      if (!seen.has(c.componentId)) {
        seen.add(c.componentId);
        matches.push(c);
      }
    }
    if (title && (normalized.includes(title) || base.includes(title))) {
      if (!seen.has(c.componentId)) {
        seen.add(c.componentId);
        matches.push(c);
      }
    }
  }
  return matches;
}

function toolUseComponents(
  index: ComponentIndex,
  tool: ToolUseContext,
): { components: ComponentSummary[]; applicability: string } {
  const name = tool.block.name;
  const input = tool.block.input;

  if (isSkillTool(name)) {
    const skillName = str(input, 'skill');
    return {
      components: componentsForSkillName(index, skillName),
      applicability: 'tool_use:Skill',
    };
  }

  if (isAgentTool(name)) {
    const agentType = str(input, 'subagent_type');
    return {
      components: componentsForAgentType(index, agentType),
      applicability: 'tool_use:Agent',
    };
  }

  const mcpSplit = splitMcpToolName(name);
  if (mcpSplit) {
    return {
      components: componentsForMcpServer(index, mcpSplit.server),
      applicability: 'tool_use:mcp',
    };
  }

  // A skill may be invoked directly by its qualified name (rare, but
  // `invoked_skills` and `dynamic_skill` attachments confirm it happens).
  const directSkill = componentsForSkillName(index, name);
  if (directSkill.length > 0)
    return { components: directSkill, applicability: 'tool_use:skill_name' };

  return { components: [], applicability: 'none' };
}

function assistantAttributionComponents(
  index: ComponentIndex,
  entry: AssistantEntry,
): { components: ComponentSummary[]; applicability: string }[] {
  const results: { components: ComponentSummary[]; applicability: string }[] = [];
  if (entry.attributionSkill) {
    results.push({
      components: componentsForSkillName(index, entry.attributionSkill),
      applicability: 'attribution:skill',
    });
  }
  if (entry.attributionAgent) {
    results.push({
      components: componentsForAgentType(index, entry.attributionAgent),
      applicability: 'attribution:agent',
    });
  }
  if (entry.attributionMcpServer) {
    results.push({
      components: componentsForMcpServer(index, entry.attributionMcpServer),
      applicability: 'attribution:mcp_server',
    });
  }
  return results;
}

function attachmentComponents(
  index: ComponentIndex,
  entry: AttachmentEntry,
): { components: ComponentSummary[]; applicability: string }[] {
  const results: { components: ComponentSummary[]; applicability: string }[] = [];
  const att = entry.attachment;

  if (
    att.type === 'skill_listing' ||
    att.type === 'invoked_skills' ||
    att.type === 'dynamic_skill'
  ) {
    const raw = att as unknown as Record<string, unknown>;
    const names =
      att.type === 'invoked_skills'
        ? Array.isArray(raw.skills)
          ? raw.skills
              .filter((s): s is Record<string, unknown> => isRecord(s))
              .map((s) => str(s, 'name'))
              .filter((n): n is string => typeof n === 'string')
          : []
        : ((att as { names?: string[] }).names ??
          (att as { skillNames?: string[] }).skillNames ??
          []);
    for (const name of names ?? []) {
      const comps = componentsForSkillName(index, name);
      if (comps.length > 0) {
        results.push({ components: comps, applicability: `attachment:${att.type}` });
      }
    }
  }

  if (att.type === 'agent_listing_delta' || att.type === 'agent_mention') {
    const raw = att as unknown as Record<string, unknown>;
    const names =
      att.type === 'agent_mention'
        ? [str(raw, 'agentType') ?? '']
        : ((att as { addedTypes?: string[] }).addedTypes ?? []);
    for (const name of names) {
      const comps = componentsForAgentType(index, name);
      if (comps.length > 0) {
        results.push({ components: comps, applicability: `attachment:${att.type}` });
      }
    }
  }

  if (att.type === 'mcp_instructions_delta') {
    const raw = att as unknown as Record<string, unknown>;
    const names = [...(strArr(raw, 'addedNames') ?? []), ...(strArr(raw, 'removedNames') ?? [])];
    for (const name of names) {
      const comps = componentsForMcpServer(index, name);
      if (comps.length > 0) {
        results.push({ components: comps, applicability: 'attachment:mcp_instructions_delta' });
      }
    }
  }

  if (att.type === 'nested_memory' || att.type === 'compact_file_reference') {
    const raw = att as unknown as Record<string, unknown>;
    const path =
      att.type === 'nested_memory' ? str(raw, 'path') : (att as { filename?: string }).filename;
    const comps = componentsForRulePath(index, path);
    if (comps.length > 0) {
      results.push({ components: comps, applicability: `attachment:${att.type}` });
    }
  }

  return results;
}

function componentsForEvidenceRecord(
  record: NormalizedEvidenceRecord,
  session: ClaudeCodeSession,
  index: ComponentIndex,
  toolUseIndex: Map<string, ToolUseContext>,
): { component: ComponentSummary; applicability: string }[] {
  const matches: { component: ComponentSummary; applicability: string }[] = [];
  const seen = new Set<string>();

  const add = (components: ComponentSummary[], applicability: string): void => {
    for (const c of components) {
      if (seen.has(c.componentId)) continue;
      seen.add(c.componentId);
      matches.push({ component: c, applicability });
    }
  };

  const sourceEventId = record.sourceEventId;

  // 1. Direct tool_use attribution.
  const toolUse = toolUseIndex.get(sourceEventId);
  if (toolUse) {
    const { components, applicability } = toolUseComponents(index, toolUse);
    add(components, applicability);

    const attributions = assistantAttributionComponents(index, toolUse.assistant);
    for (const a of attributions) add(a.components, a.applicability);
  }

  // 2. Turn / message attribution by entry uuid (parent turn first, then
  //    the source entry itself when it is a turn uuid).
  const entryByUuid = buildEntryByUuid(session);
  const turnId = record.parentId ?? sourceEventId;
  const turnEntry = entryByUuid.get(turnId);
  const sourceEntry = entryByUuid.get(sourceEventId);
  const assistantEntry =
    turnEntry && isAssistantEntry(turnEntry)
      ? turnEntry
      : sourceEntry && isAssistantEntry(sourceEntry)
        ? sourceEntry
        : undefined;
  if (assistantEntry) {
    for (const a of assistantAttributionComponents(index, assistantEntry))
      add(a.components, a.applicability);
    const content = assistantEntry.message.content;
    if (Array.isArray(content)) {
      for (const raw of content) {
        const tool = asToolUse(raw);
        if (tool) {
          const ctx: ToolUseContext = {
            assistant: assistantEntry,
            block: tool,
            sourceEventId: tool.id,
            parentTurnId: assistantEntry.uuid,
            timestampMs: assistantEntry.timestampMs,
          };
          const { components, applicability } = toolUseComponents(index, ctx);
          add(components, applicability);
        }
      }
    }
  }

  if (sourceEntry && isAttachmentEntry(sourceEntry)) {
    for (const a of attachmentComponents(index, sourceEntry)) add(a.components, a.applicability);
  }

  // 3. File operations can also be linked to a rule whose glob matches the
  //    target path — this is a best-effort exposure link.
  if (record.recordType === 'file_operation') {
    const payload = record.payload as FileOperationRecordPayload | undefined;
    if (payload?.normalizedPath) {
      const pathComps = componentsForRuleGlobMatch(index, session.rules, payload.normalizedPath);
      add(pathComps, 'file_path:rule_match');
    }
  }

  // 4. Normalized events may carry attachment-derived component evidence.
  if (record.recordType === 'normalized_event') {
    const payload = record.payload as NormalizedEventRecordPayload | undefined;
    if (payload?.attachmentNames) {
      for (const name of payload.attachmentNames) {
        add(componentsForSkillName(index, name), 'attachment:skill_listing');
        add(componentsForAgentType(index, name), 'attachment:agent_listing');
        add(componentsForMcpServer(index, name), 'attachment:mcp_listing');
      }
    }
    if (payload?.filePath)
      add(componentsForRulePath(index, payload.filePath), 'attachment:rule_path');
  }

  return matches;
}

export function normalizeComponentEvidenceLinks(
  session: ClaudeCodeSession,
  components: readonly ComponentSummary[],
  evidenceRecords: readonly NormalizedEvidenceRecord[],
  context: ClaudeCodeEvidenceContext,
): NormalizedEvidenceRecord[] {
  const records: NormalizedEvidenceRecord[] = [];
  if (components.length === 0 || evidenceRecords.length === 0) return records;

  const index = buildComponentIndex(components);
  const toolUseIndex = buildToolUseIndex(session, context);

  const grainTypeForRecordType = (recordType: string): string | undefined => {
    switch (recordType) {
      case 'turn':
        return 'turn';
      case 'message':
        return 'message';
      case 'task':
      case 'task_event':
        return 'task';
      case 'validation':
        return 'validation';
      case 'file_operation':
        return 'file';
      case 'command_execution':
        return 'command';
      case 'normalized_event':
        return 'event';
      case 'invocation':
        return 'invocation';
      case 'payload':
        return 'payload';
      default:
        return undefined;
    }
  };

  for (const record of evidenceRecords) {
    const grainType = grainTypeForRecordType(record.recordType);
    if (!grainType) continue;

    const matched = componentsForEvidenceRecord(record, session, index, toolUseIndex);
    for (const { component, applicability } of matched) {
      const linkId = stableId('component_link', {
        session: context.sessionId,
        component: component.componentId,
        grain: record.recordId,
      });
      const payload: ComponentEvidenceLinkRecordPayload = {
        linkId,
        componentId: component.componentId,
        grainType,
        grainId: record.recordId,
        applicability,
        startSequence: 0,
        endSequence: 0,
        availabilityCompleteness: 'complete',
        injectionCompleteness: 'complete',
        state: 'linked',
      };
      records.push({
        recordId: linkId,
        recordType: 'component_evidence_link',
        sessionId: context.sessionId,
        parentId: record.recordId,
        sourceEventId: record.sourceEventId,
        provenance: provenanceFor(context, record.sourceEventId),
        payload,
      });
    }
  }

  return records;
}
