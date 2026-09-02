import { css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import '../../components/charts/analytics-chart';
import '../../components/analytics/filter-bar';
import '../../components/analytics/stat-tile-hero';
import '../../components/analytics/stat-tile-delta';
import '../../components/analytics/stat-tile-missing';
import '../../components/analytics/stat-ring';
import '../../components/charts/sparkline';
import type {
  DimensionDomains,
  InvocationsByDomain,
  ModelHarnessMatrix,
  PortfolioKpiBand,
  PortfolioTrendSeries,
  ProjectLeaderboard,
  SessionsByModelBar,
} from '@lucasschirm/sal-db';
import type {
  ChartEvidenceLink,
  ChartSeries,
  ChartState,
} from '../../components/charts/chart-types';
import { analyticsClient } from '../../db/analytics-client';
import { formatRelativeTime } from '../../lib/format';
import { navigateTo } from '../../router';
import { type SyncManagerSnapshot, syncManager } from '../../sync/sync-manager';
import { PageLitElement, pageHostStyles } from '../page-lit-element';
import {
  type DomainBarRowView,
  invocationsByDomainToChartSeries,
  invocationsByDomainToRows,
  kpiBandToCleanCompletionView,
  kpiBandToCostView,
  kpiBandToSessionsHero,
  kpiBandToTokensView,
  modelHarnessMatrixToHeatmapSeries,
  type ProjectLeaderboardRowView,
  projectLeaderboardToRows,
  sessionsByModelToChartSeries,
  tokenTrendToChartSeries,
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

/** Stable empty-array reference for `filter-bar`'s `*Options` properties —
 * see `portfolio-view.ts` history for the rationale (reused reference avoids
 * `dimension-chip` re-rendering on every unrelated update). */
const EMPTY_DIMENSION_OPTIONS: readonly string[] = [];

interface PanelState<T> {
  data: T | null;
  state: LoadState;
  error?: string;
}

function idlePanel<T>(): PanelState<T> {
  return { data: null, state: 'idle' };
}

/**
 * `<portfolio-view>` — the Portfolio analytics home page (`/`), issue #170.
 * Pure composition: every value comes from `AnalyticsDataSource` DTOs
 * (issue #169) shaped by `portfolio-chart-helpers.ts`; every widget comes
 * from the shared card library (issue #166) and chart layer (issue #168).
 * No metric math happens in this file.
 */
@customElement('portfolio-view')
export class PortfolioView extends PageLitElement {
  static styles = [
    pageHostStyles,
    css`
    :host {
      color: var(--rd-ink-primary, #e6e9ef);
    }

    .title-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }

    .title-row h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 700;
    }

    .subtitle {
      margin: 4px 0 0;
      font-size: 13px;
      color: var(--rd-ink-muted, #9aa4b2);
    }

    .title-actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .sync-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border-radius: 999px;
      border: 1px solid var(--rd-border-2, #232936);
      background: var(--rd-surface-card, #171b24);
      font-size: 12px;
      color: var(--rd-ink-muted, #9aa4b2);
    }

    .sync-chip.syncing {
      color: var(--rd-accent, #4f8cff);
      border-color: var(--rd-accent, #4f8cff);
    }

    .export-button {
      background: var(--rd-surface-card, #171b24);
      border: 1px solid var(--rd-border-2, #232936);
      color: var(--rd-ink-primary, #e6e9ef);
      border-radius: 8px;
      padding: 7px 14px;
      font-size: 13px;
      cursor: pointer;
    }

    .export-button:hover {
      border-color: var(--rd-border-emphasis, #313947);
    }

    filter-bar {
      display: block;
      margin-bottom: 24px;
    }

    .section {
      margin-bottom: 24px;
    }

    .kpi-band {
      display: grid;
      grid-template-columns: repeat(4, minmax(200px, 1fr));
      gap: 16px;
    }

    .split-row {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 16px;
      align-items: stretch;
    }

    /* Grid items default to a min-width of auto, which lets a wide
     * intrinsically-sized child (an ECharts SVG renders at a fixed pixel
     * width before it observes its container) push the track wider than
     * the grid itself — the classic CSS grid overflow trap. Every direct
     * child must be free to shrink to its track's actual width. */
    .split-row > * {
      min-width: 0;
    }

    @media (max-width: 1024px) {
      .kpi-band {
        grid-template-columns: repeat(2, minmax(200px, 1fr));
      }

      .split-row {
        grid-template-columns: 1fr;
      }
    }

    .panel-error {
      color: var(--rd-status-error, #ff6b6b);
      font-size: 13px;
      padding: 12px;
      background: var(--rd-surface-card, #171b24);
      border: 1px solid var(--rd-border-2, #232936);
      border-radius: 12px;
    }

    .chart-caption {
      font-size: 12px;
      color: var(--rd-ink-faint, #7d8794);
      margin: 8px 0 0;
    }

    .domain-footnote {
      font-size: 12px;
      color: var(--rd-ink-faint, #7d8794);
      margin: 8px 0 0;
    }

    .domain-footnote a {
      color: var(--rd-accent, #4f8cff);
      text-decoration: none;
    }

    .domain-footnote a:hover {
      text-decoration: underline;
    }

    table.leaderboard {
      width: 100%;
      border-collapse: collapse;
      background: var(--rd-surface-card, #171b24);
      border: 1px solid var(--rd-border-2, #232936);
      border-radius: 12px;
      overflow: hidden;
      font-size: 13px;
    }

    table.leaderboard th,
    table.leaderboard td {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid var(--rd-border-1, #20242e);
    }

    table.leaderboard th {
      color: var(--rd-ink-muted, #9aa4b2);
      font-weight: 600;
      font-size: 12px;
    }

    table.leaderboard td {
      color: var(--rd-ink-primary, #e6e9ef);
    }

    .project-name {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .color-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .tokens-cell {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 140px;
    }

    .tokens-bar-track {
      flex: 1;
      height: 6px;
      border-radius: 3px;
      background: var(--rd-border-1, #20242e);
      overflow: hidden;
    }

    .tokens-bar-fill {
      height: 100%;
      background: var(--rd-accent, #4f8cff);
      border-radius: 3px;
    }

    /* Visible sample-size text for a table cell — a title-attribute-only
     * pattern is hover-only and not reliably reachable by keyboard/AT
     * users (see .agents/rules/aggregates-expose-sample-size.md). */
    .cell-caption {
      font-size: 11px;
      color: var(--rd-ink-faint, #7d8794);
      margin-top: 2px;
    }

    a {
      color: var(--rd-accent, #4f8cff);
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    .section-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      margin-bottom: 12px;
    }

    .section-header h2 {
      margin: 0;
      font-size: 16px;
    }

    .section-header .section-caption {
      font-size: 12px;
      color: var(--rd-ink-muted, #9aa4b2);
    }
  `,
  ];

  @state() private filters: PortfolioParams = parsePortfolioHash(window.location.hash);

  @state() private syncSnapshot: SyncManagerSnapshot | null = null;

  @state() private kpi: PanelState<PortfolioKpiBand> = idlePanel();

  @state() private trends: PanelState<PortfolioTrendSeries> = idlePanel();

  @state() private sessionsByModel: PanelState<SessionsByModelBar> = idlePanel();

  @state() private matrix: PanelState<ModelHarnessMatrix> = idlePanel();

  @state() private invocations: PanelState<InvocationsByDomain> = idlePanel();

  @state() private leaderboard: PanelState<ProjectLeaderboard> = idlePanel();

  @state() private dimensionDomains: DimensionDomains | null = null;

  private readonly requestGuard = new RequestSequenceGuard();

  private hashListener = () => this.handleHashChange();

  private dataChangeListener = () => this.handleDataChange();

  private syncChangeListener = (event: Event) => {
    this.syncSnapshot = (event as CustomEvent<SyncManagerSnapshot>).detail;
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('hashchange', this.hashListener);
    analyticsClient.addEventListener('data-change', this.dataChangeListener);
    syncManager.addEventListener('change', this.syncChangeListener);
    this.syncSnapshot = syncManager.getSnapshot();
    this.load();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('hashchange', this.hashListener);
    analyticsClient.removeEventListener('data-change', this.dataChangeListener);
    syncManager.removeEventListener('change', this.syncChangeListener);
  }

  private handleHashChange(): void {
    if (this.isPortfolioHash()) this.load();
  }

  private handleDataChange(): void {
    if (this.isPortfolioHash()) this.load();
  }

  private isPortfolioHash(): boolean {
    return window.location.hash === '#/' || window.location.hash.startsWith('#/?');
  }

  /**
   * Loads every card's data concurrently under one request token
   * (`RequestSequenceGuard` discards a stale response, see
   * `request-sequence-guard.ts`). Each card's `PanelState` is set
   * independently from its own `PromiseSettledResult`, so a failing query
   * never blanks a sibling card (`.agents/rules/no-silent-empty-states.md`).
   * The leaderboard query always omits the time range — it is an all-time
   * ranking regardless of the active range filter, per issue #170.
   */
  private async load(): Promise<void> {
    const requestToken = this.requestGuard.begin();
    const params = parsePortfolioHash(window.location.hash);
    this.filters = params;
    const query = portfolioParamsToQuery(params);
    const leaderboardQuery = { ...query, timeRange: undefined };

    // Every card enters 'loading' synchronously, before the await, so the
    // first paint (and every filter-change refetch) shows a real loading
    // affordance instead of silently reusing the prior render — the KPI
    // band's bare empty div and the leaderboard's headers-only table are
    // otherwise indistinguishable from "nothing wired up"
    // (`.agents/rules/no-silent-empty-states.md`).
    this.kpi = { data: this.kpi.data, state: 'loading' };
    this.trends = { data: this.trends.data, state: 'loading' };
    this.sessionsByModel = { data: this.sessionsByModel.data, state: 'loading' };
    this.matrix = { data: this.matrix.data, state: 'loading' };
    this.invocations = { data: this.invocations.data, state: 'loading' };
    this.leaderboard = { data: this.leaderboard.data, state: 'loading' };

    const [kpi, trends, sessionsByModel, matrix, invocations, leaderboard, domains] =
      await Promise.allSettled([
        analyticsClient.portfolio.getKpiBand(query),
        analyticsClient.portfolio.getTrends(query),
        analyticsClient.portfolio.getSessionsByModel(query),
        analyticsClient.portfolio.getModelHarnessMatrix(query),
        analyticsClient.portfolio.getInvocationsByDomain(query),
        analyticsClient.portfolio.getProjectLeaderboard(leaderboardQuery),
        analyticsClient.metadata.getDimensionDomains(),
      ]);

    if (!this.requestGuard.isCurrent(requestToken)) return;
    this.applyResults(kpi, trends, sessionsByModel, matrix, invocations, leaderboard, domains);
  }

  private applyResults(
    kpi: PromiseSettledResult<PortfolioKpiBand>,
    trends: PromiseSettledResult<PortfolioTrendSeries>,
    sessionsByModel: PromiseSettledResult<SessionsByModelBar>,
    matrix: PromiseSettledResult<ModelHarnessMatrix>,
    invocations: PromiseSettledResult<InvocationsByDomain>,
    leaderboard: PromiseSettledResult<ProjectLeaderboard>,
    domains: PromiseSettledResult<DimensionDomains>,
  ): void {
    this.kpi = panelStateFromResult(kpi);
    this.trends = panelStateFromResult(trends);
    this.sessionsByModel = panelStateFromResult(sessionsByModel);
    this.matrix = panelStateFromResult(matrix);
    this.invocations = panelStateFromResult(invocations);
    this.leaderboard = panelStateFromResult(leaderboard);
    this.dimensionDomains = domains.status === 'fulfilled' ? domains.value : this.dimensionDomains;
  }

  private handleFiltersChanged(event: CustomEvent<PortfolioParams>): void {
    navigateTo(`/${buildPortfolioHash(event.detail)}`);
  }

  private handlePointClick(event: CustomEvent<ChartEvidenceLink>): void {
    const link = event.detail;
    if (link?.href) navigateTo(link.href.replace(/^#/, ''));
  }

  private async handleExport(): Promise<void> {
    const bytes = await analyticsClient.exportAnalyticsDatabase();
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/x-sqlite3' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `sal-analytics-${new Date().toISOString().slice(0, 10)}.sqlite`;
    anchor.click();
    URL.revokeObjectURL(url);
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

  private get sessionsScope(): SessionsScope {
    return this.filters.sessions ?? 'main';
  }

  private renderFilters() {
    const domains = this.dimensionDomains;
    return html`
      <filter-bar
        .filters=${this.filters}
        .projectOptions=${domains?.projects ?? EMPTY_DIMENSION_OPTIONS}
        .harnessOptions=${domains?.harnesses ?? EMPTY_DIMENSION_OPTIONS}
        .modelOptions=${domains?.models ?? EMPTY_DIMENSION_OPTIONS}
        @filters-changed=${this.handleFiltersChanged}
      ></filter-bar>
    `;
  }

  private renderSyncChip() {
    const snapshot = this.syncSnapshot;
    const active =
      snapshot?.activeRun?.state === 'running' || snapshot?.activeRun?.state === 'queued';
    const label = active
      ? 'Syncing…'
      : snapshot?.lastCompletedAt
        ? `Synced ${formatRelativeTime(snapshot.lastCompletedAt)}`
        : 'Not synced yet';
    return html`<span class="sync-chip ${active ? 'syncing' : ''}">${label}</span>`;
  }

  private renderTitleRow() {
    return html`
      <div class="title-row">
        <div>
          <h1>Portfolio</h1>
          <p class="subtitle">Portfolio-wide analytics across every synced project.</p>
        </div>
        <div class="title-actions">
          ${this.renderSyncChip()}
          <button type="button" class="export-button" @click=${this.handleExport}>
            Export
          </button>
        </div>
      </div>
    `;
  }

  private renderKpiBand() {
    if (this.kpi.state === 'error') {
      return html`<div class="panel-error" role="alert">${this.kpi.error}</div>`;
    }
    if (!this.kpi.data) {
      return html`<div class="kpi-band chart-caption" role="status">Loading KPI band…</div>`;
    }

    const kpi = this.kpi.data;
    const sessions = kpiBandToSessionsHero(kpi, this.sessionsScope);
    const tokens = kpiBandToTokensView(kpi);
    const cost = kpiBandToCostView(kpi);
    const clean = kpiBandToCleanCompletionView(kpi);

    return html`
      <div class="kpi-band">
        <stat-tile-hero
          label="Sessions"
          value=${sessions.value}
          .delta=${sessions.delta}
          .sparklinePoints=${sessions.sparklinePoints}
          footnote=${sessions.footnote}
          sampleLabel=${sessions.sampleLabel}
        ></stat-tile-hero>
        <stat-tile-delta
          label="Tokens"
          value=${tokens.value}
          .delta=${tokens.delta}
          .breakdown=${tokens.breakdown}
          sampleLabel=${tokens.sampleLabel}
        ></stat-tile-delta>
        ${this.renderCostTile(cost)}
        ${this.renderCleanCompletionTile(clean)}
      </div>
    `;
  }

  private renderCostTile(cost: ReturnType<typeof kpiBandToCostView>) {
    if (cost.kind === 'missing') {
      return html`<stat-tile-missing label="Cost" reason=${cost.reason}></stat-tile-missing>`;
    }
    return html`
      <stat-tile-delta
        label="Cost"
        value=${cost.value}
        .delta=${cost.delta}
        sampleLabel=${cost.sampleLabel}
      ></stat-tile-delta>
    `;
  }

  private renderCleanCompletionTile(clean: ReturnType<typeof kpiBandToCleanCompletionView>) {
    if (clean.kind === 'missing') {
      return html`
        <stat-tile-missing label="Clean completion" reason=${clean.reason}></stat-tile-missing>
      `;
    }
    return html`
      <stat-ring
        label="Clean completion"
        percent=${clean.percent}
        centerText=${clean.centerText}
        sampleLabel=${clean.sampleLabel}
      ></stat-ring>
    `;
  }

  private tokenTrendSeries(): ChartSeries | null {
    return this.trends.data ? tokenTrendToChartSeries(this.trends.data, this.sessionsScope) : null;
  }

  private renderTrendRow() {
    const tokenSeries = this.tokenTrendSeries();
    const modelSeries = this.sessionsByModel.data
      ? sessionsByModelToChartSeries(this.sessionsByModel.data)
      : null;

    return html`
      <div class="section split-row">
        <div>
          <analytics-chart
            title="Token usage trend"
            description="Daily cache write, cache read, output, and total tokens across the portfolio."
            .series=${tokenSeries}
            .state=${this.chartState(this.trends.state)}
          ></analytics-chart>
          ${this.renderTokenTrendCaption()}
        </div>
        <div>
          <analytics-chart
            title="Sessions by model"
            .series=${modelSeries}
            .state=${this.chartState(this.sessionsByModel.state)}
          ></analytics-chart>
          ${this.renderSessionsByModelCaption()}
        </div>
      </div>
    `;
  }

  private renderTokenTrendCaption() {
    const token = this.trends.data?.token;
    if (!token) return null;
    return html`<p class="chart-caption">n=${token.knownN} of ${token.eligibleN} days</p>`;
  }

  private renderSessionsByModelCaption() {
    const token = this.sessionsByModel.data?.token;
    if (!token) return null;
    return html`
      <p class="chart-caption">
        n=${token.knownN} sessions ·
        ${SESSIONS_SCOPE_CAPTION[this.sessionsScope]}
      </p>
    `;
  }

  private renderHeatmapDomainsRow() {
    const heatmapSeries = this.matrix.data
      ? modelHarnessMatrixToHeatmapSeries(this.matrix.data)
      : null;
    const domainSeries = this.invocations.data
      ? invocationsByDomainToChartSeries(this.invocations.data, this.filters)
      : null;
    const domainRows = this.invocations.data
      ? invocationsByDomainToRows(this.invocations.data, this.filters)
      : [];

    return html`
      <div class="section split-row">
        <analytics-chart
          title="Sessions by model × harness"
          description="Session counts for every observed (model, harness) combination. A dashed cell means that combination has never run."
          .series=${heatmapSeries}
          .state=${this.chartState(this.matrix.state)}
        ></analytics-chart>
        <div>
          <analytics-chart
            title="Invocations by domain"
            description="Tool, Skill, Agent, and Sub Agent invocation counts across the portfolio."
            .series=${domainSeries}
            .state=${this.chartState(this.invocations.state)}
            @point-click=${this.handlePointClick}
          ></analytics-chart>
          ${this.renderDomainFootnote(domainRows)}
        </div>
      </div>
    `;
  }

  private renderDomainFootnote(rows: DomainBarRowView[]) {
    if (rows.length === 0) return null;
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    return html`
      <p class="domain-footnote">
        n=${total} invocations across four canonical domains — Tool, Skill, Agent, Sub Agent.
        <a href="#/mcp">MCP servers →</a>
      </p>
    `;
  }

  private renderLeaderboard() {
    if (this.leaderboard.state === 'error') {
      return html`<div class="panel-error" role="alert">${this.leaderboard.error}</div>`;
    }
    if (!this.leaderboard.data) {
      return html`<div class="chart-caption" role="status">Loading project leaderboard…</div>`;
    }
    const rows = projectLeaderboardToRows(this.leaderboard.data, this.filters);
    if (rows.length === 0) {
      return html`<div class="chart-caption">No projects found.</div>`;
    }

    return html`
      <div class="section">
        <div class="section-header">
          <h2>Project leaderboard</h2>
          <span class="section-caption">
            All time · ranked by token volume · <a href="#/projects">View all</a>
          </span>
        </div>
        ${this.renderLeaderboardTable(rows)}
      </div>
    `;
  }

  private renderLeaderboardTable(rows: ProjectLeaderboardRowView[]) {
    return html`
      <table class="leaderboard">
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col">Sessions</th>
            <th scope="col">Tokens</th>
            <th scope="col">Clean rate</th>
            <th scope="col">Last active</th>
            <th scope="col">30d trend</th>
          </tr>
        </thead>
        <tbody>
          ${repeat(
            rows,
            (row) => row.href,
            (row) => this.renderLeaderboardRow(row),
          )}
        </tbody>
      </table>
    `;
  }

  private renderLeaderboardRow(row: ProjectLeaderboardRowView) {
    // No click handler: `row.href` is a same-page `#/projects/...` link, and
    // the app's `HashRouter` already intercepts every such anchor click
    // globally (`router.ts`'s `handleAnchorClick`) — a per-row handler here
    // would only reallocate a closure on every render for no behavioral
    // difference.
    return html`
      <tr>
        <td>
          <a href=${row.href}>
            <span class="project-name">
              <span class="color-dot" style="background:${row.color}"></span>
              ${row.name}
            </span>
          </a>
        </td>
        <td>${row.sessionCount}</td>
        <td>
          <span class="tokens-cell">
            <span class="tokens-bar-track">
              <span class="tokens-bar-fill" style="width:${row.tokensFraction * 100}%"></span>
            </span>
            ${row.tokensValue}
          </span>
          <div class="cell-caption">${row.tokensSampleLabel}</div>
        </td>
        <td>
          ${row.cleanRateText}
          <div class="cell-caption">${row.cleanRateSampleLabel}</div>
        </td>
        <td>${row.lastActiveText}</td>
        <td>
          <span role="img" aria-label=${row.trendAriaLabel}>
            <rd-sparkline .points=${row.trendPoints} width="80" height="24"></rd-sparkline>
          </span>
        </td>
      </tr>
    `;
  }

  render() {
    return html`
      <div class="portfolio-view">
        ${this.renderTitleRow()}
        ${this.renderFilters()}
        <div class="section">${this.renderKpiBand()}</div>
        ${this.renderTrendRow()}
        ${this.renderHeatmapDomainsRow()}
        ${this.renderLeaderboard()}
      </div>
    `;
  }
}

const SESSIONS_SCOPE_CAPTION: Record<SessionsScope, string> = {
  main: 'main sessions only',
  all: 'including sub agents',
  sub_agents: 'sub-agent sessions only',
};

/** Cursor/list-page DTOs expose `items`; the trend/bar-list DTOs expose
 * `series`/`rows` instead — checked so a range narrowed to zero rows renders
 * the empty affordance rather than being silently mistaken for 'ok'
 * (`.agents/rules/no-silent-empty-states.md`). */
function panelStateFromResult<T>(result: PromiseSettledResult<T>): PanelState<T> {
  if (result.status === 'fulfilled') {
    const data = result.value;
    return { data, state: isEmptyPanelData(data) ? 'empty' : 'ok' };
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
  if ('rows' in data) return (data as { rows: unknown[] }).rows.length === 0;
  if ('cells' in data) return (data as { cells: unknown[] }).cells.length === 0;
  return false;
}

declare global {
  interface HTMLElementTagNameMap {
    'portfolio-view': PortfolioView;
  }
}
