import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { dbClient } from '../db/db-client';
import type { DashboardSession, IndicatorKey, ToolExecution, TranscriptMessage } from '../types';
import { isAgentTool, isReadTool, isSkillTool, isWriteTool } from '../workers/session-parser.worker';
import { formatDuration } from '../lib/format';
import type { EventTableRow } from '../components/events-table';
import '../components/events-table';

interface MessageNode {
  message: TranscriptMessage;
  children: MessageNode[];
}

const INDICATOR_LABELS: Record<IndicatorKey, string> = {
  tokens: 'Token Usage',
  compactions: 'Context Compactions',
  turns: 'Interactions (Turns)',
  tools: 'Tool Executions',
  files_read: 'Files Read',
  files_written: 'Files Written',
  agents: 'Agent Invocations',
  skills: 'Skill Invocations',
  diagnostics: 'Cache Diagnostics',
  tasks: 'Tasks',
};

const TOKEN_EVENT_TYPES = new Set([
  'assistant_turn',
  'message_start',
  'message_delta',
  'usage_snapshot',
  'model_inference',
]);

/**
 * Indicator Details page: drill-down view showing the granular events that
 * make up a specific metric from the Session Dashboard, as a data table.
 */
@customElement('indicator-details')
export class IndicatorDetails extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .indicator-details {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .back-link {
      color: var(--md-sys-color-primary, #4f8cff);
      text-decoration: none;
      font-size: 14px;
    }

    .back-link:hover {
      text-decoration: underline;
    }

