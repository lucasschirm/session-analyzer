import { css, html, LitElement, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import { formatCompactNumber, formatFullNumber } from '../lib/format';
import { type SyncManager, type SyncManagerSnapshot, syncManager } from '../sync/sync-manager';

type SessionStatus =
  | 'pending'
  | 'processing'
  | 'in_sync'
  | 'failed'
  | 'skipped'
  | 'transcript_unavailable';
type ProjectSnapshot = SyncManagerSnapshot['projects'][number];
type SessionSnapshot = SyncManagerSnapshot['sessions'][number];

/**
 * Modal showing the per-project, per-session sync progress for the active run.
 *
 * - Opened from the global progress bar, it shows the full run summary.
 * - Opened from a project spinner, it filters to that project via `project-id`.
 */
@customElement('project-sync-status-modal')
export class ProjectSyncStatusModal extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }

    .modal {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
      padding: 16px;
    }

    .panel {
      background: var(--md-sys-color-surface, #171a21);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 12px;
      padding: 24px;
      width: min(640px, 100%);
      max-height: min(80vh, 600px);
      display: flex;
      flex-direction: column;
      gap: 16px;
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
    }

    h2 {
      margin: 0;
      font-size: 18px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .empty {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-size: 14px;
    }

    .project-section {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .project-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      font-size: 14px;
      font-weight: 600;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .project-meta {
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-weight: 400;
      white-space: nowrap;
    }

    .session-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
      overflow-y: auto;
    }

    .session-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 10px;
      border-radius: 8px;
      background: var(--md-sys-color-surface-container, #1f242e);
      font-size: 13px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .session-state {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }

    .session-id {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .state-icon {
      width: 18px;
      text-align: center;
    }

    .state-pending {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .state-processing {
      color: var(--md-sys-color-primary, #4f8cff);
      animation: spin 1s linear infinite;
    }

    .state-in_sync {
      color: var(--md-sys-color-success, #3ecf8e);
    }

    .state-failed {
      color: var(--md-sys-color-error, #ff6b6b);
    }

    .state-skipped,
    .state-transcript_unavailable {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .session-progress {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      white-space: nowrap;
    }

    .warnings {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 13px;
      color: var(--md-sys-color-error, #ff6b6b);
    }

    .close-button {
      align-self: flex-end;
      border: none;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
    }

    .close-button:hover {
      background: var(--md-sys-color-surface-container-hover, #262d3a);
    }

    @keyframes spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }
  `;

  @property({ type: Boolean, reflect: true }) open = false;

  @property({ type: String, attribute: 'project-id' }) projectId = '';

  @property({ attribute: false })
  syncManager: SyncManager = syncManager;

  @state() private snapshot: SyncManagerSnapshot | null = null;

  connectedCallback(): void {
    super.connectedCallback();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.syncManager.removeEventListener('change', this.handleChange);
  }

  willUpdate(changed: PropertyValues): void {
    if (changed.has('open')) {
      if (this.open) {
        this.snapshot = this.syncManager.getSnapshot();
        this.syncManager.addEventListener('change', this.handleChange);
      } else {
        this.snapshot = null;
        this.syncManager.removeEventListener('change', this.handleChange);
      }
    }
  }

  private handleChange = (event: Event): void => {
    this.snapshot = (event as CustomEvent<SyncManagerSnapshot>).detail;
  };

  private handleOverlayClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.close();
    }
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.close();
    }
  }

  private close(): void {
    this.dispatchEvent(new CustomEvent('modal-close', { bubbles: true, composed: true }));
  }

  private stateIcon(status: SessionStatus): string {
    switch (status) {
      case 'pending':
        return '🕒';
      case 'processing':
        return '⠋';
      case 'in_sync':
        return '✓';
      case 'failed':
        return '⚠';
      case 'skipped':
        return '−';
      case 'transcript_unavailable':
        return '—';
      default:
        return '';
    }
  }

  private sessionStatus(session: SessionSnapshot): SessionStatus {
    if (session.status === 'transcript_unavailable') return 'transcript_unavailable';
    if (['pending', 'processing', 'in_sync', 'failed', 'skipped'].includes(session.status)) {
      return session.status as SessionStatus;
    }
    return 'pending';
  }

  private renderSessionRow(session: SessionSnapshot): TemplateResult {
    const status = this.sessionStatus(session);
    const stateClasses = { 'state-icon': true, [`state-${status}`]: true };
    return html`
      <li class="session-item">
        <span class="session-state">
          <span class=${classMap(stateClasses)}>
            ${this.stateIcon(status)}
          </span>
          <span class="session-id" title=${session.sessionId}>${session.sessionId}</span>
        </span>
        <span
          class="session-progress"
          title="Found ${formatFullNumber(session.filesFound)} · Downloaded ${formatFullNumber(
            session.filesDownloaded,
          )} · Failed ${formatFullNumber(session.filesFailed)}"
        >
          ${formatCompactNumber(session.filesDownloaded)}/${formatCompactNumber(session.filesFound)}
        </span>
      </li>
    `;
  }

  private renderSessions(sessions: SessionSnapshot[]): TemplateResult {
    return html`
      <ul class="session-list">
        ${repeat(
          sessions,
          (session) => session.sessionId,
          (session) => this.renderSessionRow(session),
        )}
      </ul>
    `;
  }

  private renderProject(project: ProjectSnapshot, sessions: SessionSnapshot[]): TemplateResult {
    const projectSessions = sessions.filter((s) => s.projectId === project.projectId);

    return html`
      <div class="project-section">
        <div class="project-header">
          <span>${project.projectId}</span>
          <span class="project-meta">
            ${project.sessionsDone + project.sessionsFailed}/${project.totalSessions} sessions
            · ${formatCompactNumber(project.filesDownloaded)}/${formatCompactNumber(project.filesFound)} files
          </span>
        </div>
        ${this.renderSessions(projectSessions)}
      </div>
    `;
  }

  private renderProjects(projects: ProjectSnapshot[], sessions: SessionSnapshot[]): TemplateResult {
    if (projects.length === 0) {
      return html`<p class="empty">No active sync for this project.</p>`;
    }
    return html`${repeat(
      projects,
      (project) => project.projectId,
      (project) => this.renderProject(project, sessions),
    )}`;
  }

  private renderWarnings(warnings: string[]): TemplateResult {
    if (warnings.length === 0) return html``;
    return html`
      <ul class="warnings">
        ${warnings.map((warning) => html`<li>${warning}</li>`)}
      </ul>
    `;
  }

  private currentSnapshot(): SyncManagerSnapshot {
    return this.snapshot ?? this.syncManager.getSnapshot();
  }

  render(): TemplateResult {
    if (!this.open) {
      return html``;
    }

    const snapshot = this.currentSnapshot();
    const projects = this.projectId
      ? snapshot.projects.filter((p) => p.projectId === this.projectId)
      : snapshot.projects;

    return html`
      <div
        class="modal"
        @click=${this.handleOverlayClick}
        @keydown=${this.handleKeydown}
      >
        <div class="panel" role="dialog" aria-modal="true" aria-label="Sync status">
          <h2>${this.projectId ? `Sync: ${this.projectId}` : 'Sync status'}</h2>
          ${this.renderProjects(projects, snapshot.sessions)}
          ${this.renderWarnings(snapshot.warnings)}
          <button class="close-button" @click=${this.close} type="button">Close</button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'project-sync-status-modal': ProjectSyncStatusModal;
  }
}
