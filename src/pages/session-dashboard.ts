import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { dbClient } from '../db/db-client';
import { navigateTo } from '../router';
import { parseInWorker } from '../workers/parser-client';
import type { DashboardSession, IndicatorKey, ToolExecution } from '../types';
import { estimateTokenCount, formatCompactNumber, formatDuration, formatFullNumber } from '../lib/format';
import { isAgentOrSkill } from '../workers/session-parser.worker';
import {
  classifyUploadedFiles,
  mergeSubagentIntoSession,
  parseSubagentMeta,
  type UploadedFile,
} from '../lib/subagents';
import '../components/metrics-card';
import '../components/upload-zone';

/**
 * Session Dashboard: the primary analytics view for an uploaded session.
 *
 * Bold metric cards across the top - every card routes to the Indicator
 * Details page for its metric. A link at the top routes to the dedicated
 * Session Transcript page (chat-like markdown-rendered messages, plus
 * subagent transcripts when present).
 */
@customElement('session-dashboard')
export class SessionDashboard extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .session-dashboard {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .back-link {
      color: var(--md-sys-color-primary, #4f8cff);
      text-decoration: none;
      font-size: 14px;
    }

    .back-link:hover {
      text-decoration: underline;
    }

    .title-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      flex-wrap: wrap;
    }

    h1 {
      margin: 0;
      font-size: 24px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      word-break: break-word;
    }

