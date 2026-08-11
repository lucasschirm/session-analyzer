import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { dbClient } from '../db/db-client';
import { navigateTo } from '../router';
import type { DashboardSession, IndicatorKey } from '../types';
import '../components/metrics-card';
import '../components/session-transcript';

/**
 * Session Dashboard: the primary analytics view for an uploaded session.
 *
 * Bold metric cards across the top - every card routes to the Indicator
 * Details page for its metric. Below, a toggleable chat-like transcript of
 * the user/assistant messages (markdown rendered + sanitized).
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

    button.transcript-toggle {
      background: var(--md-sys-color-primary, #4f8cff);
      color: #fff;
      border: none;
      padding: 10px 18px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      flex-shrink: 0;
    }

    button.transcript-toggle:hover {
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
  `;

  @property({ type: String, attribute: 'session-id' }) sessionId = '';

  @state() private session: DashboardSession | null = null;

  @state() private showTranscript = false;

  @state() private isLoading = true;

  @state() private error: string | null = null;

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

  private openIndicator(indicator: IndicatorKey): void {
    navigateTo(`/sessions/${this.sessionId}/indicator/${indicator}`);
  }

  private toggleTranscript(): void {
    this.showTranscript = !this.showTranscript;
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
          <button class="transcript-toggle" @click=${this.toggleTranscript}>
            ${this.showTranscript ? 'Hide Session Transcript' : 'View Session Transcript'}
          </button>
        </div>

        ${this.error ? html`<div class="error">${this.error}</div>` : ''}

        <div class="metrics-grid">
          <metrics-card
            label="Total Tokens"
            value="${session.total_tokens.toLocaleString()}"
            sub="↑ ${session.input_tokens.toLocaleString()} in • ↓ ${session.output_tokens.toLocaleString()} out"
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
            sub="conversation turns"
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
        </div>

        ${this.showTranscript
          ? html`
            <h2>Session Transcript</h2>
            <session-transcript .messages=${session.messages}></session-transcript>
          `
          : ''}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-dashboard': SessionDashboard;
  }
}
