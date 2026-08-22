import { css, html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { formatCompactNumber, formatFullNumber } from '../lib/format';
import { type SyncManagerSnapshot, syncManager } from '../sync/sync-manager';
import type { DashboardSession, Project } from '../types';
import './session-sync-chip';
import './session-sync-error-modal';

/**
 * Session list.
 *
 * Renders sessions (expected sorted by date descending) as clickable rows and
 * dispatches `session-click` with the selected session id.
 *
 * When a `project` is supplied, each row also shows a `session-sync-chip`
 * reflecting the current sync state and opens the error modal on failed
 * sessions.
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

    .session-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }
  `;

  @property({ type: Array }) sessions: DashboardSession[] = [];

  @property({ type: Object }) project: Project | null = null;

  @state() private syncSnapshot: SyncManagerSnapshot | null = null;

  @state() private errorModalOpen = false;

  @state() private errorSession: DashboardSession | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.syncSnapshot = syncManager.getSnapshot();
    syncManager.addEventListener('change', this.handleSyncChange);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    syncManager.removeEventListener('change', this.handleSyncChange);
  }

  private handleSyncChange = (event: Event): void => {
    this.syncSnapshot = (event as CustomEvent<SyncManagerSnapshot>).detail;
  };

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
      }),
    );
  }

  private syncStatusFor(session: DashboardSession): string {
    const project = this.project;
    if (!project?.readable_id || !session.sync_session_id) return session.sync_status ?? '';

    const live = this.syncSnapshot?.sessions.find(
      (s) => s.projectId === project.readable_id && s.sessionId === session.sync_session_id,
    );
    return live?.status ?? session.sync_status ?? '';
  }

  private openErrorModal(session: DashboardSession): void {
    this.errorSession = session;
    this.errorModalOpen = true;
  }

  private closeErrorModal(): void {
    this.errorModalOpen = false;
    this.errorSession = null;
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
                <div class="session-row">
                  <div class="session-title">${session.title || this.sourceLabel(session)}</div>
                  ${
                    this.project && (session.sync_status || session.sync_session_id)
                      ? html`
                        <session-sync-chip
                          .status=${this.syncStatusFor(session)}
                          .details=${session.sync_details ?? ''}
                          @chip-click=${(event: Event) => {
                            event.stopPropagation();
                            this.openErrorModal(session);
                          }}
                        ></session-sync-chip>
                      `
                      : ''
                  }
                </div>
                <div class="session-meta">
                  ${this.sourceLabel(session)} • ${this.formatDate(session.started_at)}
                  ${session.model ? html` • ${session.model}` : ''}
                </div>
              </div>
              <div class="session-tokens">
                <div class="token-count" title=${formatFullNumber(session.total_tokens)}>
                  ${formatCompactNumber(session.total_tokens)}
                </div>
                <div class="token-label">tokens</div>
              </div>
            </button>
          `,
        )}
      </div>

      ${
        this.errorSession && this.project
          ? html`
            <session-sync-error-modal
              .open=${this.errorModalOpen}
              .connectionId=${this.project.connection_id ?? ''}
              .projectId=${this.project.readable_id ?? ''}
              .sessionId=${this.errorSession.sync_session_id ?? ''}
              .syncDetails=${this.errorSession.sync_details ?? ''}
              .status=${this.errorSession.sync_status ?? ''}
              @modal-close=${this.closeErrorModal}
            ></session-sync-error-modal>
          `
          : ''
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-list': SessionList;
  }
}
