/**
 * Session builder shared by every format parser in `session-parser.worker.ts`.
 *
 * Extracted verbatim out of the worker module so the Claude Code transformer
 * (`src/lib/claude-to-dashboard.ts`) can reuse it without pulling in the
 * other five formats' parsing code. Behaviour is unchanged from before the
 * extraction - the other five formats keep using this exact class.
 */

import type {
  DashboardSession,
  MessageRole,
  ModelTokenUsage,
  ParsedSession,
  ParseError,
  SessionEvent,
  SessionSource,
  SessionTask,
  ToolExecution,
  TranscriptMessage,
} from '../types';

// ==================== Tool classification ====================

const READ_TOOL_PATTERN =
  /^(read_file|read|view|cat_file|cat|ls|list_dir|list_files|glob|grep|grep_search|search|search_files|find)$/i;
const WRITE_TOOL_PATTERN =
  /^(file_write|write_file|write|create_file|edit|str_replace|apply_patch|insert|replace|create_directory|write)$/i;
// Deliberately excludes "task": Claude Code's real subagent-launching tool
// is named "Agent" (already matched below); a bare "task" substring match
// was tried once but incorrectly caught the unrelated TaskCreate/TaskUpdate/
// TaskGet/TaskList/TaskOutput/TaskStop todo-list-management tools too.
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

/**
 * Claude Code's exact tool name for a Skill invocation. Skill calls have
 * their own dedicated tracking (the `skills` indicator) and are deliberately
 * excluded from the generic "tool call" pool (`tool_executions` as consumed
 * by the Tools Used metric / `tools` indicator) - see AGENTS.md.
 */
export function isSkillTool(toolName: string): boolean {
  return toolName === 'Skill';
}

/**
 * Claude Code's exact tool name for a subagent-launching call. Like Skill,
 * Agent calls have their own dedicated tracking (the `agents` indicator) and
 * are excluded from the generic "tool call" pool - see AGENTS.md.
 */
export function isAgentTool(toolName: string): boolean {
  return toolName === 'Agent';
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ==================== Session builder ====================

/**
 * Accumulates normalized facts while a parser walks its source events, then
 * finalizes into an immutable DashboardSession.
 */
export class SessionBuilder {
  readonly toolExecutions: ToolExecution[] = [];
  readonly events: SessionEvent[] = [];
  readonly messages: TranscriptMessage[] = [];
  readonly errors: ParseError[] = [];

  inputTokens = 0;
  outputTokens = 0;
  cacheCreationTokens = 0;
  cacheReadTokens = 0;
  costUsd: number | undefined;
  model: string | undefined;
  externalId: string | undefined;
  contextCompactions = 0;
  turns = 0;
  startedAt = Number.MAX_SAFE_INTEGER;
  endedAt = 0;

  private readonly filesRead = new Set<string>();
  private readonly filesWritten = new Set<string>();
  private agentInvocations = 0;
  private readonly modelUsage = new Map<string, ModelTokenUsage>();
  private readonly tasks = new Map<string, SessionTask>();

  observeTimestamp(timestamp: number): void {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return;
    if (timestamp < this.startedAt) this.startedAt = timestamp;
    if (timestamp > this.endedAt) this.endedAt = timestamp;
  }

  /**
   * Merges one `task_reminder` snapshot into the tracked task list. Each
   * snapshot carries the *full current* task list (not a delta), so tasks
   * are deduped by `id` across every snapshot seen; `first_seen_at` is the
   * earliest snapshot the id appeared in, `completed_at` is the earliest
   * snapshot where its status was already 'completed'.
   */
  trackTaskReminder(items: Array<Record<string, unknown>>, timestamp: number): void {
    for (const item of items) {
      const id = typeof item.id === 'string' ? item.id : undefined;
      if (!id) continue;

      const status = typeof item.status === 'string' ? item.status : 'pending';
      const existing = this.tasks.get(id);

      this.tasks.set(id, {
        id,
        subject: typeof item.subject === 'string' ? item.subject : (existing?.subject ?? ''),
        description: typeof item.description === 'string' ? item.description : (existing?.description ?? ''),
        status,
        first_seen_at: existing ? Math.min(existing.first_seen_at, timestamp) : timestamp,
        completed_at: existing?.completed_at ?? (status === 'completed' ? timestamp : undefined),
      });
    }
  }

  /** Accumulates per-model token usage for sessions that span multiple models. */
  addModelUsage(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheCreationTokens = 0,
    cacheReadTokens = 0
  ): void {
    const usage = this.modelUsage.get(model) ?? {
      model,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    };
    usage.input_tokens += inputTokens;
    usage.output_tokens += outputTokens;
    usage.cache_creation_tokens += cacheCreationTokens;
    usage.cache_read_tokens += cacheReadTokens;
    this.modelUsage.set(model, usage);
  }

  addTool(
    toolName: string,
    toolType: string,
    target: string | undefined,
    timestamp: number,
    success = true,
    parameters?: Record<string, unknown>
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
      parameters: parameters && Object.keys(parameters).length > 0 ? parameters : undefined,
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
    this.addTranscriptMessage(role, content, timestamp);
    if (content) this.turns++;
  }

  /**
   * Like `addMessage`, but doesn't count a turn - for parsers (e.g. Claude
   * Code) that already count turns at a coarser granularity than "one
   * message" (one assistant entry may yield zero, one, or several messages).
   */
  addTranscriptMessage(
    role: MessageRole,
    content: string,
    timestamp: number,
    uuid?: string,
    parentUuid?: string
  ): void {
    if (!content) return;
    this.messages.push({
      id: generateId(),
      session_id: '',
      role,
      content,
      timestamp,
      uuid,
      parent_uuid: parentUuid,
    });
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
      cache_creation_tokens: this.cacheCreationTokens,
      cache_read_tokens: this.cacheReadTokens,
      // Deliberately input + output only, matching the conventional "tokens
      // used" sense (and how Claude Code's own `/cost` breaks down usage:
      // input/output/cache separately, never blended into one figure).
      // Cache tokens are NOT summed in here - `cache_read_input_tokens` in
      // particular re-counts the same cached context on nearly every turn
      // (prompt caching), so folding it into "Total Tokens" would inflate
      // the headline number by orders of magnitude without representing
      // distinct tokens processed. Cache figures remain visible in the
      // dedicated Token Usage breakdown panel and the per-model table.
      total_tokens: this.inputTokens + this.outputTokens,
      cost_usd: this.costUsd,
      model: this.model,
      models: Array.from(this.modelUsage.values()),
      context_compactions: this.contextCompactions,
      total_turns: this.turns,
      files_read: this.filesRead.size,
      files_written: this.filesWritten.size,
      agent_invocations: this.agentInvocations,
      tool_executions: this.toolExecutions,
      events: this.events,
      messages: this.messages,
      tasks: Array.from(this.tasks.values()),
      external_id: this.externalId,
      subagents: [],
    };

    for (const tool of this.toolExecutions) tool.session_id = session.id;
    for (const event of this.events) event.session_id = session.id;
    for (const message of this.messages) message.session_id = session.id;

    return { session, parseErrors: this.errors };
  }
}
