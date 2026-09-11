import type { AnalyticsQuery, Filter, ProjectSessionListItem } from '@lucasschirm/sal-db';
import { css, html, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { analyticsClient } from '../db/analytics-client';
import { PageLitElement, pageHostStyles } from './page-lit-element';
import '../components/project-sessions-table';

const PAGE_SIZE = 20;

@customElement('project-sessions-page')
export class ProjectSessionsPage extends PageLitElement {
  static styles = [
    pageHostStyles,
    css`
      :host {
        color: var(--md-sys-color-on-surface, #e6e9ef);
        display: block;
        max-width: 1200px;
        margin: 0 auto;
      }

      .page-header {
        margin-bottom: 16px;
      }

      h1 {
        margin: 8px 0 4px;
        font-size: 24px;
        color: var(--md-sys-color-on-surface, #e6e9ef);
      }

      .breadcrumbs {
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 14px;
      }

      .back-link {
        color: var(--md-sys-color-primary, #4f8cff);
        text-decoration: none;
      }

      .back-link:hover {
        text-decoration: underline;
      }

      .breadcrumb-sep {
        color: var(--md-sys-color-on-surface-variant, #9aa4b2);
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
        min-width: 130px;
      }

      .filter-bar label.search-label {
        flex: 1;
        min-width: 220px;
      }

      .filter-bar input,
      .filter-bar select {
        background: var(--md-sys-color-surface, #171a21);
        border: 1px solid var(--md-sys-color-outline, #2a303c);
        border-radius: 6px;
        padding: 8px 12px;
        color: var(--md-sys-color-on-surface, #e6e9ef);
        font: inherit;
        font-size: 13px;
      }

      .filter-bar input:focus,
      .filter-bar select:focus {
        outline: 2px solid var(--md-sys-color-primary, #4f8cff);
        outline-offset: 1px;
      }

      .filter-bar button {
        background: transparent;
        color: var(--md-sys-color-primary, #4f8cff);
        border: 1px solid var(--md-sys-color-outline, #2a303c);
        border-radius: 6px;
        padding: 8px 16px;
        font: inherit;
        font-size: 13px;
        cursor: pointer;
        transition: background-color 0.15s ease;
      }

      .filter-bar button:hover {
        background: var(--md-sys-color-surface, #171a21);
      }

      .pagination-bar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: 16px;
        padding: 12px 16px;
        background: var(--md-sys-color-surface-container, #1f242e);
        border: 1px solid var(--md-sys-color-outline, #2a303c);
        border-radius: 8px;
        font-size: 13px;
        color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      }

      .pagination-actions {
        display: flex;
        gap: 8px;
      }

      .pagination-btn {
        background: var(--md-sys-color-surface, #171a21);
        border: 1px solid var(--md-sys-color-outline, #2a303c);
        border-radius: 6px;
        color: var(--md-sys-color-on-surface, #e6e9ef);
        padding: 6px 14px;
        font: inherit;
        font-size: 13px;
        cursor: pointer;
        transition: background-color 0.15s ease;
      }

      .pagination-btn:hover:not(:disabled) {
        background: var(--md-sys-color-surface-container-hover, #262d3a);
        color: var(--md-sys-color-primary, #4f8cff);
      }

      .pagination-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
    `,
  ];

  @property({ type: String, attribute: 'project-id' }) projectId = '';

  @state() private sessions: ProjectSessionListItem[] = [];

  @state() private loading = false;

  @state() private error: string | null = null;

  @state() private totalCount = 0;

  @state() private pageOffset = 0;

  @state() private searchQuery = '';

  @state() private timeStart = '';

  @state() private timeEnd = '';

  @state() private harness = '';

  @state() private mode = '';

  @state() private sessionsScope = 'all';

  @state() private resolvedProjectId: string | null = null;

  private searchDebounceTimer: number | undefined;

  connectedCallback(): void {
    super.connectedCallback();
    if (this.projectId) {
      void this.load();
    }
  }

  willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    if (changed.has('projectId') && this.projectId) {
      this.pageOffset = 0;
      void this.load();
    }
  }

  private async load(): Promise<void> {
    if (!this.projectId) return;
    this.loading = true;
    this.error = null;

    try {
      const decoded = decodeURIComponent(this.projectId);
      const resolved = await analyticsClient.resolveProjectId(decoded);
      this.resolvedProjectId = resolved ?? this.projectId;
      const targetProjectId = this.resolvedProjectId;

      const filters: Filter[] = [];
      if (this.searchQuery.trim()) {
        filters.push({ field: 'search', operator: 'contains', value: this.searchQuery.trim() });
      }
      if (this.harness.trim()) {
        filters.push({ field: 'harness', operator: 'eq', value: this.harness.trim() });
      }
      if (this.mode.trim()) {
        filters.push({ field: 'mode', operator: 'eq', value: this.mode.trim() });
      }
      if (this.sessionsScope && this.sessionsScope !== 'all') {
        filters.push({ field: 'sessions', operator: 'eq', value: this.sessionsScope });
      }

      const query: AnalyticsQuery = {
        limit: PAGE_SIZE,
        cursor: String(this.pageOffset),
        filters: filters.length > 0 ? filters : undefined,
        timeRange:
          this.timeStart || this.timeEnd
            ? {
                start: this.timeStart ? new Date(this.timeStart).toISOString() : '',
                end: this.timeEnd ? new Date(this.timeEnd).toISOString() : '',
              }
            : undefined,
      };

      const page = await analyticsClient.search.getProjectSessionList(targetProjectId, query);
      this.sessions = [...page.items];
      this.totalCount = page.totalCount ?? page.items.length;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  }

  private handleSearchInput(e: Event): void {
    const input = e.target as HTMLInputElement;
    this.searchQuery = input.value;
    clearTimeout(this.searchDebounceTimer);
    this.searchDebounceTimer = window.setTimeout(() => {
      this.pageOffset = 0;
      void this.load();
    }, 250);
  }

  private handleFilterChange(
    key: 'timeStart' | 'timeEnd' | 'harness' | 'mode' | 'sessionsScope',
    value: string,
  ): void {
    this[key] = value;
    this.pageOffset = 0;
    void this.load();
  }

  private resetFilters(): void {
    this.searchQuery = '';
    this.timeStart = '';
    this.timeEnd = '';
    this.harness = '';
    this.mode = '';
    this.sessionsScope = 'all';
    this.pageOffset = 0;
    void this.load();
  }

  private prevPage(): void {
    if (this.pageOffset <= 0) return;
    this.pageOffset = Math.max(0, this.pageOffset - PAGE_SIZE);
    void this.load();
  }

  private nextPage(): void {
    if (this.pageOffset + PAGE_SIZE >= this.totalCount) return;
    this.pageOffset += PAGE_SIZE;
    void this.load();
  }

  render() {
    const currentPage = Math.floor(this.pageOffset / PAGE_SIZE) + 1;
    const totalPages = Math.max(1, Math.ceil(this.totalCount / PAGE_SIZE));
    const canPrev = this.pageOffset > 0;
    const canNext = this.pageOffset + PAGE_SIZE < this.totalCount;

    return html`
      <div class="project-sessions-page">
        <div class="page-header">
          <div class="breadcrumbs">
            <a class="back-link" href="#/">&lt; Dashboard</a>
            <span class="breadcrumb-sep">/</span>
            <a class="back-link" href="#/projects/${encodeURIComponent(this.projectId)}">
              ← Project Behavior
            </a>
          </div>
          <h1>Sessions — ${this.projectId}</h1>
        </div>

        <div class="filter-bar">
          <label class="search-label">
            Search
            <input
              type="text"
              placeholder="Search by title or ID..."
              .value=${this.searchQuery}
              @input=${this.handleSearchInput}
            />
          </label>
          <label>
            From
            <input
              type="date"
              .value=${this.timeStart}
              @change=${(e: Event) =>
                this.handleFilterChange('timeStart', (e.target as HTMLInputElement).value)}
            />
          </label>
          <label>
            To
            <input
              type="date"
              .value=${this.timeEnd}
              @change=${(e: Event) =>
                this.handleFilterChange('timeEnd', (e.target as HTMLInputElement).value)}
            />
          </label>
          <label>
            Harness
            <input
              type="text"
              placeholder="e.g. claude"
              .value=${this.harness}
              @change=${(e: Event) =>
                this.handleFilterChange('harness', (e.target as HTMLInputElement).value)}
            />
          </label>
          <label>
            Mode
            <select
              .value=${this.mode}
              @change=${(e: Event) =>
                this.handleFilterChange('mode', (e.target as HTMLSelectElement).value)}
            >
              <option value="">All</option>
              <option value="auto">Auto</option>
              <option value="plan">Plan</option>
            </select>
          </label>
          <label>
            Sessions
            <select
              .value=${this.sessionsScope}
              @change=${(e: Event) =>
                this.handleFilterChange('sessionsScope', (e.target as HTMLSelectElement).value)}
            >
              <option value="all">All</option>
              <option value="main">Main</option>
              <option value="sub_agents">Sub Agents</option>
            </select>
          </label>
          <button type="button" @click=${this.resetFilters}>Reset</button>
        </div>

        <project-sessions-table
          .sessions=${this.sessions}
          .loading=${this.loading}
          .error=${this.error}
          .searchQuery=${this.searchQuery}
        ></project-sessions-table>

        ${
          this.totalCount > 0
            ? html`
            <div class="pagination-bar">
              <span>
                Page ${currentPage} of ${totalPages} (${this.totalCount} session${
                  this.totalCount === 1 ? '' : 's'
                })
              </span>
              <div class="pagination-actions">
                <button
                  class="pagination-btn"
                  type="button"
                  ?disabled=${!canPrev || this.loading}
                  @click=${this.prevPage}
                >
                  &lt; Previous
                </button>
                <button
                  class="pagination-btn"
                  type="button"
                  ?disabled=${!canNext || this.loading}
                  @click=${this.nextPage}
                >
                  Next &gt;
                </button>
              </div>
            </div>
          `
            : ''
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'project-sessions-page': ProjectSessionsPage;
  }
}
