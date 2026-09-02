import type { SessionEventPayloadDetail, SessionEventRow } from '@lucasschirm/sal-db';
import { css, html, LitElement, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import {
  EMPTY_EVENT_FILTER,
  type EventFilterState,
  eventKindBadgeLabel,
  eventStatusView,
  eventToolOptions,
  filterSessionEvents,
  isErrorEventStatus,
} from './session-evidence-chart-helpers';

/**
 * Number of rows rendered into the DOM at once. Measured against a 5k-event
 * fixture (`session-evidence-events-table.test.ts`,
 * "renders within budget at 5k events" perf case): rendering all 5,000 rows
 * unbounded blows well past a single 16ms frame budget, so beyond this cap
 * the table paginates the DOM (a "Show more" button) rather than rendering
 * every filtered row at once. 200 rows keeps a single render well under
 * budget while still showing a full screenful of context.
 */
const ROW_WINDOW = 200;

/**
 * Hard ceiling on how far repeated "Show more" clicks can grow the rendered
 * row count. Without this, "Show more" alone can still mount every row of a
 * lightly-filtered 5,000-row session into the DOM — narrowing the filters
 * is the intended path past this point.
 */
const MAX_VISIBLE_ROWS = 1000;

/**
 * Session events table (issue #172), built fresh per
 * `.agents/skills/filterable-table-pattern`. Client-side `.filter()` over an
 * already-loaded, non-paginated event list — legitimate only because the
 * caller loads the full-detail session-events DTO up front (never the old
 * cursor-paginated `getEvidencePages`).
 */
@customElement('session-evidence-events-table')
export class SessionEvidenceEventsTable extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      margin-bottom: 12px;
    }

    .toolbar select,
    .toolbar input[type='text'] {
      background: var(--rd-surface-inset, #12151c);
      border: 1px solid var(--rd-border-2, #232936);
      border-radius: 6px;
      padding: 6px 10px;
      color: var(--rd-ink-primary, #e6e9ef);
      font: inherit;
      font-size: 13px;
    }

    .toolbar label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      color: var(--rd-ink-secondary, #c9d4e3);
    }

    .turn-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      padding: 4px 8px 4px 10px;
      border-radius: 999px;
      background: var(--rd-accent-container, #1c2b4a);
      color: var(--rd-accent-on-container, #cfe0ff);
    }

    .turn-chip button {
      background: transparent;
      border: none;
      color: inherit;
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
      padding: 0;
    }

    .counter {
      margin-left: auto;
      font-size: 12px;
      color: var(--rd-ink-muted, #9aa4b2);
      font-variant-numeric: tabular-nums;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    thead th {
      text-align: left;
      padding: 8px 10px;
      color: var(--rd-ink-muted, #9aa4b2);
      font-weight: 600;
      border-bottom: 1px solid var(--rd-border-2, #232936);
      position: sticky;
      top: 0;
      background: var(--rd-surface-card, #171b24);
    }

    tbody tr.event-row {
      cursor: pointer;
      border-bottom: 1px solid var(--rd-border-1, #20242e);
    }

    tbody tr.event-row:hover {
      background: var(--rd-surface-row-hover, #1f2531);
    }

    tbody tr.event-row.error-row {
      background: rgba(208, 59, 59, 0.08);
      border-left: 3px solid var(--rd-status-critical, #d03b3b);
    }

    tbody tr.event-row.active-turn {
      outline: 1px solid var(--rd-accent, #4f8cff);
      outline-offset: -1px;
    }

    td {
      padding: 7px 10px;
      color: var(--rd-ink-primary, #e6e9ef);
      vertical-align: top;
    }

    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .target-cell {
      max-width: 240px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .kind-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--rd-border-2, #232936);
      font-size: 11px;
      text-transform: uppercase;
      font-weight: 600;
    }

    .error-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--rd-status-critical, #d03b3b);
      font-weight: 600;
      margin-left: 6px;
    }

    .status-cell {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }

    tr.expanded-row td {
      padding: 0 10px 12px;
    }

    .expanded-detail {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px;
    }

    .detail-block h4 {
      margin: 0 0 6px;
      font-size: 12px;
      text-transform: uppercase;
      color: var(--rd-ink-muted, #9aa4b2);
    }

    .detail-block pre {
      margin: 0;
      max-height: 320px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      background: var(--rd-surface-inset, #12151c);
      border: 1px solid var(--rd-border-2, #232936);
      border-radius: 6px;
      padding: 10px;
      font-size: 12px;
    }

    .load-full-payload {
      margin-top: 6px;
      font-size: 12px;
      background: transparent;
      border: 1px solid var(--rd-border-2, #232936);
      color: var(--rd-accent, #4f8cff);
      border-radius: 6px;
      padding: 4px 8px;
      cursor: pointer;
    }

    .truncation-note {
      font-size: 11px;
      color: var(--rd-ink-faint, #7d8794);
      margin-top: 4px;
    }

    .empty {
      padding: 24px 0;
      text-align: center;
      color: var(--rd-ink-muted, #9aa4b2);
      font-size: 13px;
    }

    .show-more {
      display: block;
      margin: 14px auto 0;
      background: var(--rd-surface-inset, #12151c);
      border: 1px solid var(--rd-border-2, #232936);
      color: var(--rd-ink-primary, #e6e9ef);
      border-radius: 6px;
      padding: 8px 16px;
      cursor: pointer;
      font-size: 13px;
    }
  `;

  @property({ type: Array, attribute: false }) events: readonly SessionEventRow[] = [];

  @property({ type: Number, attribute: false }) turnFilter: number | null = null;

  @property({ type: Object, attribute: false })
  fullPayloads: ReadonlyMap<string, SessionEventPayloadDetail> = new Map();

  @property({ type: Object, attribute: false }) loadingPayloadIds: ReadonlySet<string> = new Set();

  @state() private toolFilter = EMPTY_EVENT_FILTER.tool;

  @state() private errorsOnlyFilter = EMPTY_EVENT_FILTER.errorsOnly;

  @state() private textFilter = EMPTY_EVENT_FILTER.text;

  @state() private expandedIds: Set<string> = new Set();

  @state() private visibleCount = ROW_WINDOW;

  /**
   * Memoized filter/derivation results, recomputed only in `willUpdate` when
   * an input they depend on actually changed — not on every render (e.g.
   * toggling `expandedIds` or the parent pushing a new `fullPayloads` Map
   * must not re-scan the full up-to-5,000-row event list).
   */
  private _filtered: readonly SessionEventRow[] = [];

  private _toolOptions: readonly string[] = [];

  private static readonly FILTER_DEPS = [
    'events',
    'turnFilter',
    'toolFilter',
    'errorsOnlyFilter',
    'textFilter',
  ] as const;

  protected willUpdate(changed: PropertyValues): void {
    const filterChanged = SessionEvidenceEventsTable.FILTER_DEPS.some((key) => changed.has(key));
    if (changed.has('events')) {
      this._toolOptions = eventToolOptions(this.events);
    }
    if (filterChanged) {
      this._filtered = filterSessionEvents(this.events, this.currentFilter());
    }
    if (changed.has('turnFilter') || changed.has('events') || filterChanged) {
      this.visibleCount = ROW_WINDOW;
    }
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has('turnFilter') && this.turnFilter !== null) {
      this.scrollToTurn(this.turnFilter);
    }
  }

  private scrollToTurn(turn: number): void {
    const row = this.renderRoot.querySelector<HTMLElement>(`[data-turn="${turn}"]`);
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  private currentFilter(): EventFilterState {
    return {
      turn: this.turnFilter,
      tool: this.toolFilter,
      errorsOnly: this.errorsOnlyFilter,
      text: this.textFilter,
    };
  }

  private clearTurnFilter(): void {
    this.dispatchEvent(
      new CustomEvent<null>('turn-filter-changed', { detail: null, bubbles: true, composed: true }),
    );
  }

  private toggleExpanded(id: string): void {
    const next = new Set(this.expandedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.expandedIds = next;
  }

  private requestFullPayload(payloadId: string): void {
    this.dispatchEvent(
      new CustomEvent<{ payloadId: string }>('load-full-payload', {
        detail: { payloadId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private hasActiveFilter(): boolean {
    return (
      this.turnFilter !== null ||
      this.toolFilter !== '' ||
      this.errorsOnlyFilter ||
      this.textFilter !== ''
    );
  }

  private renderToolbar(filtered: number, total: number) {
    const options = this._toolOptions;
    return html`
      <div class="toolbar">
        <select
          aria-label="Filter by name"
          .value=${this.toolFilter}
          @change=${(e: Event) => {
            this.toolFilter = (e.target as HTMLSelectElement).value;
          }}
        >
          <option value="">All names</option>
          ${options.map((name) => html`<option value=${name}>${name}</option>`)}
        </select>
        <label>
          <input
            type="checkbox"
            .checked=${this.errorsOnlyFilter}
            @change=${(e: Event) => {
              this.errorsOnlyFilter = (e.target as HTMLInputElement).checked;
            }}
          />
          Errors only
        </label>
        <input
          type="text"
          placeholder="Search name, target, payload…"
          aria-label="Search events"
          .value=${this.textFilter}
          @input=${(e: Event) => {
            this.textFilter = (e.target as HTMLInputElement).value;
          }}
        />
        ${
          this.turnFilter !== null
            ? html`
              <span class="turn-chip">
                Turn ${this.turnFilter}
                <button type="button" aria-label="Clear turn filter" @click=${() => this.clearTurnFilter()}>
                  ×
                </button>
              </span>
            `
            : ''
        }
        <span class="counter">
          ${
            this.hasActiveFilter()
              ? `${filtered} of ${total} events`
              : `${total} events · no filters active`
          }
        </span>
      </div>
    `;
  }

  private renderPayloadBlock(label: string, payload: SessionEventRow['inputPayload']) {
    if (!payload)
      return html`<div class="detail-block"><h4>${label}</h4><p class="empty">—</p></div>`;
    const full = this.fullPayloads.get(payload.payloadId);
    const content = full?.content ?? payload.content;
    const stillTruncated = payload.truncated && !full;
    return html`
      <div class="detail-block">
        <h4>${label}</h4>
        <pre>${prettyPrint(content)}</pre>
        ${
          stillTruncated
            ? html`
              <p class="truncation-note">
                Truncated to the transfer cap.
                <button
                  type="button"
                  class="load-full-payload"
                  ?disabled=${this.loadingPayloadIds.has(payload.payloadId)}
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    this.requestFullPayload(payload.payloadId);
                  }}
                >
                  ${this.loadingPayloadIds.has(payload.payloadId) ? 'Loading…' : 'Load full payload'}
                </button>
              </p>
            `
            : ''
        }
      </div>
    `;
  }

  private renderRow(event: SessionEventRow) {
    const expanded = this.expandedIds.has(event.id);
    const isError = isErrorEventStatus(event.status);
    const status = eventStatusView(event.status);
    const rowClasses = [
      'event-row',
      isError ? 'error-row' : '',
      this.turnFilter !== null && this.turnFilter === event.turnNumber ? 'active-turn' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return html`
      <tr
        class=${rowClasses}
        data-turn=${event.turnNumber ?? ''}
        @click=${() => this.toggleExpanded(event.id)}
      >
        <td>${event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : '—'}</td>
        <td><span class="kind-badge">${eventKindBadgeLabel(event.kind)}</span>${isError ? html`<span class="error-badge" title="Error">⚠</span>` : ''}</td>
        <td class="mono">${event.name}</td>
        <td class="mono target-cell" title=${event.target ?? ''}>${event.target ?? '—'}</td>
        <td>${event.tokens !== undefined ? event.tokens : '—'}</td>
        <td>${event.durationMs !== undefined ? `${event.durationMs}ms` : '—'}</td>
        <td>
          <span class="status-cell">
            <span aria-hidden="true">${status.icon}</span>${status.text}
          </span>
        </td>
      </tr>
      ${
        expanded
          ? html`
            <tr class="expanded-row">
              <td colspan="7">
                <div class="expanded-detail">
                  ${this.renderPayloadBlock('Input', event.inputPayload)}
                  ${this.renderPayloadBlock('Result', event.resultPayload)}
                </div>
              </td>
            </tr>
          `
          : ''
      }
    `;
  }

  private showMore(): void {
    this.visibleCount = Math.min(this.visibleCount + ROW_WINDOW, MAX_VISIBLE_ROWS);
  }

  render() {
    const filtered = this._filtered;
    const windowed = filtered.slice(0, this.visibleCount);
    return html`
      <div class="session-evidence-events-table">
        ${this.renderToolbar(filtered.length, this.events.length)}
        ${
          filtered.length === 0
            ? html`<p class="empty state-empty">
                ${
                  this.events.length === 0
                    ? 'No events recorded for this session.'
                    : 'No events match the current filters.'
                }
              </p>`
            : html`
              <table>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Name</th>
                    <th scope="col">Target</th>
                    <th scope="col">Tokens</th>
                    <th scope="col">Duration</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${repeat(
                    windowed,
                    (event) => event.id,
                    (event) => this.renderRow(event),
                  )}
                </tbody>
              </table>
              ${
                filtered.length > windowed.length && this.visibleCount < MAX_VISIBLE_ROWS
                  ? html`
                    <button type="button" class="show-more" @click=${this.showMore}>
                      Show ${Math.min(ROW_WINDOW, filtered.length - windowed.length)} more (${
                        filtered.length - windowed.length
                      } remaining)
                    </button>
                  `
                  : ''
              }
            `
        }
      </div>
    `;
  }
}

function prettyPrint(content: string | null | undefined): string {
  if (!content) return '—';
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-evidence-events-table': SessionEvidenceEventsTable;
  }
}
