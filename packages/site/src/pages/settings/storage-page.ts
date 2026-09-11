import { css, html, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { PageLitElement, pageHostStyles } from '../page-lit-element';
import '../../components/delete-confirmation-modal';
import { type AnalyticsBackendReport, analyticsClient } from '../../db/analytics-client';
import { dbClient } from '../../db/db-client';

/** Stable row identity — never the display label (`DatabaseRow.name`), per
 * `.agents/rules/component-identity-not-display-name.md`'s "never key on
 * display name alone" spirit. Used to look up the right client/RPC and as
 * the `repeat()` key. */
type DbId = 'control' | 'analytics';

/** Lifecycle of a row's Size column value — distinct from the value itself so
 * a failed size query never collapses onto the same "—" rendering as a
 * legitimate loading or (theoretically impossible) null-size state. */
type SizeState = 'loading' | 'ok' | 'error';

interface DatabaseRow {
  id: DbId;
  name: string;
  filename: string;
  backend: string;
  durability: string;
  size: number | null;
  sizeState: SizeState;
}

type OverlayMode = 'optimize' | 'download';
type OverlayPhase = 'running' | 'stalled' | 'success' | 'error';

/** Drives the shared "Optimizing…"/"Preparing download…" overlay used by
 * both the per-row Optimize button and the Download flow. */
interface OverlayState {
  dbId: DbId;
  mode: OverlayMode;
  phase: OverlayPhase;
  message?: string;
}

/** Per-database action table, keyed by stable id rather than display label —
 * the single source of truth for which client/RPC a row's buttons call. */
interface DbActions {
  label: string;
  downloadPrefix: string;
  vacuum: () => Promise<void>;
  exportOptimized: () => Promise<Uint8Array>;
  getSize: () => Promise<number>;
}

/** Stall safety net (per `sync-progress-observability.md`): VACUUM/VACUUM
 * INTO have no page-by-page progress callback, so a client-side timer is the
 * only way to make a genuine hang observably different from a slow-but-live
 * run. */
const OVERLAY_STALL_MS = 30_000;

/** How long the success phase stays visible before the overlay auto-closes. */
const OVERLAY_SUCCESS_DISMISS_MS = 900;

/**
 * Settings > Storage page.
 *
 * Shows the current storage configuration (control + analytics DB backends),
 * the size of each SQLite database, and allows downloading or deleting them.
 * Deleting requires a confirmation dialog and triggers a full reset: workers
 * are torn down, OPFS files and caches are removed, and the page reloads so
 * fresh empty databases are created on the next boot.
 */
@customElement('storage-page')
export class StoragePage extends PageLitElement {
  static styles = [
    pageHostStyles,
    css`
    :host {
      color: var(--md-sys-color-on-surface, #e6e9ef);
      max-width: 800px;
    }

    h1 {
      margin: 0 0 8px;
      font-size: 24px;
    }

    p.description {
      margin: 0 0 24px;
      font-size: 14px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .section {
      margin-bottom: 32px;
    }

    h2 {
      margin: 0 0 12px;
      font-size: 18px;
    }

    .config-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .config-card {
      background: var(--md-sys-color-surface, #171a21);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 12px;
      padding: 16px;
    }

    .config-card h3 {
      margin: 0 0 8px;
      font-size: 15px;
    }

    .config-row {
      display: flex;
      justify-content: space-between;
      font-size: 13px;
      padding: 4px 0;
    }

    .config-row .label {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .config-row .value {
      color: var(--md-sys-color-on-surface, #e6e9ef);
      font-weight: 600;
    }

    .warning-banner {
      background: rgba(255, 107, 107, 0.12);
      border: 1px solid var(--md-sys-color-error-container, #5c2626);
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 16px;
      font-size: 13px;
      color: var(--md-sys-color-error, #ff6b6b);
    }

    .db-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }

    .db-table th,
    .db-table td {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid var(--md-sys-color-outline, #2a303c);
    }

    .db-table th {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .db-table td.actions {
      display: flex;
      gap: 8px;
    }

    .db-table .filename {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    button {
      border: none;
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }

    button.secondary {
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
    }

    button.secondary:hover {
      background: var(--md-sys-color-surface-container-hover, #262d3a);
    }

    button.danger {
      background: transparent;
      color: var(--md-sys-color-error, #ff6b6b);
      border: 1px solid var(--md-sys-color-error-container, #5c2626);
    }

    button.danger:hover {
      background: var(--md-sys-color-error-container, #5c2626);
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .error {
      background: var(--md-sys-color-error-container, #5c2626);
      color: var(--md-sys-color-on-error-container, #ffb4ab);
      padding: 12px 16px;
      border-radius: 8px;
      margin-bottom: 16px;
      font-size: 13px;
    }

    .size-error {
      color: var(--md-sys-color-error, #ff6b6b);
      font-weight: 600;
    }

    .storage-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
      padding: 16px;
    }

    .storage-overlay-panel {
      background: var(--md-sys-color-surface, #171a21);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 12px;
      padding: 24px;
      width: min(420px, 100%);
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
      font-size: 14px;
    }

    .storage-overlay-panel p {
      margin: 0 0 8px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .storage-overlay-panel p:last-child {
      margin-bottom: 0;
    }

    .overlay-stalled {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-size: 13px;
    }

    .overlay-error {
      color: var(--md-sys-color-error, #ff6b6b);
    }

    .overlay-actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 12px;
    }
  `,
  ];

  @state() private controlBackend: 'opfs' | 'memory' | null = null;

  @state() private analyticsBackend: AnalyticsBackendReport | null = null;

  @state() private databases: DatabaseRow[] = [];

  @state() private error: string | null = null;

  @state() private deleteDialogOpen = false;

  @state() private deleting = false;

  @state() private overlay: OverlayState | null = null;

  private overlayStallTimer?: number;

  private overlaySuccessTimer?: number;

  /** Single source of truth for which client/RPC a row's buttons call —
   * keyed by stable `DbId`, never by the mutable display label. */
  private readonly dbActions: Record<DbId, DbActions> = {
    control: {
      label: 'Control DB',
      downloadPrefix: 'session-analyzer',
      vacuum: () => dbClient.vacuum(),
      exportOptimized: () => dbClient.exportControlDatabaseOptimized(),
      getSize: () => dbClient.getControlDatabaseSize(),
    },
    analytics: {
      label: 'Analytics DB',
      downloadPrefix: 'sal-analytics',
      vacuum: () => analyticsClient.vacuum(),
      exportOptimized: () => analyticsClient.exportAnalyticsDatabaseOptimized(),
      getSize: () => analyticsClient.getAnalyticsDatabaseSize(),
    },
  };

  async connectedCallback(): Promise<void> {
    super.connectedCallback();
    void this.loadStorageInfo();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.clearOverlayTimers();
  }

  private async loadStorageInfo(): Promise<void> {
    try {
      const [controlStorage, analyticsReport] = await Promise.all([
        dbClient.ensureReady(),
        analyticsClient
          .ensureReady()
          .then(() => analyticsClient.getBackend())
          .catch(() => null),
      ]);
      if (!this.isConnected) return;
      this.controlBackend = controlStorage;
      this.analyticsBackend = analyticsReport;
      this.databases = this.buildInitialRows(controlStorage, analyticsReport);

      // Fetch sizes in parallel via the lightweight PRAGMA-based RPC (never
      // the whole-database export path) — non-fatal if either fails.
      void this.loadSize('control');
      void this.loadSize('analytics');
    } catch (error) {
      if (!this.isConnected) return;
      this.error = `Failed to load storage info: ${(error as Error).message}`;
    }
  }

  private buildInitialRows(
    controlStorage: 'opfs' | 'memory',
    analyticsReport: AnalyticsBackendReport | null,
  ): DatabaseRow[] {
    return [
      {
        id: 'control',
        name: this.dbActions.control.label,
        filename: '/session-analyzer.sqlite3',
        backend: controlStorage === 'opfs' ? 'OPFS' : 'In-Memory',
        durability: controlStorage === 'opfs' ? 'Persistent' : 'Ephemeral',
        size: null,
        sizeState: 'loading',
      },
      {
        id: 'analytics',
        name: this.dbActions.analytics.label,
        filename: '/sal-analytics.sqlite3',
        backend: analyticsReport
          ? analyticsReport.backendName === 'wasm-opfs'
            ? 'OPFS'
            : 'In-Memory'
          : 'Unknown',
        durability: analyticsReport?.durability ?? 'Unknown',
        size: null,
        sizeState: 'loading',
      },
    ];
  }

  private setRowSize(id: DbId, size: number | null, sizeState: SizeState): void {
    this.databases = this.databases.map((db) => (db.id === id ? { ...db, size, sizeState } : db));
  }

  /** Refreshes a single row's Size column via the cheap PRAGMA-based RPC.
   * Used both on initial load and after a VACUUM (which changes page count). */
  private async loadSize(id: DbId): Promise<void> {
    this.setRowSize(id, null, 'loading');
    try {
      const size = await this.dbActions[id].getSize();
      if (!this.isConnected) return;
      this.setRowSize(id, size, 'ok');
    } catch {
      if (!this.isConnected) return;
      this.setRowSize(id, null, 'error');
    }
  }

  private formatSize(bytes: number | null): string {
    if (bytes === null) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  /** Builds the download-anchor and clicks it, exactly as the pre-existing
   * analytics download path did: `Blob` → object URL → temp `<a>` → click →
   * revoke. */
  private triggerDownload(id: DbId, bytes: Uint8Array): void {
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/x-sqlite3' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    const prefix = this.dbActions[id].downloadPrefix;
    anchor.download = `${prefix}-${new Date().toISOString().slice(0, 10)}.sqlite`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private clearOverlayTimers(): void {
    if (this.overlayStallTimer !== undefined) {
      window.clearTimeout(this.overlayStallTimer);
      this.overlayStallTimer = undefined;
    }
    if (this.overlaySuccessTimer !== undefined) {
      window.clearTimeout(this.overlaySuccessTimer);
      this.overlaySuccessTimer = undefined;
    }
  }

  /** Schedules a one-shot phase transition, applied only if the overlay still
   * belongs to `dbId` and is still in `fromPhase` — guards against a stale
   * timer from a finished/superseded operation clobbering current state.
   * `toPhase: null` closes the overlay instead of transitioning it. */
  private armPhaseTimer(
    dbId: DbId,
    fromPhase: OverlayPhase,
    toPhase: OverlayPhase | null,
    delayMs: number,
  ): number {
    return window.setTimeout(() => {
      if (this.overlay?.dbId === dbId && this.overlay.phase === fromPhase) {
        this.overlay = toPhase ? { ...this.overlay, phase: toPhase } : null;
      }
    }, delayMs);
  }

  /** Shared state machine for both the Optimize button and the Download flow:
   * running → (stalled after `OVERLAY_STALL_MS` if still pending) →
   * success (auto-closes) | error (stays open until dismissed). Guards every
   * post-await continuation with `isConnected` so a result that resolves
   * after the page navigates away never mutates state or triggers a
   * surprise download. */
  private async runOverlay(
    dbId: DbId,
    mode: OverlayMode,
    action: () => Promise<void>,
  ): Promise<void> {
    this.clearOverlayTimers();
    this.overlay = { dbId, mode, phase: 'running' };
    this.overlayStallTimer = this.armPhaseTimer(dbId, 'running', 'stalled', OVERLAY_STALL_MS);

    try {
      await action();
      if (!this.isConnected) return;
      this.clearOverlayTimers();
      this.overlay = { dbId, mode, phase: 'success' };
      if (mode === 'optimize') void this.loadSize(dbId);
      this.overlaySuccessTimer = this.armPhaseTimer(
        dbId,
        'success',
        null,
        OVERLAY_SUCCESS_DISMISS_MS,
      );
    } catch (error) {
      if (!this.isConnected) return;
      this.clearOverlayTimers();
      this.overlay = { dbId, mode, phase: 'error', message: (error as Error).message };
      if (mode === 'optimize') void this.loadSize(dbId);
    }
  }

  private dismissOverlay(): void {
    this.clearOverlayTimers();
    this.overlay = null;
  }

  private async handleDownload(event: Event, id: DbId): Promise<void> {
    event.stopPropagation();
    await this.runOverlay(id, 'download', async () => {
      const bytes = await this.dbActions[id].exportOptimized();
      // Guard the download side effect itself, not just the overlay state
      // that follows it — `runOverlay`'s own `isConnected` check runs after
      // this closure returns, which would be too late to stop the anchor
      // click if the page navigated away while the export was in flight.
      if (!this.isConnected) return;
      this.triggerDownload(id, bytes);
    });
  }

  private async handleOptimize(event: Event, id: DbId): Promise<void> {
    event.stopPropagation();
    await this.runOverlay(id, 'optimize', () => this.dbActions[id].vacuum());
  }

  private handleDeleteClick(): void {
    this.deleteDialogOpen = true;
  }

  private handleDeleteCancel(): void {
    this.deleteDialogOpen = false;
  }

  private async handleDeleteConfirm(): Promise<void> {
    this.deleteDialogOpen = false;
    this.deleting = true;

    try {
      // 1. Close the analytics worker (releases OPFS locks).
      await analyticsClient.close().catch(() => undefined);

      // 2. Reset the control DB client (terminates worker, clears state).
      dbClient.reset();

      // 3. Clear all caches (service worker caches).
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }

      // 4. Unregister service workers (e.g. coi-sw.js).
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((reg) => reg.unregister()));
      }

      // 5. Clear OPFS — remove all files in the origin private file system.
      if (navigator.storage?.getDirectory) {
        try {
          const root = await navigator.storage.getDirectory();
          // Remove all entries recursively.
          for await (const [name, handle] of root.entries()) {
            if (handle.kind === 'directory') {
              await root.removeEntry(name, { recursive: true }).catch(() => undefined);
            } else {
              await root.removeEntry(name).catch(() => undefined);
            }
          }
        } catch {
          // OPFS may not be available — non-fatal.
        }
      }

      // 6. Clear localStorage and sessionStorage (preference state, etc.).
      try {
        localStorage.clear();
      } catch {
        // Non-fatal.
      }
      try {
        sessionStorage.clear();
      } catch {
        // Non-fatal.
      }

      // 7. Reload the page so fresh empty databases are created on boot.
      window.location.reload();
    } catch (error) {
      this.deleting = false;
      this.error = `Failed to delete data: ${(error as Error).message}`;
    }
  }

  /** Renders the Size column body: distinguishes loading, a resolved value
   * (including a legitimate `0`), and a failed size query — never collapsing
   * failure onto the same "—" a legitimate empty/loading state would show. */
  private renderSizeCell(db: DatabaseRow): TemplateResult {
    if (db.sizeState === 'loading') return html`Calculating…`;
    if (db.sizeState === 'error') return html`<span class="size-error">Error</span>`;
    return html`${this.formatSize(db.size)}`;
  }

  /** A row's actions are disabled while its own size is (re)loading, or while
   * ANY overlay operation is in flight — not just one matching this row's id.
   * The overlay is a single full-page modal shared across all rows with no
   * focus trap, so gating only on `overlay?.dbId === db.id` would leave a
   * different row's buttons keyboard-reachable behind the backdrop; starting
   * a second operation there would overwrite the single shared `overlay`
   * field mid-flight and silently defeat the first operation's stall/error
   * state. Only one row's operation may be in flight at a time. */
  private isRowBusy(db: DatabaseRow): boolean {
    if (db.sizeState === 'loading') return true;
    return this.overlay !== null;
  }

  private overlayHeading(overlay: OverlayState): string {
    const label = this.dbActions[overlay.dbId].label;
    return overlay.mode === 'download' ? `Preparing ${label} download…` : `Optimizing ${label}…`;
  }

  /** Body of the shared overlay, one branch per state-machine phase. */
  private renderOverlayBody(overlay: OverlayState): TemplateResult {
    switch (overlay.phase) {
      case 'running':
        return html`<p>${this.overlayHeading(overlay)}</p>`;
      case 'stalled':
        return html`
          <p>${this.overlayHeading(overlay)}</p>
          <p class="overlay-stalled">This is taking longer than expected. The operation is still running.</p>
        `;
      case 'success':
        return html`
          <p>${overlay.mode === 'download' ? 'Download ready.' : 'Optimization complete.'}</p>
        `;
      case 'error':
        return html`
          <p class="overlay-error">Failed: ${overlay.message}</p>
          <div class="overlay-actions">
            <button
              type="button"
              class="secondary"
              @click=${this.dismissOverlay}
            >
              Dismiss
            </button>
          </div>
        `;
    }
  }

  private renderOverlay(): TemplateResult | string {
    const overlay = this.overlay;
    if (!overlay) return '';
    return html`
      <div class="storage-overlay" role="status" aria-live="polite">
        <div class="storage-overlay-panel">${this.renderOverlayBody(overlay)}</div>
      </div>
    `;
  }

  private renderDatabaseRow(db: DatabaseRow): TemplateResult {
    return html`
      <tr>
        <td>${db.name}<br /><small class="filename">${db.filename}</small></td>
        <td>${db.backend}</td>
        <td>${this.renderSizeCell(db)}</td>
        <td class="actions">
          <button
            class="secondary"
            ?disabled=${this.isRowBusy(db)}
            @click=${(event: Event) => this.handleDownload(event, db.id)}
          >
            Download
          </button>
          <button
            class="secondary"
            ?disabled=${this.isRowBusy(db)}
            @click=${(event: Event) => this.handleOptimize(event, db.id)}
          >
            Optimize
          </button>
        </td>
      </tr>
    `;
  }

  render() {
    const hasEphemeral =
      this.controlBackend === 'memory' || this.analyticsBackend?.durability === 'ephemeral';

    return html`
      <h1>Storage</h1>
      <p class="description">
        View and manage the local SQLite databases. All data is stored in your browser via OPFS
        (when available) or in-memory as a fallback.
      </p>

      ${this.error ? html`<div class="error">${this.error}</div>` : ''}

      ${
        hasEphemeral
          ? html`
          <div class="warning-banner">
            ⚠ One or more databases are running in <strong>in-memory</strong> mode. Data will be
            lost when the browser tab is closed. This happens when OPFS or SharedArrayBuffer is
            unavailable (e.g. missing COOP/COEP headers).
          </div>
        `
          : ''
      }

      <div class="section">
        <h2>Configuration</h2>
        <div class="config-grid">
          <div class="config-card">
            <h3>Control Database</h3>
            <div class="config-row">
              <span class="label">Backend</span>
              <span class="value">${this.controlBackend ?? '—'}</span>
            </div>
            <div class="config-row">
              <span class="label">Durability</span>
              <span class="value">
                ${this.controlBackend === 'opfs' ? 'Persistent' : this.controlBackend === 'memory' ? 'Ephemeral' : '—'}
              </span>
            </div>
          </div>
          <div class="config-card">
            <h3>Analytics Database</h3>
            <div class="config-row">
              <span class="label">Backend</span>
              <span class="value">${this.analyticsBackend?.backendName ?? '—'}</span>
            </div>
            <div class="config-row">
              <span class="label">Durability</span>
              <span class="value">${this.analyticsBackend?.durability ?? '—'}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="section">
        <h2>Databases</h2>
        <table class="db-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Backend</th>
              <th>Size</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${repeat(
              this.databases,
              (db) => db.id,
              (db) => this.renderDatabaseRow(db),
            )}
          </tbody>
        </table>
      </div>

      <div class="section">
        <h2>Danger Zone</h2>
        <p class="description">
          Delete all local databases and clear all site data. This action cannot be undone. After
          deletion, the page will reload and create fresh empty databases.
        </p>
        <button class="danger" ?disabled=${this.deleting} @click=${this.handleDeleteClick}>
          ${this.deleting ? 'Deleting…' : 'Delete All Data'}
        </button>
      </div>

      <delete-confirmation-modal
        .open=${this.deleteDialogOpen}
        .message=${'This will permanently delete all projects, sessions, connections, and analytics data stored in your browser. This cannot be undone.'}
        .confirmLabel=${'Delete All Data'}
        .titleText=${'Delete all data?'}
        @delete-confirmed=${this.handleDeleteConfirm}
        @modal-close=${this.handleDeleteCancel}
      ></delete-confirmation-modal>

      ${this.renderOverlay()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'storage-page': StoragePage;
  }
}
