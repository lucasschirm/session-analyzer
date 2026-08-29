import type {
  ComponentFactPage,
  ContextTimingSeries,
  EvidencePage,
  RootChildBreakdown,
  SessionEvidenceSummary,
  SessionEvidenceView as SessionEvidenceViewApi,
  SessionTree,
  SessionValidationSummary,
} from '@lucasschirm/sal-db';
import { css, html, LitElement, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import '../../components/charts/analytics-chart';
import '../../components/metrics-card';
import { analyticsClient } from '../../db/analytics-client';
import { navigateTo } from '../../router';
import {
  componentFactsToChartSeries,
  componentFactsToRows,
  contextTimingToChartSeries,
  summaryToMetricCards,
} from './session-evidence-chart-helpers';
import {
  buildSessionEvidenceHash,
  parseSessionEvidenceHash,
  sessionEvidenceParamsToQuery,
} from './session-evidence-params';
import './session-evidence-evidence';
import './session-evidence-transcript';
import './session-evidence-tree';

type LoadState = 'idle' | 'loading' | 'ok' | 'empty' | 'partial' | 'error';

interface PanelState<T> {
  data: T | null;
  state: LoadState;
  error?: string;
}

@customElement('session-evidence-view')
export class SessionEvidenceView extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .session-evidence {
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .back-link {
      color: var(--md-sys-color-primary, #4f8cff);
      text-decoration: none;
      font-size: 14px;
    }

    .back-link:hover {
      text-decoration: underline;
    }

    .title-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      flex-wrap: wrap;
    }

    h1 {
      margin: 0;
      font-size: 24px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      word-break: break-word;
    }

    .session-subtitle {
      margin: 4px 0 0;
      font-size: 13px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .transcript-link {
      background: var(--md-sys-color-primary, #4f8cff);
      color: #fff;
      border: none;
      padding: 10px 18px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      flex-shrink: 0;
      text-decoration: none;
      display: inline-block;
    }

    .transcript-link:hover {
      filter: brightness(1.1);
    }

    .error {
      background: var(--md-sys-color-error-container, #5c2626);
      color: var(--md-sys-color-on-error-container, #ffb4ab);
      padding: 12px 16px;
      border-radius: 8px;
    }

    .notice {
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 13px;
    }

    .tombstone {
      border: 1px solid var(--md-sys-color-tertiary, #ffb86c);
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .metric-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 12px;
    }

    .metric-grid metrics-card {
      cursor: pointer;
    }

    .section {
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 12px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .section h2 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .filter-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: end;
    }

    .filter-bar label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      min-width: 140px;
    }

    .filter-bar input, .filter-bar select, .filter-bar button {
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
      cursor: pointer;
      border: none;
    }

    .validation-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .validation-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 10px;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      background: var(--md-sys-color-surface, #171a21);
      font-size: 13px;
    }

    .validation-status {
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      font-size: 11px;
      text-transform: uppercase;
      font-weight: 600;
    }

    .component-table {
      width: 100%;
      border-collapse: collapse;
      background: var(--md-sys-color-surface, #171a21);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      overflow: hidden;
      font-size: 13px;
    }

    .component-table th, .component-table td {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid var(--md-sys-color-outline, #2a303c);
    }

    .component-table th {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-weight: 600;
    }

    .kind-badge {
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      font-size: 11px;
      text-transform: uppercase;
      font-weight: 600;
    }

    .view-tabs {
      display: flex;
      gap: 8px;
    }

    .view-tab {
      padding: 8px 14px;
      font-size: 14px;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      background: var(--md-sys-color-surface, #171a21);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      cursor: pointer;
      text-decoration: none;
    }

    .view-tab:hover {
      background: var(--md-sys-color-surface-container-hover, #262d3a);
    }

    .view-tab.active {
      background: var(--md-sys-color-primary, #4f8cff);
      color: var(--md-sys-color-on-primary, #fff);
      border-color: var(--md-sys-color-primary, #4f8cff);
    }
  `;

  @property({ type: String, attribute: 'session-id' }) sessionId = '';

  @state() private params = parseSessionEvidenceHash(window.location.hash, '');

  @state() private loading = false;

  @state() private globalState: LoadState = 'idle';

  @state() private globalError: string | null = null;

  @state() private isTombstone = false;

  @state() private summary: PanelState<SessionEvidenceSummary> = { data: null, state: 'idle' };

  @state() private contextTiming: PanelState<ContextTimingSeries> = { data: null, state: 'idle' };

  @state() private rootChild: PanelState<RootChildBreakdown> = { data: null, state: 'idle' };

  @state() private componentFacts: PanelState<ComponentFactPage> = { data: null, state: 'idle' };

  @state() private validation: PanelState<SessionValidationSummary> = { data: null, state: 'idle' };

  @state() private evidence: PanelState<EvidencePage> = { data: null, state: 'idle' };

  @state() private transcript: PanelState<EvidencePage> = { data: null, state: 'idle' };

  @state() private sessionTree: PanelState<SessionTree> = { data: null, state: 'idle' };

  private hashListener = () => this.handleHashChange();

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('hashchange', this.hashListener);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('hashchange', this.hashListener);
  }

  private handleHashChange(): void {
    const match = window.location.hash.match(/^#\/sessions\/([^/?]+)/);
    if (match) {
      try {
        if (decodeURIComponent(match[1]) === this.sessionId) {
          this.load();
        }
      } catch {
        if (match[1] === this.sessionId) {
          this.load();
        }
      }
    }
  }

  willUpdate(changed: PropertyValues): void {
    if (changed.has('sessionId') && this.sessionId) {
      this.load();
    }
  }

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.globalState = 'loading';
    this.globalError = null;
    this.isTombstone = false;

    const params = parseSessionEvidenceHash(window.location.hash, this.sessionId);
    this.params = params;
    const query = sessionEvidenceParamsToQuery(params);

    const sessionApi: SessionEvidenceViewApi = analyticsClient.session;
    const searchApi = analyticsClient.search;

    const [
      summary,
      contextTiming,
      rootChild,
      componentFacts,
      validation,
      evidence,
      transcript,
      sessionTree,
    ] = await Promise.allSettled([
      sessionApi.getSummary(this.sessionId, query),
      sessionApi.getContextTimingSeries(this.sessionId, query),
      sessionApi.getRootChildBreakdown(this.sessionId, query),
      sessionApi.getComponentFacts(this.sessionId, query),
      sessionApi.getValidationSummary(this.sessionId, query),
      sessionApi.getEvidencePages(this.sessionId, query),
      sessionApi.getTranscriptPages(this.sessionId, query),
      searchApi.getRootSessionTree(this.sessionId),
    ]);

    this.summary = panelStateFromResult(summary);
    this.contextTiming = panelStateFromResult(contextTiming);
    this.rootChild = panelStateFromResult(rootChild);
    this.componentFacts = panelStateFromResult(componentFacts);
    this.validation = panelStateFromResult(validation);
    this.evidence = panelStateFromResult(evidence);
    this.transcript = panelStateFromResult(transcript);
    this.sessionTree = panelStateFromResult(sessionTree);

    this.isTombstone =
      hasTombstone(this.evidence) ||
      hasTombstone(this.transcript) ||
      this.summary.data?.token.knownN === 0;

    const states = [
      this.summary.state,
      this.contextTiming.state,
      this.rootChild.state,
      this.componentFacts.state,
      this.validation.state,
      this.evidence.state,
      this.transcript.state,
      this.sessionTree.state,
    ];

    if (states.every((s) => s === 'ok' || s === 'empty')) {
      this.globalState = states.some((s) => s === 'ok') ? 'ok' : 'empty';
    } else if (states.some((s) => s === 'ok')) {
      this.globalState = 'partial';
    } else {
      this.globalState = 'error';
      this.globalError = 'Session evidence failed to load.';
    }

    this.loading = false;
  }

  private chartState(
    state: LoadState,
  ): import('../../components/charts/chart-types').ChartState | null {
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

  private goToMetric(metric: { href?: string }): void {
    if (metric.href) navigateTo(metric.href.replace(/^#/, ''));
  }

  private updateParams(updates: Partial<typeof this.params>): void {
    const next = { ...this.params, ...updates };
    const hash = buildSessionEvidenceHash(next);
    navigateTo(`/sessions/${this.sessionId}${hash}`);
  }

  private handlePageChange(
    detail: { cursor?: string; direction: 'next' | 'previous' },
    view: 'evidence' | 'transcript',
  ): void {
    this.updateParams({
      view,
      cursor: detail.cursor,
    });
  }

  private renderBackLink(): unknown {
    const returnContext = this.params.returnContext;
    if (returnContext) {
      return html`<a class="back-link" href="${returnContext}">← Back</a>`;
    }
    return html`<a class="back-link" href="#/">← Back to Projects</a>`;
  }

  private renderHeader() {
    const summary = this.summary.data;
    return html`
      <div class="title-row">
        <div>
          <h1>Session Evidence — ${this.sessionId}</h1>
          <p class="session-subtitle">
            ${summary ? html`Harness: ${summary.harness}` : ''}
            ${summary?.parentSessionId ? html` • Parent: ${summary.parentSessionId}` : ''}
          </p>
        </div>
        <a class="transcript-link" href="#/sessions/${this.sessionId}/transcript">
          View Full Transcript
        </a>
      </div>
    `;
  }

  private renderOverview() {
    if (this.summary.state === 'error') {
      return html`<div class="error">${this.summary.error}</div>`;
    }
    if (!this.summary.data) {
      return html`<p class="notice">Loading summary…</p>`;
    }

    const cards = summaryToMetricCards(this.summary.data, this.params);
    if (cards.length === 0) {
      return html`<p class="notice">No headline metrics available for this session.</p>`;
    }

    return html`
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
    `;
  }

  private renderContextTiming() {
    const series = this.contextTiming.data
      ? contextTimingToChartSeries(this.contextTiming.data)
      : null;
    return html`
      <div class="section">
        <h2>Context and request timing</h2>
        <analytics-chart
          title="Token composition by turn"
          .series=${series}
          .state=${this.chartState(this.contextTiming.state)}
        ></analytics-chart>
      </div>
    `;
  }

  private renderRootChild() {
    return html`
      <div class="section">
        <h2>Root and child sessions</h2>
        ${
          this.rootChild.data
            ? html`
              <session-evidence-tree .tree=${this.sessionTree.data}></session-evidence-tree>
            `
            : html`<p class="notice">No tree data available.</p>`
        }
      </div>
    `;
  }

  private renderComponentFacts() {
    if (this.componentFacts.state === 'error') {
      return html`<div class="error">${this.componentFacts.error}</div>`;
    }
    if (!this.componentFacts.data || this.componentFacts.data.items.length === 0) {
      return html`
        <div class="section">
          <h2>Tool / Skill / Agent activity</h2>
          <p class="notice">No component activity found.</p>
        </div>
      `;
    }

    const rows = componentFactsToRows(this.componentFacts.data);
    const series = componentFactsToChartSeries(this.componentFacts.data);

    return html`
      <div class="section">
        <h2>Tool / Skill / Agent activity</h2>
        <p class="notice">
          Tool, Skill, Agent, and Sub Agent are distinct kinds. The table and
          chart use the precomputed component fact rollups for this session.
        </p>
        <analytics-chart
          title="Invocations by component kind"
          .series=${series}
          .state=${this.chartState(this.componentFacts.state)}
        ></analytics-chart>
        <table class="component-table">
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col">Component</th>
              <th scope="col">Invocations</th>
              <th scope="col">Outcome</th>
              <th scope="col">Metrics</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (row) => html`
                <tr>
                  <td><span class="kind-badge">${row.kind}</span></td>
                  <td>${row.componentId}</td>
                  <td>${row.invocations}</td>
                  <td>${row.outcome}</td>
                  <td>${row.metrics}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  private renderValidation() {
    if (!this.validation.data || this.validation.data.validations.length === 0) {
      return html`
        <div class="section">
          <h2>Validation</h2>
          <p class="notice">No validation records found.</p>
        </div>
      `;
    }

    return html`
      <div class="section">
        <h2>Validation</h2>
        <ul class="validation-list">
          ${this.validation.data.validations.map(
            (v) => html`
              <li class="validation-row">
                <span>${v.validationType}</span>
                <span class="validation-status">${v.status} (${v.count})</span>
              </li>
            `,
          )}
        </ul>
      </div>
    `;
  }

  private renderEvidenceTabs() {
    const currentView = this.params.view ?? 'evidence';
    return html`
      <div class="view-tabs" role="tablist" aria-label="Evidence view">
        <a
          class="view-tab ${currentView === 'evidence' ? 'active' : ''}"
          href="#/sessions/${this.sessionId}?view=evidence"
          @click=${(e: Event) => {
            e.preventDefault();
            this.updateParams({ view: 'evidence' });
          }}
        >
          Evidence
        </a>
        <a
          class="view-tab ${currentView === 'transcript' ? 'active' : ''}"
          href="#/sessions/${this.sessionId}?view=transcript"
          @click=${(e: Event) => {
            e.preventDefault();
            this.updateParams({ view: 'transcript' });
          }}
        >
          Transcript
        </a>
      </div>
    `;
  }

  private renderEvidenceSection() {
    const currentView = this.params.view ?? 'evidence';
    return html`
      <div class="section">
        <h2>Evidence</h2>
        ${this.renderEvidenceTabs()}
        ${
          currentView === 'transcript'
            ? html`
              <session-evidence-transcript
                .page=${this.transcript.data}
                .loading=${this.transcript.state === 'loading'}
                .state=${
                  this.transcript.state === 'error'
                    ? 'error'
                    : hasTombstone(this.transcript)
                      ? 'tombstone'
                      : this.transcript.data?.items.length === 0
                        ? 'empty'
                        : 'ok'
                }
                @page-change=${(e: CustomEvent) => this.handlePageChange(e.detail, 'transcript')}
              ></session-evidence-transcript>
            `
            : html`
              <session-evidence-evidence
                .page=${this.evidence.data}
                .loading=${this.evidence.state === 'loading'}
                .state=${
                  this.evidence.state === 'error'
                    ? 'error'
                    : hasTombstone(this.evidence)
                      ? 'tombstone'
                      : this.evidence.data?.items.length === 0
                        ? 'empty'
                        : 'ok'
                }
                @page-change=${(e: CustomEvent) => this.handlePageChange(e.detail, 'evidence')}
              ></session-evidence-evidence>
            `
        }
      </div>
    `;
  }

  render() {
    return html`
      <div class="session-evidence">
        ${this.renderBackLink()}
        ${this.renderHeader()}

        ${
          this.globalState === 'error' && this.globalError
            ? html`<div class="error" role="alert">${this.globalError}</div>`
            : ''
        }
        ${
          this.isTombstone
            ? html`<div class="notice tombstone" role="alert">
              This session evidence has been deleted or superseded.
            </div>`
            : ''
        }
        ${this.loading ? html`<p class="notice">Loading session evidence…</p>` : ''}

        ${this.renderOverview()}
        ${this.renderContextTiming()}
        ${this.renderRootChild()}
        ${this.renderComponentFacts()}
        ${this.renderValidation()}
        ${this.renderEvidenceSection()}
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

function hasTombstone(panel: PanelState<EvidencePage>): boolean {
  if (!panel.data) return false;
  return panel.data.items.some((row) => row.entityType === 'tombstone');
}

declare global {
  interface HTMLElementTagNameMap {
    'session-evidence-view': SessionEvidenceView;
  }
}
