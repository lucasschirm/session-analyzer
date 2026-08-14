import { css, html, LitElement, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { dbClient } from '../db/db-client';
import { formatCompactNumber } from '../lib/format';
import type { DashboardSession, SubagentUsage, TranscriptMessage } from '../types';
import '../components/session-transcript';

/**
 * Accent colors cycled across subagent cards/columns by index (stable
 * regardless of open/close order) so a card's color visually ties it to its
 * open column - the page's one signature element.
 */
const SUBAGENT_ACCENTS = ['#4f8cff', '#3ecf8e', '#f5a623', '#e2578e', '#8b5cf6', '#22d3ee'];

/**
 * Session Transcript page: the main session's transcript, with subagent
 * cards rendered inline at the point in the conversation each subagent was
 * launched (by comparing each `SubagentUsage.started_at` against the main
 * transcript's message timestamps - Claude Code doesn't record an exact
 * tool_use <-> subagent-transcript link, so this is a chronological
 * best-effort placement).
 *
 * At most one subagent transcript is open at a time, driven entirely by the
 * `:agentId` route segment (`#/sessions/:sessionId/transcript/:agentId`) -
 * clicking a card navigates there, splitting the page into two columns;
 * with no agentId the page renders a single full-width column, matching the
 * width of every other page.
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

    .transcript-columns {
      display: flex;
      align-items: flex-start;
      gap: 16px;
    }

    .transcript-column {
      /* Alone (the default): fills the full page width, same as every
         other page. Split with a subagent column: the two share it evenly. */
      flex: 1 1 0;
      min-width: 0;
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
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      border-radius: 6px;
      width: 24px;
      height: 24px;
      line-height: 1;
      font-size: 14px;
      text-decoration: none;
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
      }

      .column-body {
        max-height: none;
      }
    }
  `;

  @property({ type: String, attribute: 'session-id' }) sessionId = '';

  /** The subagent whose transcript is open, from the `:agentId` route segment - empty when none is open. */
  @property({ type: String, attribute: 'agent-id' }) agentId = '';

  @state() private session: DashboardSession | null = null;

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

  /**
   * Groups subagents by the main-transcript message they should render
   * after: the latest message at or before the subagent's own `started_at`.
   * There's no exact tool_use <-> subagent link in the data, so this is a
   * chronological best-effort placement - "when in the conversation they
   * were called".
   */
  private subagentPlacements(session: DashboardSession): Map<string, SubagentUsage[]> {
    const placements = new Map<string, SubagentUsage[]>();
    if (session.messages.length === 0) return placements;

    const sortedMessages = [...session.messages].sort((a, b) => a.timestamp - b.timestamp);
    const sortedSubagents = [...session.subagents].sort(
      (a, b) => (a.started_at ?? 0) - (b.started_at ?? 0),
    );

    for (const subagent of sortedSubagents) {
      const startedAt = subagent.started_at ?? 0;
      let anchor = sortedMessages[0];
      for (const message of sortedMessages) {
        if (message.timestamp <= startedAt) anchor = message;
        else break;
      }
      const list = placements.get(anchor.id) ?? [];
      list.push(subagent);
      placements.set(anchor.id, list);
    }

    return placements;
  }

  private renderSubagentCard(subagent: SubagentUsage): TemplateResult {
    const accent = this.accentFor(subagent.agent_id);
    const isOpen = this.agentId === subagent.agent_id;
    const href = isOpen
      ? `#/sessions/${this.sessionId}/transcript`
      : `#/sessions/${this.sessionId}/transcript/${subagent.agent_id}`;

    return html`
      <a
        class="subagent-card ${isOpen ? 'active' : ''}"
        style="--accent: ${accent}"
        href=${href}
        aria-pressed=${isOpen}
      >
        <span class="subagent-card-title">${this.subagentTitle(subagent)}</span>
        ${subagent.agent_type ? html`<span class="subagent-card-meta">${subagent.agent_type}</span>` : ''}
        <span class="subagent-card-tokens"
          >${formatCompactNumber(subagent.total_tokens)} tokens •
          ${(subagent.messages ?? []).length} msgs</span
        >
        <span class="subagent-card-hint">${isOpen ? 'Close column' : 'Open column'}</span>
      </a>
    `;
  }

  private renderInlineSubagents(
    placements: Map<string, SubagentUsage[]>,
    message: TranscriptMessage,
  ): TemplateResult | string {
    const subagents = placements.get(message.id);
    if (!subagents || subagents.length === 0) return '';
    return html`
      <div class="subagent-row">
        ${repeat(
          subagents,
          (subagent) => subagent.agent_id,
          (subagent) => this.renderSubagentCard(subagent),
        )}
      </div>
    `;
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

    const openSubagent = this.agentId
      ? session.subagents.find((subagent) => subagent.agent_id === this.agentId)
      : undefined;
    const placements = this.subagentPlacements(session);

    return html`
      <div class="transcript-page">
        <a class="back-link" href="#/sessions/${this.sessionId}">← Back to Session</a>

        <div>
          <h1>Transcript — ${session.title || this.sourceLabel(session.source)}</h1>
          <p class="subtitle">
            ${session.messages.length} main message${session.messages.length === 1 ? '' : 's'}
            ${
              session.subagents.length > 0
                ? html` • ${session.subagents.length} subagent${session.subagents.length === 1 ? '' : 's'}`
                : ''
            }
          </p>
        </div>

        ${this.error ? html`<div class="error">${this.error}</div>` : ''}

        <div class="transcript-columns">
          <div class="transcript-column">
            <div class="column-header">
              <h2 class="column-title">Main Session</h2>
            </div>
            <div class="column-body">
              <session-transcript
                .messages=${session.messages}
                .renderAfter=${(message: TranscriptMessage) => this.renderInlineSubagents(placements, message)}
              ></session-transcript>
            </div>
          </div>

          ${
            openSubagent
              ? html`
              <div class="transcript-column" style="--column-accent: ${this.accentFor(openSubagent.agent_id)}">
                <div class="column-header">
                  <h2 class="column-title">${this.subagentTitle(openSubagent)}</h2>
                  <a
                    class="column-close"
                    href="#/sessions/${this.sessionId}/transcript"
                    aria-label="Close ${this.subagentTitle(openSubagent)} transcript"
                  >
                    ×
                  </a>
                </div>
                <div class="column-body">
                  <session-transcript .messages=${openSubagent.messages ?? []}></session-transcript>
                </div>
              </div>
            `
              : ''
          }
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