    .session-subtitle {
      margin: 4px 0 0;
      font-size: 13px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    a.transcript-link {
      background: var(--md-sys-color-primary, #4f8cff);
      color: #fff;
      border: none;
      padding: 10px 18px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      flex-shrink: 0;
      text-decoration: none;
      display: inline-block;
    }

    a.transcript-link:hover {
      filter: brightness(1.1);
    }

    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 12px;
    }

    .metrics-grid metrics-card {
      cursor: pointer;
    }

    h2 {
      margin: 8px 0 0;
      font-size: 18px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
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

    .insights-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
    }

    .panel {
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 12px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .panel-title {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .stat-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
      gap: 12px;
    }

    .stat-value {
      font-size: 18px;
      font-weight: 700;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .stat-label {
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      margin-top: 2px;
    }

    .usage-card-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .usage-card {
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
    }

    .usage-card-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      flex-wrap: wrap;
    }

    .usage-card-title {
      font-weight: 600;
      font-size: 13px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      word-break: break-word;
    }

    .usage-card-meta {
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      word-break: break-word;
    }

    .usage-card-stats {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 16px;
    }

    .usage-stat-value {
      font-size: 13px;
      font-weight: 600;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .usage-stat-label {
      font-size: 11px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .rank-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .rank-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .rank-count {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .skill-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .skill-item {
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .skill-item-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      flex-wrap: wrap;
    }

    .skill-name {
      font-weight: 600;
      font-size: 13px;
      color: var(--md-sys-color-primary, #4f8cff);
    }

    .skill-usage {
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .skill-invocations {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .skill-params {
      cursor: pointer;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .skill-params.preview {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .skill-params.expanded {
      white-space: pre-wrap;
      word-break: break-word;
    }

    .attach-folder {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .attach-folder-hint {
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }
  `;

  @property({ type: String, attribute: 'session-id' }) sessionId = '';

  @state() private session: DashboardSession | null = null;

  @state() private isLoading = true;

  @state() private error: string | null = null;

  @state() private expandedSkillIds = new Set<string>();

  @state() private isAttachingFolder = false;

  @state() private attachError: string | null = null;

  willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('sessionId') && this.sessionId) {
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

  /**
   * Post-hoc attach: lets the user drop a session's supplementary data
   * folder (`subagents/agent-<id>.jsonl` + `.meta.json`) onto an already
   * open session, folding each subagent's tokens/cache/models into it. Any
   * top-level transcript file in the drop is ignored here - this control is
   * for supplementary data only, not for uploading a different session.
   */
  private async handleFolderAttached(event: CustomEvent<{ files: UploadedFile[] }>): Promise<void> {
    const session = this.session;
    if (!session) return;

    const { subagentGroups } = classifyUploadedFiles(event.detail.files);
    if (subagentGroups.length === 0) {
      this.attachError = 'No subagent data found in the dropped folder.';
      return;
    }

    this.isAttachingFolder = true;
    this.attachError = null;

    try {
      for (const group of subagentGroups) {
        if (!group.jsonl) continue;
        const content = await group.jsonl.file.text();
        const parsedSub = await parseInWorker(content, { projectId: session.project_id });
        const meta = group.meta ? parseSubagentMeta(await group.meta.file.text()) : {};
        mergeSubagentIntoSession(session, group.agentId, parsedSub.session, meta);
      }
      await dbClient.replaceSession(session);
      await this.loadSession();
    } catch (error) {
      this.attachError = `Failed to attach folder: ${(error as Error).message}`;
    } finally {
      this.isAttachingFolder = false;
    }
  }

  private get mostUsedTool(): { name: string; count: number } | null {
    if (!this.session || this.session.tool_executions.length === 0) return null;

    const counts = new Map<string, number>();
    for (const execution of this.session.tool_executions) {
      counts.set(execution.tool_name, (counts.get(execution.tool_name) ?? 0) + 1);
    }

    let best: { name: string; count: number } | null = null;
    for (const [name, count] of counts) {
      if (!best || count > best.count) best = { name, count };
    }
    return best;
  }

  /** Every distinct tool used, ranked by call count (most-used first). */
  private get topTools(): Array<{ name: string; count: number }> {
    if (!this.session) return [];
    const counts = new Map<string, number>();
    for (const execution of this.session.tool_executions) {
      counts.set(execution.tool_name, (counts.get(execution.tool_name) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }

  /** Skill/agent tool calls grouped by skill name, each with its total usage count. */
  private get skillGroups(): Array<{ name: string; count: number; invocations: ToolExecution[] }> {
    if (!this.session) return [];
    const groups = new Map<string, ToolExecution[]>();
    for (const execution of this.session.tool_executions) {
      if (!isAgentOrSkill(execution.tool_name)) continue;
      const invocations = groups.get(execution.tool_name) ?? [];
      invocations.push(execution);
      groups.set(execution.tool_name, invocations);
    }
    return Array.from(groups.entries())
      .map(([name, invocations]) => ({ name, count: invocations.length, invocations }))
      .sort((a, b) => b.count - a.count);
  }

  /** Tally of `cache_miss_reason.type` across every recorded diagnostic. */
  private get cacheMissReasons(): Array<{ reason: string; count: number }> {
    if (!this.session) return [];
    const counts = new Map<string, number>();
    for (const event of this.session.events) {
      if (event.event_type !== 'diagnostic') continue;
      const cacheMissReason = event.metadata?.cache_miss_reason as Record<string, unknown> | undefined;
      const reason =
        cacheMissReason && typeof cacheMissReason.type === 'string' ? cacheMissReason.type : 'unknown';
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Estimated token volume attributable to tool_result content being fed
   * back into context, i.e. how much of the session's input token volume
   * came from tool output rather than user prompts or system context.
   *
   * No client-side tokenizer is available, so this is a heuristic estimate
   * (~4 characters per token, a common rough approximation for
   * English/code text) - NOT derived from the exact `usage` object figures
   * shown elsewhere on this page. Always labeled "(est.)" in the UI so it's
   * never confused with those exact numbers.
   */
  private get toolResultTokenEstimate(): number {
    if (!this.session) return 0;
    let total = 0;
    for (const execution of this.session.tool_executions) {
      if (execution.result) total += estimateTokenCount(execution.result);
    }
    return total;
  }

  /**
   * `toolResultTokenEstimate` as a percentage of the session's total input
   * token volume (input + cache write + cache read - every way an input
   * token can reach the model, cached or not). `null` when there's no input
   * volume to divide by.
   */
  private get toolResultTokenPercent(): number | null {
    if (!this.session) return null;
    const totalInputVolume =
      this.session.input_tokens + this.session.cache_creation_tokens + this.session.cache_read_tokens;
    if (totalInputVolume <= 0) return null;
    return (this.toolResultTokenEstimate / totalInputVolume) * 100;
  }

  /** Mean lifecycle time (first seen -> completed) across completed tasks only. */
  private get avgTaskDurationMs(): number {
    if (!this.session) return 0;
    const durations = this.session.tasks
      .filter((task) => task.completed_at !== undefined)
      .map((task) => task.completed_at! - task.first_seen_at);
    if (durations.length === 0) return 0;
    return durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
  }

  private openIndicator(indicator: IndicatorKey): void {
    navigateTo(`/sessions/${this.sessionId}/indicator/${indicator}`);
  }

  private toggleSkillParams(id: string): void {
    const next = new Set(this.expandedSkillIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.expandedSkillIds = next;
  }

  private sourceLabel(source: string): string {
    return source.replaceAll('_', ' ');
  }

  render() {
    const session = this.session;

    if (!session && !this.isLoading) {
      return html`
        <div class="session-dashboard">
          <a class="back-link" href="#/">← Back to Projects</a>
          <p class="notice">${this.error ?? 'Session not found.'}</p>
        </div>
      `;
    }

    if (!session) {
      return html`<div class="session-dashboard"><p class="notice">Loading session…</p></div>`;
    }

    const mostUsed = this.mostUsedTool;

    return html`
      <div class="session-dashboard">
        ${session.project_id
          ? html`<a class="back-link" href="#/projects/${session.project_id}">← Back to Project</a>`
          : ''}

        <div class="title-row">
          <div>
            <h1>${session.title || this.sourceLabel(session.source)}</h1>
            <p class="session-subtitle">
              ${this.sourceLabel(session.source)}
              ${session.model ? html` • ${session.model}` : ''} •
              ${new Date(session.started_at).toLocaleString()} •
              ${Math.max(1, Math.round((session.ended_at - session.started_at) / 1000))}s
              ${session.cost_usd !== undefined ? html` • $${session.cost_usd.toFixed(4)}` : ''}
            </p>
          </div>
          <a class="transcript-link" href="#/sessions/${this.sessionId}/transcript">
            View Session Transcript
          </a>
        </div>

        ${this.error ? html`<div class="error">${this.error}</div>` : ''}

        <div class="attach-folder">
          <upload-zone
            ?disabled=${this.isAttachingFolder}
            @files-selected=${this.handleFolderAttached}
          ></upload-zone>
          <p class="attach-folder-hint">
            Drop this session's data folder (containing <code>subagents/</code>) here to fold in
            subagent token/cache/model usage.
          </p>
          ${this.isAttachingFolder ? html`<p class="notice">Attaching folder…</p>` : ''}
          ${this.attachError ? html`<div class="error">${this.attachError}</div>` : ''}
        </div>

        <div class="metrics-grid">
          <metrics-card
            label="Total Tokens"
            value="${formatCompactNumber(session.total_tokens)}"
            valueTitle="${formatFullNumber(session.total_tokens)}"
            sub="↑ ${formatCompactNumber(session.input_tokens)} in • ↓ ${formatCompactNumber(session.output_tokens)} out"
            icon="🔤"
            clickable
            @card-click=${() => this.openIndicator('tokens')}
          ></metrics-card>
          <metrics-card
            label="Context Compactions"
            value="${session.context_compactions}"
            icon="🗜️"
            clickable
            @card-click=${() => this.openIndicator('compactions')}
          ></metrics-card>
          <metrics-card
            label="Total Interactions"
            value="${session.total_turns}"
            sub="assistant turns (text + tool-only)"
            icon="💬"
            clickable
            @card-click=${() => this.openIndicator('turns')}
          ></metrics-card>
          <metrics-card
            label="Tools Used"
            value="${session.tool_executions.length}"
            sub=${mostUsed ? `most used: ${mostUsed.name} (×${mostUsed.count})` : 'no tool usage'}
            icon="🛠️"
            clickable
            @card-click=${() => this.openIndicator('tools')}
          ></metrics-card>
          <metrics-card
            label="Files Read"
            value="${session.files_read}"
            icon="📖"
            clickable
            @card-click=${() => this.openIndicator('files_read')}
          ></metrics-card>
          <metrics-card
            label="Files Written"
            value="${session.files_written}"
            icon="✍️"
            clickable
            @card-click=${() => this.openIndicator('files_written')}
          ></metrics-card>
          <metrics-card
            label="Agents / Skills"
            value="${session.agent_invocations}"
            icon="🤖"
            clickable
            @card-click=${() => this.openIndicator('agents')}
          ></metrics-card>
          ${session.tasks.length > 0
            ? html`
              <metrics-card
                label="Total Tasks"
                value="${session.tasks.length}"
                icon="📋"
                clickable
                @card-click=${() => this.openIndicator('tasks')}
              ></metrics-card>
              <metrics-card
                label="Tasks Completed"
                value="${session.tasks.filter((task) => task.status === 'completed').length}"
                sub="of ${session.tasks.length} total"
                icon="✅"
                clickable
                @card-click=${() => this.openIndicator('tasks')}
              ></metrics-card>
              <metrics-card
                label="Avg Time / Task"
                value="${formatDuration(this.avgTaskDurationMs)}"
                sub="completed tasks only"
                icon="⏱️"
                clickable
                @card-click=${() => this.openIndicator('tasks')}
              ></metrics-card>
            `
            : ''}
        </div>

        <div class="insights-grid">
          <div class="panel">
            <h3 class="panel-title">Token Usage</h3>
            <div class="stat-row">
              <div>
                <div class="stat-value" title=${formatFullNumber(session.input_tokens)}>
                  ${formatCompactNumber(session.input_tokens)}
                </div>
                <div class="stat-label">Input</div>
              </div>
              <div>
                <div class="stat-value" title=${formatFullNumber(session.output_tokens)}>
                  ${formatCompactNumber(session.output_tokens)}
                </div>
                <div class="stat-label">Output</div>
              </div>
              <div>
                <div class="stat-value" title=${formatFullNumber(session.cache_creation_tokens)}>
                  ${formatCompactNumber(session.cache_creation_tokens)}
                </div>
                <div class="stat-label">Cache Write</div>
              </div>
              <div>
                <div class="stat-value" title=${formatFullNumber(session.cache_read_tokens)}>
                  ${formatCompactNumber(session.cache_read_tokens)}
                </div>
                <div class="stat-label">Cache Read</div>
              </div>
            </div>
          </div>

          ${session.tool_executions.some((execution) => execution.result)
            ? html`
              <div class="panel">
                <h3 class="panel-title">Tool Result Tokens</h3>
                <div class="stat-row">
                  <div>
                    <div
                      class="stat-value"
                      title="${formatFullNumber(this.toolResultTokenEstimate)} tokens - estimated from tool_result content length (~4 chars/token), not an exact usage-object count"
                    >
                      ${formatCompactNumber(this.toolResultTokenEstimate)}
                    </div>
                    <div class="stat-label">Tool Output Volume (est.)</div>
                  </div>
                  <div>
                    <div class="stat-value">
                      ${this.toolResultTokenPercent === null ? '—' : `${this.toolResultTokenPercent.toFixed(1)}%`}
                    </div>
                    <div class="stat-label">of Input Volume (est.)</div>
                  </div>
                </div>
              </div>
            `
            : ''}

          ${session.models.length > 0
            ? html`
              <div class="panel">
                <h3 class="panel-title">Models Used</h3>
                <div class="usage-card-list">
                  ${session.models.map(
                    (usage) => html`
                      <div class="usage-card">
                        <div class="usage-card-title">${usage.model}</div>
                        <div class="usage-card-stats">
                          <div>
                            <div class="usage-stat-value" title=${formatFullNumber(usage.input_tokens)}>
                              ${formatCompactNumber(usage.input_tokens)}
                            </div>
                            <div class="usage-stat-label">Input</div>
                          </div>
                          <div>
                            <div class="usage-stat-value" title=${formatFullNumber(usage.output_tokens)}>
                              ${formatCompactNumber(usage.output_tokens)}
                            </div>
                            <div class="usage-stat-label">Output</div>
                          </div>
                          <div>
                            <div
                              class="usage-stat-value"
                              title=${formatFullNumber(usage.cache_creation_tokens)}
                            >
                              ${formatCompactNumber(usage.cache_creation_tokens)}
                            </div>
                            <div class="usage-stat-label">Cache W</div>
                          </div>
                          <div>
                            <div class="usage-stat-value" title=${formatFullNumber(usage.cache_read_tokens)}>
                              ${formatCompactNumber(usage.cache_read_tokens)}
                            </div>
                            <div class="usage-stat-label">Cache R</div>
                          </div>
                        </div>
                      </div>
                    `
                  )}
                </div>
              </div>
            `
            : ''}

          ${this.topTools.length > 0
            ? html`
              <div class="panel">
                <h3 class="panel-title">Most Used Tools</h3>
                <ul class="rank-list">
                  ${this.topTools.slice(0, 8).map(
                    (tool) => html`
                      <li class="rank-item">
                        <span>${tool.name}</span>
                        <span class="rank-count">×${tool.count}</span>
                      </li>
                    `
                  )}
                </ul>
              </div>
            `
            : ''}

          ${this.skillGroups.length > 0
            ? html`
              <div class="panel">
                <h3 class="panel-title">Skills Used</h3>
                <div class="skill-list">
                  ${this.skillGroups.map(
                    (group) => html`
                      <div class="skill-item">
                        <div class="skill-item-header">
                          <div class="skill-name">${group.name}</div>
                          <div class="skill-usage">Total usage: ${group.count}</div>
                        </div>
                        <div class="skill-invocations">
                          ${group.invocations.map((execution) => {
                            const params = execution.parameters
                              ? JSON.stringify(execution.parameters, null, 2)
                              : '';
                            const expanded = this.expandedSkillIds.has(execution.id);
                            return params
                              ? html`
                                <div
                                  class="skill-params ${expanded ? 'expanded' : 'preview'}"
                                  title=${params}
                                  @click=${() => this.toggleSkillParams(execution.id)}
                                >
                                  ${params}
                                </div>
                              `
                              : html`<div class="skill-params">no parameters</div>`;
                          })}
                        </div>
                      </div>
                    `
                  )}
                </div>
              </div>
            `
            : ''}

          ${this.cacheMissReasons.length > 0
            ? html`
              <div class="panel">
                <h3 class="panel-title">Cache Diagnostics</h3>
                <ul class="rank-list">
                  ${this.cacheMissReasons.map(
                    (item) => html`
                      <li class="rank-item">
                        <span>${item.reason.replaceAll('_', ' ')}</span>
                        <span class="rank-count">×${item.count}</span>
                      </li>
                    `
                  )}
                </ul>
                <a class="back-link" href="#/sessions/${this.sessionId}/indicator/diagnostics"
                  >View all diagnostics →</a
                >
              </div>
            `
            : ''}

          ${session.subagents.length > 0
            ? html`
              <div class="panel">
                <h3 class="panel-title">Subagents</h3>
                <div class="usage-card-list">
                  ${session.subagents.map(
                    (subagent) => html`
                      <div class="usage-card">
                        <div class="usage-card-header">
                          <div class="usage-card-title">${subagent.description || subagent.agent_id}</div>
                          ${subagent.agent_type ? html`<div class="usage-card-meta">${subagent.agent_type}</div>` : ''}
                        </div>
                        ${subagent.model ? html`<div class="usage-card-meta">${subagent.model}</div>` : ''}
                        <div class="usage-card-stats">
                          <div>
                            <div class="usage-stat-value" title=${formatFullNumber(subagent.total_tokens)}>
                              ${formatCompactNumber(subagent.total_tokens)}
                            </div>
                            <div class="usage-stat-label">Total</div>
                          </div>
                          <div>
                            <div
                              class="usage-stat-value"
                              title=${formatFullNumber(subagent.cache_creation_tokens)}
                            >
                              ${formatCompactNumber(subagent.cache_creation_tokens)}
                            </div>
                            <div class="usage-stat-label">Cache W</div>
                          </div>
                          <div>
                            <div
                              class="usage-stat-value"
                              title=${formatFullNumber(subagent.cache_read_tokens)}
                            >
                              ${formatCompactNumber(subagent.cache_read_tokens)}
                            </div>
                            <div class="usage-stat-label">Cache R</div>
                          </div>
                          <div>
                            <div class="usage-stat-value">${subagent.tool_call_count}</div>
                            <div class="usage-stat-label">Tools</div>
                          </div>
                        </div>
                      </div>
                    `
                  )}
                </div>
              </div>
            `
            : ''}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-dashboard': SessionDashboard;
  }
}
