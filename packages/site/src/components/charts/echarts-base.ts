import {
  BarChart,
  BoxplotChart,
  CustomChart,
  EffectScatterChart,
  FunnelChart,
  HeatmapChart,
  LineChart,
  PictorialBarChart,
  PieChart,
  RadarChart,
  SankeyChart,
  ScatterChart,
  SunburstChart,
  ThemeRiverChart,
  TreeChart,
  TreemapChart,
} from 'echarts/charts';
import {
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  ToolboxComponent,
  TooltipComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { css, html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { createRef, ref } from 'lit/directives/ref.js';
import type { ChartEvidenceLink, ChartSeries, ChartState, EChartsCoreOption } from './chart-types';
import { stateIcon, stateLabel, toTableRows } from './chart-types';

echarts.use([
  AriaComponent,
  BarChart,
  BoxplotChart,
  CustomChart,
  DataZoomComponent,
  EffectScatterChart,
  FunnelChart,
  GridComponent,
  HeatmapChart,
  LegendComponent,
  LineChart,
  MarkLineComponent,
  PieChart,
  PictorialBarChart,
  RadarChart,
  SankeyChart,
  ScatterChart,
  SunburstChart,
  ThemeRiverChart,
  TitleComponent,
  ToolboxComponent,
  TooltipComponent,
  TreeChart,
  TreemapChart,
  SVGRenderer,
]);

type EChartsInstance = ReturnType<typeof echarts.init>;

/**
 * Low-level ECharts wrapper used by analytics-chart.
 *
 * Handles ECharts lifecycle, keyboard focus, a tabular fallback, and all
 * documented chart states. It does not read SQL or compute metrics; the option
 * is built from a ChartSeries DTO upstream.
 */
@customElement('echarts-base')
export class EchartsBase extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .echarts-base {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .chart-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      flex-wrap: wrap;
    }

    .state-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      background: var(--md-sys-color-surface-container, #1f242e);
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .state-loading { color: var(--md-sys-color-primary, #4f8cff); }
    .state-empty { color: var(--md-sys-color-on-surface-variant, #9aa4b2); }
    .state-partial { color: var(--md-sys-color-tertiary, #ffb86c); }
    .state-unavailable { color: var(--md-sys-color-on-surface-variant, #9aa4b2); }
    .state-unsupported { color: var(--md-sys-color-error, #ff6b6b); }
    .state-integrity-error { color: var(--md-sys-color-error, #ff6b6b); }
    .state-stale-rollup { color: var(--md-sys-color-tertiary, #ffb86c); }
    .state-error { color: var(--md-sys-color-error, #ff6b6b); }

    .chart-container {
      width: 100%;
      height: 300px;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      background: var(--md-sys-color-surface, #171a21);
      outline: none;
    }

    .chart-container:focus-visible {
      outline: 2px solid var(--md-sys-color-primary, #4f8cff);
      outline-offset: 2px;
    }

    .chart-error {
      color: var(--md-sys-color-error, #ff6b6b);
      padding: 16px;
      font-size: 13px;
    }

    .table-fallback {
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      padding: 12px;
    }

    .table-fallback summary {
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
      font-size: 12px;
    }

    th, td {
      text-align: left;
      padding: 6px 8px;
      border-bottom: 1px solid var(--md-sys-color-outline, #2a303c);
    }

    th {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-weight: 600;
    }

    td {
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    a {
      color: var(--md-sys-color-primary, #4f8cff);
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }
  `;

  @property({ type: Object }) option: EChartsCoreOption | null = null;

  @property({ type: Object }) series: ChartSeries | null = null;

  @property({ type: String }) state: ChartState | null = null;

  @property({ type: String }) ariaDescription = '';

  @state() private chartError: string | null = null;

  @state() private tableOpen = false;

  private chartInstance: EChartsInstance | null = null;

  private chartRef = createRef<HTMLDivElement>();

  private resizeObserver: ResizeObserver | null = null;

  firstUpdated(): void {
    this.initChart();
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has('option') || changed.has('series') || changed.has('state')) {
      this.updateChart();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.chartInstance?.dispose();
    this.chartInstance = null;
  }

  private initChart(): void {
    const container = this.chartRef.value;
    if (!container || this.chartInstance) return;
    try {
      this.chartInstance = echarts.init(container, undefined, {
        renderer: 'svg',
        width: 400,
        height: 300,
      });
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(container);
      this.bindChartEvents();
      this.updateChart();
    } catch (error) {
      this.chartError = error instanceof Error ? error.message : 'Chart could not render';
    }
  }

  private updateChart(): void {
    if (!this.chartInstance || this.chartError) return;
    try {
      this.chartInstance.setOption(this.option ?? {}, true);
      this.chartInstance.resize();
    } catch (error) {
      this.chartError = error instanceof Error ? error.message : 'Chart update failed';
    }
  }

  private handleResize(): void {
    if (!this.chartInstance || this.chartError) return;
    try {
      this.chartInstance.resize();
    } catch {
      // Resize is best-effort; a failed resize should not surface as an error.
    }
  }

  private bindChartEvents(): void {
    if (!this.chartInstance) return;
    this.chartInstance.on('click', (params: unknown) => {
      const p = params as { data?: { evidenceLink?: ChartEvidenceLink } };
      if (p.data?.evidenceLink) {
        this.dispatchEvent(
          new CustomEvent('point-click', {
            detail: p.data.evidenceLink,
            bubbles: true,
            composed: true,
          }),
        );
      }
    });
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.tableOpen = !this.tableOpen;
    }
  }

  private renderStateBadge() {
    if (!this.state) return '';
    const classes = { 'state-badge': true, [`state-${this.state}`]: true };
    return html`
      <span class=${classMap(classes)} aria-live="polite">
        <span aria-hidden="true">${stateIcon(this.state)}</span>
        ${stateLabel(this.state)}
      </span>
    `;
  }

  private renderTable() {
    if (!this.series) return '';
    const rows = toTableRows(this.series);
    return html`
      <details class="table-fallback" ?open=${this.tableOpen}>
        <summary>View as table</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">${this.series.xLabel}</th>
              <th scope="col">${this.series.yLabel}</th>
              <th scope="col">Label</th>
              <th scope="col">Series</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (row) => html`
                <tr>
                  <td>${row.x}</td>
                  <td>${row.y}</td>
                  <td>${row.label}</td>
                  <td>
                    ${
                      row.evidenceHref
                        ? html`<a href="${row.evidenceHref}">${row.series}</a>`
                        : row.series
                    }
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </details>
    `;
  }

  render() {
    return html`
      <div class="echarts-base">
        <div class="chart-header">
          ${this.renderStateBadge()}
          <span class="summary">${this.ariaDescription}</span>
        </div>
        ${
          this.chartError
            ? html`<div class="chart-error" role="alert">${this.chartError}</div>`
            : html`
              <div
                class="chart-container"
                tabindex="0"
                role="img"
                aria-label=${this.ariaDescription}
                @keydown=${this.handleKeyDown}
                ${ref(this.chartRef)}
              ></div>
            `
        }
        ${this.renderTable()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'echarts-base': EchartsBase;
  }
}
