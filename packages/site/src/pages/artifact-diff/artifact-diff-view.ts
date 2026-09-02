import type {
  ArtifactVersionDiff,
  ArtifactVersionMetadata,
  MetadataChange,
  SideBySideDiff,
} from '@lucasschirm/sal-db';
import { css, html, LitElement } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import '../../components/charts/analytics-chart';
import '../../components/metrics-card';
import type { ChartState } from '../../components/charts/chart-types';
import { analyticsClient } from '../../db/analytics-client';
import { navigateTo } from '../../router';
import {
  cohortsToChartSeries,
  componentDiffRows,
  diffSummary,
  isTombstoneMetadata,
  metadataChangesTable,
  metadataToMetricCards,
  sessionExposureRows,
} from './artifact-diff-chart-helpers';
import type { ArtifactDiffParams, ArtifactDiffViewMode } from './artifact-diff-params';
import {
  artifactDiffParamsToQuery,
  buildArtifactDiffHash,
  originHref,
  parseArtifactDiffHash,
} from './artifact-diff-params';

type LoadState = 'idle' | 'loading' | 'ok' | 'empty' | 'partial' | 'error' | 'tombstone';

interface PanelState<T> {
  data: T | null;
  state: LoadState;
  error?: string;
}

@customElement('artifact-diff-view')
export class ArtifactDiffView extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: 24px;
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

    h3 {
      margin: 0 0 12px;
      font-size: 16px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
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

    .notice {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-size: 13px;
      padding: 12px 0;
    }

    .error,
    .tombstone {
      color: var(--md-sys-color-error, #ff6b6b);
      font-size: 13px;
      padding: 12px;
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      margin-bottom: 16px;
    }

    .tombstone {
      color: var(--md-sys-color-on-surface, #e6e9ef);
      border-color: var(--md-sys-color-error, #ff6b6b);
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

    .diff-controls {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }

    .diff-controls button {
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 6px;
      padding: 8px 16px;
      font: inherit;
      cursor: pointer;
    }

    .diff-controls button.active {
      background: var(--md-sys-color-primary, #4f8cff);
      color: var(--md-sys-color-on-primary, #fff);
      border-color: var(--md-sys-color-primary, #4f8cff);
    }

    .diff-panel {
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      padding: 16px;
      overflow: auto;
    }

    .diff-summary {
      font-size: 13px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      margin-bottom: 12px;
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

    .side-by-side {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }

    .side-column {
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 6px;
      padding: 12px;
      background: var(--md-sys-color-surface, #171a21);
    }

    .side-column h4 {
      margin: 0 0 8px;
      font-size: 13px;
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

    .empty {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-size: 13px;
      padding: 12px 0;
    }

    .component-diff {
      margin-top: 16px;
      padding: 16px;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      background: var(--md-sys-color-surface-container, #1f242e);
    }

    .concurrent-list {
      list-style: disc;
      margin: 0;
      padding-left: 20px;
      font-size: 13px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .concurrent-list li {
      margin-bottom: 4px;
    }

    .metadata-change .field {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .metadata-change .values {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
    }

    .metadata-change .old {
      color: #ff6b6b;
    }

    .metadata-change .new {
      color: #3ecf8e;
    }

    .no-select {
      user-select: text;
    }
  `;

  @state() private params: ArtifactDiffParams = parseArtifactDiffHash(
    typeof window !== 'undefined' ? window.location.hash : '',
  );

  @state() private viewMode: ArtifactDiffViewMode = this.params.view ?? 'unified';

  @state() private leftMeta: PanelState<ArtifactVersionMetadata> = {
    data: null,
    state: 'idle',
  };

  @state() private rightMeta: PanelState<ArtifactVersionMetadata> = {
    data: null,
    state: 'idle',
  };

  @state() private diff: PanelState<ArtifactVersionDiff> = { data: null, state: 'idle' };

  @state() private globalState: LoadState = 'idle';

  @state() private globalError: string | null = null;

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
    const next = parseArtifactDiffHash(window.location.hash);
    this.params = next;
    this.viewMode = next.view ?? 'unified';
    this.load();
  }

  private async load(): Promise<void> {
    if (!this.params.leftArtifact || !this.params.rightArtifact) {
      this.globalState = 'empty';
      return;
    }

    this.globalState = 'loading';
    this.globalError = null;
    this.leftMeta = { data: null, state: 'loading' };
    this.rightMeta = { data: null, state: 'loading' };
    this.diff = { data: null, state: 'loading' };

    const query = artifactDiffParamsToQuery(this.params);

    const [leftResult, rightResult, diffResult] = await Promise.allSettled([
      analyticsClient.artifact.getMetadata(this.params.leftArtifact, query),
      analyticsClient.artifact.getMetadata(this.params.rightArtifact, query),
      analyticsClient.artifact.getDiff(
        this.params.leftArtifact,
        this.params.rightArtifact,
        query,
      ) as Promise<ArtifactVersionDiff>,
    ]);

    this.leftMeta = panelStateFromResult(leftResult);
    this.rightMeta = panelStateFromResult(rightResult);
    this.diff = panelStateFromResult(diffResult);

    if (diffResult.status === 'rejected') {
      this.globalState = 'error';
      this.globalError =
        diffResult.reason instanceof Error ? diffResult.reason.message : 'Diff could not be loaded';
      return;
    }

    const diff = diffResult.value;
    const tombstone = this.isTombstone(diff);

    if (tombstone) {
      this.globalState = 'tombstone';
      return;
    }

    if (leftResult.status === 'rejected' || rightResult.status === 'rejected') {
      this.globalState = 'partial';
      this.globalError = 'Some artifact metadata could not be loaded';
      return;
    }

    this.globalState = 'ok';
  }

  private isTombstone(diff: ArtifactVersionDiff): boolean {
    const hasAvailabilityChange = diff.metadataChanges.some(
      (m) =>
        m.field === 'availability' && m.oldValue === 'available' && m.newValue === 'unavailable',
    );
    const leftTombstone = this.leftMeta.data ? isTombstoneMetadata(this.leftMeta.data) : false;
    const rightTombstone = this.rightMeta.data ? isTombstoneMetadata(this.rightMeta.data) : false;
    return hasAvailabilityChange || leftTombstone || rightTombstone;
  }

  private selectViewMode(mode: ArtifactDiffViewMode): void {
    if (mode === this.viewMode) return;
    this.viewMode = mode;
    const next = { ...this.params, view: mode };
    navigateTo(buildArtifactDiffHash(next).replace(/^#/, ''));
  }

  private chartState(state: LoadState): ChartState | null {
    if (state === 'loading') return 'loading';
    if (state === 'empty') return 'empty';
    if (state === 'partial') return 'partial';
    if (state === 'error') return 'error';
    if (state === 'tombstone') return 'unavailable';
    return null;
  }

  private renderBreadcrumbs() {
    const origin = originHref(this.params);
    const leftLabel = this.diff.data?.leftVersion ?? this.params.leftArtifact;
    const rightLabel = this.diff.data?.rightVersion ?? this.params.rightArtifact;

    return html`
      <nav class="breadcrumbs" aria-label="Breadcrumbs">
        ${
          origin
            ? html`<a href=${origin}>${this.breadcrumbOriginLabel()}</a>`
            : html`<a href="#/">Dashboard</a>`
        }
        <span aria-hidden="true">/</span>
        <span class="current">Artifact diff</span>
        ${
          this.params.component
            ? html`
              <span aria-hidden="true">/</span>
              <span class="current">${this.params.component}</span>
            `
            : ''
        }
        <span aria-hidden="true">/</span>
        <span class="current">${leftLabel} → ${rightLabel}</span>
      </nav>
    `;
  }

  private breadcrumbOriginLabel(): string {
    switch (this.params.origin) {
      case 'portfolio':
        return 'Dashboard';
      case 'project':
        return 'Project Behavior';
      case 'component':
        return 'Artifact Ecosystem';
      case 'session':
        return 'Session Evidence';
      default:
        return 'Back';
    }
  }

  private renderHeader() {
    const artifactId = this.diff.data?.artifactId ?? 'Artifact';
    const leftVersion = this.diff.data?.leftVersion ?? this.params.leftArtifact;
    const rightVersion = this.diff.data?.rightVersion ?? this.params.rightArtifact;

    return html`
      <h1>${artifactId}</h1>
      <p class="diff-summary">
        ${leftVersion} → ${rightVersion}
      </p>
    `;
  }

  private renderStateNotice() {
    if (this.globalState === 'loading') {
      return html`<p class="notice">Loading artifact diff…</p>`;
    }
    if (this.globalState === 'empty') {
      return html`<p class="empty">Provide two artifact versions to compare.</p>`;
    }
    if (this.globalState === 'error' && this.globalError) {
      return html`<div class="error" role="alert">${this.globalError}</div>`;
    }
    if (this.globalState === 'tombstone') {
      return html`
        <div class="tombstone" role="status">
          This artifact diff has been deleted or superseded. Only metadata remains, if any.
        </div>
      `;
    }
    return '';
  }

  private renderMetadataCards(side: 'left' | 'right', meta: ArtifactVersionMetadata | null) {
    if (!meta) return '';
    const cards = metadataToMetricCards(side, meta);
    return html`
      <div class="section">
        <h2>${side === 'left' ? 'Left' : 'Right'} version metadata</h2>
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

  private renderMetadataChanges() {
    const changes = this.diff.data ? metadataChangesTable(this.diff.data) : [];
    if (changes.length === 0) return '';

    return html`
      <div class="section">
        <h2>Changed metadata</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Old value</th>
              <th scope="col">New value</th>
            </tr>
          </thead>
          <tbody>
            ${changes.map((change) => this.renderMetadataChangeRow(change))}
          </tbody>
        </table>
      </div>
    `;
  }

  private renderMetadataChangeRow(change: MetadataChange) {
    return html`
      <tr class="metadata-change">
        <td><span class="field">${change.field}</span></td>
        <td><span class="old">${change.oldValue ?? '—'}</span></td>
        <td><span class="new">${change.newValue ?? '—'}</span></td>
      </tr>
    `;
  }

  private renderCohorts() {
    const diff = this.diff.data;
    if (!diff) return '';

    const series = cohortsToChartSeries(diff);
    const rows = sessionExposureRows(diff);

    return html`
      <div class="section">
        <h2>Sessions exposed to each version</h2>
        <p class="diff-summary" id="cohort-summary">${diffSummary(diff)}</p>
        <analytics-chart
          title="Observational cohort distribution"
          .series=${series}
          .state=${this.chartState(this.globalState)}
          aria-describedby="cohort-summary"
        ></analytics-chart>
        ${
          rows.length > 0
            ? html`
              <table>
                <thead>
                  <tr>
                    <th scope="col">Session</th>
                    <th scope="col">Exposure count</th>
                    <th scope="col">Saw left</th>
                    <th scope="col">Saw right</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows.map(
                    (row) => html`
                      <tr>
                        <td><a href=${row.href}>${row.sessionId}</a></td>
                        <td>${row.count}</td>
                        <td>${row.left ? 'Yes' : 'No'}</td>
                        <td>${row.right ? 'Yes' : 'No'}</td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            `
            : html`<p class="empty">No session exposure data.</p>`
        }
      </div>
    `;
  }

  private renderConcurrentChanges() {
    const changes = this.diff.data?.concurrentChanges ?? [];
    if (changes.length === 0) return '';

    return html`
      <div class="section">
        <h2>Concurrent changes</h2>
        <ul class="concurrent-list">
          ${changes.map((change) => html`<li>${change}</li>`)}
        </ul>
      </div>
    `;
  }

  private renderDiffControls() {
    const diff = this.diff.data;
    if (!diff || this.globalState === 'tombstone') return '';
    if (!diff.unifiedDiff && !diff.sideBySideDiff) return '';

    return html`
      <div class="diff-controls" role="group" aria-label="Diff view mode">
        <button
          class=${this.viewMode === 'unified' ? 'active' : ''}
          @click=${() => this.selectViewMode('unified')}
          type="button"
        >
          Unified
        </button>
        <button
          class=${this.viewMode === 'sideBySide' ? 'active' : ''}
          @click=${() => this.selectViewMode('sideBySide')}
          type="button"
        >
          Side-by-side
        </button>
      </div>
    `;
  }

  private renderArtifactDiff() {
    const diff = this.diff.data;
    if (!diff) return '';

    const contentAvailable = diff.contentAvailable !== false;
    const hasDiff = Boolean(diff.unifiedDiff || diff.sideBySideDiff);

    if (!contentAvailable || !hasDiff) {
      return html`
        <div class="section">
          <h2>Artifact diff</h2>
          <p class="notice" role="status">
            Source text is unavailable or purged. The diff is limited to metadata-only evidence.
          </p>
        </div>
      `;
    }

    return html`
      <div class="section">
        <h2>Artifact diff</h2>
        ${this.renderDiffControls()}
        <div class="diff-panel" role="region" aria-label="Artifact text diff">
          ${
            this.viewMode === 'sideBySide' && diff.sideBySideDiff
              ? this.renderSideBySide(diff.sideBySideDiff)
              : diff.unifiedDiff
                ? this.renderUnified(diff.unifiedDiff)
                : html`<p class="empty">No diff content available.</p>`
          }
        </div>
      </div>
    `;
  }

  private renderUnified(unifiedDiff: string) {
    const lines = unifiedDiff.split('\n');
    return html`
      <pre class="no-select" aria-label="Unified diff: added lines begin with plus, removed with minus">
        ${lines.map((line) => {
          const cls = line.startsWith('+')
            ? 'diff-added'
            : line.startsWith('-')
              ? 'diff-removed'
              : '';
          return html`<p class="diff-line ${cls}">${line}</p>`;
        })}
      </pre>
    `;
  }

  private renderSideBySide(sideBySideDiff: SideBySideDiff) {
    return html`
      <div class="side-by-side" role="group" aria-label="Side-by-side diff">
        <div class="side-column">
          <h4>Left</h4>
          <pre class="no-select">
            ${sideBySideDiff.left.map((line) => {
              const cls = line.changeType === 'removed' ? 'diff-removed' : '';
              return html`<p class="diff-line ${cls}">${line.text}</p>`;
            })}
          </pre>
        </div>
        <div class="side-column">
          <h4>Right</h4>
          <pre class="no-select">
            ${sideBySideDiff.right.map((line) => {
              const cls = line.changeType === 'added' ? 'diff-added' : '';
              return html`<p class="diff-line ${cls}">${line.text}</p>`;
            })}
          </pre>
        </div>
      </div>
    `;
  }

  private renderComponentDiffs() {
    const diff = this.diff.data;
    if (!diff) return '';

    const rows = componentDiffRows(diff);
    if (rows.length === 0) return '';

    return html`
      <div class="section">
        <h2>Component-level diffs</h2>
        ${rows.map((row) => this.renderComponentDiffPanel(row))}
      </div>
    `;
  }

  private renderComponentDiffPanel(row: ReturnType<typeof componentDiffRows>[0]) {
    const label = `${row.kind}${row.componentId ? ` — ${row.componentId}` : ''} (${row.sourcePointer})`;

    return html`
      <div class="component-diff">
        <h3>${label}</h3>
        ${
          row.isPurged
            ? html`<p class="notice">Component source text is purged; metadata-only evidence shown.</p>`
            : ''
        }
        ${
          row.metadataChanges.length > 0
            ? html`
              <table>
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Old value</th>
                    <th scope="col">New value</th>
                  </tr>
                </thead>
                <tbody>
                  ${row.metadataChanges.map((change) => this.renderMetadataChangeRow(change))}
                </tbody>
              </table>
            `
            : ''
        }
        ${
          !row.isPurged && (row.unifiedDiff || row.sideBySideDiff)
            ? html`
              <div class="diff-panel" role="region" aria-label="Component diff for ${label}">
                ${
                  this.viewMode === 'sideBySide' && row.sideBySideDiff
                    ? this.renderSideBySide(row.sideBySideDiff)
                    : row.unifiedDiff
                      ? this.renderUnified(row.unifiedDiff)
                      : ''
                }
              </div>
            `
            : ''
        }
      </div>
    `;
  }

  render() {
    return html`
      <div class="artifact-diff-view">
        ${this.renderBreadcrumbs()}
        ${this.renderHeader()}
        ${this.renderStateNotice()}

        ${
          this.globalState === 'ok' || this.globalState === 'partial'
            ? html`
              ${this.renderMetadataCards('left', this.leftMeta.data)}
              ${this.renderMetadataCards('right', this.rightMeta.data)}
              ${this.renderMetadataChanges()}
              ${this.renderCohorts()}
              ${this.renderConcurrentChanges()}
              ${this.renderArtifactDiff()}
              ${this.renderComponentDiffs()}
            `
            : this.globalState === 'tombstone'
              ? html`
                ${this.renderMetadataCards('left', this.leftMeta.data)}
                ${this.renderMetadataCards('right', this.rightMeta.data)}
                ${this.renderMetadataChanges()}
              `
              : ''
        }
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
    'artifact-diff-view': ArtifactDiffView;
  }
}
