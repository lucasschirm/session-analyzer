import type { ProjectSessionListItem } from '@lucasschirm/sal-db';
import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { formatDateTime, formatSessionTitle } from '../lib/format';
import { navigateTo } from '../router';

/**
 * Project sessions table component.
 *
 * Displays a list of project sessions with columns:
 * - Title (clickable to view session evidence)
 * - Start date
 * - Sub agents (count)
 *
 * Supports loading, error, and empty states.
 */
@customElement('project-sessions-table')
export class ProjectSessionsTable extends LitElement {
  static styles = css`
    :host {
      display: block;
      width: 100%;
    }

    .table-container {
      width: 100%;
      overflow-x: auto;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      background: var(--md-sys-color-surface-container, #1f242e);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      text-align: left;
    }

    th,
    td {
      padding: 12px 16px;
      border-bottom: 1px solid var(--md-sys-color-outline, #2a303c);
    }

    th {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-weight: 600;
      white-space: nowrap;
      background: var(--md-sys-color-surface, #171a21);
    }

    tbody tr:last-child td {
      border-bottom: none;
    }

    tbody tr {
      transition: background-color 0.15s ease;
      cursor: pointer;
    }

    tbody tr:hover {
      background: var(--md-sys-color-surface-container-hover, #262d3a);
    }

    .col-title {
      min-width: 240px;
    }

    .col-start-date {
      min-width: 160px;
      white-space: nowrap;
    }

    .col-subagents {
      min-width: 110px;
      white-space: nowrap;
      text-align: right;
    }

    th.col-subagents {
      text-align: right;
    }

    .session-title-link {
      color: var(--md-sys-color-primary, #4f8cff);
      text-decoration: none;
      font-weight: 500;
      display: inline-block;
      max-width: 480px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      vertical-align: middle;
    }

    .session-title-link:hover {
      text-decoration: underline;
    }

    .subagents-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 24px;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
      background: var(--md-sys-color-surface, #171a21);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .subagents-badge.has-subagents {
      border-color: var(--md-sys-color-primary, #4f8cff);
      color: var(--md-sys-color-primary, #4f8cff);
      background: var(--md-sys-color-primary-container, #1c2b4a);
    }

    .loading-notice,
    .empty-state {
      padding: 32px 16px;
      text-align: center;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-size: 14px;
    }

    .error-banner {
      padding: 16px;
      background: var(--md-sys-color-error-container, #5c2626);
      color: var(--md-sys-color-on-error-container, #ffb4ab);
      border-radius: 8px;
      font-size: 13px;
    }
  `;

  @property({ type: Array }) sessions: ProjectSessionListItem[] = [];

  @property({ type: Boolean }) loading = false;

  @property({ type: String }) error: string | null = null;

  @property({ type: String }) searchQuery = '';

  private handleSessionClick(e: Event, sessionId: string): void {
    if (e instanceof MouseEvent) {
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return;
      }
    }
    e.preventDefault();
    navigateTo(`/sessions/${encodeURIComponent(sessionId)}`);
  }

  render() {
    if (this.error) {
      return html`<div class="project-sessions-table error-banner" role="alert">${this.error}</div>`;
    }

    if (this.loading && this.sessions.length === 0) {
      return html`<div class="project-sessions-table table-container"><p class="loading-notice">Loading sessions…</p></div>`;
    }

    if (this.sessions.length === 0) {
      const message = this.searchQuery
        ? `No sessions matching "${this.searchQuery}".`
        : 'No sessions found in this project.';
      return html`<div class="project-sessions-table table-container"><p class="empty-state">${message}</p></div>`;
    }

    return html`
      <div class="project-sessions-table table-container">
        <table>
          <thead>
            <tr>
              <th scope="col" class="col-title">Title</th>
              <th scope="col" class="col-start-date">Start date</th>
              <th scope="col" class="col-subagents">Sub agents</th>
            </tr>
          </thead>
          <tbody>
            ${repeat(
              this.sessions,
              (session) => session.sessionId,
              (session) => {
                const title = formatSessionTitle(session.title, session.startedAt);
                const subagentCount = session.subagentCount ?? 0;
                return html`
                  <tr @click=${(e: Event) => this.handleSessionClick(e, session.sessionId)}>
                    <td class="col-title">
                      <a
                        class="session-title-link"
                        href="#/sessions/${encodeURIComponent(session.sessionId)}"
                        title=${title}
                        @click=${(e: Event) => this.handleSessionClick(e, session.sessionId)}
                      >
                        ${title}
                      </a>
                    </td>
                    <td class="col-start-date" title=${session.startedAt ?? ''}>
                      ${formatDateTime(session.startedAt)}
                    </td>
                    <td class="col-subagents">
                      <span class="subagents-badge ${subagentCount > 0 ? 'has-subagents' : ''}">
                        ${subagentCount}
                      </span>
                    </td>
                  </tr>
                `;
              },
            )}
          </tbody>
        </table>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'project-sessions-table': ProjectSessionsTable;
  }
}
