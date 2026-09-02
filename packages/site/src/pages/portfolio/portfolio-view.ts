import { css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { analyticsClient } from '../../db/analytics-client';
import { navigateTo } from '../../router';
import { PageLitElement, pageHostStyles } from '../page-lit-element';
import '../../components/charts/analytics-chart';
import '../../components/metrics-card';
import '../../components/analytics/filter-bar';
import type {
  ComponentUtilizationPage,
  DimensionDomains,
  ModelHarnessCohortPage,
  PortfolioOverview,
  PortfolioTrendSeries,
  ProjectListPage,
} from '@lucasschirm/sal-db';
import type {
  ChartEvidenceLink,
  ChartSeries,
  ChartState,
} from '../../components/charts/chart-types';
import {
  componentUtilizationToChartSeries,
  type MetricCardView,
  modelHarnessCohortsToChartSeries,
  overviewToMetricCards,
  type ProjectRowView,
  projectListToRows,
  tokenTrendToChartSeries,
  trendToChartSeries,
} from './portfolio-chart-helpers';
import {
  buildPortfolioHash,
  type PortfolioParams,
  parsePortfolioHash,
  portfolioParamsToQuery,
  type SessionsScope,
} from './portfolio-params';
import { RequestSequenceGuard } from './request-sequence-guard';

type LoadState = 'idle' | 'loading' | 'ok' | 'empty' | 'partial' | 'error';

/** Stable empty-array reference for `filter-bar`'s `*Options` properties
 * before the dimension domains have loaded — reusing one instance (instead
 * of a fresh `[]` per render) avoids forcing `dimension-chip`'s
 * `@property({ type: Array })` to see a changed reference, and re-render,
 * on every unrelated `portfolio-view` update. */
const EMPTY_DIMENSION_OPTIONS: readonly string[] = [];

interface PanelState<T> {
  data: T | null;
  state: LoadState;
  error?: string;
}

@customElement('portfolio-view')
export class PortfolioView extends PageLitElement {
  static styles = [
    pageHostStyles,
    css`
    :host {
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    h2 {
      margin: 0 0 16px;
      font-size: 22px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    filter-bar {
      display: block;
      margin-bottom: 24px;
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

    .component-counts {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }

    .component-counts span {
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 12px;
    }

    .unused-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }

    .unused-list span {
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
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

    th, td {
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
  `,
  ];

  @property({ type: Object }) params: Record<string, string> = {};

  @state() private filters: PortfolioParams = parsePortfolioHash(window.location.hash);

  @state() private loading = false;

  @state() private globalState: LoadState = 'idle';

  @state() private globalError: string | null = null;

  @state() private overview: PanelState<PortfolioOverview> = { data: null, state: 'idle' };

  @state() private trends: PanelState<PortfolioTrendSeries> = { data: null, state: 'idle' };

  @state() private components: PanelState<ComponentUtilizationPage> = { data: null, state: 'idle' };

  @state() private cohorts: PanelState<ModelHarnessCohortPage> = { data: null, state: 'idle' };

  @state() private projects: PanelState<ProjectListPage> = { data: null, state: 'idle' };

  @state() private domains: DimensionDomains | null = null;

  private pendingReload = false;

  private readonly requestGuard = new RequestSequenceGuard();

  private hashListener = () => this.handleHashChange();

  private dataChangeListener = () => this.handleDataChange();

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('hashchange', this.hashListener);
    analyticsClient.addEventListener('data-change', this.dataChangeListener);
    this.load();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('hashchange', this.hashListener);
    analyticsClient.removeEventListener('data-change', this.dataChangeListener);
  }

  private handleHashChange(): void {
    if (window.location.hash === '#/' || window.location.hash.startsWith('#/?')) {
      this.load();
    }
  }

  private handleDataChange(): void {
    if (window.location.hash !== '#/' && !window.location.hash.startsWith('#/?')) {
      return;
    }
    this.load();
  }

  private async load(): Promise<void> {
    if (this.loading) {
      this.pendingReload = true;
      return;
    }
    this.loading = true;
    this.pendingReload = false;
    this.globalState = 'loading';
    this.globalError = null;

    const requestToken = this.requestGuard.begin();
    const params = parsePortfolioHash(window.location.hash);
    this.filters = params;
    const query = portfolioParamsToQuery(params);

    const [overview, trends, components, cohorts, projects, domains] = await Promise.allSettled([
      analyticsClient.portfolio.getOverview(query),
      analyticsClient.portfolio.getTrends(query),
      analyticsClient.portfolio.getComponentUtilization(query),
      analyticsClient.portfolio.getModelHarnessCohorts(query),
      analyticsClient.portfolio.getProjectList({ ...query, limit: 50 }),
      analyticsClient.metadata.getDimensionDomains(),
    ]);

    this.loading = false;
    // A newer reload may have started while this one was in flight (e.g. a
    // fast filter change fired while a slower request was still pending) —
    // discard this stale response rather than overwriting fresher data.
    if (this.requestGuard.isCurrent(requestToken)) {
      this.applyResults(overview, trends, components, cohorts, projects, domains);
    }
    await this.reloadIfPending();
  }

  private async reloadIfPending(): Promise<void> {
    if (!this.pendingReload) return;
    this.pendingReload = false;
    await this.load();
  }

  private applyResults(
    overview: PromiseSettledResult<PortfolioOverview>,
    trends: PromiseSettledResult<PortfolioTrendSeries>,
    components: PromiseSettledResult<ComponentUtilizationPage>,
    cohorts: PromiseSettledResult<ModelHarnessCohortPage>,
    projects: PromiseSettledResult<ProjectListPage>,
    domains: PromiseSettledResult<DimensionDomains>,
  ): void {
    this.overview = panelStateFromResult(overview);
    this.trends = panelStateFromResult(trends);
    this.components = panelStateFromResult(components);
    this.cohorts = panelStateFromResult(cohorts);
    this.projects = panelStateFromResult(projects);
    this.domains = domains.status === 'fulfilled' ? domains.value : this.domains;

    const states = [
      this.overview.state,
      this.trends.state,
      this.components.state,
      this.cohorts.state,
      this.projects.state,
    ];
    if (states.every((s) => s === 'ok' || s === 'empty')) {
      this.globalState = states.some((s) => s === 'ok') ? 'ok' : 'empty';
    } else if (states.some((s) => s === 'ok')) {
      this.globalState = 'partial';
    } else {
      this.globalState = 'error';
      this.globalError = 'All portfolio views failed to load.';
    }
  }

  private handleFiltersChanged(event: CustomEvent<PortfolioParams>): void {
    navigateTo(`/${buildPortfolioHash(event.detail)}`);
  }

  private goToProject(row: ProjectRowView): void {
    navigateTo(row.href.replace(/^#/, ''));
  }

  private goToMetric(metric: MetricCardView): void {
    if (metric.href) navigateTo(metric.href.replace(/^#/, ''));
  }

  private handlePointClick(event: CustomEvent<ChartEvidenceLink>): void {
    const link = event.detail;
    if (link?.href) navigateTo(link.href.replace(/^#/, ''));
  }

  private renderFilters() {
    return html`
      <filter-bar
        .filters=${this.filters}
        .projectOptions=${this.domains?.projects ?? EMPTY_DIMENSION_OPTIONS}
        .harnessOptions=${this.domains?.harnesses ?? EMPTY_DIMENSION_OPTIONS}
        .modelOptions=${this.domains?.models ?? EMPTY_DIMENSION_OPTIONS}
        @filters-changed=${this.handleFiltersChanged}
      ></filter-bar>
    `;
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

  private renderOverview() {
    if (this.overview.state === 'error') {
      return html`<div class="error">${this.overview.error}</div>`;
    }
    if (!this.overview.data) {
      return html`<analytics-chart title="Overview" .state=${this.chartState(this.overview.state)}></analytics-chart>`;
    }

    const overview = this.overview.data;
    const cards = overviewToMetricCards(overview, this.filters);

    return html`
      <div class="section">
        <h2>Overview</h2>
        <div class="metric-grid">
          ${repeat(
            cards,
            (card) => card.label,
            (card) => html`
              <metrics-card
                label=${card.label}
                value=${card.value}
                sub=${card.sub}
                .clickable=${Boolean(card.href)}
                @card-click=${() => this.goToMetric(card)}
              ></metrics-card>
            `,
          )}
        </div>
        ${
          overview.unusedOfferedComponents.length > 0
            ? html`
              <div class="section">
                <strong>Unused offered artifacts</strong>
                <div class="unused-list">
                  ${overview.unusedOfferedComponents.map((c) => html`<span>${c}</span>`)}
                </div>
              </div>
            `
            : ''
        }
        ${
          Object.keys(overview.componentCounts).length > 0
            ? html`
              <div class="section">
                <strong>Artifact counts</strong>
                <div class="component-counts">
                  ${Object.entries(overview.componentCounts).map(
                    ([kind, count]) => html`<span>${kind}: ${count}</span>`,
                  )}
                </div>
              </div>
            `
            : ''
        }
      </div>
    `;
  }

  private renderTrends() {
    const scope: SessionsScope = this.filters.sessions ?? 'main';
    const tokenSeries: ChartSeries | null = this.trends.data
      ? tokenTrendToChartSeries(this.trends.data, scope)
      : null;
    const series: ChartSeries | null = this.trends.data
      ? trendToChartSeries(this.trends.data, scope)
      : null;
    return html`
      <div class="section">
        <h2>Trends</h2>
        <analytics-chart
          title="Token usage trends"
          description="Daily token totals — cache write, cache read, output, and total tokens — so you can track how token consumption evolves over time."
          .series=${tokenSeries}
          .state=${this.chartState(this.trends.state)}
        ></analytics-chart>
        <analytics-chart
          title="Session Metrics"
          description="Daily totals for every metric across all sessions in the portfolio — wall-clock duration, turns, tool/skill/agent invocations, file operations, commands, validations, compaction events, and edit cycles."
          .series=${series}
          .state=${this.chartState(this.trends.state)}
          style="margin-top: 24px;"
        ></analytics-chart>
      </div>
    `;
  }

  private renderComponents() {
    const series: ChartSeries | null = this.components.data
      ? componentUtilizationToChartSeries(this.components.data, this.filters)
      : null;
    return html`
      <div class="section">
        <h2>Artifact utilization</h2>
        <analytics-chart
          title="Sessions per artifact"
          description="Number of sessions that used each artifact, helping you spot which tools and integrations are most active across the portfolio."
          .series=${series}
          .state=${this.chartState(this.components.state)}
          @point-click=${this.handlePointClick}
        ></analytics-chart>
      </div>
    `;
  }

  private renderCohorts() {
    const series: ChartSeries | null = this.cohorts.data
      ? modelHarnessCohortsToChartSeries(this.cohorts.data)
      : null;
    return html`
      <div class="section">
        <h2>Model × harness cohorts</h2>
        <analytics-chart
          title="Sessions by model and harness"
          description="Session counts grouped by model and harness, showing which model-harness combinations are used most frequently."
          .series=${series}
          .state=${this.chartState(this.cohorts.state)}
        ></analytics-chart>
      </div>
    `;
  }

  private renderProjects() {
    if (this.projects.state === 'error') {
      return html`<div class="error">${this.projects.error}</div>`;
    }
    if (!this.projects.data || this.projects.data.items.length === 0) {
      return html`<div class="empty">No projects found.</div>`;
    }

    const rows = projectListToRows(this.projects.data, this.filters);

    return html`
      <div class="section">
        <h2>Projects (${this.projects.data.items.length})</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Sessions</th>
              <th scope="col">Harness</th>
            </tr>
          </thead>
          <tbody>
            ${repeat(
              rows,
              (row) => row.href,
              (row) => html`
                <tr>
                  <td><a href=${row.href} @click=${(e: Event) => {
                    e.preventDefault();
                    this.goToProject(row);
                  }}>${row.name}</a></td>
                  <td>${row.sessionCount}</td>
                  <td>${row.harness}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  render() {
    return html`
      <div class="portfolio-view">
        <h1>Portfolio</h1>
        ${
          this.globalState === 'error' && this.globalError
            ? html`<div class="error" role="alert">${this.globalError}</div>`
            : ''
        }
        ${this.renderFilters()}
        ${this.loading ? html`<p>Loading portfolio…</p>` : ''}
        ${this.renderOverview()}
        ${this.renderTrends()}
        ${this.renderComponents()}
        ${this.renderCohorts()}
        ${this.renderProjects()}
      </div>
    `;
  }
}

/** Cursor/list-page DTOs expose `items`; the trend series DTO exposes
 * `series` instead — both are checked so a range narrowed to zero rows
 * (e.g. the 7d preset excluding every rollup) renders the empty affordance
 * rather than being silently mistaken for 'ok' (`.agents/rules/no-silent-empty-states.md`). */
function panelStateFromResult<T>(result: PromiseSettledResult<T>): PanelState<T> {
  if (result.status === 'fulfilled') {
    const data = result.value;
    const isEmpty = isEmptyPanelData(data);
    return { data, state: isEmpty ? 'empty' : 'ok' };
  }
  return {
    data: null,
    state: 'error',
    error: result.reason instanceof Error ? result.reason.message : String(result.reason),
  };
}

function isEmptyPanelData(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  if ('items' in data) return (data as { items: unknown[] }).items.length === 0;
  if ('series' in data) return (data as { series: unknown[] }).series.length === 0;
  return false;
}

declare global {
  interface HTMLElementTagNameMap {
    'portfolio-view': PortfolioView;
  }
}
