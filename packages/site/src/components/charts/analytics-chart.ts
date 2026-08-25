import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import './echarts-base';
import { toEChartsOption } from './chart-helpers';
import type { ChartSeries, ChartState } from './chart-types';
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

    .chart-title {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .chart-summary {
      font-size: 13px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      margin: 0;
    }
  `;

  @property({ type: Object }) series: ChartSeries | null = null;

  @property({ type: String }) state: ChartState | null = null;

  @property({ type: String }) title = '';

  private get option() {
    return this.series ? toEChartsOption(this.series) : null;
  }

  private get summary(): string {
    return this.series ? textualSummary(this.series, this.state) : '';
  }

  render() {
    return html`
      <div class="analytics-chart">
        ${this.title ? html`<h3 class="chart-title">${this.title}</h3>` : ''}
        <p class="chart-summary">${this.summary}</p>
        <echarts-base
          .option=${this.option}
          .series=${this.series}
          .state=${this.state}
          .ariaDescription=${this.summary}
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
