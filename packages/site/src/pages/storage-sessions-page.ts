import { css, html, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { formatDateTime } from '../lib/format';
import { type StorageSessionItem, syncManager } from '../sync/sync-manager';
import type { Connection } from '../types';
import { PageLitElement, pageHostStyles } from './page-lit-element';

/**
 * Storage sessions cherry-pick page (`#/storage/:storage/sessions`).
 *
 * Allows users to inspect sessions in an S3 remote data source,
 * filter by project, sort by modified date (ASC/DESC), hide already
 * synced sessions, select multiple sessions, and queue them for sync.
 */
@customElement('storage-sessions-page')
export class StorageSessionsPage extends PageLitElement {
  static styles = [
    pageHostStyles,
    css`
      :host {
        color: var(--md-sys-color-on-surface, #e6e9ef);
        display: block;
        max-width: 1200px;
        margin: 0 auto;
      }

      .storage-sessions-page {
        display: flex;
        flex-direction: column;
        gap: 20px;
      }

      .breadcrumbs {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 14px;
      }

      .back-link {
        color: var(--md-sys-color-primary, #4f8cff);
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }

      .back-link:hover {
        text-decoration: underline;
      }

      .header-title-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
      }

      h1 {
        margin: 0;
        font-size: 24px;
        color: var(--md-sys-color-on-surface, #e6e9ef);
      }

      .subtitle {
        margin: 4px 0 0;
        font-size: 14px;
        color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      }

      .toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
        background: var(--md-sys-color-surface, #171a21);
        border: 1px solid var(--md-sys-color-outline, #2a303c);
        border-radius: 8px;
        padding: 12px 16px;
      }

      .filters-group {
        display: flex;
        align-items: center;
        gap: 16px;
        flex-wrap: wrap;
      }

      .filter-control {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      }

      select {
        background: var(--md-sys-color-surface-container, #1f242e);
        border: 1px solid var(--md-sys-color-outline, #2a303c);
        color: var(--md-sys-color-on-surface, #e6e9ef);
        padding: 6px 10px;
        border-radius: 6px;
        font-size: 13px;
        cursor: pointer;
      }

      select:focus {
        outline: 2px solid var(--md-sys-color-primary, #4f8cff);
        outline-offset: 1px;
      }

      .checkbox-label {
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        user-select: none;
        font-size: 13px;
        color: var(--md-sys-color-on-surface, #e6e9ef);
      }

      .checkbox-label input {
        accent-color: var(--md-sys-color-primary, #4f8cff);
        cursor: pointer;
      }

      .actions-group {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
      }

      .selection-count {
        font-size: 13px;
        font-weight: 500;
        color: var(--md-sys-color-on-surface, #e6e9ef);
      }

      button {
        border: none;
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: opacity 0.15s ease, background-color 0.15s ease;
      }

      button.primary {
        background: var(--md-sys-color-primary, #4f8cff);
        color: #fff;
      }

      button.primary:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      button.secondary {
        background: var(--md-sys-color-surface-container, #1f242e);
        color: var(--md-sys-color-on-surface, #e6e9ef);
        border: 1px solid var(--md-sys-color-outline, #2a303c);
      }

      button.secondary:hover {
        background: var(--md-sys-color-surface-container-hover, #262d3a);
      }

      .table-container {
        width: 100%;
        overflow-x: auto;
        border: 1px solid var(--md-sys-color-outline, #2a303c);
        border-radius: 8px;
        background: var(--md-sys-color-surface-container, #1f242e);
      }

      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
        text-align: left;
      }

      th,
      td {
        padding: 12px 16px;
        border-bottom: 1px solid var(--md-sys-color-outline, #2a303c);
      }

      th {
        color: var(--md-sys-color-on-surface-variant, #9aa4b2);
        font-weight: 600;
        white-space: nowrap;
        background: var(--md-sys-color-surface, #171a21);
      }

      tbody tr:last-child td {
        border-bottom: none;
      }

      tbody tr {
        transition: background-color 0.15s ease;
        cursor: pointer;
      }

      tbody tr:hover {
        background: var(--md-sys-color-surface-container-hover, #262d3a);
      }

      tbody tr.selected {
        background: rgba(79, 140, 255, 0.1);
      }

      .col-checkbox {
        width: 40px;
        text-align: center;
      }

      .col-checkbox input {
        accent-color: var(--md-sys-color-primary, #4f8cff);
        cursor: pointer;
      }

      .col-session {
        min-width: 240px;
      }

      .session-title {
        font-weight: 500;
        color: var(--md-sys-color-on-surface, #e6e9ef);
        display: block;
      }

      .col-project {
        min-width: 160px;
      }

      .project-badge {
        display: inline-block;
        font-size: 12px;
        color: var(--md-sys-color-on-surface, #e6e9ef);
      }

      .col-date {
        min-width: 160px;
        white-space: nowrap;
        color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      }

      .col-status {
        width: 110px;
        white-space: nowrap;
      }

      .badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .badge-synced {
        background: rgba(52, 168, 83, 0.15);
        color: #81c995;
        border: 1px solid rgba(52, 168, 83, 0.3);
      }

      .badge-unsynced {
        background: var(--md-sys-color-surface, #171a21);
        color: var(--md-sys-color-on-surface-variant, #9aa4b2);
        border: 1px solid var(--md-sys-color-outline, #2a303c);
      }

      .state-box {
        text-align: center;
        padding: 48px 24px;
        border: 1px dashed var(--md-sys-color-outline, #2a303c);
        border-radius: 8px;
        color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      }

      .error-banner {
        background: var(--md-sys-color-error-container, #5c2626);
        color: var(--md-sys-color-on-error-container, #ffb4ab);
        padding: 12px 16px;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .feedback-banner {
        background: rgba(52, 168, 83, 0.15);
        color: #81c995;
        border: 1px solid rgba(52, 168, 83, 0.3);
        padding: 12px 16px;
        border-radius: 8px;
      }

      .spinner {
        display: inline-block;
        width: 20px;
        height: 20px;
        border: 2px solid rgba(79, 140, 255, 0.2);
        border-top-color: var(--md-sys-color-primary, #4f8cff);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
        vertical-align: middle;
        margin-right: 8px;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ];

  @property({ type: String }) storage: string = '';

  @state() private connection: Connection | null = null;

  @state() private sessions: StorageSessionItem[] = [];

  @state() private filteredSessions: StorageSessionItem[] = [];

  @state() private selectedSessionKeys: Set<string> = new Set();

  @state() private projectFilter: string = 'all';

  @state() private sortOrder: 'desc' | 'asc' = 'desc';

  @state() private hideSynced: boolean = false;

  @state() private loading: boolean = true;

  @state() private error: string | null = null;

  @state() private syncFeedback: string | null = null;

  private loadGeneration: number = 0;

  connectedCallback(): void {
    super.connectedCallback();
    syncManager.addEventListener('change', this.handleSyncChange);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    syncManager.removeEventListener('change', this.handleSyncChange);
  }

  protected willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (changed.has('storage') && this.storage) {
      void this.loadData();
    }
    if (
      changed.has('sessions') ||
      changed.has('projectFilter') ||
      changed.has('hideSynced') ||
      changed.has('sortOrder')
    ) {
      this.computeFilteredSessions();
    }
  }

  private computeFilteredSessions(): void {
    let list = this.sessions;
    if (this.projectFilter !== 'all') {
      list = list.filter((s) => s.projectId === this.projectFilter);
    }
    if (this.hideSynced) {
      list = list.filter((s) => !s.synced);
    }
    this.filteredSessions = [...list].sort((a, b) => {
      const diff = a.modifiedTimestamp - b.modifiedTimestamp;
      return this.sortOrder === 'asc' ? diff : -diff;
    });
  }

  async loadData(): Promise<void> {
    if (!this.storage) return;
    const generation = ++this.loadGeneration;
    this.loading = true;
    this.error = null;
    try {
      const connection = await syncManager.getConnection(this.storage);
      const sessions = await syncManager.listStorageSessions(this.storage);
      if (this.loadGeneration !== generation || !this.isConnected) return;
      this.connection = connection;
      this.sessions = sessions;
    } catch (err) {
      if (this.loadGeneration !== generation || !this.isConnected) return;
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (this.loadGeneration === generation && this.isConnected) {
        this.loading = false;
      }
    }
  }

  private handleSyncChange = (): void => {
    void this.refreshStatuses();
  };

  private async refreshStatuses(): Promise<void> {
    if (this.sessions.length === 0 || !this.storage) return;
    const generation = this.loadGeneration;
    try {
      const sessions = await syncManager.listStorageSessions(this.storage);
      if (this.loadGeneration === generation && this.isConnected) {
        this.sessions = sessions;
      }
    } catch {
      // non-fatal background refresh
    }
  }

  private get availableProjects(): Array<{ id: string; name: string }> {
    const seen = new Map<string, string>();
    for (const s of this.sessions) {
      if (!seen.has(s.projectId)) seen.set(s.projectId, s.projectName);
    }
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  }

  private handleProjectFilterChange(event: Event): void {
    this.projectFilter = (event.target as HTMLSelectElement).value;
  }

  private handleSortOrderChange(event: Event): void {
    this.sortOrder = (event.target as HTMLSelectElement).value as 'desc' | 'asc';
  }

  private handleHideSyncedChange(event: Event): void {
    this.hideSynced = (event.target as HTMLInputElement).checked;
  }

  private handleToggleSession(projectId: string, sessionId: string): void {
    const key = `${projectId}:${sessionId}`;
    const next = new Set(this.selectedSessionKeys);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    this.selectedSessionKeys = next;
  }

  private handleSelectAllVisible(): void {
    const next = new Set(this.selectedSessionKeys);
    for (const s of this.filteredSessions) {
      next.add(`${s.projectId}:${s.sessionId}`);
    }
    this.selectedSessionKeys = next;
  }

  private handleDeselectAll(): void {
    this.selectedSessionKeys = new Set();
  }

  private handleResetFilters(): void {
    this.projectFilter = 'all';
    this.hideSynced = false;
  }

  private handleSyncSelected(): void {
    const connId = this.connection?.id ?? this.storage;
    const selected = this.sessions.filter((s) =>
      this.selectedSessionKeys.has(`${s.projectId}:${s.sessionId}`),
    );
    if (selected.length === 0) return;
    const targetSessions = selected.map((s) => ({
      projectId: s.projectId,
      sessionId: s.sessionId,
    }));
    syncManager.requestRun(connId, { targetSessions });
    const count = selected.length;
    this.syncFeedback = `Sync queued for ${count} session${count === 1 ? '' : 's'}.`;
  }

  private formatSessionTitle(session: StorageSessionItem): string {
    if (session.title?.trim()) {
      return session.title.trim();
    }
    return `Session from ${formatDateTime(session.lastModified)}`;
  }

  private renderHeader(): TemplateResult {
    const storageLabel = this.connection?.name || this.storage || 'Storage';
    return html`
      <div class="breadcrumbs">
        <a href="#/settings/data-sources" class="back-link">← Data Sources</a>
        <span>/</span>
        <span>${storageLabel}</span>
      </div>
      <div class="header-title-row">
        <div>
          <h1>Cherry-pick Sessions</h1>
          <p class="subtitle">Select sessions from ${storageLabel} to sync to your local workspace.</p>
        </div>
      </div>
    `;
  }

  private renderProjectFilter(): TemplateResult {
    return html`
      <label class="filter-control">
        Project:
        <select
          id="project-filter"
          .value=${this.projectFilter}
          @change=${this.handleProjectFilterChange}
        >
          <option value="all">All projects</option>
          ${repeat(
            this.availableProjects,
            (p) => p.id,
            (p) => html`<option value=${p.id}>${p.name}</option>`,
          )}
        </select>
      </label>
    `;
  }

  private renderSortFilter(): TemplateResult {
    return html`
      <label class="filter-control">
        Sort:
        <select
          id="sort-order"
          .value=${this.sortOrder}
          @change=${this.handleSortOrderChange}
        >
          <option value="desc">Modified date: Newest first</option>
          <option value="asc">Modified date: Oldest first</option>
        </select>
      </label>
    `;
  }

  private renderHideSyncedFilter(): TemplateResult {
    return html`
      <label class="checkbox-label">
        <input
          type="checkbox"
          id="hide-synced"
          .checked=${this.hideSynced}
          @change=${this.handleHideSyncedChange}
        />
        Hide already synced
      </label>
    `;
  }

  private renderFilters(): TemplateResult {
    return html`
      <div class="filters-group">
        ${this.renderProjectFilter()}
        ${this.renderSortFilter()}
        ${this.renderHideSyncedFilter()}
      </div>
    `;
  }

  private renderSelectionActions(): TemplateResult {
    const count = this.selectedSessionKeys.size;
    return html`
      <div class="actions-group">
        <span class="selection-count">${count} selected</span>
        <button type="button" class="secondary" @click=${this.handleSelectAllVisible}>
          Select visible
        </button>
        <button type="button" class="secondary" @click=${this.handleDeselectAll}>
          Clear
        </button>
        <button
          type="button"
          class="primary sync-selected-btn"
          ?disabled=${count === 0}
          @click=${this.handleSyncSelected}
        >
          Sync ${count > 0 ? `(${count})` : ''} Selected
        </button>
      </div>
    `;
  }

  private renderToolbar(): TemplateResult {
    return html`
      <div class="toolbar">
        ${this.renderFilters()}
        ${this.renderSelectionActions()}
      </div>
    `;
  }

  private renderRow(session: StorageSessionItem): TemplateResult {
    const key = `${session.projectId}:${session.sessionId}`;
    const selected = this.selectedSessionKeys.has(key);
    const title = this.formatSessionTitle(session);
    return html`
      <tr
        class=${selected ? 'selected' : ''}
        @click=${() => this.handleToggleSession(session.projectId, session.sessionId)}
      >
        <td class="col-checkbox" @click=${(e: Event) => e.stopPropagation()}>
          <input
            type="checkbox"
            .checked=${selected}
            aria-label="Select session ${title}"
            @change=${() => this.handleToggleSession(session.projectId, session.sessionId)}
          />
        </td>
        <td class="col-session">
          <span class="session-title" title="Session ID: ${session.sessionId}">${title}</span>
        </td>
        <td class="col-project">
          <span class="project-badge">${session.projectName}</span>
        </td>
        <td class="col-date">${formatDateTime(session.lastModified)}</td>
        <td class="col-status">
          <span class="badge ${session.synced ? 'badge-synced' : 'badge-unsynced'}">
            ${session.synced ? 'Synced' : 'Not synced'}
          </span>
        </td>
      </tr>
    `;
  }

  private renderTable(): TemplateResult {
    if (this.filteredSessions.length === 0) {
      return html`
        <div class="state-box">
          <p>No sessions match the current filter criteria.</p>
          <button type="button" class="secondary" @click=${this.handleResetFilters}>
            Reset filters
          </button>
        </div>
      `;
    }
    return html`
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th class="col-checkbox"></th>
              <th class="col-session">Session</th>
              <th class="col-project">Project</th>
              <th class="col-date">Modified Date</th>
              <th class="col-status">Status</th>
            </tr>
          </thead>
          <tbody>
            ${repeat(
              this.filteredSessions,
              (s) => `${s.projectId}:${s.sessionId}`,
              (s) => this.renderRow(s),
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  private renderContent(): TemplateResult {
    if (this.error) {
      return html`
        <div class="error-banner" role="alert">
          <span>${this.error}</span>
          <button type="button" class="secondary" @click=${this.loadData}>Retry</button>
        </div>
      `;
    }
    if (this.loading) {
      return html`
        <div class="state-box" role="status" aria-live="polite">
          <span class="spinner"></span> Loading sessions from storage...
        </div>
      `;
    }
    if (this.sessions.length === 0) {
      return html`<div class="state-box">No sessions found in this storage.</div>`;
    }
    return html`
      ${this.renderToolbar()}
      ${this.renderTable()}
    `;
  }

  render(): TemplateResult {
    return html`
      <div class="storage-sessions-page">
        ${this.renderHeader()}
        ${this.syncFeedback ? html`<div class="feedback-banner">${this.syncFeedback}</div>` : ''}
        ${this.renderContent()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'storage-sessions-page': StorageSessionsPage;
  }
}
