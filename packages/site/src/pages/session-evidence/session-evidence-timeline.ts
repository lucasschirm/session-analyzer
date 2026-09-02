import type { SessionEventRow, TurnTimeline } from '@lucasschirm/sal-db';
import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { cardSurfaceStyles } from '../../components/analytics/card-surface-styles';
import {
  buildTimelineSegmentViews,
  timelineBandColor,
  timelineBandLabel,
} from './session-evidence-chart-helpers';

const LEGEND_KINDS = ['user', 'assistant', 'invocation', 'sub_agent'] as const;

/**
 * Turn timeline card (issue #172): a horizontal proportional strip whose
 * segment widths sum to 100% of the session's wall-clock duration, colored
 * by the DTO's recorded classification. Clicking a segment dispatches
 * `timeline-segment-click` with the segment's turn number so the page can
 * scroll the events table and apply a turn filter chip.
 */
@customElement('session-evidence-timeline')
export class SessionEvidenceTimeline extends LitElement {
  static styles = [
    cardSurfaceStyles,
    css`
    :host {
      display: block;
    }

    .session-evidence-timeline {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    h2 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      color: var(--rd-ink-primary, #e6e9ef);
    }

    .strip {
      display: flex;
      width: 100%;
      height: 28px;
      gap: 2px;
      border-radius: 6px;
      overflow: hidden;
    }

    .segment {
      height: 100%;
      min-width: 2px;
      border: none;
      cursor: pointer;
      padding: 0;
      opacity: 0.85;
      transition: opacity 0.1s ease, outline-color 0.1s ease;
    }

    .segment:hover,
    .segment.active {
      opacity: 1;
      outline: 2px solid var(--rd-ink-primary, #e6e9ef);
      outline-offset: -2px;
    }

    .axis {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: var(--rd-ink-muted, #9aa4b2);
      font-variant-numeric: tabular-nums;
    }

    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      font-size: 12px;
      color: var(--rd-ink-secondary, #c9d4e3);
    }

    .legend-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .legend-swatch {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      flex-shrink: 0;
    }

    .empty {
      font-size: 13px;
      color: var(--rd-ink-muted, #9aa4b2);
    }
    `,
  ];

  @property({ type: Object, attribute: false }) timeline: TurnTimeline | null = null;

  @property({ type: Array, attribute: false }) events: readonly SessionEventRow[] = [];

  @property({ type: Number }) activeTurn: number | null = null;

  private handleSegmentClick(turnNumber: number | undefined): void {
    if (turnNumber === undefined) return;
    this.dispatchEvent(
      new CustomEvent<{ turn: number }>('timeline-segment-click', {
        detail: { turn: turnNumber },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private renderAxis(totalDurationMs: number) {
    const midMs = totalDurationMs / 2;
    return html`
      <div class="axis">
        <span>0:00</span>
        <span>${formatAxisMs(midMs)}</span>
        <span>${formatAxisMs(totalDurationMs)}</span>
      </div>
    `;
  }

  private renderLegend() {
    return html`
      <div class="legend" aria-hidden="true">
        ${LEGEND_KINDS.map(
          (kind) => html`
            <span class="legend-item">
              <span
                class="legend-swatch"
                style="background: ${timelineBandColor(kind)}"
              ></span>
              ${timelineBandLabel(kind)}
            </span>
          `,
        )}
      </div>
    `;
  }

  render() {
    if (!this.timeline?.totalDurationMs) {
      return html`
        <div class="card-surface session-evidence-timeline">
          <h2>Turn timeline</h2>
          <p class="empty state-empty">No timestamped turn evidence available yet.</p>
        </div>
      `;
    }

    const views = buildTimelineSegmentViews(this.timeline, this.events);
    if (views.length === 0) {
      return html`
        <div class="card-surface session-evidence-timeline">
          <h2>Turn timeline</h2>
          <p class="empty state-empty">No timestamped turn evidence available yet.</p>
        </div>
      `;
    }

    return html`
      <div class="card-surface session-evidence-timeline">
        <h2>Turn timeline</h2>
        <div class="strip" role="list" aria-label="Turn timeline">
          ${repeat(
            views,
            (view) => view.key,
            (view) => html`
              <button
                type="button"
                class="segment ${this.activeTurn !== null && this.activeTurn === view.turnNumber ? 'active' : ''}"
                role="listitem"
                style="width: ${view.widthPercent}%; background: ${view.color}"
                title=${view.tooltip}
                aria-label=${view.tooltip}
                @click=${() => this.handleSegmentClick(view.turnNumber)}
              ></button>
            `,
          )}
        </div>
        ${this.renderAxis(this.timeline.totalDurationMs)}
        ${this.renderLegend()}
      </div>
    `;
  }
}

function formatAxisMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

declare global {
  interface HTMLElementTagNameMap {
    'session-evidence-timeline': SessionEvidenceTimeline;
  }
}
