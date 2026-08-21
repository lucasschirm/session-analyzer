import { css, html, LitElement, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { type SyncManager, type SyncManagerSnapshot, syncManager } from '../sync/sync-manager';

import './project-sync-status-modal';

/**
 * Global sync progress bar, always mounted so it never unmount/remount across
 * run transitions. It displays live aggregate counts when a run is active and
 * the queued-run suffix when runs are waiting.
 *
 * Clicking the bar (not the cancel button) opens the full run summary modal.
 */
@customElement('sync-progress-bar')
export class SyncProgressBar extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }

    .progress-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 7px 12px;
      border-radius: 8px;
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      font-size: 13px;
      cursor: pointer;
      user-select: none;
      transition: background-color 0.15s ease;
    }

    .progress-bar:hover {
      background: var(--md-sys-color-surface-container-hover, #262d3a);
    }

    .progress-bar.hidden {
      display: none;
    }

    .spinner {
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }

    .counts {
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .count-group {
      display: flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
    }

    .queued-suffix {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      white-space: nowrap;
    }

    .cancel-button {
      background: transparent;
      border: none;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-size: 13px;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 6px;
      line-height: 1;
    }

    .cancel-button:hover {
      color: var(--md-sys-color-error, #ff6b6b);
      background: var(--md-sys-color-error-container, #5c2626);
    }
  `;

  @property({ attribute: false })
  syncManager: SyncManager = syncManager;

  @state() private snapshot: SyncManagerSnapshot | null = null;

  @state() private modalOpen = false;

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
    totalProjects: number;
    startedProjects: number;
    totalSessions: number;
    sessionsDone: number;
    filesFound: number;
    filesDownloaded: number;
    queuedRuns: number;
  } {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return {
        totalProjects: 0,
        startedProjects: 0,
        totalSessions: 0,
        sessionsDone: 0,
        filesFound: 0,
        filesDownloaded: 0,
        queuedRuns: 0,
      };
    }

    return {
      totalProjects: snapshot.projects.length,
      startedProjects: snapshot.projects.filter((project) => project.status !== 'queued').length,
      totalSessions: this.sumProjects((p) => p.totalSessions, snapshot),
      sessionsDone: this.sumProjects((p) => p.sessionsDone, snapshot),
      filesFound: this.sumProjects((p) => p.filesFound, snapshot),
      filesDownloaded: this.sumProjects((p) => p.filesDownloaded, snapshot),
      queuedRuns: snapshot.queuedRuns.length,
    };
  }

  private sumProjects(
    value: (project: SyncManagerSnapshot['projects'][number]) => number,
    snapshot: SyncManagerSnapshot,
  ): number {
    return snapshot.projects.reduce((sum, project) => sum + value(project), 0);
  }

  private handleBarClick(): void {
    if (this.shouldShow) {
      this.modalOpen = true;
    }
  }

  private handleCancelClick(event: Event): void {
    event.stopPropagation();
    this.syncManager.cancel();
  }

  private handleModalClose(): void {
    this.modalOpen = false;
  }

  private renderCounts(totals: {
    totalProjects: number;
    startedProjects: number;
    totalSessions: number;
    sessionsDone: number;
    filesFound: number;
    filesDownloaded: number;
  }): TemplateResult {
    const label = `Projects ${totals.startedProjects}/${totals.totalProjects} | Sessions ${totals.sessionsDone}/${totals.totalSessions} | Files ${totals.filesDownloaded}/${totals.filesFound}`;
    return html`
      <span class="counts" title="Projects started | Sessions completed | Files downloaded">
        ${label}
      </span>
    `;
  }

  private renderQueuedSuffix(count: number): TemplateResult {
    if (count === 0) return html``;
    return html`<span class="queued-suffix">· ${count} queued</span>`;
  }

  private renderModal(): TemplateResult {
    return html`
      <project-sync-status-modal
        .open=${this.modalOpen}
        .syncManager=${this.syncManager}
        @modal-close=${this.handleModalClose}
      ></project-sync-status-modal>
    `;
  }

  render(): TemplateResult {
    const totals = this.totals;
    const show = this.shouldShow;
    const barClasses = { 'progress-bar': true, hidden: !show };

    return html`
      <div
        class=${classMap(barClasses)}
        @click=${this.handleBarClick}
        role="status"
        aria-live="polite"
      >
        <span class="spinner">⠿</span>
        ${this.renderCounts(totals)}
        ${this.renderQueuedSuffix(totals.queuedRuns)}
        <button
          class="cancel-button"
          title="Cancel sync"
          @click=${this.handleCancelClick}
          type="button"
        >
          [✕ Cancel]
        </button>
      </div>

      ${this.renderModal()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sync-progress-bar': SyncProgressBar;
  }
}