    h1 {
      margin: 0;
      font-size: 22px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .subtitle {
      margin: 0;
      font-size: 13px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .error {
      background: var(--md-sys-color-error-container, #5c2626);
      color: var(--md-sys-color-on-error-container, #ffb4ab);
      padding: 12px 16px;
      border-radius: 8px;
    }

    .notice {
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 13px;
    }

    .message-tree {
      display: flex;
      flex-direction: column;
      gap: 8px;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      background: var(--md-sys-color-surface, #171a21);
      padding: 12px;
    }

    .message-node {
      border-left: 2px solid var(--md-sys-color-outline, #2a303c);
      padding-left: 10px;
    }

    .message-node.root {
      border-left: none;
      padding-left: 0;
    }

    .message-children {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 8px;
      margin-left: 14px;
    }

    .message-header {
      display: flex;
      align-items: baseline;
      gap: 8px;
      cursor: default;
    }

    .message-header.has-children {
      cursor: pointer;
    }

    .message-toggle {
      font-size: 11px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      width: 12px;
      flex-shrink: 0;
    }

    .message-role {
      font-weight: 600;
      font-size: 12px;
      text-transform: capitalize;
      color: var(--md-sys-color-primary, #4f8cff);
      flex-shrink: 0;
    }

    .message-timestamp {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      flex-shrink: 0;
    }

    .message-content {
      font-size: 13px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      word-break: break-word;
    }

    .message-child-count {
      font-size: 11px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .tool-filters {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      background: var(--md-sys-color-surface, #171a21);
    }

    .tool-filters select,
    .tool-filters input[type='text'] {
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 13px;
    }

    .tool-filters input[type='text'] {
      flex: 1;
      min-width: 200px;
    }

    .tool-filter-checkbox {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      cursor: pointer;
      user-select: none;
    }

    .tool-filter-count {
      margin-left: auto;
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .tools-table {
      overflow-x: auto;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      background: var(--md-sys-color-surface, #171a21);
    }

    .tools-table table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }

    .tools-table th,
    .tools-table td {
      padding: 10px 16px;
      text-align: left;
      border-bottom: 1px solid var(--md-sys-color-outline, #2a303c);
      vertical-align: top;
    }

    .tools-table th {
      background: var(--md-sys-color-surface-container, #1f242e);
      font-weight: 600;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      position: sticky;
      top: 0;
    }

    .tools-table tr:last-child td {
      border-bottom: none;
    }

    .tool-row {
      cursor: pointer;
    }

    .tool-row:hover {
      background: var(--md-sys-color-surface-container-hover, #262d3a);
    }

    .tool-row.tool-row-error {
      background: var(--md-sys-color-error-container, rgba(255, 84, 84, 0.12));
    }

    .tool-row.tool-row-error:hover {
      background: var(--md-sys-color-error-container, rgba(255, 84, 84, 0.2));
    }

    .tool-name {
      font-weight: 600;
      color: var(--md-sys-color-primary, #4f8cff);
      white-space: nowrap;
    }

    .tool-timestamp {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      white-space: nowrap;
    }

    .tool-target {
      color: var(--md-sys-color-on-surface, #e6e9ef);
      word-break: break-word;
    }

    .error-badge {
      display: inline-block;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.02em;
      color: var(--md-sys-color-on-error, #ffffff);
      background: var(--md-sys-color-error, #c4453e);
      border-radius: 4px;
      padding: 2px 6px;
      white-space: nowrap;
    }

    .success-badge {
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .tool-detail-row td {
      background: var(--md-sys-color-surface-container, #1f242e);
    }

    .tool-detail {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .tool-detail-section h4 {
      margin: 0 0 4px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .tool-detail-section pre {
      margin: 0;
      max-height: 320px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }
  `;

  @property({ type: String, attribute: 'session-id' }) sessionId = '';

  @property({ type: String }) indicator = '';

  @state() private session: DashboardSession | null = null;

  @state() private isLoading = true;

  @state() private error: string | null = null;

  @state() private collapsedMessageIds = new Set<string>();

  @state() private expandedToolIds = new Set<string>();

  @state() private toolNameFilter = '';

  @state() private toolErrorsOnlyFilter = false;

  @state() private toolTextFilter = '';

  @state() private expandedSkillExecutionIds = new Set<string>();

  @state() private skillNameFilter = '';

  @state() private skillTextFilter = '';

  @state() private expandedAgentExecutionIds = new Set<string>();

  @state() private agentTypeFilter = '';

  @state() private agentTextFilter = '';

  willUpdate(changed: Map<string, unknown>): void {
    if ((changed.has('sessionId') || changed.has('indicator')) && this.sessionId) {
      void this.loadSession();
    }
  }

  private async loadSession(): Promise<void> {
    this.isLoading = true;
    try {
      this.session = await dbClient.getSession(this.sessionId);
      this.error = this.session ? null : `Session not found: ${this.sessionId}`;
    } catch (error) {
      this.error = `Failed to load session: ${(error as Error).message}`;
    } finally {
      this.isLoading = false;
    }
  }

  private isKnownIndicator(key: string): key is IndicatorKey {
    return key in INDICATOR_LABELS;
  }

  private buildRows(session: DashboardSession, indicator: IndicatorKey): EventTableRow[] {
    switch (indicator) {
      case 'tokens': {
        const usageRows = session.events
          .filter((event) => TOKEN_EVENT_TYPES.has(event.event_type))
          .map((event) => ({
            id: event.id,
            timestamp: event.timestamp,
            event_type: event.event_type,
            description: event.description,
            metadata: event.metadata,
          }));
        if (usageRows.length > 0) return usageRows;
        return [
          {
            id: `${session.id}-tokens-summary`,
            timestamp: session.started_at,
            event_type: 'summary',
            description: `Input: ${session.input_tokens.toLocaleString()} • Output: ${session.output_tokens.toLocaleString()} • Total: ${session.total_tokens.toLocaleString()}`,
          },
        ];
      }
      case 'compactions':
        return session.events
          .filter((event) => event.event_type === 'context_compaction')
          .map((event) => ({
            id: event.id,
            timestamp: event.timestamp,
            event_type: event.event_type,
            description: event.description,
            metadata: event.metadata,
          }));
      case 'turns':
        return session.messages.map((message) => ({
          id: message.id,
          timestamp: message.timestamp,
          event_type: `${message.role} message`,
          description: message.content.length > 160 ? `${message.content.slice(0, 160)}…` : message.content,
        }));
      case 'tools':
        return this.toolRows(session, (toolName) => !isSkillTool(toolName) && !isAgentTool(toolName));
      case 'files_read':
        return this.toolRows(session, (toolName) => isReadTool(toolName));
      case 'files_written':
        return this.toolRows(session, (toolName) => isWriteTool(toolName));
      case 'skills':
        return this.toolRows(session, (toolName) => isSkillTool(toolName));
      case 'agents':
        return this.toolRows(session, (toolName) => isAgentTool(toolName));
      case 'diagnostics':
        return session.events
          .filter((event) => event.event_type === 'diagnostic')
          .map((event) => ({
            id: event.id,
            timestamp: event.timestamp,
            event_type: event.event_type,
            description: event.description,
            metadata: event.metadata,
          }));
      case 'tasks':
        return session.tasks.map((task) => ({
          id: task.id,
          timestamp: task.completed_at ?? task.first_seen_at,
          event_type: task.status,
          description: task.subject,
          metadata: {
            description: task.description,
            first_seen_at: new Date(task.first_seen_at).toLocaleString(),
            completed_at: task.completed_at ? new Date(task.completed_at).toLocaleString() : undefined,
            duration: task.completed_at
              ? formatDuration(task.completed_at - task.first_seen_at)
              : undefined,
          },
        }));
    }
  }

  private toolRows(
    session: DashboardSession,
    predicate: (toolName: string) => boolean
  ): EventTableRow[] {
    return session.tool_executions
      .filter((execution) => predicate(execution.tool_name))
      .map((execution) => ({
        id: execution.id,
        timestamp: execution.timestamp,
        event_type: execution.tool_name,
        description: execution.target ?? '-',
        metadata: { tool_type: execution.tool_type, success: execution.success },
      }));
  }

  private toggleToolExpanded(id: string): void {
    const next = new Set(this.expandedToolIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.expandedToolIds = next;
  }

  /**
   * Tool executions that count as a plain "tool call" - excludes Skill and
   * Agent invocations, which have their own dedicated tracking (the
   * `skills`/`agents` indicators) and are never listed here (see AGENTS.md).
   */
  private genericToolExecutions(session: DashboardSession): ToolExecution[] {
    return session.tool_executions.filter(
      (execution) => !isSkillTool(execution.tool_name) && !isAgentTool(execution.tool_name)
    );
  }

  /** Distinct tool names present in the session, for the "by tool" filter dropdown. */
  private distinctToolNames(session: DashboardSession): string[] {
    return Array.from(new Set(this.genericToolExecutions(session).map((execution) => execution.tool_name))).sort();
  }

  /**
   * Applies the combinable tools-page filters (by tool, errors-only, free
   * text across tool name / inputs / result) to the session's tool
   * executions. Plain in-memory `.filter()` - the page already holds every
   * row for this session, so there's no DB query involved.
   */
  private filteredToolExecutions(session: DashboardSession): ToolExecution[] {
    const nameFilter = this.toolNameFilter;
    const errorsOnly = this.toolErrorsOnlyFilter;
    const text = this.toolTextFilter.trim().toLowerCase();

    return this.genericToolExecutions(session).filter((execution) => {
      if (nameFilter && execution.tool_name !== nameFilter) return false;
      if (errorsOnly && execution.success !== false) return false;
      if (text) {
        const haystack = [
          execution.tool_name,
          execution.parameters ? JSON.stringify(execution.parameters) : '',
          execution.result ?? '',
        ]
          .join('\n')
          .toLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    });
  }

  private renderToolDetail(execution: ToolExecution): TemplateResult {
    const inputs = execution.parameters ? JSON.stringify(execution.parameters, null, 2) : 'No inputs recorded';
    const result = execution.result ?? 'No result recorded';
    return html`
      <tr class="tool-detail-row">
        <td colspan="4">
          <div class="tool-detail">
            <div class="tool-detail-section">
              <h4>Inputs</h4>
              <pre>${inputs}</pre>
            </div>
            <div class="tool-detail-section">
              <h4>Result</h4>
              <pre>${result}</pre>
            </div>
          </div>
        </td>
      </tr>
    `;
  }

  private renderToolsSection(session: DashboardSession): TemplateResult {
    const toolNames = this.distinctToolNames(session);
    const filtered = this.filteredToolExecutions(session);
    const totalCount = this.genericToolExecutions(session).length;

    return html`
      <div class="tool-filters">
        <select
          .value=${this.toolNameFilter}
          @change=${(event: Event) => {
            this.toolNameFilter = (event.target as HTMLSelectElement).value;
          }}
        >
          <option value="">All tools</option>
          ${toolNames.map((name) => html`<option value=${name}>${name}</option>`)}
        </select>
        <label class="tool-filter-checkbox">
          <input
            type="checkbox"
            .checked=${this.toolErrorsOnlyFilter}
            @change=${(event: Event) => {
              this.toolErrorsOnlyFilter = (event.target as HTMLInputElement).checked;
            }}
          />
          Errors only
        </label>
        <input
          type="text"
          placeholder="Search tool, inputs, or result…"
          .value=${this.toolTextFilter}
          @input=${(event: Event) => {
            this.toolTextFilter = (event.target as HTMLInputElement).value;
          }}
        />
        <span class="tool-filter-count">${filtered.length} of ${totalCount}</span>
      </div>

      <div class="tools-table">
        ${filtered.length === 0
          ? html`<p class="notice">No tool executions match these filters.</p>`
          : html`
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Tool</th>
                  <th>Target</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${filtered.map((execution) => {
                  const expanded = this.expandedToolIds.has(execution.id);
                  return html`
                    <tr
                      class="tool-row ${execution.success === false ? 'tool-row-error' : ''}"
                      @click=${() => this.toggleToolExpanded(execution.id)}
                    >
                      <td class="tool-timestamp">${new Date(execution.timestamp).toLocaleString()}</td>
                      <td class="tool-name">${execution.tool_name}</td>
                      <td class="tool-target">${execution.target ?? '-'}</td>
                      <td>
                        ${execution.success === false
                          ? html`<span class="error-badge">Error</span>`
                          : html`<span class="success-badge">OK</span>`}
                      </td>
                    </tr>
                    ${expanded ? this.renderToolDetail(execution) : ''}
                  `;
                })}
              </tbody>
            </table>
          `}
      </div>
    `;
  }

  /** Every `Skill` tool invocation in the session (the `skills` indicator's scope). */
  private skillExecutions(session: DashboardSession): ToolExecution[] {
    return session.tool_executions.filter((execution) => isSkillTool(execution.tool_name));
  }

  /** The invoked skill's own name (e.g. `code-review`), falling back to the tool name. */
  private skillNameFor(execution: ToolExecution): string {
    const skillParam = execution.parameters?.skill;
    return typeof skillParam === 'string' && skillParam ? skillParam : execution.tool_name;
  }

  /** Short preview of the skill's invocation args, for the table's detail column. */
  private skillArgsPreview(execution: ToolExecution): string {
    const args = execution.parameters?.args;
    if (typeof args === 'string' && args) return args;
    const rest = { ...(execution.parameters ?? {}) };
    delete rest.skill;
    return Object.keys(rest).length > 0 ? JSON.stringify(rest) : '-';
  }

  /**
   * The content produced right after an execution's `tool_result` - found by
   * matching `parent_uuid` against the `tool_result`'s own `uuid`
   * (`execution.result_uuid`) - concatenated in timestamp order. Used by both
   * the Skills and Agents sections to recover what actually happened beyond
   * the terse `tool_result` acknowledgement (e.g. a Skill's expanded
   * instructions, or the orchestrator's follow-up after an Agent call).
   */
  private linkedContentFor(session: DashboardSession, execution: ToolExecution): string {
    if (!execution.result_uuid) return 'No linked content found';
    const linked = session.messages
      .filter((message) => message.parent_uuid === execution.result_uuid)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((message) => message.content);
    return linked.length > 0 ? linked.join('\n\n') : 'No linked content found';
  }

  /** Distinct skill names present in the session, for the "by skill" filter dropdown. */
  private distinctSkillNames(session: DashboardSession): string[] {
    return Array.from(new Set(this.skillExecutions(session).map((execution) => this.skillNameFor(execution)))).sort();
  }

  /**
   * Applies the combinable skills-page filters (by skill, free text across
   * skill name / inputs / result / linked content) to the session's `Skill`
   * tool invocations.
   */
  private filteredSkillExecutions(session: DashboardSession): ToolExecution[] {
    const nameFilter = this.skillNameFilter;
    const text = this.skillTextFilter.trim().toLowerCase();

    return this.skillExecutions(session).filter((execution) => {
      if (nameFilter && this.skillNameFor(execution) !== nameFilter) return false;
      if (text) {
        const haystack = [
          this.skillNameFor(execution),
          execution.parameters ? JSON.stringify(execution.parameters) : '',
          execution.result ?? '',
          this.linkedContentFor(session, execution),
        ]
          .join('\n')
          .toLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    });
  }

  private toggleSkillExecutionExpanded(id: string): void {
    const next = new Set(this.expandedSkillExecutionIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.expandedSkillExecutionIds = next;
  }

  private renderSkillDetail(session: DashboardSession, execution: ToolExecution): TemplateResult {
    const inputs = execution.parameters ? JSON.stringify(execution.parameters, null, 2) : 'No inputs recorded';
    const result = execution.result ?? 'No result recorded';
    const content = this.linkedContentFor(session, execution);
    return html`
      <tr class="tool-detail-row">
        <td colspan="4">
          <div class="tool-detail">
            <div class="tool-detail-section">
              <h4>Inputs</h4>
              <pre>${inputs}</pre>
            </div>
            <div class="tool-detail-section">
              <h4>Result</h4>
              <pre>${result}</pre>
            </div>
            <div class="tool-detail-section">
              <h4>Skill Content</h4>
              <pre>${content}</pre>
            </div>
          </div>
        </td>
      </tr>
    `;
  }

  private renderSkillsSection(session: DashboardSession): TemplateResult {
    const skillExecutions = this.skillExecutions(session);
    const skillNames = this.distinctSkillNames(session);
    const filtered = this.filteredSkillExecutions(session);

    return html`
      <div class="tool-filters">
        <select
          .value=${this.skillNameFilter}
          @change=${(event: Event) => {
            this.skillNameFilter = (event.target as HTMLSelectElement).value;
          }}
        >
          <option value="">All skills</option>
          ${skillNames.map((name) => html`<option value=${name}>${name}</option>`)}
        </select>
        <input
          type="text"
          placeholder="Search skill, inputs, result, or content…"
          .value=${this.skillTextFilter}
          @input=${(event: Event) => {
            this.skillTextFilter = (event.target as HTMLInputElement).value;
          }}
        />
        <span class="tool-filter-count">${filtered.length} of ${skillExecutions.length}</span>
      </div>

      <div class="tools-table">
        ${filtered.length === 0
          ? html`<p class="notice">No skill invocations match these filters.</p>`
          : html`
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Skill</th>
                  <th>Details</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${filtered.map((execution) => {
                  const expanded = this.expandedSkillExecutionIds.has(execution.id);
                  return html`
                    <tr
                      class="tool-row ${execution.success === false ? 'tool-row-error' : ''}"
                      @click=${() => this.toggleSkillExecutionExpanded(execution.id)}
                    >
                      <td class="tool-timestamp">${new Date(execution.timestamp).toLocaleString()}</td>
                      <td class="tool-name">${this.skillNameFor(execution)}</td>
                      <td class="tool-target">${this.skillArgsPreview(execution)}</td>
                      <td>
                        ${execution.success === false
                          ? html`<span class="error-badge">Error</span>`
                          : html`<span class="success-badge">OK</span>`}
                      </td>
                    </tr>
                    ${expanded ? this.renderSkillDetail(session, execution) : ''}
                  `;
                })}
              </tbody>
            </table>
          `}
      </div>
    `;
  }

  /** Every `Agent` tool invocation in the session (the `agents` indicator's scope - "project agents", distinct from Sub Agents/session.subagents). */
  private agentExecutions(session: DashboardSession): ToolExecution[] {
    return session.tool_executions.filter((execution) => isAgentTool(execution.tool_name));
  }

  /** The invoked agent's type (e.g. `general-purpose`, `Explore`), falling back to the tool name. */
  private agentTypeFor(execution: ToolExecution): string {
    const subagentType = execution.parameters?.subagent_type;
    return typeof subagentType === 'string' && subagentType ? subagentType : execution.tool_name;
  }

  /** Short preview of the agent's task description, for the table's detail column. */
  private agentDescriptionPreview(execution: ToolExecution): string {
    const description = execution.parameters?.description;
    if (typeof description === 'string' && description) return description;
    const prompt = execution.parameters?.prompt;
    if (typeof prompt === 'string' && prompt) return prompt.length > 120 ? `${prompt.slice(0, 120)}…` : prompt;
    return '-';
  }

  /** Distinct agent types present in the session, for the "by type" filter dropdown. */
  private distinctAgentTypes(session: DashboardSession): string[] {
    return Array.from(new Set(this.agentExecutions(session).map((execution) => this.agentTypeFor(execution)))).sort();
  }

  /**
   * Applies the combinable agents-page filters (by agent type, free text
   * across type / inputs / result / linked content) to the session's `Agent`
   * tool invocations.
   */
  private filteredAgentExecutions(session: DashboardSession): ToolExecution[] {
    const typeFilter = this.agentTypeFilter;
    const text = this.agentTextFilter.trim().toLowerCase();

    return this.agentExecutions(session).filter((execution) => {
      if (typeFilter && this.agentTypeFor(execution) !== typeFilter) return false;
      if (text) {
        const haystack = [
          this.agentTypeFor(execution),
          execution.parameters ? JSON.stringify(execution.parameters) : '',
          execution.result ?? '',
          this.linkedContentFor(session, execution),
        ]
          .join('\n')
          .toLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    });
  }

  private toggleAgentExecutionExpanded(id: string): void {
    const next = new Set(this.expandedAgentExecutionIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.expandedAgentExecutionIds = next;
  }

  private renderAgentDetail(session: DashboardSession, execution: ToolExecution): TemplateResult {
    const inputs = execution.parameters ? JSON.stringify(execution.parameters, null, 2) : 'No inputs recorded';
    const result = execution.result ?? 'No result recorded';
    const content = this.linkedContentFor(session, execution);
    return html`
      <tr class="tool-detail-row">
        <td colspan="4">
          <div class="tool-detail">
            <div class="tool-detail-section">
              <h4>Inputs</h4>
              <pre>${inputs}</pre>
            </div>
            <div class="tool-detail-section">
              <h4>Result</h4>
              <pre>${result}</pre>
            </div>
            <div class="tool-detail-section">
              <h4>Linked Content</h4>
              <pre>${content}</pre>
            </div>
          </div>
        </td>
      </tr>
    `;
  }

  private renderAgentsSection(session: DashboardSession): TemplateResult {
    const agentExecutions = this.agentExecutions(session);
    const agentTypes = this.distinctAgentTypes(session);
    const filtered = this.filteredAgentExecutions(session);

    return html`
      <div class="tool-filters">
        <select
          .value=${this.agentTypeFilter}
          @change=${(event: Event) => {
            this.agentTypeFilter = (event.target as HTMLSelectElement).value;
          }}
        >
          <option value="">All agent types</option>
          ${agentTypes.map((name) => html`<option value=${name}>${name}</option>`)}
        </select>
        <input
          type="text"
          placeholder="Search agent type, inputs, result, or content…"
          .value=${this.agentTextFilter}
          @input=${(event: Event) => {
            this.agentTextFilter = (event.target as HTMLInputElement).value;
          }}
        />
        <span class="tool-filter-count">${filtered.length} of ${agentExecutions.length}</span>
      </div>

      <div class="tools-table">
        ${filtered.length === 0
          ? html`<p class="notice">No agent invocations match these filters.</p>`
          : html`
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Agent Type</th>
                  <th>Description</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${filtered.map((execution) => {
                  const expanded = this.expandedAgentExecutionIds.has(execution.id);
                  return html`
                    <tr
                      class="tool-row ${execution.success === false ? 'tool-row-error' : ''}"
                      @click=${() => this.toggleAgentExecutionExpanded(execution.id)}
                    >
                      <td class="tool-timestamp">${new Date(execution.timestamp).toLocaleString()}</td>
                      <td class="tool-name">${this.agentTypeFor(execution)}</td>
                      <td class="tool-target">${this.agentDescriptionPreview(execution)}</td>
                      <td>
                        ${execution.success === false
                          ? html`<span class="error-badge">Error</span>`
                          : html`<span class="success-badge">OK</span>`}
                      </td>
                    </tr>
                    ${expanded ? this.renderAgentDetail(session, execution) : ''}
                  `;
                })}
              </tbody>
            </table>
          `}
      </div>
    `;
  }

  /**
   * Nests messages under their parent by `parent_uuid` - but only when that
   * `uuid` is actually present among this session's messages. A message's
   * immediate parent in the raw transcript is very often a tool call/result
   * (never turned into a TranscriptMessage), so most messages legitimately
   * have no resolvable parent here and stay at the top level.
   */
  private buildMessageTree(session: DashboardSession): MessageNode[] {
    const nodes = session.messages.map((message) => ({ message, children: [] as MessageNode[] }));
    const byUuid = new Map<string, MessageNode>();
    for (const node of nodes) {
      if (node.message.uuid) byUuid.set(node.message.uuid, node);
    }

    const roots: MessageNode[] = [];
    for (const node of nodes) {
      const parent = node.message.parent_uuid ? byUuid.get(node.message.parent_uuid) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  private toggleMessageNode(id: string): void {
    const next = new Set(this.collapsedMessageIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.collapsedMessageIds = next;
  }

  private renderMessageNode(node: MessageNode, isRoot: boolean): TemplateResult {
    const { message, children } = node;
    const hasChildren = children.length > 0;
    const collapsed = this.collapsedMessageIds.has(message.id);

    return html`
      <div class="message-node ${isRoot ? 'root' : ''}">
        <div
          class="message-header ${hasChildren ? 'has-children' : ''}"
          @click=${() => hasChildren && this.toggleMessageNode(message.id)}
        >
          <span class="message-toggle">${hasChildren ? (collapsed ? '▶' : '▼') : ''}</span>
          <span class="message-role">${message.role}</span>
          <span class="message-timestamp">${new Date(message.timestamp).toLocaleString()}</span>
          ${hasChildren
            ? html`<span class="message-child-count"
                >${children.length} repl${children.length === 1 ? 'y' : 'ies'}</span
              >`
            : ''}
        </div>
        <div class="message-content">
          ${message.content.length > 300 ? `${message.content.slice(0, 300)}…` : message.content}
        </div>
        ${hasChildren && !collapsed
          ? html`
            <div class="message-children">
              ${children.map((child) => this.renderMessageNode(child, false))}
            </div>
          `
          : ''}
      </div>
    `;
  }

  render() {
    if (!this.isKnownIndicator(this.indicator)) {
      return html`
        <div class="indicator-details">
          <a class="back-link" href="#/sessions/${this.sessionId}">← Back to Session</a>
          <div class="error">Unknown indicator: ${this.indicator}</div>
        </div>
      `;
    }

    if (!this.session && !this.isLoading) {
      return html`
        <div class="indicator-details">
          <a class="back-link" href="#/">← Back to Projects</a>
          <p class="notice">${this.error ?? 'Session not found.'}</p>
        </div>
      `;
    }

    if (!this.session) {
      return html`<div class="indicator-details"><p class="notice">Loading indicator…</p></div>`;
    }

    const indicator = this.indicator as IndicatorKey;
    const session = this.session;
    const isTurns = indicator === 'turns';
    const isTools = indicator === 'tools';
    const isSkills = indicator === 'skills';
    const isAgents = indicator === 'agents';
    const messageTree = isTurns ? this.buildMessageTree(session) : [];
    const rows = isTurns || isTools || isSkills || isAgents ? [] : this.buildRows(session, indicator);
    const recordCount = isTurns
      ? session.messages.length
      : isTools
        ? this.genericToolExecutions(session).length
        : isSkills
          ? this.skillExecutions(session).length
          : isAgents
            ? this.agentExecutions(session).length
            : rows.length;
    // "Total Interactions" (session.total_turns) counts every assistant turn
    // unconditionally, including turns that only made tool calls (thinking +
    // tool_use, no `text` block). This page only lists messages that carry
    // visible text, so the two counts legitimately diverge - a tool-heavy
    // session can show far fewer records here than the dashboard's turn
    // count implies. Surface that gap explicitly instead of leaving it
    // looking like a bug.
    const assistantMessagesWithText = isTurns
      ? session.messages.filter((message) => message.role === 'assistant').length
      : 0;
    const toolOnlyTurns = isTurns ? Math.max(0, session.total_turns - assistantMessagesWithText) : 0;

    return html`
      <div class="indicator-details">
        <a class="back-link" href="#/sessions/${this.sessionId}">← Back to Session</a>
        <div>
          <h1>${INDICATOR_LABELS[indicator]}</h1>
          <p class="subtitle">
            ${recordCount} record${recordCount === 1 ? '' : 's'} • ${session.title || session.source}
          </p>
        </div>

        ${this.error ? html`<div class="error">${this.error}</div>` : ''}

        ${isTurns && toolOnlyTurns > 0
          ? html`
            <p class="notice">
              ${assistantMessagesWithText} of ${session.total_turns} assistant turns produced visible
              text and appear below. The other ${toolOnlyTurns}
              turn${toolOnlyTurns === 1 ? '' : 's'} only made tool calls (thinking + tool use, no spoken
              text), so ${toolOnlyTurns === 1 ? 'it is' : 'they are'} not shown as messages here - see
              <a class="back-link" href="#/sessions/${this.sessionId}/indicator/tools">Tool Executions</a>
              for that activity.
            </p>
          `
          : ''}

        ${isTurns
          ? html`
            <div class="message-tree">
              ${messageTree.map((node) => this.renderMessageNode(node, true))}
            </div>
          `
          : isTools
            ? this.renderToolsSection(session)
            : isSkills
              ? this.renderSkillsSection(session)
              : isAgents
                ? this.renderAgentsSection(session)
                : html`<events-table .events=${rows} showMetadata></events-table>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'indicator-details': IndicatorDetails;
  }
}
