import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { dbClient } from '../db/db-client';
import type { DashboardSession, SubagentUsage } from '../types';
import { formatCompactNumber } from '../lib/format';
import '../components/session-transcript';

/**
 * Accent colors cycled across subagent cards/columns by index (stable
 * regardless of open/close order) so a card's color visually ties it to its
 * open column - the page's one signature element.
 */
const SUBAGENT_ACCENTS = ['#4f8cff', '#3ecf8e', '#f5a623', '#e2578e', '#8b5cf6', '#22d3ee'];

/**
 * Session Transcript page: the main session's transcript as the first
 * column, with an optional row of subagent cards above it. Clicking a card
 * opens (or closes) an additional column showing that subagent's own
 * transcript, so multiple subagent transcripts can be compared side by side
 * with the main transcript at once.
 */
@customElement('session-transcript-page')
export class SessionTranscriptPage extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .transcript-page {
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
      word-break: break-word;
    }

    .subtitle {
      margin: 4px 0 0;
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

    .subagent-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .subagent-card {
      --accent: #4f8cff;
      display: flex;
      flex-direction: column;
      gap: 4px;
      align-items: flex-start;
      min-width: 160px;
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-left: 3px solid var(--accent);
      border-radius: 8px;
      padding: 8px 14px 8px 12px;
      cursor: pointer;
      font: inherit;
      text-align: left;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      transition: background-color 0.15s ease, transform 0.1s ease;
    }

    .subagent-card:hover {
      background: var(--md-sys-color-surface-container-hover, #262d3a);
    }

    .subagent-card:active {
      transform: scale(0.98);
    }

    .subagent-card.active {
      background: var(--md-sys-color-surface-container-hover, #262d3a);
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }

    .subagent-card-title {
      font-size: 13px;
      font-weight: 600;
    }

    .subagent-card-meta {
      font-size: 11px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .subagent-card-tokens {
      font-size: 11px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--accent);
    }

    .subagent-card-hint {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .transcript-columns {
      display: flex;
      align-items: flex-start;
      gap: 16px;
      overflow-x: auto;
      padding-bottom: 8px;
    }

    .transcript-column {
      flex: 1 1 420px;
      min-width: 320px;
      max-width: 560px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      border-top: 3px solid var(--column-accent, var(--md-sys-color-outline, #2a303c));
      padding-top: 10px;
    }

    .column-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      min-height: 24px;
    }

    .column-title {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      word-break: break-word;
    }

    .column-close {
      background: transparent;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      border-radius: 6px;
      width: 24px;
      height: 24px;
      line-height: 1;
      font-size: 14px;
      cursor: pointer;
      flex-shrink: 0;
    }

    .column-close:hover {
      color: var(--md-sys-color-on-surface, #e6e9ef);
      border-color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .column-body {
      max-height: 75vh;
      overflow-y: auto;
      padding-right: 2px;
    }

    @media (max-width: 760px) {
      .transcript-columns {
        flex-direction: column;
        overflow-x: visible;
      }

      .transcript-column {
        max-width: none;
        min-width: 0;
      }

      .column-body {
        max-height: none;
      }
    }
  `;

  @property({ type: String, attribute: 'session-id' }) sessionId = '';

  @state() private session: DashboardSession | null = null;

  @state() private isLoading = true;

  @state() private error: string | null = null;

  /** Agent ids with an open column, in the order they were opened. */
  @state() private openAgentIds: string[] = [];

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

  private toggleSubagentColumn(agentId: string): void {
    this.openAgentIds = this.openAgentIds.includes(agentId)
      ? this.openAgentIds.filter((id) => id !== agentId)
      : [...this.openAgentIds, agentId];
  }

  private accentFor(agentId: string): string {
    const session = this.session;
    if (!session) return SUBAGENT_ACCENTS[0];
    const index = session.subagents.findIndex((subagent) => subagent.agent_id === agentId);
    return SUBAGENT_ACCENTS[Math.max(0, index) % SUBAGENT_ACCENTS.length];
  }

  private subagentTitle(subagent: SubagentUsage): string {
    return subagent.description || subagent.agent_id;
  }

  private sourceLabel(source: string): string {
    return source.replaceAll('_', ' ');
  }

  render() {
    const session = this.session;

    if (!session && !this.isLoading) {
      return html`
        <div class="transcript-page">
          <a class="back-link" href="#/">← Back to Projects</a>
          <p class="notice">${this.error ?? 'Session not found.'}</p>
        </div>
      `;
    }

    if (!session) {
      return html`<div class="transcript-page"><p class="notice">Loading transcript…</p></div>`;
    }

    const openSubagents = this.openAgentIds
      .map((agentId) => session.subagents.find((subagent) => subagent.agent_id === agentId))
      .filter((subagent): subagent is SubagentUsage => subagent !== undefined);

    return html`
      <div class="transcript-page">
        <a class="back-link" href="#/sessions/${this.sessionId}">← Back to Session</a>

        <div>
          <h1>Transcript — ${session.title || this.sourceLabel(session.source)}</h1>
          <p class="subtitle">
            ${session.messages.length} main message${session.messages.length === 1 ? '' : 's'}
            ${session.subagents.length > 0
              ? html` • ${session.subagents.length} subagent${session.subagents.length === 1 ? '' : 's'}`
              : ''}
          </p>
        </div>

        ${this.error ? html`<div class="error">${this.error}</div>` : ''}

        ${session.subagents.length > 0
          ? html`
            <div class="subagent-row">
              ${repeat(
                session.subagents,
                (subagent) => subagent.agent_id,
                (subagent) => {
                  const accent = this.accentFor(subagent.agent_id);
                  const isOpen = this.openAgentIds.includes(subagent.agent_id);
                  return html`
                    <button
                      class="subagent-card ${isOpen ? 'active' : ''}"
                      style="--accent: ${accent}"
                      @click=${() => this.toggleSubagentColumn(subagent.agent_id)}
                      aria-pressed=${isOpen}
                    >
                      <span class="subagent-card-title">${this.subagentTitle(subagent)}</span>
                      ${subagent.agent_type
                        ? html`<span class="subagent-card-meta">${subagent.agent_type}</span>`
                        : ''}
                      <span class="subagent-card-tokens"
                        >${formatCompactNumber(subagent.total_tokens)} tokens •
                        ${(subagent.messages ?? []).length} msgs</span
                      >
                      <span class="subagent-card-hint">${isOpen ? 'Close column' : 'Open column'}</span>
                    </button>
                  `;
                }
              )}
            </div>
          `
          : ''}

        <div class="transcript-columns">
          <div class="transcript-column">
            <div class="column-header">
              <h2 class="column-title">Main Session</h2>
            </div>
            <div class="column-body">
              <session-transcript .messages=${session.messages}></session-transcript>
            </div>
          </div>

          ${repeat(
            openSubagents,
            (subagent) => subagent.agent_id,
            (subagent) => html`
              <div class="transcript-column" style="--column-accent: ${this.accentFor(subagent.agent_id)}">
                <div class="column-header">
                  <h2 class="column-title">${this.subagentTitle(subagent)}</h2>
                  <button
                    class="column-close"
                    @click=${() => this.toggleSubagentColumn(subagent.agent_id)}
                    aria-label="Close ${this.subagentTitle(subagent)} transcript"
                  >
                    ×
                  </button>
                </div>
                <div class="column-body">
                  <session-transcript .messages=${subagent.messages ?? []}></session-transcript>
                </div>
              </div>
            `
          )}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-transcript-page': SessionTranscriptPage;
  }
}
