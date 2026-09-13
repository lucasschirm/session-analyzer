import { css, html, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
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

      .col-actions {
        width: 170px;
        white-space: nowrap;
      }

      .row-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .action-btn {
        padding: 4px 10px;
        font-size: 12px;
        font-weight: 500;
        border-radius: 4px;
        cursor: pointer;
        background: var(--md-sys-color-surface-container, #1f242e);
        color: var(--md-sys-color-on-surface, #e6e9ef);
        border: 1px solid var(--md-sys-color-outline, #2a303c);
        transition: background-color 0.15s ease, border-color 0.15s ease;
      }

      .action-btn:hover:not(:disabled) {
        background: var(--md-sys-color-surface-container-hover, #262d3a);
        border-color: var(--md-sys-color-primary, #4f8cff);
      }

      .action-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .view-btn {
        color: var(--md-sys-color-primary, #4f8cff);
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

  @state() private availableProjects: Array<{ id: string; name: string }> = [];

  @state() private selectedSessionKeys: Set<string> = new Set();

  @state() private projectFilter: string = 'all';

  @state() private sortOrder: 'desc' | 'asc' = 'desc';

  @state() private hideSynced: boolean = false;

  @state() private loading: boolean = true;

  @state() private error: string | null = null;

  @state() private syncFeedback: string | null = null;
  @state() private processingSessionIds: Set<string> = new Set();

  private loadGeneration: number = 0;
  private isRefreshingStatuses: boolean = false;
  private pendingRefresh: boolean = false;

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
    if (changed.has('sessions')) {
      this.computeAvailableProjects();
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

  private computeAvailableProjects(): void {
    const seen = new Map<string, string>();
    for (const s of this.sessions) {
      if (!seen.has(s.projectId)) seen.set(s.projectId, s.projectName);
    }
    this.availableProjects = Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
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
    this.prepareForLoad();
    try {
      const conn = await syncManager.getConnection(this.storage);
      const items = await syncManager.listStorageSessions(this.storage);
      this.applyLoadResult(generation, conn, items);
    } catch (err) {
      if (this.loadGeneration === generation && this.isConnected) {
        this.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (this.loadGeneration === generation && this.isConnected) {
        this.loading = false;
      }
    }
  }

  private prepareForLoad(): void {
    this.loading = true;
    this.error = null;
    this.selectedSessionKeys = new Set();
    this.syncFeedback = null;
  }

  private applyLoadResult(gen: number, conn: Connection | null, items: StorageSessionItem[]): void {
    if (this.loadGeneration !== gen || !this.isConnected) return;
    this.connection = conn;
    this.sessions = items;
  }

  private handleSyncChange = (): void => {
    void this.refreshStatuses();
  };

  private async refreshStatuses(): Promise<void> {
    if (this.sessions.length === 0 || !this.storage) return;
    if (this.isRefreshingStatuses) {
      this.pendingRefresh = true;
      return;
    }
    this.isRefreshingStatuses = true;
    const generation = this.loadGeneration;
    try {
      const updated = await syncManager.refreshStorageSessionStatuses(this.sessions);
      if (this.loadGeneration === generation && this.isConnected) this.sessions = updated;
    } catch {
      // non-fatal background refresh
    } finally {
      this.finishRefresh();
    }
  }

  private finishRefresh(): void {
    this.isRefreshingStatuses = false;
    if (this.pendingRefresh) {
      this.pendingRefresh = false;
      void this.refreshStatuses();
    }
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

  private toggleSessionByKey(key: string): void {
    const next = new Set(this.selectedSessionKeys);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    this.selectedSessionKeys = next;
  }

  private handleRowClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (target instanceof HTMLInputElement && target.type === 'checkbox') return;
    const tr = (event.currentTarget as HTMLElement).closest('tr');
    const key = tr?.getAttribute('data-key');
    if (key) this.toggleSessionByKey(key);
  }

  private handleCheckboxChange(event: Event): void {
    const target = event.currentTarget as HTMLInputElement;
    const key = target.getAttribute('data-key');
    if (key) this.toggleSessionByKey(key);
  }

  private handleCellClick(event: Event): void {
    event.stopPropagation();
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
    this.selectedSessionKeys = new Set();
    this.syncFeedback = `Sync queued for ${count} session${count === 1 ? '' : 's'}.`;
  }

  private isProcessingSession(sessionId: string): boolean {
    return this.processingSessionIds.has(sessionId);
  }

  private addProcessingSession(sessionId: string): void {
    const next = new Set(this.processingSessionIds);
    next.add(sessionId);
    this.processingSessionIds = next;
  }

  private removeProcessingSession(sessionId: string): void {
    const next = new Set(this.processingSessionIds);
    next.delete(sessionId);
    this.processingSessionIds = next;
  }

  private findSessionTitle(sessionId: string): string {
    const item = this.sessions.find((s) => s.sessionId === sessionId);
    return item ? this.formatSessionTitle(item) : 'session';
  }

  private handleViewClick(event: MouseEvent): void {
    const btn = (event.currentTarget as HTMLElement).closest('button');
    const sessionId = btn?.getAttribute('data-session-id');
    if (sessionId) window.location.hash = `#/sessions/${sessionId}`;
  }

  private handleReprocessClick(event: MouseEvent): void {
    const btn = (event.currentTarget as HTMLElement).closest('button');
    const sessionId = btn?.getAttribute('data-session-id');
    const projectId = btn?.getAttribute('data-project-id');
    if (!sessionId || !projectId) return;
    void this.reprocessSession(projectId, sessionId);
  }

  private async reprocessSession(projectId: string, sessionId: string): Promise<void> {
    this.addProcessingSession(sessionId);
    try {
      await syncManager.reprocessSession(this.storage, projectId, sessionId);
      const title = this.findSessionTitle(sessionId);
      this.syncFeedback = `Reprocessing started for "${title}".`;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.removeProcessingSession(sessionId);
    }
  }

  private handleViewRawClick(event: MouseEvent): void {
    const btn = (event.currentTarget as HTMLElement).closest('button');
    const sessionId = btn?.getAttribute('data-session-id');
    const projectId = btn?.getAttribute('data-project-id');
    if (!sessionId || !projectId) return;
    const tab = window.open('about:blank', '_blank');
    void this.viewRawSession(projectId, sessionId, tab);
  }

  private async viewRawSession(
    projectId: string,
    sessionId: string,
    tab: Window | null,
  ): Promise<void> {
    this.addProcessingSession(sessionId);
    try {
      const file = await syncManager.downloadRawSessionFile(this.storage, projectId, sessionId);
      this.openRawContentInTab(tab, file.content);
    } catch (err) {
      this.handleViewRawError(tab, err);
    } finally {
      this.removeProcessingSession(sessionId);
    }
  }

  private openRawContentInTab(tab: Window | null, content: string): void {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    if (tab && !tab.closed) {
      tab.location.href = url;
    } else {
      window.open(url, '_blank');
    }
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  private handleViewRawError(tab: Window | null, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (tab && !tab.closed) {
      tab.document.body.innerText = `Failed to load raw session file: ${message}`;
    }
    this.error = `Could not view raw session: ${message}`;
  }

  private formatSessionTitle(session: StorageSessionItem): string {
    if (session.title?.trim()) {
      return session.title.trim();
    }
    return `Session from ${formatDateTime(session.lastModified)}`;
  }

  private get storageLabel(): string {
    return this.connection?.name ?? (this.loading ? 'Remote Storage' : 'Storage');
  }

  private renderHeader(): TemplateResult {
    const label = this.storageLabel;
    return html`
      <div class="breadcrumbs">
        <a
          class="back-link"
          href="#/settings/data-sources"
        >
          ← Data Sources
        </a>
        <span>/</span>
        <span>${label}</span>
      </div>
      <div class="header-title-row">
        <div>
          <h1>Cherry-pick Sessions</h1>
          <p class="subtitle">Select sessions from ${label} to sync to your local workspace.</p>
        </div>
      </div>
    `;
  }

  private renderProjectFilter(): TemplateResult {
    return html`
      <label class="filter-control">
        Project:
        <select
          .value=${this.projectFilter}
          id="project-filter"
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
          .value=${this.sortOrder}
          id="sort-order"
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
          .checked=${this.hideSynced}
          id="hide-synced"
          type="checkbox"
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

  private renderSyncButton(count: number): TemplateResult {
    return html`
      <button
        ?disabled=${count === 0}
        class="primary sync-selected-btn"
        type="button"
        @click=${this.handleSyncSelected}
      >
        Sync ${count > 0 ? `(${count})` : ''} Selected
      </button>
    `;
  }

  private renderSelectionActions(): TemplateResult {
    const count = this.selectedSessionKeys.size;
    return html`
      <div class="actions-group">
        <span class="selection-count">${count} selected</span>
        <button
          class="secondary"
          type="button"
          @click=${this.handleSelectAllVisible}
        >
          Select visible
        </button>
        <button
          class="secondary"
          type="button"
          @click=${this.handleDeselectAll}
        >
          Clear
        </button>
        ${this.renderSyncButton(count)}
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

  private renderStatusBadge(synced: boolean): TemplateResult {
    return html`
      <span
        class=${classMap({
          badge: true,
          'badge-synced': synced,
          'badge-unsynced': !synced,
        })}
      >
        ${synced ? 'Synced' : 'Not synced'}
      </span>
    `;
  }

  private renderSessionCheckbox(key: string, selected: boolean, title: string): TemplateResult {
    return html`
      <td
        class="col-checkbox"
        @click=${this.handleCellClick}
      >
        <input
          .checked=${selected}
          class="session-checkbox"
          data-key=${key}
          type="checkbox"
          aria-label="Select session ${title}"
          @change=${this.handleCheckboxChange}
        />
      </td>
    `;
  }

  private renderViewButton(sessionId: string): TemplateResult {
    return html`
      <button
        class="action-btn view-btn"
        data-session-id=${sessionId}
        type="button"
        @click=${this.handleViewClick}
      >
        View
      </button>
    `;
  }

  private renderReprocessButton(projectId: string, sessionId: string): TemplateResult {
    const busy = this.isProcessingSession(sessionId);
    return html`
      <button
        ?disabled=${busy}
        class="action-btn reprocess-btn"
        data-project-id=${projectId}
        data-session-id=${sessionId}
        type="button"
        @click=${this.handleReprocessClick}
      >
        ${busy ? 'Reprocessing...' : 'Reprocess'}
      </button>
    `;
  }

  private renderViewRawButton(projectId: string, sessionId: string): TemplateResult {
    const busy = this.isProcessingSession(sessionId);
    return html`
      <button
        ?disabled=${busy}
        class="action-btn view-raw-btn"
        data-project-id=${projectId}
        data-session-id=${sessionId}
        type="button"
        @click=${this.handleViewRawClick}
      >
        ${busy ? 'Loading...' : 'View raw'}
      </button>
    `;
  }

  private renderRowActions(session: StorageSessionItem): TemplateResult {
    return html`
      <div class="row-actions">
        ${
          session.synced
            ? html`${this.renderViewButton(session.sessionId)}${this.renderReprocessButton(session.projectId, session.sessionId)}`
            : this.renderViewRawButton(session.projectId, session.sessionId)
        }
      </div>
    `;
  }

  private renderSessionTitleCell(session: StorageSessionItem, title: string): TemplateResult {
    return html`
      <td class="col-session">
        <span
          class="session-title"
          title="Session ID: ${session.sessionId}"
        >
          ${title}
        </span>
      </td>
    `;
  }

  private renderRow(session: StorageSessionItem): TemplateResult {
    const key = `${session.projectId}:${session.sessionId}`;
    const selected = this.selectedSessionKeys.has(key);
    const title = this.formatSessionTitle(session);
    return html`
      <tr class=${classMap({ selected })} data-key=${key} @click=${this.handleRowClick}>
        ${this.renderSessionCheckbox(key, selected, title)}
        ${this.renderSessionTitleCell(session, title)}
        <td class="col-project"><span class="project-badge">${session.projectName}</span></td>
        <td class="col-date">${formatDateTime(session.lastModified)}</td>
        <td class="col-status">${this.renderStatusBadge(session.synced)}</td>
        <td class="col-actions" @click=${this.handleCellClick}>
          ${this.renderRowActions(session)}
        </td>
      </tr>
    `;
  }

  private renderTableHeader(): TemplateResult {
    return html`
      <thead>
        <tr>
          <th class="col-checkbox"></th>
          <th class="col-session">Session</th>
          <th class="col-project">Project</th>
          <th class="col-date">Modified Date</th>
          <th class="col-status">Status</th>
          <th class="col-actions">Actions</th>
        </tr>
      </thead>
    `;
  }

  private renderEmptyFilterState(): TemplateResult {
    return html`
      <div class="state-box">
        <p>No sessions match the current filter.</p>
        <button
          class="secondary"
          type="button"
          @click=${this.handleResetFilters}
        >
          Reset filters
        </button>
      </div>
    `;
  }

  private renderEmptyStorageState(): TemplateResult {
    return html`
      <div class="state-box">
        <p>No sessions found in this storage.</p>
        <button
          class="secondary"
          type="button"
          @click=${this.loadData}
        >
          Check again
        </button>
      </div>
    `;
  }

  private renderTable(): TemplateResult {
    if (this.filteredSessions.length === 0) {
      return this.renderEmptyFilterState();
    }
    return html`
      <div class="table-container">
        <table>
          ${this.renderTableHeader()}
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

  private renderErrorState(): TemplateResult {
    return html`
      <div
        class="error-banner"
        role="alert"
      >
        <span>${this.error}</span>
        <button
          class="secondary"
          type="button"
          @click=${this.loadData}
        >
          Retry
        </button>
      </div>
    `;
  }

  private renderLoadingState(): TemplateResult {
    return html`
      <div
        class="state-box"
        role="status"
        aria-live="polite"
      >
        <span class="spinner"></span> Loading sessions from storage...
      </div>
    `;
  }

  private renderContent(): TemplateResult {
    if (this.error) return this.renderErrorState();
    if (this.loading) return this.renderLoadingState();
    if (this.sessions.length === 0) return this.renderEmptyStorageState();
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
