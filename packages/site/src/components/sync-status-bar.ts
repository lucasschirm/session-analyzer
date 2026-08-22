import { css, html, LitElement, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { type SyncManager, type SyncManagerSnapshot, syncManager } from '../sync/sync-manager';

/**
 * Bottom-fixed sync discovery indicator.
 *
 * Shows a one-line summary of what the active sync run has found so far:
 * "Found: X Projects / Y Sessions / Z sessions pending". It appears whenever
 * a run is active or queued and hides itself when the run finishes, giving the
 * user an immediate, always-visible signal that clicking "Sync" started work.
 */
@customElement('sync-status-bar')
export class SyncStatusBar extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }

    .status-bar {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 16px;
      background: var(--md-sys-color-surface-container, #1f242e);
      border-top: 1px solid var(--md-sys-color-outline, #2a303c);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      font-size: 13px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      z-index: 20;
      transition: transform 0.2s ease, opacity 0.2s ease;
    }

    .status-bar.hidden {
      transform: translateY(100%);
      opacity: 0;
      pointer-events: none;
    }

    .spinner {
      animation: spin 1s linear infinite;
      flex-shrink: 0;
    }

    @keyframes spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }

    .summary {
      display: flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .label {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .queued-suffix {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      white-space: nowrap;
    }
  `;

  @property({ attribute: false })
  syncManager: SyncManager = syncManager;

  @state() private snapshot: SyncManagerSnapshot | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.snapshot = this.syncManager.getSnapshot();
    this.syncManager.addEventListener('change', this.handleChange);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.syncManager.removeEventListener('change', this.handleChange);
  }

  private handleChange = (event: Event): void => {
    this.snapshot = (event as CustomEvent<SyncManagerSnapshot>).detail;
  };

  private get shouldShow(): boolean {
    const snapshot = this.snapshot;
    if (!snapshot) return false;
    if (snapshot.queuedRuns.length > 0) return true;
    if (!snapshot.activeRun) return false;
    return snapshot.activeRun.state === 'running' || snapshot.activeRun.state === 'queued';
  }

  private get totals(): {
    foundProjects: number;
    foundSessions: number;
    pendingSessions: number;
    queuedRuns: number;
  } {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return { foundProjects: 0, foundSessions: 0, pendingSessions: 0, queuedRuns: 0 };
    }

    const foundProjects = snapshot.projects.length;
    const foundSessions = snapshot.projects.reduce(
      (sum, project) => sum + project.totalSessions,
      0,
    );
    const pendingSessions = snapshot.sessions.filter((s) => s.status === 'pending').length;

    return {
      foundProjects,
      foundSessions,
      pendingSessions,
      queuedRuns: snapshot.queuedRuns.length,
    };
  }

  private renderQueuedSuffix(count: number): TemplateResult {
    if (count === 0) return html``;
    return html`<span class="queued-suffix">· ${count} queued</span>`;
  }

  render(): TemplateResult {
    const totals = this.totals;
    const show = this.shouldShow;
    const barClasses = { 'status-bar': true, hidden: !show };

    return html`
      <div
        class=${classMap(barClasses)}
        role="status"
        aria-live="polite"
        title="Sync discovery summary"
      >
        <span class="spinner">⠿</span>
        <span class="summary">
          <span class="label">Found:</span>
          ${totals.foundProjects} Project${totals.foundProjects === 1 ? '' : 's'}
          /
          ${totals.foundSessions} Session${totals.foundSessions === 1 ? '' : 's'}
          /
          ${totals.pendingSessions} session${totals.pendingSessions === 1 ? '' : 's'} pending
        </span>
        ${this.renderQueuedSuffix(totals.queuedRuns)}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sync-status-bar': SyncStatusBar;
  }
}
