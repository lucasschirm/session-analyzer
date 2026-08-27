import { css, html, LitElement, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { type SyncManager, type SyncManagerSnapshot, syncManager } from '../sync/sync-manager';

import './project-sync-status-modal';

/** How long the final-results summary stays visible after a run completes. */
const COMPLETED_DISPLAY_MS = 6000;

/**
 * Global sync progress bar, always mounted so it never unmount/remount across
 * run transitions. It displays live aggregate counts when a run is active and
 * the queued-run suffix when runs are waiting.
 *
 * When a run finishes (done / cancelled / failed) the bar switches to a
 * final-results summary with unicode icons showing files downloaded, new
 * projects, new sessions, and sessions updated. The summary auto-hides after
 * {@link COMPLETED_DISPLAY_MS} milliseconds.
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

    .progress-bar.completed {
      border-color: var(--md-sys-color-outline-variant, #3a4150);
    }

    .progress-bar.completed-done {
      border-color: var(--md-sys-color-success, #3ecf8e);
    }

    .progress-bar.completed-failed {
      border-color: var(--md-sys-color-error, #ff6b6b);
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

    .count-icon {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .count-icon-done {
      color: var(--md-sys-color-success, #3ecf8e);
    }

    .count-icon-new {
      color: var(--md-sys-color-primary, #4f8cff);
    }

    .count-icon-updated {
      color: var(--md-sys-color-tertiary, #f0a040);
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

    .dismiss-button {
      background: transparent;
      border: none;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-size: 13px;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 6px;
      line-height: 1;
    }

    .dismiss-button:hover {
      color: var(--md-sys-color-on-surface, #e6e9ef);
      background: var(--md-sys-color-surface-container-hover, #262d3a);
    }
  `;

  @property({ attribute: false })
  syncManager: SyncManager = syncManager;

  @state() private snapshot: SyncManagerSnapshot | null = null;

  @state() private modalOpen = false;

  /** Snapshot captured when the run transitioned to a terminal state. */
  @state() private completedSnapshot: SyncManagerSnapshot | null = null;

  /** The terminal state of the completed run (done / cancelled / failed). */
  @state() private completedState: 'done' | 'cancelled' | 'failed' | null = null;

  private completedTimer: ReturnType<typeof setTimeout> | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.snapshot = this.syncManager.getSnapshot();
    this.syncManager.addEventListener('change', this.handleChange);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.syncManager.removeEventListener('change', this.handleChange);
    this.clearCompletedTimer();
  }

  private handleChange = (event: Event): void => {
    const snapshot = (event as CustomEvent<SyncManagerSnapshot>).detail;
    this.snapshot = snapshot;

    const runState = snapshot.activeRun?.state;
    if (runState === 'done' || runState === 'cancelled' || runState === 'failed') {
      // A run just entered a terminal state — capture the final snapshot and
      // start the auto-hide timer. If a new run starts while the summary is
      // still visible, the transition back to running/queued clears it.
      if (this.completedState !== runState || !this.completedSnapshot) {
        this.completedSnapshot = snapshot;
        this.completedState = runState;
        this.startCompletedTimer();
      }
    } else if (runState === 'running' || runState === 'queued') {
      this.clearCompletedDisplay();
    }
  };

  private startCompletedTimer(): void {
    this.clearCompletedTimer();
    this.completedTimer = setTimeout(() => {
      this.clearCompletedDisplay();
    }, COMPLETED_DISPLAY_MS);
  }

  private clearCompletedTimer(): void {
    if (this.completedTimer) {
      clearTimeout(this.completedTimer);
      this.completedTimer = null;
    }
  }

  private clearCompletedDisplay(): void {
    this.clearCompletedTimer();
    this.completedSnapshot = null;
    this.completedState = null;
  }

  private get isCompletedDisplay(): boolean {
    return this.completedSnapshot !== null && this.completedState !== null;
  }

  private get shouldShow(): boolean {
    if (this.isCompletedDisplay) return true;
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

  /** Final-results totals computed from the captured completed snapshot. */
  private get completedTotals(): {
    filesDownloaded: number;
    newProjects: number;
    newSessions: number;
    sessionsUpdated: number;
  } {
    const snapshot = this.completedSnapshot;
    if (!snapshot) {
      return { filesDownloaded: 0, newProjects: 0, newSessions: 0, sessionsUpdated: 0 };
    }
    return {
      filesDownloaded: this.sumProjects((p) => p.filesDownloaded, snapshot),
      newProjects: snapshot.projects.filter((p) => p.isNew).length,
      newSessions: snapshot.sessions.filter((s) => s.isNew).length,
      sessionsUpdated: snapshot.sessions.filter((s) => s.wasUpdated).length,
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

  private handleDismissClick(event: Event): void {
    event.stopPropagation();
    this.clearCompletedDisplay();
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

  private renderCompletedCounts(totals: {
    filesDownloaded: number;
    newProjects: number;
    newSessions: number;
    sessionsUpdated: number;
  }): TemplateResult {
    const title = `Files downloaded: ${totals.filesDownloaded} | New projects: ${totals.newProjects} | New sessions: ${totals.newSessions} | Sessions updated: ${totals.sessionsUpdated}`;
    return html`
      <span class="counts" title=${title}>
        <span class="count-group">
          <span class="count-icon count-icon-done">⬇</span>${totals.filesDownloaded}
        </span>
        <span class="count-group">
          <span class="count-icon count-icon-new">✦</span>${totals.newProjects}
        </span>
        <span class="count-group">
          <span class="count-icon count-icon-new">✚</span>${totals.newSessions}
        </span>
        <span class="count-group">
          <span class="count-icon count-icon-updated">↻</span>${totals.sessionsUpdated}
        </span>
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
    const show = this.shouldShow;
    if (!show) {
      return html`${this.renderModal()}`;
    }

    const completed = this.isCompletedDisplay;
    const barClasses = {
      'progress-bar': true,
      hidden: false,
      completed,
      'completed-done': completed && this.completedState === 'done',
      'completed-failed': completed && this.completedState === 'failed',
    };

    if (completed) {
      const totals = this.completedTotals;
      const stateIcon =
        this.completedState === 'done' ? '✓' : this.completedState === 'cancelled' ? '⊘' : '⚠';
      const stateLabel =
        this.completedState === 'done'
          ? 'Sync complete'
          : this.completedState === 'cancelled'
            ? 'Sync cancelled'
            : 'Sync failed';

      return html`
        <div
          class=${classMap(barClasses)}
          @click=${this.handleBarClick}
          role="status"
          aria-live="polite"
          title=${stateLabel}
        >
          <span class="count-icon count-icon-done">${stateIcon}</span>
          ${this.renderCompletedCounts(totals)}
          <button
            class="dismiss-button"
            title="Dismiss"
            @click=${this.handleDismissClick}
            type="button"
          >
            [✕]
          </button>
        </div>
        ${this.renderModal()}
      `;
    }

    const totals = this.totals;
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
