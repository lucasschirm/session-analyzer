import type {
  ComponentFactPage,
  ContextTimingSeries,
  EvidencePage,
  RootChildBreakdown,
  SessionEventPayloadDetail,
  SessionEventsDetail,
  SessionEvidenceSummary,
  SessionEvidenceView as SessionEvidenceViewApi,
  SessionTree,
  SessionValidationSummary,
  TurnTimeline,
} from '@lucasschirm/sal-db';
import { css, html, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { PageLitElement, pageHostStyles } from '../page-lit-element';
import '../../components/charts/analytics-chart';
import '../../components/metrics-card';
import { analyticsClient } from '../../db/analytics-client';
import { navigateTo } from '../../router';
import {
  componentFactsToChartSeries,
  componentFactsToRows,
  contextTimingToChartSeries,
  firstUserMessageExcerpt,
  summaryToMetricCards,
} from './session-evidence-chart-helpers';
import {
  buildSessionEvidenceHash,
  parseSessionEvidenceHash,
  sessionEvidenceParamsToQuery,
} from './session-evidence-params';
import './session-evidence-header';
import './session-evidence-timeline';
import './session-evidence-events-table';
import './session-evidence-transcript';
import './session-evidence-tree';

type LoadState = 'idle' | 'loading' | 'ok' | 'empty' | 'partial' | 'error';

interface PanelState<T> {
  data: T | null;
  state: LoadState;
  error?: string;
}

@customElement('session-evidence-view')
export class SessionEvidenceView extends PageLitElement {
  static styles = [
    pageHostStyles,
    css`
    .session-evidence {
      display: flex;
      flex-direction: column;
      gap: 24px;
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

  `,
  ];

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

  @state() private transcript: PanelState<EvidencePage> = { data: null, state: 'idle' };

  @state() private sessionTree: PanelState<SessionTree> = { data: null, state: 'idle' };

  @state() private sessionEvents: PanelState<SessionEventsDetail> = { data: null, state: 'idle' };

  @state() private turnTimeline: PanelState<TurnTimeline> = { data: null, state: 'idle' };

  @state() private activeTurn: number | null = null;

  @state() private fullPayloads: Map<string, SessionEventPayloadDetail> = new Map();

  @state() private loadingPayloadIds: Set<string> = new Set();

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
    this.activeTurn = null;
    this.fullPayloads = new Map();
    this.loadingPayloadIds = new Set();

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
      transcript,
      sessionTree,
      sessionEvents,
      turnTimeline,
    ] = await Promise.allSettled([
      sessionApi.getSummary(this.sessionId, query),
      sessionApi.getContextTimingSeries(this.sessionId, query),
      sessionApi.getRootChildBreakdown(this.sessionId, query),
      sessionApi.getComponentFacts(this.sessionId, query),
      sessionApi.getValidationSummary(this.sessionId, query),
      sessionApi.getTranscriptPages(this.sessionId, query),
      searchApi.getRootSessionTree(this.sessionId),
      sessionApi.getSessionEvents(this.sessionId, query),
      sessionApi.getTurnTimeline(this.sessionId, query),
    ]);

    this.summary = panelStateFromResult(summary);
    this.contextTiming = panelStateFromResult(contextTiming);
    this.rootChild = panelStateFromResult(rootChild);
    this.componentFacts = panelStateFromResult(componentFacts);
    this.validation = panelStateFromResult(validation);
    this.transcript = panelStateFromResult(transcript);
    this.sessionTree = panelStateFromResult(sessionTree);
    this.sessionEvents = panelStateFromResult(sessionEvents);
    this.turnTimeline = panelStateFromResult(turnTimeline);

    this.isTombstone = hasTombstone(this.transcript) || this.summary.data?.token.knownN === 0;

    const states = [
      this.summary.state,
      this.contextTiming.state,
      this.rootChild.state,
      this.componentFacts.state,
      this.validation.state,
      this.transcript.state,
      this.sessionTree.state,
      this.sessionEvents.state,
      this.turnTimeline.state,
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

  private handlePageChange(detail: { cursor?: string; direction: 'next' | 'previous' }): void {
    this.updateParams({
      view: 'transcript',
      cursor: detail.cursor,
    });
  }

  private handleTimelineSegmentClick(event: CustomEvent<{ turn: number }>): void {
    this.activeTurn = this.activeTurn === event.detail.turn ? null : event.detail.turn;
  }

  private handleTurnFilterChanged(): void {
    this.activeTurn = null;
  }

  private async handleLoadFullPayload(event: CustomEvent<{ payloadId: string }>): Promise<void> {
    const { payloadId } = event.detail;
    if (this.fullPayloads.has(payloadId) || this.loadingPayloadIds.has(payloadId)) return;
    this.loadingPayloadIds = new Set(this.loadingPayloadIds).add(payloadId);
    try {
      const detail = await analyticsClient.session.getEventPayload(
        this.sessionId,
        payloadId,
        sessionEvidenceParamsToQuery(this.params),
      );
      if (detail) {
        this.fullPayloads = new Map(this.fullPayloads).set(payloadId, detail);
      }
    } finally {
      const next = new Set(this.loadingPayloadIds);
      next.delete(payloadId);
      this.loadingPayloadIds = next;
    }
  }

  private renderHeader() {
    const summary = this.summary.data;
    const facts = summary ? summaryToMetricCards(summary, this.params) : [];
    const excerpt = firstUserMessageExcerpt(this.transcript.data);
    const returnContext = this.params.returnContext;
    return html`
      <session-evidence-header
        .sessionId=${this.sessionId}
        .summary=${summary}
        .titleExcerpt=${excerpt}
        .facts=${facts}
        .projectHref=${returnContext}
        .subAgentCount=${this.rootChild.data ? this.rootChild.data.children.length : null}
        subAgentHref="#/sessions/${this.sessionId}?view=transcript"
      ></session-evidence-header>
    `;
  }

  private renderTimeline() {
    if (this.turnTimeline.state === 'error') {
      return html`<div class="error" role="alert">${this.turnTimeline.error}</div>`;
    }
    return html`
      <session-evidence-timeline
        .timeline=${this.turnTimeline.data}
        .events=${this.sessionEvents.data?.events ?? []}
        .activeTurn=${this.activeTurn}
        @timeline-segment-click=${this.handleTimelineSegmentClick}
      ></session-evidence-timeline>
    `;
  }

  private renderEventsTable() {
    if (this.sessionEvents.state === 'error') {
      return html`<div class="error" role="alert">${this.sessionEvents.error}</div>`;
    }
    return html`
      <div class="section">
        <h2>Events</h2>
        <session-evidence-events-table
          .events=${this.sessionEvents.data?.events ?? []}
          .turnFilter=${this.activeTurn}
          .fullPayloads=${this.fullPayloads}
          .loadingPayloadIds=${this.loadingPayloadIds}
          @turn-filter-changed=${this.handleTurnFilterChanged}
          @load-full-payload=${this.handleLoadFullPayload}
        ></session-evidence-events-table>
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
              <th scope="col">Artifact</th>
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

  private renderSubAgentTranscript() {
    return html`
      <div class="section">
        <h2>Sub agent transcript</h2>
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
          @page-change=${(e: CustomEvent) => this.handlePageChange(e.detail)}
        ></session-evidence-transcript>
      </div>
    `;
  }

  render() {
    return html`
      <div class="session-evidence">
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

        ${this.renderTimeline()}
        ${this.renderEventsTable()}
        ${this.renderOverview()}
        ${this.renderContextTiming()}
        ${this.renderRootChild()}
        ${this.renderComponentFacts()}
        ${this.renderValidation()}
        ${this.renderSubAgentTranscript()}
      </div>
    `;
  }
}

/** Array-bearing fields that mark a fulfilled DTO as legitimately empty (no rows), never confused with a query failure. */
const EMPTY_CHECK_FIELDS = ['items', 'events', 'segments'] as const;

function panelStateFromResult<T>(result: PromiseSettledResult<T>): PanelState<T> {
  if (result.status === 'fulfilled') {
    const data = result.value;
    const emptyField =
      data && typeof data === 'object'
        ? EMPTY_CHECK_FIELDS.find((field) =>
            Array.isArray((data as Record<string, unknown>)[field]),
          )
        : undefined;
    const isEmpty = emptyField
      ? ((data as Record<string, unknown[]>)[emptyField]?.length ?? 0) === 0
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
