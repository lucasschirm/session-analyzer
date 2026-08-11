import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { dbClient } from '../db/db-client';
import type { DashboardSession, IndicatorKey } from '../types';
import { isAgentOrSkill, isReadTool, isWriteTool } from '../workers/session-parser.worker';
import type { EventTableRow } from '../components/events-table';
import '../components/events-table';

const INDICATOR_LABELS: Record<IndicatorKey, string> = {
  tokens: 'Token Usage',
  compactions: 'Context Compactions',
  turns: 'Interactions (Turns)',
  tools: 'Tool Executions',
  files_read: 'Files Read',
  files_written: 'Files Written',
  agents: 'Agents & Skills',
};

const TOKEN_EVENT_TYPES = new Set([
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
  `;

  @property({ type: String, attribute: 'session-id' }) sessionId = '';

  @property({ type: String }) indicator = '';

  @state() private session: DashboardSession | null = null;

  @state() private isLoading = true;

  @state() private error: string | null = null;

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
        return this.toolRows(session, () => true);
      case 'files_read':
        return this.toolRows(session, (toolName) => isReadTool(toolName));
      case 'files_written':
        return this.toolRows(session, (toolName) => isWriteTool(toolName));
      case 'agents':
        return this.toolRows(session, (toolName) => isAgentOrSkill(toolName));
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
    const rows = this.buildRows(this.session, indicator);

    return html`
      <div class="indicator-details">
        <a class="back-link" href="#/sessions/${this.sessionId}">← Back to Session</a>
        <div>
          <h1>${INDICATOR_LABELS[indicator]}</h1>
          <p class="subtitle">
            ${rows.length} record${rows.length === 1 ? '' : 's'} • ${this.session.title || this.session.source}
          </p>
        </div>

        ${this.error ? html`<div class="error">${this.error}</div>` : ''}

        <events-table .events=${rows} showMetadata></events-table>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'indicator-details': IndicatorDetails;
  }
}
