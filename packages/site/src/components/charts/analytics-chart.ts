import { css, html, LitElement, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import './echarts-base';
import { toEChartsOption } from './chart-helpers';
import type { ChartSeries, ChartState, EChartsCoreOption } from './chart-types';
import { textualSummary } from './chart-types';

/**
 * Reusable analytics chart component.
 *
 * Receives a ChartSeries DTO (no SQL, no metric formulas) and delegates
 * rendering to echarts-base. Provides keyboard focus, a textual summary,
 * tabular fallback, and all documented chart states.
 */
@customElement('analytics-chart')
export class AnalyticsChart extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .analytics-chart {
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 12px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .chart-title-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
      flex-wrap: wrap;
    }

    .chart-title {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .summary-toggle {
      background: none;
      border: none;
      padding: 0;
      font-size: 13px;
      font-weight: 400;
      color: var(--md-sys-color-primary, #4f8cff);
      cursor: pointer;
      text-decoration: none;
    }

    .summary-toggle:hover {
      text-decoration: underline;
    }

    .chart-description {
      margin: 0;
      font-size: 13px;
      line-height: 1.5;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .chart-summary {
      font-size: 13px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      margin: 0;
    }
  `;

  @property({ type: Object, attribute: false }) series: ChartSeries | null = null;

  @property({ type: String }) state: ChartState | null = null;

  @property({ type: String }) title = '';

  @property({ type: String }) description = '';

  /** Passed through to `echarts-base` to override the default empty-state copy. */
  @property({ type: String }) emptyMessage = 'No sessions in this range';

  /** Passed through to `echarts-base` to override the default error-state copy. */
  @property({ type: String }) errorMessage = 'This chart could not load. Try again.';

  @state() private summaryVisible = false;

  /**
   * Memoized ECharts option, recomputed only when `series` changes (not on
   * every unrelated re-render, e.g. toggling the textual summary). `option`
   * is bound to `echarts-base` via reference equality (`@property({type:
   * Object})`'s default `hasChanged`); a fresh object on every render would
   * trigger a full `setOption`/`resize` even when nothing chart-relevant
   * changed.
   *
   * Skipped for `heatmap` series: `echarts-base` renders those via
   * `rd-heatmap-grid` instead of ECharts (see its `isHeatmap` gate), so
   * building an ECharts option for one would be pure waste — no consumer
   * ever reads it.
   */
  @state() private computedOption: EChartsCoreOption | null = null;

  willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('series')) {
      this.computedOption =
        this.series && this.series.chartType !== 'heatmap' ? toEChartsOption(this.series) : null;
    }
  }

  private get summary(): string {
    return this.series ? textualSummary(this.series, this.state) : '';
  }

  private toggleSummary(e: Event): void {
    e.preventDefault();
    this.summaryVisible = !this.summaryVisible;
  }

  render() {
    const hasSummary = Boolean(this.summary);
    return html`
      <div class="analytics-chart">
        ${
          this.title
            ? html`
              <div class="chart-title-row">
                <h3 class="chart-title">${this.title}</h3>
                ${
                  hasSummary
                    ? html`<button
                      class="summary-toggle"
                      type="button"
                      @click=${this.toggleSummary}
                    >
                      ${this.summaryVisible ? 'Hide summary' : 'Show summary'}
                    </button>`
                    : ''
                }
              </div>
            `
            : ''
        }
        ${this.description ? html`<p class="chart-description">${this.description}</p>` : ''}
        ${
          this.summaryVisible && hasSummary
            ? html`<p class="chart-summary">${this.summary}</p>`
            : ''
        }
        <echarts-base
          .option=${this.computedOption}
          .series=${this.series}
          .state=${this.state}
          .ariaDescription=${this.summary}
          .emptyMessage=${this.emptyMessage}
          .errorMessage=${this.errorMessage}
        ></echarts-base>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'analytics-chart': AnalyticsChart;
  }
}
