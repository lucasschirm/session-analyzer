import { css, html, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { analyticsClient } from '../../db/analytics-client';
import { navigateTo } from '../../router';
import { PageLitElement, pageHostStyles } from '../page-lit-element';
import '../../components/charts/analytics-chart';
import '../../components/metrics-card';
import type {
  ComparisonPage,
  ConfigurationTimeline,
  OutlierPage,
  ProjectBehaviorSummary,
  SessionTrendSeries,
} from '@lucasschirm/sal-db';
import type { ChartSeries, ChartState } from '../../components/charts/chart-types';
import { formatChartValue } from '../../components/charts/chart-types';
import type { SessionsScope } from '../portfolio/portfolio-params';
import {
  type ComparisonRowView,
  comparisonPageToRows,
  configurationTimelineToChartSeries,
  formatMetricValue,
  type MetricCardView,
  type OutlierRowView,
  outlierPageToRows,
  sessionTokenTrendToChartSeries,
  sessionTrendToChartSeries,
  summaryToMetricCards,
} from './project-behavior-chart-helpers';
import {
  buildProjectBehaviorHash,
  type ProjectBehaviorParams,
  parseProjectBehaviorHash,
  projectBehaviorParamsToQuery,
} from './project-behavior-params';

type LoadState = 'idle' | 'loading' | 'ok' | 'empty' | 'partial' | 'error';

interface PanelState<T> {
  data: T | null;
  state: LoadState;
  error?: string;
}

function panelStateFromResult<T>(
  result: PromiseSettledResult<T>,
  isEmpty: (data: T) => boolean,
): PanelState<T> {
  if (result.status === 'fulfilled') {
    const data = result.value;
    return { data, state: isEmpty(data) ? 'empty' : 'ok' };
  }
  return {
    data: null,
    state: 'error',
    error: result.reason instanceof Error ? result.reason.message : String(result.reason),
  };
}

/**
 * Project Behavior analytics view.
 *
 * Renders from the AnalyticsDataSource DTOs: session-to-session context growth,
 * a configuration timeline, matched cohorts, and outliers. It does not import
 * SQL types or compute canonical metrics.
 */
@customElement('project-behavior-view')
export class ProjectBehaviorPage extends PageLitElement {
  static styles = [
    pageHostStyles,
    css`
    :host {
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    h1 {
      margin: 0 0 8px;
      font-size: 24px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    h2 {
      margin: 0 0 12px;
      font-size: 18px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .back-link {
      color: var(--md-sys-color-primary, #4f8cff);
      text-decoration: none;
      font-size: 14px;
    }

    .back-link:hover {
      text-decoration: underline;
    }

    .filter-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: end;
      margin: 16px 0 24px;
      padding: 16px;
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 12px;
    }

    .filter-bar label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      min-width: 140px;
    }

    .filter-bar input,
    .filter-bar select {
      background: var(--md-sys-color-surface, #171a21);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 6px;
      padding: 8px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      font: inherit;
    }

    .filter-bar button {
      background: var(--md-sys-color-primary, #4f8cff);
      color: var(--md-sys-color-on-primary, #fff);
      border: none;
      border-radius: 6px;
      padding: 8px 16px;
      font: inherit;
      cursor: pointer;
    }

    .filter-bar button.secondary {
      background: transparent;
      color: var(--md-sys-color-primary, #4f8cff);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
    }

    .section {
      margin-bottom: 24px;
    }

    .metric-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 16px;
    }

    metrics-card {
      cursor: pointer;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      overflow: hidden;
      font-size: 13px;
    }

    th,
    td {
      text-align: left;
      padding: 10px 12px;
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

    .error {
      color: var(--md-sys-color-error, #ff6b6b);
      font-size: 13px;
      padding: 12px;
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
    }

    .empty {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-size: 13px;
      padding: 12px;
    }

    .notice {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-size: 14px;
      padding: 8px 0;
    }

    .regression-yes {
      font-weight: 600;
      color: var(--md-sys-color-error, #ff6b6b);
    }
  `,
  ];

  @property({ type: String, attribute: 'project-id' }) projectId = '';

  @state() private filters: ProjectBehaviorParams = { projectId: '' };

  @state() private loading = false;

  @state() private globalState: LoadState = 'idle';

  @state() private globalError: string | null = null;

  /** Internal analytics project id resolved from the URL's project id. */
  private resolvedProjectId: string | null = null;

  @state() private summary: PanelState<ProjectBehaviorSummary> = { data: null, state: 'idle' };

  @state() private trends: PanelState<SessionTrendSeries> = { data: null, state: 'idle' };

  @state() private timeline: PanelState<ConfigurationTimeline> = { data: null, state: 'idle' };

  @state() private outliers: PanelState<OutlierPage> = { data: null, state: 'idle' };

  @state() private comparisons: PanelState<ComparisonPage> = { data: null, state: 'idle' };

  private hashListener = () => this.handleHashChange();

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('hashchange', this.hashListener);
    if (this.projectId) {
      void this.load();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('hashchange', this.hashListener);
  }

  willUpdate(changed: PropertyValues): void {
    if (changed.has('projectId') && this.projectId) {
      void this.load();
    }
  }

  private handleHashChange(): void {
    if (window.location.hash.startsWith(`#/projects/${this.projectId}`)) {
      void this.load();
    }
  }

  private async load(): Promise<void> {
    if (this.loading || !this.projectId) return;
    this.loading = true;
    this.globalState = 'loading';
    this.globalError = null;

    // Resolve the URL project id (which may be a native/sync project id or an
    // encoded project name) to the internal analytics project id used by all
    // analytics queries.
    const decodedProjectId = (() => {
      try {
        return decodeURIComponent(this.projectId);
      } catch {
        return this.projectId;
      }
    })();
    try {
      const resolved = await analyticsClient.resolveProjectId(decodedProjectId);
      this.resolvedProjectId = resolved;
      if (!resolved) {
        this.globalState = 'empty';
        this.globalError = null;
        this.loading = false;
        return;
      }
    } catch {
      this.globalState = 'error';
      this.globalError = 'Failed to resolve project id.';
      this.loading = false;
      return;
    }

    const analyticsProjectId = this.resolvedProjectId ?? this.projectId;
    const parsed = parseProjectBehaviorHash(window.location.hash);
    this.filters = { ...parsed, projectId: this.projectId };
    const query = projectBehaviorParamsToQuery(this.filters);

    const [summary, trends, timeline, outliers, comparisons] = await Promise.allSettled([
      analyticsClient.project.getSummary(analyticsProjectId, query),
      analyticsClient.project.getSessionTrendSeries(analyticsProjectId, query),
      analyticsClient.project.getConfigurationTimeline(analyticsProjectId, query),
      analyticsClient.project.getOutliers(analyticsProjectId, query),
      analyticsClient.project.getComparisons(analyticsProjectId, query),
    ]);

    this.summary = panelStateFromResult(summary, (d) => d.headlineMetrics.length === 0);
    this.trends = panelStateFromResult(trends, (d) => d.series.length === 0);
    this.timeline = panelStateFromResult(timeline, (d) => d.events.length === 0);
    this.outliers = panelStateFromResult(outliers, (d) => d.items.length === 0);
    this.comparisons = panelStateFromResult(comparisons, (d) => d.items.length === 0);

    const states = [
      this.summary.state,
      this.trends.state,
      this.timeline.state,
      this.outliers.state,
      this.comparisons.state,
    ];
    if (states.every((s) => s === 'ok' || s === 'empty')) {
      this.globalState = states.some((s) => s === 'ok') ? 'ok' : 'empty';
    } else if (states.some((s) => s === 'ok')) {
      this.globalState = 'partial';
    } else {
      this.globalState = 'error';
      this.globalError = 'All project behavior views failed to load.';
    }

    this.loading = false;
  }

  private updateFilter(key: keyof ProjectBehaviorParams, value: string): void {
    const record = { ...this.filters } as unknown as Record<string, string | undefined>;
    record[key as string] = value === '' ? undefined : value;
    navigateTo(
      `/projects/${this.projectId}${buildProjectBehaviorHash(
        record as unknown as ProjectBehaviorParams,
      )}`,
    );
  }

  private resetFilters(): void {
    navigateTo(`/projects/${this.projectId}`);
  }

  private goToMetric(metric: MetricCardView): void {
    if (metric.href) {
      navigateTo(metric.href.replace(/^#/, ''));
    }
  }

  private goToSession(sessionId: string): void {
    navigateTo(`/sessions/${sessionId}`);
  }

  private chartState(state: LoadState): ChartState | null {
    switch (state) {
      case 'loading':
        return 'loading';
      case 'empty':
        return 'empty';
      case 'partial':
        return 'partial';
      case 'error':
        return 'error';
      default:
        return null;
    }
  }

  private renderBreadcrumb() {
    const back = this.filters.returnContext
      ? `#/?${new URLSearchParams(this.filters.returnContext).toString()}`
      : '#/';
    return html`<a class="back-link" href=${back}>← Back to Dashboard</a>`;
  }

  private renderFilters() {
    return html`
      <div class="filter-bar">
        <label>
          From
          <input
            type="date"
            .value=${this.filters.timeStart ?? ''}
            @change=${(e: Event) =>
              this.updateFilter('timeStart', (e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          To
          <input
            type="date"
            .value=${this.filters.timeEnd ?? ''}
            @change=${(e: Event) =>
              this.updateFilter('timeEnd', (e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          Harness
          <input
            type="text"
            .value=${this.filters.harness ?? ''}
            @change=${(e: Event) =>
              this.updateFilter('harness', (e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          Model
          <input
            type="text"
            .value=${this.filters.model ?? ''}
            @change=${(e: Event) =>
              this.updateFilter('model', (e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          Mode
          <select
            .value=${this.filters.mode ?? ''}
            @change=${(e: Event) =>
              this.updateFilter('mode', (e.target as HTMLSelectElement).value)}
          >
            <option value="">All</option>
            <option value="auto">Auto</option>
            <option value="plan">Plan</option>
          </select>
        </label>
        <label>
          Artifact
          <input
            type="text"
            .value=${this.filters.component ?? ''}
            @change=${(e: Event) =>
              this.updateFilter('component', (e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          Task cohort
          <input
            type="text"
            .value=${this.filters.taskCohort ?? ''}
            @change=${(e: Event) =>
              this.updateFilter('taskCohort', (e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          Sessions
          <select
            .value=${this.filters.sessions ?? 'main'}
            @change=${(e: Event) =>
              this.updateFilter('sessions', (e.target as HTMLSelectElement).value)}
          >
            <option value="main">Main</option>
            <option value="all">All</option>
            <option value="sub_agents">Sub Agents</option>
          </select>
        </label>
        <label>
          Confidence
          <select
            .value=${this.filters.confidence ?? ''}
            @change=${(e: Event) =>
              this.updateFilter('confidence', (e.target as HTMLSelectElement).value)}
          >
            <option value="">All</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label>
          Analysis release
          <input
            type="text"
            .value=${this.filters.analysisRelease ?? ''}
            @change=${(e: Event) =>
              this.updateFilter('analysisRelease', (e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          Comparability group
          <input
            type="text"
            .value=${this.filters.comparabilityGroup ?? ''}
            @change=${(e: Event) =>
              this.updateFilter('comparabilityGroup', (e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          Generation
          <input
            type="text"
            .value=${this.filters.generation ?? ''}
            @change=${(e: Event) =>
              this.updateFilter('generation', (e.target as HTMLInputElement).value)}
          />
        </label>
        <button class="secondary" @click=${this.resetFilters}>Reset</button>
      </div>
    `;
  }

  private renderOverview() {
    if (this.summary.state === 'error') {
      return html`
        <div class="section">
          <h2>Overview</h2>
          <div class="error">${this.summary.error}</div>
        </div>
      `;
    }
    if (!this.summary.data) {
      return html`
        <div class="section">
          <h2>Overview</h2>
          <analytics-chart title="Overview" .state=${this.chartState(this.summary.state)}>
          </analytics-chart>
        </div>
      `;
    }

    const cards = summaryToMetricCards(this.summary.data, this.filters);
    if (cards.length === 0) {
      return html`
        <div class="section">
          <h2>Overview</h2>
          <div class="empty">No metrics available.</div>
        </div>
      `;
    }

    return html`
      <div class="section">
        <h2>Overview</h2>
        <div class="metric-grid">
          ${cards.map(
            (card) => html`
              <metrics-card
                label=${card.label}
                value=${card.value}
                sub=${card.sub}
                valueTitle=${card.valueTitle ?? ''}
                .clickable=${Boolean(card.href)}
                @card-click=${() => this.goToMetric(card)}
              ></metrics-card>
            `,
          )}
        </div>
      </div>
    `;
  }

  private renderTrends() {
    const scope: SessionsScope = this.filters.sessions ?? 'main';
    const tokenSeries: ChartSeries | null = this.trends.data
      ? sessionTokenTrendToChartSeries(this.trends.data, scope)
      : null;
    const series: ChartSeries | null = this.trends.data
      ? sessionTrendToChartSeries(this.trends.data, scope)
      : null;
    return html`
      <div class="section">
        <h2>Session Metrics</h2>
        <analytics-chart
          title="Token usage trends"
          description="Per-session token totals — cache write, cache read, output, and total tokens — so you can track how token consumption grows across consecutive sessions."
          .series=${tokenSeries}
          .state=${this.chartState(this.trends.state)}
        ></analytics-chart>
        <analytics-chart
          title="Session Metrics"
          description="Per-session metric totals over time — duration, turns, tool/skill/agent invocations, and more — so you can see how context and activity grow across consecutive sessions in this project."
          .series=${series}
          .state=${this.chartState(this.trends.state)}
          style="margin-top: 24px;"
        ></analytics-chart>
      </div>
    `;
  }

  private renderConfigurationTimeline() {
    const series: ChartSeries | null = this.timeline.data
      ? configurationTimelineToChartSeries(this.timeline.data)
      : null;
    return html`
      <div class="section">
        <h2>Configuration timeline</h2>
        <analytics-chart
          title="Configuration timeline"
          description="Changes to model, mode, and other configuration settings across sessions, annotated on a timeline so you can correlate configuration shifts with performance changes."
          .series=${series}
          .state=${this.chartState(this.timeline.state)}
        ></analytics-chart>
      </div>
    `;
  }

  private renderCohorts() {
    if (this.comparisons.state === 'error') {
      return html`<div class="error">${this.comparisons.error}</div>`;
    }
    if (!this.comparisons.data || this.comparisons.data.items.length === 0) {
      return html`
        <div class="section">
          <h2>Matched before / after cohorts</h2>
          <div class="empty">No cohort comparisons available.</div>
        </div>
      `;
    }

    const rows: ComparisonRowView[] = comparisonPageToRows(this.comparisons.data);
    return html`
      <div class="section">
        <h2>Matched before / after cohorts</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col">Before / Control</th>
              <th scope="col">After / Treatment</th>
              <th scope="col">Absolute Δ</th>
              <th scope="col">Relative Δ</th>
              <th scope="col">Regression</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (row) => html`
                <tr>
                  <td>${row.kind}</td>
                  <td>
                    ${row.cohortA.label}
                    (n=${row.cohortA.knownN}${
                      row.cohortA.knownN < row.cohortA.eligibleN
                        ? ` of ${row.cohortA.eligibleN}`
                        : ''
                    })
                  </td>
                  <td>
                    ${row.cohortB.label}
                    (n=${row.cohortB.knownN}${
                      row.cohortB.knownN < row.cohortB.eligibleN
                        ? ` of ${row.cohortB.eligibleN}`
                        : ''
                    })
                  </td>
                  <td>${formatMetricValue(row.absoluteDelta)}</td>
                  <td>${formatMetricValue(row.relativeDelta)}</td>
                  <td class=${row.regression ? 'regression-yes' : ''}>
                    ${row.regression ? 'Yes' : 'No'}
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  private renderOutliers() {
    if (this.outliers.state === 'error') {
      return html`<div class="error">${this.outliers.error}</div>`;
    }
    if (!this.outliers.data || this.outliers.data.items.length === 0) {
      return html`
        <div class="section">
          <h2>Outliers</h2>
          <div class="empty">No outliers available.</div>
        </div>
      `;
    }

    const rows: OutlierRowView[] = outlierPageToRows(this.outliers.data, this.filters);
    return html`
      <div class="section">
        <h2>Outliers</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Session</th>
              <th scope="col">Metric</th>
              <th scope="col">Value</th>
              <th scope="col">Deviation</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (row) => html`
                <tr>
                  <td>
                    <a href=${row.href} @click=${(e: Event) => this.handleSessionClick(e, row)}>
                      ${row.sessionId}
                    </a>
                  </td>
                  <td>${row.metricId}</td>
                  <td>${formatChartValue(row.value)}</td>
                  <td>${formatChartValue(row.deviation)}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  private handleSessionClick(e: Event, row: OutlierRowView): void {
    e.preventDefault();
    this.goToSession(row.sessionId);
  }

  render() {
    return html`
      <div class="project-behavior-view">
        <h1>Project Behavior</h1>
        ${this.renderBreadcrumb()}
        ${
          this.globalState === 'error' && this.globalError
            ? html`<div class="error" role="alert">${this.globalError}</div>`
            : ''
        }
        ${this.renderFilters()}
        ${this.loading ? html`<p class="notice">Loading project behavior…</p>` : ''}
        ${this.renderOverview()}
        ${this.renderTrends()}
        ${this.renderConfigurationTimeline()}
        ${this.renderCohorts()}
        ${this.renderOutliers()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'project-behavior-view': ProjectBehaviorPage;
  }
}
