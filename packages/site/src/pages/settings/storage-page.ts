import { css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { PageLitElement, pageHostStyles } from '../page-lit-element';
import '../../components/delete-confirmation-modal';
import '../../components/settings-tabs';
import { type AnalyticsBackendReport, analyticsClient } from '../../db/analytics-client';
import { dbClient } from '../../db/db-client';

interface DatabaseRow {
  name: string;
  filename: string;
  backend: string;
  durability: string;
  size: number | null;
  loading: boolean;
}

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
  `,
  ];

  @state() private controlBackend: 'opfs' | 'memory' | null = null;

  @state() private analyticsBackend: AnalyticsBackendReport | null = null;

  @state() private databases: DatabaseRow[] = [];

  @state() private error: string | null = null;

  @state() private deleteDialogOpen = false;

  @state() private deleting = false;

  async connectedCallback(): Promise<void> {
    super.connectedCallback();
    void this.loadStorageInfo();
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
      this.controlBackend = controlStorage;
      this.analyticsBackend = analyticsReport;

      // Load database sizes via export byte length (guaranteed to work even
      // when OPFS files are locked by sync access handles).
      const databases: DatabaseRow[] = [
        {
          name: 'Control DB',
          filename: '/session-analyzer.sqlite3',
          backend: controlStorage === 'opfs' ? 'OPFS' : 'In-Memory',
          durability: controlStorage === 'opfs' ? 'Persistent' : 'Ephemeral',
          size: null,
          loading: true,
        },
        {
          name: 'Analytics DB',
          filename: '/sal-analytics.sqlite3',
          backend: analyticsReport
            ? analyticsReport.backendName === 'wasm-opfs'
              ? 'OPFS'
              : 'In-Memory'
            : 'Unknown',
          durability: analyticsReport?.durability ?? 'Unknown',
          size: null,
          loading: true,
        },
      ];
      this.databases = databases;

      // Fetch sizes in parallel — non-fatal if either fails.
      void this.loadControlSize();
      void this.loadAnalyticsSize();
    } catch (error) {
      this.error = `Failed to load storage info: ${(error as Error).message}`;
    }
  }

  private async loadControlSize(): Promise<void> {
    try {
      const bytes = await dbClient.exportControlDatabase();
      this.databases = this.databases.map((db) =>
        db.name === 'Control DB' ? { ...db, size: bytes.byteLength, loading: false } : db,
      );
    } catch {
      this.databases = this.databases.map((db) =>
        db.name === 'Control DB' ? { ...db, size: null, loading: false } : db,
      );
    }
  }

  private async loadAnalyticsSize(): Promise<void> {
    try {
      const bytes = await analyticsClient.exportAnalyticsDatabase();
      this.databases = this.databases.map((db) =>
        db.name === 'Analytics DB' ? { ...db, size: bytes.byteLength, loading: false } : db,
      );
    } catch {
      this.databases = this.databases.map((db) =>
        db.name === 'Analytics DB' ? { ...db, size: null, loading: false } : db,
      );
    }
  }

  private formatSize(bytes: number | null): string {
    if (bytes === null) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  private async handleDownload(event: Event, dbName: string): Promise<void> {
    event.stopPropagation();
    try {
      if (dbName === 'Control DB') {
        await dbClient.exportAndDownload();
      } else {
        const bytes = await analyticsClient.exportAnalyticsDatabase();
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/x-sqlite3' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `sal-analytics-${new Date().toISOString().slice(0, 10)}.sqlite`;
        anchor.click();
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      this.error = `Failed to download database: ${(error as Error).message}`;
    }
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
      if (navigator.storage && navigator.storage.getDirectory) {
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

  render() {
    const hasEphemeral =
      this.controlBackend === 'memory' || this.analyticsBackend?.durability === 'ephemeral';

    return html`
      <settings-tabs></settings-tabs>
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
            ${this.databases.map(
              (db) => html`
                <tr>
                  <td>${db.name}<br /><small style="color: var(--md-sys-color-on-surface-variant)">${db.filename}</small></td>
                  <td>${db.backend}</td>
                  <td>${db.loading ? 'Calculating…' : this.formatSize(db.size)}</td>
                  <td class="actions">
                    <button
                      class="secondary"
                      ?disabled=${db.loading}
                      @click=${(event: Event) => this.handleDownload(event, db.name)}
                    >
                      Download
                    </button>
                  </td>
                </tr>
              `,
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
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'storage-page': StoragePage;
  }
}
