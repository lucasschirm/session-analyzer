import { css, html, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import { styleMap } from 'lit/directives/style-map.js';
import { analyticsClient } from '../../db/analytics-client';
import { navigateTo } from '../../router';
import { PageLitElement, pageHostStyles } from '../page-lit-element';
import '../../components/charts/analytics-chart';
import '../../components/analytics/analytics-card';
import '../../components/analytics/filter-bar';
import '../../components/analytics/stat-tile-hero';
import '../../components/analytics/stat-tile-delta';
import '../../components/analytics/stat-tile-missing';
import type {
  DimensionDomains,
  ProjectHeader,
  ProjectModelHarnessCohorts,
  ProjectStatStrip,
  SessionDurationHistogram,
  SessionOutcomeDistribution,
  TopToolsList,
  WeeklyToolErrorRateSeries,
} from '@lucasschirm/sal-db';
import type { ChartSeries, ChartState } from '../../components/charts/chart-types';
import {
  detectRangeSelection,
  type PortfolioParams,
  type RangeSelection,
} from '../portfolio/portfolio-params';
import {
  durationHistogramSampleLabel,
  durationHistogramToChartSeries,
  headerToView,
  type ModelCohortRowView,
  modelCohortsToRows,
  type OutcomeMixView,
  outcomeMixToView,
  type StatStripView,
  statStripToView,
  topToolsToChartSeries,
  weeklyToolErrorRateNote,
  weeklyToolErrorRateToChartSeries,
} from './project-behavior-chart-helpers';
import {
  buildProjectBehaviorHash,
  fromFilterBarParams,
  type ProjectBehaviorParams,
  parseProjectBehaviorHash,
  projectBehaviorParamsToQuery,
  toFilterBarParams,
} from './project-behavior-params';

type LoadState = 'idle' | 'loading' | 'ok' | 'empty' | 'partial' | 'error';

// Stable empty-array references for `.harnessOptions`/`.modelOptions` bindings
// below: `filter-bar`'s `@property({ type: Array })` uses reference equality,
// so a fresh `?? []` literal on every render would look like a changed prop
// and trigger an unnecessary re-render of the child component.
const EMPTY_STRING_LIST: readonly string[] = [];

interface PanelState<T> {
  data: T | null;
  state: LoadState;
  error?: string;
}

/** Keyed shape of {@link ProjectBehaviorView.fetchPanels}' settled results —
 * named fields instead of array positions, so `applyCorePanels`/
 * `applyRemainingPanels` can't be silently desynced from a reorder of the
 * underlying request list. */
interface PanelResults {
  header: PromiseSettledResult<ProjectHeader>;
  statStrip: PromiseSettledResult<ProjectStatStrip>;
  histogram: PromiseSettledResult<SessionDurationHistogram>;
  outcomes: PromiseSettledResult<SessionOutcomeDistribution>;
  toolErrorRate: PromiseSettledResult<WeeklyToolErrorRateSeries>;
  topTools: PromiseSettledResult<TopToolsList>;
  modelCohorts: PromiseSettledResult<ProjectModelHarnessCohorts>;
  domains: PromiseSettledResult<DimensionDomains>;
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
 * Project Behavior drill-down (issue #171): breadcrumb + header, stat strip,
 * duration histogram / outcome mix, tool error rate / top tools, and model
 * cohorts table — all sourced from `AnalyticsDataSource.project`. No SQL, no
 * metric formulas: every value shown is already computed by the db layer.
 */
@customElement('project-behavior-view')
export class ProjectBehaviorPage extends PageLitElement {
  static styles = [
    pageHostStyles,
    css`
    :host {
      color: var(--rd-ink-primary, #e6e9ef);
    }

    .back-link {
      color: var(--rd-accent, #4f8cff);
      text-decoration: none;
      font-size: 13px;
    }

    .back-link:hover {
      text-decoration: underline;
    }

    .header-row {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin: 12px 0 20px;
    }

    h1 {
      margin: 0;
      font-size: 26px;
    }

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .chips span {
      font-size: 12px;
      color: var(--rd-ink-muted, #9aa4b2);
      background: var(--rd-surface-card, #171b24);
      border: 1px solid var(--rd-border-2, #232936);
      border-radius: 999px;
      padding: 4px 10px;
    }

    filter-bar {
      display: block;
      margin-bottom: 20px;
    }

    .stat-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 14px;
      margin-bottom: 20px;
    }

    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      margin-bottom: 20px;
    }

    .outcome-bar {
      display: flex;
      gap: 2px;
      height: 14px;
      border-radius: 7px;
      overflow: hidden;
      margin-bottom: 12px;
    }

    .outcome-segment {
      height: 100%;
    }

    .outcome-legend {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .outcome-legend-row {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
    }

    .outcome-swatch {
      width: 10px;
      height: 10px;
      border-radius: 3px;
      flex-shrink: 0;
    }

    .outcome-count {
      margin-left: auto;
      font-variant-numeric: tabular-nums;
      color: var(--rd-ink-muted, #9aa4b2);
    }

    .outcome-footnote {
      margin-top: 10px;
      font-size: 12px;
      color: var(--rd-ink-faint, #7d8794);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    th, td {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid var(--rd-border-1, #20242e);
    }

    th {
      color: var(--rd-ink-muted, #9aa4b2);
      font-weight: 600;
    }

    .tokens-bar-track {
      display: inline-block;
      width: 60px;
      height: 6px;
      background: var(--rd-border-1, #20242e);
      border-radius: 3px;
      overflow: hidden;
      vertical-align: middle;
      margin-right: 6px;
    }

    .tokens-bar-fill {
      height: 100%;
      background: var(--rd-accent, #4f8cff);
    }

    .low-n {
      color: var(--rd-ink-faint, #7d8794);
    }

    .error {
      color: var(--rd-accent-error, #ff6b6b);
      font-size: 13px;
      padding: 12px;
    }

    .footer-note {
      font-size: 12px;
      color: var(--rd-ink-faint, #7d8794);
      margin-top: 8px;
    }
  `,
  ];

  @property({ type: String, attribute: 'project-id' }) projectId = '';

  @state() private filters: ProjectBehaviorParams = { projectId: '' };

  @state() private globalState: LoadState = 'idle';

  @state() private globalError: string | null = null;

  @state() private header: PanelState<ProjectHeader> = { data: null, state: 'idle' };

  @state() private statStrip: PanelState<ProjectStatStrip> = { data: null, state: 'idle' };

  @state() private histogram: PanelState<SessionDurationHistogram> = { data: null, state: 'idle' };

  @state() private outcomes: PanelState<SessionOutcomeDistribution> = { data: null, state: 'idle' };

  @state() private toolErrorRate: PanelState<WeeklyToolErrorRateSeries> = {
    data: null,
    state: 'idle',
  };

  @state() private topTools: PanelState<TopToolsList> = { data: null, state: 'idle' };

  @state() private modelCohorts: PanelState<ProjectModelHarnessCohorts> = {
    data: null,
    state: 'idle',
  };

  @state() private domains: DimensionDomains | null = null;

  // Memoized view-model transforms: recomputed in `willUpdate` only when the
  // source `PanelState` (or, for the stat strip, the range selection) actually
  // changes, not on every unrelated `render()` (e.g. another panel resolving).
  @state() private headerView: ReturnType<typeof headerToView> | null = null;

  @state() private statStripView: StatStripView | null = null;

  @state() private outcomesView: OutcomeMixView | null = null;

  @state() private modelCohortRows: ModelCohortRowView[] | null = null;

  @state() private filterBarParams: PortfolioParams = toFilterBarParams({ projectId: '' }, '');

  private hashListener = () => this.handleHashChange();

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('hashchange', this.hashListener);
    if (this.projectId) void this.load();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('hashchange', this.hashListener);
  }

  willUpdate(changed: PropertyValues): void {
    // `connectedCallback` already triggers the initial load; on the very
    // first update cycle every reactive property (including `projectId`)
    // reports as "changed", so without the `hasUpdated` guard this would
    // fire a second, redundant sweep of all seven panel queries back-to-back
    // with the one from `connectedCallback`. Only react here to genuine
    // post-mount `projectId` changes (e.g. navigating between projects
    // without a full page reload).
    if (this.hasUpdated && changed.has('projectId') && this.projectId) void this.load();
    this.recomputeViews(changed);
  }

  private recomputeViews(changed: PropertyValues): void {
    if (changed.has('header')) {
      this.headerView = this.header.data ? headerToView(this.header.data) : null;
    }
    if (changed.has('statStrip') || changed.has('filters')) {
      this.statStripView = this.statStrip.data
        ? statStripToView(this.statStrip.data, this.rangeSelection())
        : null;
    }
    if (changed.has('outcomes')) {
      this.outcomesView = this.outcomes.data ? outcomeMixToView(this.outcomes.data) : null;
    }
    if (changed.has('modelCohorts')) {
      this.modelCohortRows = this.modelCohorts.data
        ? modelCohortsToRows(this.modelCohorts.data)
        : null;
    }
    if (changed.has('filters') || changed.has('header')) {
      const projectLabel = this.header.data?.displayName ?? this.projectId;
      this.filterBarParams = toFilterBarParams(this.filters, projectLabel);
    }
  }

  private handleHashChange(): void {
    if (window.location.hash.startsWith(`#/projects/${this.projectId}`)) void this.load();
  }

  private async resolveProject(): Promise<string | null> {
    const decoded = (() => {
      try {
        return decodeURIComponent(this.projectId);
      } catch {
        return this.projectId;
      }
    })();
    try {
      return await analyticsClient.resolveProjectId(decoded);
    } catch {
      return null;
    }
  }

  private panelRequests(resolved: string, query: ReturnType<typeof projectBehaviorParamsToQuery>) {
    return {
      header: analyticsClient.project.getHeader(resolved),
      statStrip: analyticsClient.project.getStatStrip(resolved, query),
      histogram: analyticsClient.project.getDurationHistogram(resolved, query),
      outcomes: analyticsClient.project.getOutcomeMix(resolved, query),
      toolErrorRate: analyticsClient.project.getWeeklyToolErrorRate(resolved, query),
      topTools: analyticsClient.project.getTopTools(resolved, query),
      modelCohorts: analyticsClient.project.getModelHarnessCohorts(resolved, query),
      domains: analyticsClient.metadata.getDimensionDomains(),
    };
  }

  /** Settles every panel request keyed by name — never by array position —
   * so a reorder of {@link panelRequests}' fields can't silently misassign
   * a result to the wrong panel. */
  private async fetchPanels(
    resolved: string,
    query: ReturnType<typeof projectBehaviorParamsToQuery>,
  ): Promise<PanelResults> {
    const requests = this.panelRequests(resolved, query);
    const keys = Object.keys(requests) as (keyof typeof requests)[];
    const settled = await Promise.allSettled(keys.map((key) => requests[key]));
    return Object.fromEntries(keys.map((key, i) => [key, settled[i]])) as unknown as PanelResults;
  }

  private async load(): Promise<void> {
    this.globalState = 'loading';
    this.globalError = null;
    const resolved = await this.resolveProject();
    if (!resolved) {
      // An unresolvable project (e.g. referenced only by a sync that never
      // produced a valid session record) has no panel data to fetch — every
      // panel must still transition out of its initial 'idle' state, or
      // each chart renders a blank container instead of an empty affordance
      // (chartState() maps 'idle' to null, which echarts-base treats as
      // "show the data surface", not "show the empty state").
      this.markAllPanelsEmpty();
      this.globalState = 'empty';
      return;
    }

    this.filters = { ...parseProjectBehaviorHash(window.location.hash), projectId: this.projectId };
    const query = projectBehaviorParamsToQuery(this.filters);
    this.applyResults(await this.fetchPanels(resolved, query));
  }

  private markAllPanelsEmpty(): void {
    const empty = { data: null, state: 'empty' as const };
    this.header = empty;
    this.statStrip = empty;
    this.histogram = empty;
    this.outcomes = empty;
    this.toolErrorRate = empty;
    this.topTools = empty;
    this.modelCohorts = empty;
  }

  private applyCorePanels(results: PanelResults): void {
    this.header = panelStateFromResult(results.header, () => false);
    this.statStrip = panelStateFromResult(results.statStrip, () => false);
    this.histogram = panelStateFromResult(results.histogram, (d) => d.eligibleN === 0);
  }

  private applyRemainingPanels(results: PanelResults): void {
    this.outcomes = panelStateFromResult(results.outcomes, (d) =>
      d.buckets.every((b) => b.count === 0),
    );
    this.toolErrorRate = panelStateFromResult(results.toolErrorRate, (d) => d.series.length === 0);
    this.topTools = panelStateFromResult(results.topTools, (d) => d.rows.length === 0);
    this.modelCohorts = panelStateFromResult(results.modelCohorts, (d) => d.rows.length === 0);
    this.domains = results.domains.status === 'fulfilled' ? results.domains.value : this.domains;
  }

  private applyResults(results: PanelResults): void {
    this.applyCorePanels(results);
    this.applyRemainingPanels(results);
    this.summarizeGlobalState();
  }

  private summarizeGlobalState(): void {
    const states = [
      this.header.state,
      this.statStrip.state,
      this.histogram.state,
      this.outcomes.state,
      this.toolErrorRate.state,
      this.topTools.state,
      this.modelCohorts.state,
    ];
    if (states.every((s) => s === 'ok' || s === 'empty')) {
      this.globalState = states.some((s) => s === 'ok') ? 'ok' : 'empty';
      return;
    }
    if (states.some((s) => s === 'ok')) {
      this.globalState = 'partial';
      return;
    }
    this.globalState = 'error';
    this.globalError = 'All project behavior views failed to load.';
  }

  private handleFiltersChanged(event: CustomEvent<PortfolioParams>): void {
    const next = fromFilterBarParams(this.filters, event.detail);
    navigateTo(`/projects/${this.projectId}${buildProjectBehaviorHash(next)}`);
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

  private rangeSelection(): RangeSelection {
    return detectRangeSelection(this.filters);
  }

  private renderBreadcrumb() {
    const back = this.filters.returnContext
      ? `#/?${new URLSearchParams(this.filters.returnContext).toString()}`
      : '#/';
    return html`<a class="back-link" href=${back}>← Portfolio</a>`;
  }

  private renderHeader() {
    const view = this.headerView;
    if (!view) return null;
    return html`
      <div class="header-row">
        <h1>${view.displayName}</h1>
        <div class="chips">
          <span>${view.harnessesLabel}</span>
          <span>${view.sessionCountLabel}</span>
          <span>${view.activeWindowLabel}</span>
        </div>
      </div>
      <!-- Compare period: deferred, see issue #250 -->
    `;
  }

  private renderFilters() {
    return html`
      <filter-bar
        .filters=${this.filterBarParams}
        .harnessOptions=${this.header.data?.harnesses ?? EMPTY_STRING_LIST}
        .modelOptions=${this.domains?.models ?? EMPTY_STRING_LIST}
        ?projectFixed=${true}
        @filters-changed=${this.handleFiltersChanged}
      ></filter-bar>
    `;
  }

  private renderStatTile(tile: StatStripView['sessions'], label: string, footnote = '') {
    return html`
      <stat-tile-delta
        label=${label}
        value=${tile.value}
        .delta=${tile.delta}
        sampleLabel=${footnote || tile.sampleLabel}
      ></stat-tile-delta>
    `;
  }

  private renderCostTile(view: StatStripView['cost']) {
    if (view.missing) {
      return html`
        <stat-tile-missing
          label="Cost / session"
          reason=${view.reason ?? ''}
        ></stat-tile-missing>
      `;
    }
    return html`
      <stat-tile-delta
        label="Cost / session"
        value=${view.value}
        sampleLabel=${view.sampleLabel}
      ></stat-tile-delta>
    `;
  }

  private renderStatStripDuration(view: StatStripView) {
    return html`
      <stat-tile-delta
        label="Median duration"
        value=${view.duration.value}
        sampleLabel=${view.duration.sampleLabel}
      ></stat-tile-delta>
      <stat-tile-delta
        label="Median turns"
        value=${view.turns.value}
        sampleLabel=${view.turns.sampleLabel}
      ></stat-tile-delta>
    `;
  }

  private renderStatStrip() {
    if (this.statStrip.state === 'error') {
      return html`<div class="error">${this.statStrip.error}</div>`;
    }
    const view = this.statStripView;
    if (!view) return null;
    return html`
      <div class="stat-grid">
        ${this.renderStatTile(view.sessions, 'Sessions')}
        ${this.renderStatStripDuration(view)}
        ${this.renderStatTile(view.tokensPerSession, 'Tokens / session')}
        ${this.renderCostTile(view.cost)}
      </div>
    `;
  }

  private renderHistogram() {
    const series: ChartSeries | null = this.histogram.data
      ? durationHistogramToChartSeries(this.histogram.data)
      : null;
    const sampleLabel = this.histogram.data
      ? durationHistogramSampleLabel(this.histogram.data)
      : '';
    return html`
      <analytics-chart
        title="Session duration"
        description="Session count by duration bucket, binned by the registry-defined edges."
        .series=${series}
        .state=${this.chartState(this.histogram.state)}
      ></analytics-chart>
      ${sampleLabel ? html`<div class="footer-note">${sampleLabel}</div>` : null}
    `;
  }

  /** Textual summary for the stacked bar's `aria-label` — joins the already
   * -computed legend rows into one sentence so screen-reader users get the
   * same status-and-percentage information sighted users read from color
   * (`.agents/agents/lit-performance-optimizer.md` §11.4 color-independent
   * status encoding). No metric math: `row.label`/`count`/`percent` are
   * pre-formatted view fields from `outcomeMixToView`. */
  private outcomeBarAriaLabel(view: OutcomeMixView): string {
    const parts = view.rows.map((row) => `${row.label} ${row.percent}% (${row.count})`);
    return `Session outcomes: ${parts.join(', ')}`;
  }

  private renderOutcomeSegments(view: OutcomeMixView) {
    return repeat(
      view.rows.filter((r) => r.count > 0),
      (row) => row.outcome,
      (row) => html`
        <div
          class="outcome-segment"
          style=${styleMap({ width: `${row.percent}%`, background: row.color })}
          title="${row.label}: ${row.count} (${row.percent}%)"
        ></div>
      `,
    );
  }

  private renderOutcomeLegend(view: OutcomeMixView) {
    return repeat(
      view.rows,
      (row) => row.outcome,
      (row) => html`
        <div class="outcome-legend-row">
          <span class="outcome-swatch" style=${styleMap({ background: row.color })}></span>
          <span>${row.label}</span>
          <span class="outcome-count">${row.count} (${row.percent}%)</span>
        </div>
      `,
    );
  }

  private renderOutcomes() {
    if (this.outcomes.state === 'error') {
      return html`<analytics-card cardTitle="Session outcomes"><div class="error">${this.outcomes.error}</div></analytics-card>`;
    }
    if (!this.outcomes.data || this.outcomes.data.buckets.length === 0 || !this.outcomesView) {
      return html`<analytics-card cardTitle="Session outcomes"><div class="footer-note">No sessions yet.</div></analytics-card>`;
    }
    const view = this.outcomesView;
    return html`
      <analytics-card cardTitle="Session outcomes">
        <div
          class="outcome-bar"
          role="img"
          aria-label=${this.outcomeBarAriaLabel(view)}
        >${this.renderOutcomeSegments(view)}</div>
        <div class="outcome-legend">${this.renderOutcomeLegend(view)}</div>
        <div class="outcome-footnote">
          n=${view.total} sessions • derived from each session's final native event.
          ${
            view.unreadableTailCount > 0
              ? html`${view.unreadableTailCount} session${view.unreadableTailCount === 1 ? '' : 's'} had an unreadable tail (${view.unreadableTailPercent}%).`
              : ''
          }
        </div>
      </analytics-card>
    `;
  }

  private renderToolErrorRate() {
    const series: ChartSeries | null = this.toolErrorRate.data
      ? weeklyToolErrorRateToChartSeries(this.toolErrorRate.data)
      : null;
    const note = this.toolErrorRate.data ? weeklyToolErrorRateNote(this.toolErrorRate.data) : '';
    return html`
      <analytics-chart
        title="Tool error rate"
        description="Weekly share of tool-kind invocations that failed, against the registry-defined review threshold."
        .series=${series}
        .state=${this.chartState(this.toolErrorRate.state)}
      ></analytics-chart>
      ${note ? html`<div class="footer-note">${note}</div>` : null}
    `;
  }

  private renderTopTools() {
    const series: ChartSeries | null = this.topTools.data
      ? topToolsToChartSeries(this.topTools.data)
      : null;
    return html`
      <analytics-chart
        title="Top tools"
        description="Tool invocations, ranked by count. Skills, Agents, and MCP servers have their own pages."
        .series=${series}
        .state=${this.chartState(this.topTools.state)}
      ></analytics-chart>
      <div class="footer-note">Tools only — Skills, Agents, and MCP servers are tracked separately.</div>
    `;
  }

  private renderCohortRow(row: ModelCohortRowView) {
    return html`
      <tr>
        <td>${row.model}</td>
        <td>${row.harness}</td>
        <td>${row.n}</td>
        <td>
          <span class="tokens-bar-track">
            <span
              class="tokens-bar-fill"
              style=${styleMap({ width: `${row.medianTokensBarPercent}%` })}
            ></span>
          </span>
          ${row.medianTokensLabel}
        </td>
        <td class=${classMap({ 'low-n': row.lowN })}>${row.cleanRateLabel}</td>
        <td>${row.medianCostLabel}</td>
      </tr>
    `;
  }

  private renderCohortsTable(rows: ModelCohortRowView[]) {
    return html`
      <table>
        <thead>
          <tr>
            <th scope="col">Model</th><th scope="col">Harness</th><th scope="col">Sessions</th>
            <th scope="col">Median tokens</th><th scope="col">Clean rate</th><th scope="col">Median cost</th>
          </tr>
        </thead>
        <tbody>
          ${repeat(
            rows,
            (row) => `${row.model}|${row.harness}`,
            (row) => this.renderCohortRow(row),
          )}
        </tbody>
      </table>
    `;
  }

  private renderModelCohorts() {
    if (this.modelCohorts.state === 'error') {
      return html`<analytics-card cardTitle="Model cohorts"><div class="error">${this.modelCohorts.error}</div></analytics-card>`;
    }
    if (
      !this.modelCohorts.data ||
      this.modelCohorts.data.rows.length === 0 ||
      !this.modelCohortRows
    ) {
      return html`<analytics-card cardTitle="Model cohorts"><div class="footer-note">No model activity in this window.</div></analytics-card>`;
    }
    return html`
      <analytics-card cardTitle="Model × harness cohorts">
        ${this.renderCohortsTable(this.modelCohortRows)}
      </analytics-card>
    `;
  }

  render() {
    return html`
      <div class="project-behavior-view">
        ${this.renderBreadcrumb()}
        ${
          this.globalState === 'error' && this.globalError
            ? html`<div class="error" role="alert">${this.globalError}</div>`
            : ''
        }
        ${this.renderHeader()}
        ${this.renderFilters()}
        ${this.renderStatStrip()}
        <div class="row">${this.renderHistogram()}${this.renderOutcomes()}</div>
        <div class="row">${this.renderToolErrorRate()}${this.renderTopTools()}</div>
        ${this.renderModelCohorts()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'project-behavior-view': ProjectBehaviorPage;
  }
}
