import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import type { DashboardSession } from '../types';

/**
 * Session list.
 *
 * Renders sessions (expected sorted by date descending) as clickable rows and
 * dispatches `session-click` with the selected session id.
 */
@customElement('session-list')
export class SessionList extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .session-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .session-item {
      width: 100%;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      background: var(--md-sys-color-surface, #171a21);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      cursor: pointer;
      color: inherit;
      font: inherit;
      text-align: left;
      transition: background-color 0.15s ease;
    }

    .session-item:hover {
      background: var(--md-sys-color-surface-container-hover, #262d3a);
    }

    .session-item:focus-visible {
      outline: 2px solid var(--md-sys-color-primary, #4f8cff);
      outline-offset: 2px;
    }

    .session-info {
      flex: 1;
      min-width: 0;
    }

    .session-title {
      font-weight: 600;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .session-meta {
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      margin-top: 4px;
    }

    .session-tokens {
      text-align: right;
      flex-shrink: 0;
    }

    .token-count {
      font-size: 16px;
      font-weight: 700;
      color: var(--md-sys-color-primary, #4f8cff);
    }

    .token-label {
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .empty {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      padding: 24px;
      text-align: center;
      border: 1px dashed var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
    }
  `;

  @property({ type: Array }) sessions: DashboardSession[] = [];

  private formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }

  private sourceLabel(session: DashboardSession): string {
    return session.source.replaceAll('_', ' ');
  }

  private handleSessionClick(sessionId: string): void {
    this.dispatchEvent(
      new CustomEvent('session-click', {
        detail: { sessionId },
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    if (this.sessions.length === 0) {
      return html`<div class="session-list"><p class="empty">No sessions found</p></div>`;
    }

    return html`
      <div class="session-list">
        ${repeat(
          this.sessions,
          (session) => session.id,
          (session) => html`
            <button
              class="session-item"
              type="button"
              @click=${() => this.handleSessionClick(session.id)}
            >
              <div class="session-info">
                <div class="session-title">${session.title || this.sourceLabel(session)}</div>
                <div class="session-meta">
                  ${this.sourceLabel(session)} • ${this.formatDate(session.started_at)}
                  ${session.model ? html` • ${session.model}` : ''}
                </div>
              </div>
              <div class="session-tokens">
                <div class="token-count">${session.total_tokens.toLocaleString()}</div>
                <div class="token-label">tokens</div>
              </div>
            </button>
          `
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-list': SessionList;
  }
}
