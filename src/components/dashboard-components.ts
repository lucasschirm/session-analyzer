import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { DashboardSession, Project, SessionMetrics } from '../types';

/**
 * Dashboard metrics card component
 * Displays a single metric value with label
 */
@customElement('metrics-card')
export class MetricsCard extends LitElement {
  @property({ type: String }) label = '';
  @property({ type: String }) value = '';
  @property({ type: String }) icon = '';

  static styles = css`
    .card {
      background: var(--md-sys-color-surface-container, #f5f5f5);
      border-radius: 12px;
      padding: 16px;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .icon {
      font-size: 24px;
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--md-sys-color-primary-container, #e0e0e0);
      border-radius: 8px;
    }

    .content {
      flex: 1;
    }

    .value {
      font-size: 24px;
      font-weight: 600;
      color: var(--md-sys-color-on-surface, #333);
    }

    .label {
      font-size: 14px;
      color: var(--md-sys-color-on-surface-variant, #666);
    }
  `;

  render() {
    return html`
      <div class="card">
        <div class="icon">${this.icon}</div>
        <div class="content">
          <div class="value">${this.value}</div>
          <div class="label">${this.label}</div>
        </div>
      </div>
    `;
  }
}

/**
 * Session list component
 * Displays a list of sessions with basic info
 */
@customElement('session-list')
export class SessionList extends LitElement {
  @property({ type: Array }) sessions: DashboardSession[] = [];

  static styles = css`
    .container {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .session-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: var(--md-sys-color-surface, #fff);
      border: 1px solid var(--md-sys-color-outline, #e0e0e0);
      border-radius: 8px;
      cursor: pointer;
      transition: background-color 0.2s;
    }

    .session-item:hover {
      background: var(--md-sys-color-surface-container-hover, #f0f0f0);
    }

    .session-info {
      flex: 1;
    }

    .session-source {
      font-weight: 600;
      color: var(--md-sys-color-on-surface, #333);
      text-transform: capitalize;
    }

    .session-meta {
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #666);
      margin-top: 4px;
    }

    .session-tokens {
      text-align: right;
    }

    .token-count {
      font-size: 16px;
      font-weight: 600;
      color: var(--md-sys-color-primary, #1976d2);
    }

    .token-label {
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #666);
    }
  `;

  private formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleDateString();
  }

  render() {
    if (this.sessions.length === 0) {
      return html`<p>No sessions found</p>`;
    }

    return html`
      <div class="container">
        ${this.sessions.map(
          session => html`
            <div class="session-item" @click=${() => this._handleClick(session.id)}>
              <div class="session-info">
                <div class="session-source">${session.source}</div>
                <div class="session-meta">
                  ${this.formatDate(session.started_at)} • ${session.model || 'Unknown model'}
                </div>
              </div>
              <div class="session-tokens">
                <div class="token-count">${session.total_tokens.toLocaleString()}</div>
                <div class="token-label">tokens</div>
              </div>
            </div>
          `
        )}
      </div>
    `;
  }

  private _handleClick(sessionId: string) {
    this.dispatchEvent(
      new CustomEvent('session-click', {
        detail: { sessionId },
        bubbles: true,
        composed: true,
      })
    );
  }
}

/**
 * Events table component for drill-down view
 * Shows granular events for a specific session
 */
@customElement('events-table')
export class EventsTable extends LitElement {
  @property({ type: Array }) events: Array<{
    id: string;
    timestamp: number;
    event_type: string;
    description: string;
    metadata?: Record<string, unknown>;
  }> = [];

  @property({ type: Boolean }) showMetadata = false;

  static styles = css`
    .table-container {
      overflow-x: auto;
      border: 1px solid var(--md-sys-color-outline, #e0e0e0);
      border-radius: 8px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }

    th, td {
      padding: 12px 16px;
      text-align: left;
      border-bottom: 1px solid var(--md-sys-color-outline, #e0e0e0);
    }

    th {
      background: var(--md-sys-color-surface-container, #f5f5f5);
      font-weight: 600;
      color: var(--md-sys-color-on-surface-variant, #666);
    }

    tr:hover {
      background: var(--md-sys-color-surface-container-hover, #f0f0f0);
    }

    .event-type {
      font-weight: 500;
      color: var(--md-sys-color-primary, #1976d2);
    }

    .timestamp {
      font-family: monospace;
      color: var(--md-sys-color-on-surface-variant, #666);
    }

    .metadata-preview {
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: monospace;
      font-size: 12px;
    }
  `;

  private formatTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }

  render() {
    if (this.events.length === 0) {
      return html`<p>No events recorded</p>`;
    }

    return html`
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Event Type</th>
              <th>Description</th>
              ${this.showMetadata ? html`<th>Metadata</th>` : ''}
            </tr>
          </thead>
          <tbody>
            ${this.events.map(
              event => html`
                <tr>
                  <td class="timestamp">${this.formatTimestamp(event.timestamp)}</td>
                  <td class="event-type">${event.event_type}</td>
                  <td>${event.description}</td>
                  ${this.showMetadata
                    ? html`<td class="metadata-preview">
                        ${event.metadata ? JSON.stringify(event.metadata).substring(0, 50) + '...' : '-'}
                      </td>`
                    : ''}
                </tr>
              `
            )}
          </tbody>
        </table>
      </div>
    `;
  }
}

/**
 * Project selector component
 */
@customElement('project-selector')
export class ProjectSelector extends LitElement {
  @property({ type: Array }) projects: Project[] = [];
  @property({ type: String }) selectedProjectId = '';

  static styles = css`
    select {
      padding: 8px 12px;
      font-size: 14px;
      border: 1px solid var(--md-sys-color-outline, #e0e0e0);
      border-radius: 8px;
      background: var(--md-sys-color-surface, #fff);
      color: var(--md-sys-color-on-surface, #333);
      min-width: 200px;
    }
  `;

  render() {
    return html`
      <select
        @change=${(e: Event) => {
          const target = e.target as HTMLSelectElement;
          this.selectedProjectId = target.value;
          this.dispatchEvent(
            new CustomEvent('project-change', {
              detail: { projectId: target.value },
              bubbles: true,
              composed: true,
            })
          );
        }}
        .value=${this.selectedProjectId}
      >
        <option value="">Select a project</option>
        ${this.projects.map(
          project => html`
            <option value="${project.id}">${project.name} (${project.session_count} sessions)</option>
          `
        )}
      </select>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'metrics-card': MetricsCard;
    'session-list': SessionList;
    'events-table': EventsTable;
    'project-selector': ProjectSelector;
  }
}
