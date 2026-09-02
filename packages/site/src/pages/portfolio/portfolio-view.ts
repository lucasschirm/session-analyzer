import { css, html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { analyticsClient } from '../../db/analytics-client';
import { navigateTo } from '../../router';
import '../../components/charts/analytics-chart';
import '../../components/metrics-card';
import type {
  ComponentUtilizationPage,
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

type LoadState = 'idle' | 'loading' | 'ok' | 'empty' | 'partial' | 'error';

interface PanelState<T> {
  data: T | null;
  state: LoadState;
  error?: string;
}

@customElement('portfolio-view')
export class PortfolioView extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: 24px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    h2 {
      margin: 0 0 16px;
      font-size: 22px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .filter-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: end;
      margin-bottom: 24px;
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

    .filter-bar input, .filter-bar select {
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
  `;

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

  private pendingReload = false;

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

    const params = parsePortfolioHash(window.location.hash);
    this.filters = params;
    const query = portfolioParamsToQuery(params);

    const [overview, trends, components, cohorts, projects] = await Promise.allSettled([
      analyticsClient.portfolio.getOverview(query),
      analyticsClient.portfolio.getTrends(query),
      analyticsClient.portfolio.getComponentUtilization(query),
      analyticsClient.portfolio.getModelHarnessCohorts(query),
      analyticsClient.portfolio.getProjectList({ ...query, limit: 50 }),
    ]);

    this.overview = panelStateFromResult(overview);
    this.trends = panelStateFromResult(trends);
    this.components = panelStateFromResult(components);
    this.cohorts = panelStateFromResult(cohorts);
    this.projects = panelStateFromResult(projects);

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

    this.loading = false;
    if (this.pendingReload) {
      this.pendingReload = false;
      await this.load();
    }
  }

  private updateFilter(key: keyof PortfolioParams, value: string): void {
    const next = { ...this.filters, [key]: value };
    if (value === '') {
      delete next[key];
    }
    navigateTo(`/${buildPortfolioHash(next)}`);
  }

  private resetFilters(): void {
    navigateTo('/');
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
      <div class="filter-bar">
        <label>
          Project
          <input
            type="text"
            .value=${this.filters.project ?? ''}
            @change=${(e: Event) => this.updateFilter('project', (e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          Harness
          <input
            type="text"
            .value=${this.filters.harness ?? ''}
            @change=${(e: Event) => this.updateFilter('harness', (e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          Model
          <input
            type="text"
            .value=${this.filters.model ?? ''}
            @change=${(e: Event) => this.updateFilter('model', (e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          Mode
          <select
            .value=${this.filters.mode ?? ''}
            @change=${(e: Event) => this.updateFilter('mode', (e.target as HTMLSelectElement).value)}
          >
            <option value="">All</option>
            <option value="auto">Auto</option>
            <option value="plan">Plan</option>
          </select>
        </label>
        <label>
          Sessions
          <select
            .value=${this.filters.sessions ?? 'main'}
            @change=${(e: Event) => this.updateFilter('sessions', (e.target as HTMLSelectElement).value)}
          >
            <option value="main">Main</option>
            <option value="all">All</option>
            <option value="sub_agents">Sub Agents</option>
          </select>
        </label>
        <label>
          Component
          <input
            type="text"
            .value=${this.filters.component ?? ''}
            @change=${(e: Event) => this.updateFilter('component', (e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          From
          <input
            type="date"
            .value=${this.filters.timeStart ?? ''}
            @change=${(e: Event) => this.updateFilter('timeStart', (e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          To
          <input
            type="date"
            .value=${this.filters.timeEnd ?? ''}
            @change=${(e: Event) => this.updateFilter('timeEnd', (e.target as HTMLInputElement).value)}
          />
        </label>
        <button class="secondary" @click=${this.resetFilters}>Reset</button>
      </div>
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
          ${cards.map(
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
            ${rows.map(
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

function panelStateFromResult<T>(result: PromiseSettledResult<T>): PanelState<T> {
  if (result.status === 'fulfilled') {
    const data = result.value;
    const isEmpty =
      data && typeof data === 'object' && 'items' in data
        ? (data as { items: unknown[] }).items.length === 0
        : false;
    return { data, state: isEmpty ? 'empty' : 'ok' };
  }
  return {
    data: null,
    state: 'error',
    error: result.reason instanceof Error ? result.reason.message : String(result.reason),
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'portfolio-view': PortfolioView;
  }
}
