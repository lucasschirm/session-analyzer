import type {
  ArtifactDiff,
  ComponentDistributionPage,
  ComponentEcosystemSummary,
  ComponentProjectSessionPage,
  ComponentScopePage,
  ComponentUtilizationDetail,
  ComponentVersionPage,
  LifecycleComparisonPage,
} from '@lucasschirm/sal-db';
import { css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { PageLitElement, pageHostStyles } from '../page-lit-element';
import '../../components/charts/analytics-chart';
import '../../components/metrics-card';
import type {
  ChartEvidenceLink,
  ChartSeries,
  ChartState,
} from '../../components/charts/chart-types';
import { analyticsClient } from '../../db/analytics-client';
import { navigateTo } from '../../router';
import type { MetricCardView } from './component-ecosystem-chart-helpers';
import {
  countsByKindToChartSeries,
  distributionsToChartSeries,
  lifecycleToChartSeries,
  lifecycleToRows,
  projectSessionsToRows,
  scopesToChartSeries,
  scopesToRows,
  summaryToMetricCards,
  topByUtilizationToChartSeries,
  utilizationToMetricCards,
  versionsToChartSeries,
  versionsToRows,
} from './component-ecosystem-chart-helpers';
import type { ComponentEcosystemParams } from './component-ecosystem-params';
import {
  buildComponentEcosystemHash,
  componentEcosystemParamsToQuery,
  originHref,
  parseComponentEcosystemHash,
} from './component-ecosystem-params';

type LoadState = 'idle' | 'loading' | 'ok' | 'empty' | 'partial' | 'error';

interface PanelState<T> {
  data: T | null;
  state: LoadState;
  error?: string;
}

@customElement('component-ecosystem-view')
export class ComponentEcosystemView extends PageLitElement {
  static styles = [
    pageHostStyles,
    css`
    :host {
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    h1 {
      margin: 0 0 16px;
      font-size: 24px;
    }

    h2 {
      margin: 0 0 16px;
      font-size: 18px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .breadcrumbs {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 16px;
      font-size: 13px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .breadcrumbs a {
      color: var(--md-sys-color-primary, #4f8cff);
      text-decoration: none;
    }

    .breadcrumbs a:hover {
      text-decoration: underline;
    }

    .breadcrumbs .current {
      color: var(--md-sys-color-on-surface, #e6e9ef);
      font-weight: 600;
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
      margin-bottom: 16px;
    }

    metrics-card {
      cursor: pointer;
    }

    .kind-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }

    .kind-grid span {
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 12px;
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
      font-size: 13px;
      padding: 12px 0;
    }

    .pagination {
      display: flex;
      gap: 12px;
      margin-top: 12px;
    }

    .pagination button {
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 6px;
      padding: 8px 16px;
      font: inherit;
      cursor: pointer;
    }

    .pagination button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .diff-panel {
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      padding: 16px;
      margin-top: 16px;
    }

    .diff-line {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
      padding: 2px 0;
    }

    .diff-added {
      color: #3ecf8e;
    }

    .diff-removed {
      color: #ff6b6b;
    }

    .diff-metadata {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 8px;
      margin-bottom: 12px;
    }
  `,
  ];

  @property({ type: String }) componentId = '';

  @state() private filters: ComponentEcosystemParams = parseComponentEcosystemHash(
    window.location.hash,
    this.componentId,
  );

  @state() private loading = false;

  @state() private globalState: LoadState = 'idle';

  @state() private globalError: string | null = null;

  @state() private summary: PanelState<ComponentEcosystemSummary> = { data: null, state: 'idle' };

  @state() private versions: PanelState<ComponentVersionPage> = { data: null, state: 'idle' };

  @state() private scopes: PanelState<ComponentScopePage> = { data: null, state: 'idle' };

  @state() private utilization: PanelState<ComponentUtilizationDetail> = {
    data: null,
    state: 'idle',
  };

  @state() private distributions: PanelState<ComponentDistributionPage> = {
    data: null,
    state: 'idle',
  };

  @state() private projectSessions: PanelState<ComponentProjectSessionPage> = {
    data: null,
    state: 'idle',
  };

  @state() private lifecycle: PanelState<LifecycleComparisonPage> = { data: null, state: 'idle' };

  @state() private diff: ArtifactDiff | null = null;

  @state() private diffError: string | null = null;

  @state() private diffLoading = false;

  private hashListener = () => this.handleHashChange();

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('hashchange', this.hashListener);
    this.load();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('hashchange', this.hashListener);
  }

  private handleHashChange(): void {
    if (window.location.hash.startsWith('#/artifacts')) {
      this.filters = parseComponentEcosystemHash(window.location.hash, this.componentId);
      this.load();
    }
  }

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.globalState = 'loading';
    this.globalError = null;
    this.diff = null;
    this.diffError = null;

    const query = componentEcosystemParamsToQuery(this.filters);

    if (this.componentId) {
      const [summary, versions, scopes, utilization, distributions, projectSessions, lifecycle] =
        await Promise.allSettled([
          analyticsClient.component.getSummary(query),
          analyticsClient.component.getVersions(this.componentId, query),
          analyticsClient.component.getScopes(this.componentId, query),
          analyticsClient.component.getUtilization(this.componentId, query),
          analyticsClient.component.getDistributions(this.componentId, query),
          analyticsClient.component.getProjectsSessions(this.componentId, query),
          analyticsClient.component.getLifecycleComparisons(this.componentId, query),
        ]);

      this.summary = panelStateFromResult(summary);
      this.versions = panelStateFromResult(versions);
      this.scopes = panelStateFromResult(scopes);
      this.utilization = panelStateFromResult(utilization);
      this.distributions = panelStateFromResult(distributions);
      this.projectSessions = panelStateFromResult(projectSessions);
      this.lifecycle = panelStateFromResult(lifecycle);

      const states = [
        this.versions.state,
        this.scopes.state,
        this.utilization.state,
        this.distributions.state,
        this.projectSessions.state,
        this.lifecycle.state,
      ];
      if (states.every((s) => s === 'ok' || s === 'empty')) {
        this.globalState = states.some((s) => s === 'ok') ? 'ok' : 'empty';
      } else if (states.some((s) => s === 'ok')) {
        this.globalState = 'partial';
      } else {
        this.globalState = 'error';
        this.globalError = 'Component detail views failed to load.';
      }

      if (this.filters.leftVersion && this.filters.rightVersion) {
        void this.loadDiff();
      }
    } else {
      const [summary] = await Promise.allSettled([analyticsClient.component.getSummary(query)]);
      this.summary = panelStateFromResult(summary);

      if (this.summary.state === 'error') {
        this.globalState = 'error';
        this.globalError = this.summary.error ?? 'Component ecosystem summary failed to load.';
      } else if (this.summary.state === 'empty') {
        this.globalState = 'empty';
      } else {
        this.globalState = 'ok';
      }
    }

    this.loading = false;
  }

  private async loadDiff(): Promise<void> {
    if (!this.filters.leftVersion || !this.filters.rightVersion) return;
    this.diffLoading = true;
    try {
      this.diff = await analyticsClient.artifact.getDiff(
        this.filters.leftVersion,
        this.filters.rightVersion,
        componentEcosystemParamsToQuery(this.filters),
      );
      this.diffError = null;
    } catch (error) {
      this.diff = null;
      this.diffError = error instanceof Error ? error.message : 'Diff unavailable';
    } finally {
      this.diffLoading = false;
    }
  }

  private updateFilter(key: keyof ComponentEcosystemParams, value: string): void {
    const next = { ...this.filters, [key]: value };
    if (value === '') {
      delete next[key];
    }
    if (this.componentId) {
      next.component = this.componentId;
    }
    navigateTo(buildComponentEcosystemHash(next).replace(/^#/, ''));
  }

  private resetFilters(): void {
    const base: ComponentEcosystemParams = this.componentId
      ? {
          component: this.componentId,
          origin: this.filters.origin,
          returnContext: this.filters.returnContext,
        }
      : { origin: this.filters.origin, returnContext: this.filters.returnContext };
    navigateTo(buildComponentEcosystemHash(base).replace(/^#/, ''));
  }

  private selectVersion(version: string): void {
    const next = { ...this.filters, version };
    navigateTo(buildComponentEcosystemHash(next).replace(/^#/, ''));
  }

  private compareVersions(rightVersion: string): void {
    const leftVersion = this.filters.version;
    if (!leftVersion) {
      this.selectVersion(rightVersion);
      return;
    }
    const next = { ...this.filters, leftVersion, rightVersion, version: undefined };
    navigateTo(buildComponentEcosystemHash(next).replace(/^#/, ''));
  }

  private handlePointClick(event: CustomEvent<ChartEvidenceLink>): void {
    const link = event.detail;
    if (link?.href) {
      navigateTo(link.href.replace(/^#/, ''));
    }
  }

  private goToMetric(metric: MetricCardView): void {
    if (metric.href) navigateTo(metric.href.replace(/^#/, ''));
  }

  private goToPage(cursor: string | undefined): void {
    if (!cursor) return;
    const next = { ...this.filters, cursor };
    navigateTo(buildComponentEcosystemHash(next).replace(/^#/, ''));
  }

  private componentKind(): string | undefined {
    if (this.filters.kind) return this.filters.kind;
    const top = this.summary.data?.topByUtilization;
    if (!top) return undefined;
    const match = top.find((m) => {
      const parts = m.label.split(' ');
      const id = parts.slice(1).join(' ');
      return id === this.componentId;
    });
    if (match) {
      return match.label.split(' ')[0];
    }
    return undefined;
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

  private renderBreadcrumbs() {
    const origin = this.filters.origin;
    const originLink = originHref(this.filters);
    const kind = this.componentKind();

    return html`
      <nav class="breadcrumbs" aria-label="Breadcrumbs">
        ${
          originLink
            ? html`<a href=${originLink}>
              ${origin === 'portfolio' ? 'Dashboard' : origin === 'project' ? 'Project' : 'Session'}
            </a>`
            : html`<a href="#/">Dashboard</a>`
        }
        <span aria-hidden="true">/</span>
        <a href="#/artifacts">Artifact Ecosystem</a>
        ${
          this.componentId
            ? html`
              <span aria-hidden="true">/</span>
              <span class="current">${this.componentId}${kind ? ` (${kind})` : ''}</span>
            `
            : ''
        }
        ${
          this.filters.version
            ? html`
              <span aria-hidden="true">/</span>
              <span class="current">version ${this.filters.version}</span>
            `
            : ''
        }
      </nav>
    `;
  }

  private renderFilters() {
    return html`
      <div class="filter-bar">
        <label>
          Kind
          <input
            type="text"
            .value=${this.filters.kind ?? ''}
            @change=${(e: Event) => this.updateFilter('kind', (e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          Project
          <input
            type="text"
            .value=${this.filters.project ?? ''}
            @change=${(e: Event) =>
              this.updateFilter('project', (e.target as HTMLInputElement).value)}
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
        <button class="secondary" @click=${this.resetFilters}>Reset</button>
      </div>
    `;
  }

  private renderSummary() {
    if (this.summary.state === 'error') {
      return html`<div class="error" role="alert">${this.summary.error}</div>`;
    }
    if (!this.summary.data) {
      return html`<analytics-chart
        title="Component ecosystem"
        .state=${this.chartState(this.summary.state)}
      ></analytics-chart>`;
    }

    const summary = this.summary.data;
    const cards = summaryToMetricCards(summary);
    const countSeries: ChartSeries = countsByKindToChartSeries(summary);
    const topSeries: ChartSeries = topByUtilizationToChartSeries(
      summary,
      this.filters.kind,
      this.componentId ? undefined : this.filters,
    );

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
        <analytics-chart
          title="Artifacts by kind"
          .series=${countSeries}
          .state=${this.chartState(this.summary.state)}
        ></analytics-chart>
      </div>
      <div class="section">
        <h2>Top components by utilization</h2>
        <analytics-chart
          title="Invocations per component"
          .series=${topSeries}
          .state=${this.chartState(this.summary.state)}
          @point-click=${this.handlePointClick}
        ></analytics-chart>
      </div>
    `;
  }

  private renderVersions() {
    if (this.versions.state === 'error') {
      return html`<div class="error">${this.versions.error}</div>`;
    }
    if (!this.versions.data || this.versions.data.items.length === 0) {
      return html`<div class="empty">No versions found.</div>`;
    }

    const series = versionsToChartSeries(this.versions.data);
    const rows = versionsToRows(this.versions.data, this.filters);

    return html`
      <div class="section">
        <h2>Versions</h2>
        <analytics-chart
          title="Version exposure"
          .series=${series}
          .state=${this.chartState(this.versions.state)}
        ></analytics-chart>
        <table>
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Sessions</th>
              <th scope="col">Projects</th>
              <th scope="col">First seen</th>
              <th scope="col">Last seen</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (row) => html`
                <tr class=${this.filters.version === row.version ? 'active' : ''}>
                  <td>${row.version}</td>
                  <td>${row.sessionCount}</td>
                  <td>${row.projectCount}</td>
                  <td>${row.firstSeen ?? '—'}</td>
                  <td>${row.lastSeen ?? '—'}</td>
                  <td>
                    <a href=${row.href} @click=${(e: Event) => {
                      e.preventDefault();
                      this.selectVersion(row.version);
                    }}>Select</a>
                    ${
                      this.filters.version && this.filters.version !== row.version
                        ? html` |
                          <a
                            href="#"
                            @click=${(e: Event) => {
                              e.preventDefault();
                              this.compareVersions(row.version);
                            }}
                            >Compare</a
                          >`
                        : ''
                    }
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
        <div class="pagination">
          <button
            ?disabled=${!this.versions.data.previousCursor}
            @click=${() => this.goToPage(this.versions.data?.previousCursor)}
          >
            Previous
          </button>
          <button
            ?disabled=${!this.versions.data.nextCursor}
            @click=${() => this.goToPage(this.versions.data?.nextCursor)}
          >
            Next
          </button>
        </div>
      </div>
    `;
  }

  private renderScopes() {
    if (this.scopes.state === 'error') {
      return html`<div class="error">${this.scopes.error}</div>`;
    }
    if (!this.scopes.data || this.scopes.data.items.length === 0) {
      return html`<div class="empty">No installation scopes found.</div>`;
    }

    const series = scopesToChartSeries(this.scopes.data);
    const rows = scopesToRows(this.scopes.data);

    return html`
      <div class="section">
        <h2>Installation scope</h2>
        <analytics-chart
          title="Installations per scope"
          .series=${series}
          .state=${this.chartState(this.scopes.state)}
        ></analytics-chart>
        <table>
          <thead>
            <tr>
              <th scope="col">Scope</th>
              <th scope="col">Installations</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (row) => html`
                <tr>
                  <td>${row.scope}</td>
                  <td>${row.installationCount}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  private renderUtilization() {
    if (this.utilization.state === 'error') {
      return html`<div class="error">${this.utilization.error}</div>`;
    }
    if (!this.utilization.data) {
      return html`<analytics-chart
        title="Utilization"
        .state=${this.chartState(this.utilization.state)}
      ></analytics-chart>`;
    }

    const cards = utilizationToMetricCards(this.utilization.data);

    return html`
      <div class="section">
        <h2>Utilization</h2>
        <div class="metric-grid">
          ${cards.map(
            (card) => html`
              <metrics-card
                label=${card.label}
                value=${card.value}
                sub=${card.sub}
              ></metrics-card>
            `,
          )}
        </div>
      </div>
    `;
  }

  private renderDistributions() {
    if (this.distributions.state === 'error') {
      return html`<div class="error">${this.distributions.error}</div>`;
    }
    if (!this.distributions.data || this.distributions.data.items.length === 0) {
      return html`<div class="empty">No distributions found.</div>`;
    }

    const all = distributionsToChartSeries(this.distributions.data);

    return html`
      <div class="section">
        <h2>Payload distributions</h2>
        ${all.map(
          (series) => html`
            <analytics-chart
              title=${series.label}
              .series=${series}
              .state=${this.chartState(this.distributions.state)}
            ></analytics-chart>
          `,
        )}
      </div>
    `;
  }

  private renderProjectSessions() {
    if (this.projectSessions.state === 'error') {
      return html`<div class="error">${this.projectSessions.error}</div>`;
    }
    if (!this.projectSessions.data || this.projectSessions.data.items.length === 0) {
      return html`<div class="empty">No project or session evidence found.</div>`;
    }

    const rows = projectSessionsToRows(this.projectSessions.data, this.filters);

    return html`
      <div class="section">
        <h2>Project / session evidence</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">Session</th>
              <th scope="col">Last used</th>
              <th scope="col">Metrics</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (row) => html`
                <tr>
                  <td><a href=${row.projectHref}>${row.projectId}</a></td>
                  <td><a href=${row.sessionHref}>${row.sessionId}</a></td>
                  <td>${row.lastUsed ?? '—'}</td>
                  <td>${row.metrics}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
        <div class="pagination">
          <button
            ?disabled=${!this.projectSessions.data.previousCursor}
            @click=${() => this.goToPage(this.projectSessions.data?.previousCursor)}
          >
            Previous
          </button>
          <button
            ?disabled=${!this.projectSessions.data.nextCursor}
            @click=${() => this.goToPage(this.projectSessions.data?.nextCursor)}
          >
            Next
          </button>
        </div>
      </div>
    `;
  }

  private renderLifecycle() {
    if (this.lifecycle.state === 'error') {
      return html`<div class="error">${this.lifecycle.error}</div>`;
    }
    if (!this.lifecycle.data || this.lifecycle.data.items.length === 0) {
      return html`<div class="empty">No lifecycle events found.</div>`;
    }

    const series = lifecycleToChartSeries(this.lifecycle.data);
    const rows = lifecycleToRows(this.lifecycle.data, this.filters);

    return html`
      <div class="section">
        <h2>Lifecycle timing</h2>
        <analytics-chart
          title="Affected sessions per lifecycle event"
          .series=${series}
          .state=${this.chartState(this.lifecycle.state)}
        ></analytics-chart>
        <table>
          <thead>
            <tr>
              <th scope="col">Event</th>
              <th scope="col">Change</th>
              <th scope="col">Before</th>
              <th scope="col">After</th>
              <th scope="col">Affected sessions</th>
              <th scope="col">Diff</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (row) => html`
                <tr>
                  <td>${row.eventId}</td>
                  <td>${row.changeType}</td>
                  <td>${row.beforeVersion ?? '—'}</td>
                  <td>${row.afterVersion ?? '—'}</td>
                  <td>${row.affectedSessions}</td>
                  <td>
                    ${
                      row.diffHref
                        ? html`<a
                          class="diff-link"
                          href=${row.diffHref}
                          @click=${(e: Event) => {
                            e.preventDefault();
                            if (row.beforeVersion && row.afterVersion) {
                              this.compareVersions(row.afterVersion);
                            }
                          }}
                          >View diff</a
                        >`
                        : '—'
                    }
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
        <div class="pagination">
          <button
            ?disabled=${!this.lifecycle.data.previousCursor}
            @click=${() => this.goToPage(this.lifecycle.data?.previousCursor)}
          >
            Previous
          </button>
          <button
            ?disabled=${!this.lifecycle.data.nextCursor}
            @click=${() => this.goToPage(this.lifecycle.data?.nextCursor)}
          >
            Next
          </button>
        </div>
      </div>
    `;
  }

  private renderDiff() {
    if (!this.filters.leftVersion || !this.filters.rightVersion) return '';
    if (this.diffLoading) return html`<p class="notice">Loading diff…</p>`;
    if (this.diffError) return html`<div class="error" role="alert">${this.diffError}</div>`;
    if (!this.diff) return '';

    return html`
      <div class="section">
        <h2>Artifact diff: ${this.diff.leftVersion} → ${this.diff.rightVersion}</h2>
        <div class="diff-panel">
          <div class="diff-metadata">
            ${this.diff.metadataChanges.map(
              (change) => html`
                <div>
                  <strong>${change.field}</strong><br />
                  ${change.oldValue ?? '—'} → ${change.newValue ?? '—'}
                </div>
              `,
            )}
          </div>
          ${
            this.diff.unifiedDiff
              ? html`
                <pre class="diff-unified">
${this.diff.unifiedDiff.split('\n').map((line) => {
  const cls = line.startsWith('+') ? 'diff-added' : line.startsWith('-') ? 'diff-removed' : '';
  return html`<p class="diff-line ${cls}">${line}</p>`;
})}</pre
                >
              `
              : html`<p class="notice">No unified diff available.</p>`
          }
        </div>
      </div>
    `;
  }

  private renderDetail() {
    return html`
      ${this.renderVersions()} ${this.renderScopes()} ${this.renderUtilization()}
      ${this.renderDistributions()} ${this.renderProjectSessions()} ${this.renderLifecycle()}
      ${this.renderDiff()}
    `;
  }

  render() {
    return html`
      <div class="component-ecosystem-view">
        ${this.renderBreadcrumbs()}
        <h1>
          ${this.componentId ? `Artifact: ${this.componentId}` : 'Artifact Ecosystem'}
        </h1>
        ${
          this.globalState === 'error' && this.globalError
            ? html`<div class="error" role="alert">${this.globalError}</div>`
            : ''
        }
        ${this.renderFilters()}
        ${this.loading ? html`<p class="notice">Loading component ecosystem…</p>` : ''}
        ${this.renderSummary()} ${this.componentId ? this.renderDetail() : ''}
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
    'component-ecosystem-view': ComponentEcosystemView;
  }
}
