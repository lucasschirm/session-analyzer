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
import './rd-heatmap-grid';
import type { ChartEvidenceLink, ChartSeries, ChartState, EChartsCoreOption } from './chart-types';
import { stateIcon, stateLabel, toTableRows } from './chart-types';

/** States that surface the distinguishable error banner + retry affordance. */
const ERROR_STATES: ReadonlySet<ChartState> = new Set(['error', 'integrity-error', 'unsupported']);
/** States that surface the neutral empty/unavailable affordance. */
const EMPTY_STATES: ReadonlySet<ChartState> = new Set(['empty', 'unavailable']);

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
      height: var(--chart-height, 400px);
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

    .chart-skeleton {
      width: 100%;
      height: var(--chart-height, 400px);
      border: 1px solid var(--rd-border-2, #232936);
      border-radius: 8px;
      background: linear-gradient(
        100deg,
        var(--rd-surface-inset, #12151c) 30%,
        var(--rd-surface-row-hover, #1f2531) 50%,
        var(--rd-surface-inset, #12151c) 70%
      );
      background-size: 200% 100%;
      animation: chart-skeleton-shimmer 1.4s ease-in-out infinite;
    }

    @media (prefers-reduced-motion: reduce) {
      .chart-skeleton {
        animation: none;
      }
    }

    @keyframes chart-skeleton-shimmer {
      0% {
        background-position: 200% 0;
      }
      100% {
        background-position: -200% 0;
      }
    }

    .chart-affordance {
      width: 100%;
      min-height: var(--chart-height, 400px);
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      text-align: center;
      padding: 16px;
      box-sizing: border-box;
    }

    .chart-affordance.state-empty,
    .chart-affordance.state-unavailable {
      border: 1px solid var(--rd-border-2, #232936);
      background: var(--rd-surface-inset, #12151c);
      color: var(--rd-ink-muted, #9aa4b2);
    }

    .chart-affordance.state-error,
    .chart-affordance.state-integrity-error,
    .chart-affordance.state-unsupported {
      border: 1px solid var(--md-sys-color-error, #ff6b6b);
      background: var(--rd-accent-container, #1c2b4a);
      color: var(--md-sys-color-error, #ff6b6b);
    }

    .affordance-icon {
      font-size: 24px;
      opacity: 0.7;
    }

    .affordance-message {
      font-size: 13px;
      max-width: 32ch;
    }

    .affordance-retry {
      margin-top: 4px;
      background: none;
      border: 1px solid var(--md-sys-color-error, #ff6b6b);
      color: var(--md-sys-color-error, #ff6b6b);
      border-radius: 6px;
      padding: 4px 12px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }

    .affordance-retry:hover {
      background: var(--md-sys-color-error, #ff6b6b);
      color: var(--rd-surface-page, #0c0e13);
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

  @property({ type: Object, attribute: false }) option: EChartsCoreOption | null = null;

  @property({ type: Object, attribute: false }) series: ChartSeries | null = null;

  @property({ type: String }) state: ChartState | null = null;

  @property({ type: String }) ariaDescription = '';

  /** Overrides the default neutral empty-state copy. */
  @property({ type: String }) emptyMessage = 'No sessions in this range';

  /** Overrides the default error-state copy. */
  @property({ type: String }) errorMessage = 'This chart could not load. Try again.';

  @state() private chartError: string | null = null;

  @state() private tableOpen = false;

  private chartInstance: EChartsInstance | null = null;

  private chartRef = createRef<HTMLDivElement>();

  private resizeObserver: ResizeObserver | null = null;

  updated(changed: Map<string, unknown>): void {
    if (changed.has('option') || changed.has('series') || changed.has('state')) {
      this.syncChartLifecycle();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.disposeChart();
  }

  /** True when this state renders an ECharts (or heatmap-grid) data surface
   * rather than a loading/empty/error affordance. */
  private get isDataState(): boolean {
    if (!this.state) return true;
    return (
      !ERROR_STATES.has(this.state) && this.state !== 'loading' && !EMPTY_STATES.has(this.state)
    );
  }

  private get isHeatmap(): boolean {
    return this.series?.chartType === 'heatmap';
  }

  /**
   * Keeps the ECharts instance lifecycle in sync with the current
   * state/series. A worker/query failure (surfaced via `state`) or a
   * missing DOM surface (heatmap uses `rd-heatmap-grid` instead) disposes
   * any existing instance rather than attempting to draw on stale data.
   */
  private syncChartLifecycle(): void {
    // Every entry point (state/series/option change, or an explicit retry)
    // clears a stale internal render exception first, so a prior failed
    // attempt never permanently locks the chart out of retrying with new
    // data/option — see the "stuck error state" pitfall this guards against.
    this.chartError = null;
    if (!this.isDataState || this.isHeatmap) {
      this.disposeChart();
      return;
    }
    if (!this.chartInstance) {
      this.initChart();
    } else {
      this.updateChart();
    }
  }

  private disposeChart(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.chartInstance?.dispose();
    this.chartInstance = null;
  }

  private handleRetry(event: Event): void {
    event.preventDefault();
    this.dispatchEvent(new CustomEvent('chart-retry', { bubbles: true, composed: true }));
  }

  private initChart(): void {
    const container = this.chartRef.value;
    if (!container || this.chartInstance) return;
    try {
      this.chartInstance = echarts.init(container, undefined, {
        renderer: 'svg',
        // Width and height are omitted so ECharts uses the container's CSS
        // dimensions (width: 100%, height: var(--chart-height, 300px)).
        // The ResizeObserver below handles dynamic resizing.
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
          new CustomEvent<ChartEvidenceLink>('point-click', {
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

  private renderSkeleton() {
    return html`<div class="chart-skeleton" aria-hidden="true"></div>`;
  }

  private renderEmptyPanel() {
    const cls = `chart-affordance state-${this.state}`;
    return html`
      <div class=${cls}>
        <span class="affordance-icon" aria-hidden="true">${stateIcon(this.state as ChartState)}</span>
        <p class="affordance-message">${this.emptyMessage}</p>
      </div>
    `;
  }

  private renderErrorPanel() {
    const cls = `chart-affordance state-${this.state}`;
    return html`
      <div class=${cls} role="alert">
        <span class="affordance-icon" aria-hidden="true">${stateIcon(this.state as ChartState)}</span>
        <p class="affordance-message">${this.errorMessage}</p>
        <button class="affordance-retry" type="button" @click=${this.handleRetry}>Retry</button>
      </div>
    `;
  }

  private renderChartContainer() {
    if (this.isHeatmap) {
      return html`<rd-heatmap-grid
        .series=${this.series}
        .ariaDescription=${this.ariaDescription}
      ></rd-heatmap-grid>`;
    }
    return html`
      <div
        class="chart-container"
        tabindex="0"
        role="img"
        aria-label=${this.ariaDescription}
        @keydown=${this.handleKeyDown}
        ${ref(this.chartRef)}
      ></div>
    `;
  }

  private renderBody() {
    if (this.chartError) {
      return html`<div class="chart-error" role="alert">${this.chartError}</div>`;
    }
    if (this.state === 'loading') return this.renderSkeleton();
    if (this.state && ERROR_STATES.has(this.state)) return this.renderErrorPanel();
    if (this.state && EMPTY_STATES.has(this.state)) return this.renderEmptyPanel();
    return this.renderChartContainer();
  }

  render() {
    return html`
      <div class="echarts-base">
        <div class="chart-header">
          ${this.renderStateBadge()}
        </div>
        ${this.renderBody()}
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
