import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

export interface EventTableRow {
  id: string;
  timestamp: number;
  event_type: string;
  description: string;
  metadata?: Record<string, unknown>;
}

/**
 * Events table for drill-down views.
 *
 * Shows granular events (timestamp, type, description, optional metadata)
 * that make up a metric on the Indicator Details page.
 */
@customElement('events-table')
export class EventsTable extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .events-table {
      overflow-x: auto;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      background: var(--md-sys-color-surface, #171a21);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }

    th,
    td {
      padding: 10px 16px;
      text-align: left;
      border-bottom: 1px solid var(--md-sys-color-outline, #2a303c);
      vertical-align: top;
    }

    th {
      background: var(--md-sys-color-surface-container, #1f242e);
      font-weight: 600;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      position: sticky;
      top: 0;
    }

    tr:last-child td {
      border-bottom: none;
    }

    tbody tr:hover {
      background: var(--md-sys-color-surface-container-hover, #262d3a);
    }

    .event-type {
      font-weight: 600;
      color: var(--md-sys-color-primary, #4f8cff);
      white-space: nowrap;
    }

    .timestamp {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      white-space: nowrap;
    }

    .description {
      color: var(--md-sys-color-on-surface, #e6e9ef);
      word-break: break-word;
    }

    .metadata-preview {
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .empty {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      padding: 24px;
      text-align: center;
    }
  `;

  @property({ type: Array }) events: EventTableRow[] = [];

  @property({ type: Boolean }) showMetadata = false;

  private formatTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }

  private metadataPreview(metadata: Record<string, unknown> | undefined): string {
    if (!metadata) return '-';
    const json = JSON.stringify(metadata);
    return json.length > 80 ? `${json.substring(0, 80)}…` : json;
  }

  render() {
    if (this.events.length === 0) {
      return html`<div class="events-table"><p class="empty">No events recorded</p></div>`;
    }

    return html`
      <div class="events-table">
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
            ${repeat(
              this.events,
              (event) => event.id,
              (event) => html`
                <tr>
                  <td class="timestamp">${this.formatTimestamp(event.timestamp)}</td>
                  <td class="event-type">${event.event_type}</td>
                  <td class="description">${event.description}</td>
                  ${this.showMetadata
                    ? html`<td class="metadata-preview">${this.metadataPreview(event.metadata)}</td>`
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

declare global {
  interface HTMLElementTagNameMap {
    'events-table': EventsTable;
  }
}
