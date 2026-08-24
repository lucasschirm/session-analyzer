import { css, html, LitElement } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import '../components/project-modal';
import '../components/project-sync-indicator';
import '../components/project-sync-status-modal';
import { dbClient } from '../db/db-client';
import { navigateTo } from '../router';
import { type SyncManagerSnapshot, syncManager } from '../sync/sync-manager';
import type { Project } from '../types';

/**
 * Home page: projects list with full CRUD.
 *
 * - `[ + New Project ]` opens the project modal (name + description).
 * - `[ Delete Project ]` removes the project and cascades to its sessions.
 * - `[ Export Database ]` downloads the whole SQLite file.
 * - Clicking a project card routes to the Project View.
 */
@customElement('home-page')
export class HomePage extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .home-page {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .page-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
    }

    h1 {
      margin: 0;
      font-size: 24px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .page-header-actions {
      display: flex;
      gap: 8px;
    }

    button {
      border: none;
      padding: 10px 18px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }

    button.primary {
      background: var(--md-sys-color-primary, #4f8cff);
      color: #fff;
    }

    button.primary:hover {
      filter: brightness(1.1);
    }

    button.secondary {
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
    }

    .projects-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 16px;
    }

    .project-card {
      background: var(--md-sys-color-surface, #171a21);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 12px;
      padding: 18px;
      cursor: pointer;
      transition: border-color 0.15s ease, background-color 0.15s ease;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .project-card:hover {
      border-color: var(--md-sys-color-primary, #4f8cff);
      background: var(--md-sys-color-surface-container, #1f242e);
    }

    .project-card h3 {
      margin: 0;
      font-size: 17px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .project-card .description {
      margin: 0;
      font-size: 13px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      min-height: 18px;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }

    .project-card-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: auto;
      padding-top: 8px;
    }

    .project-meta {
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .delete-button {
      background: transparent;
      border: 1px solid var(--md-sys-color-error-container, #5c2626);
      color: var(--md-sys-color-error, #ff6b6b);
      padding: 6px 12px;
      font-size: 12px;
      border-radius: 6px;
    }

    .delete-button:hover {
      background: var(--md-sys-color-error-container, #5c2626);
    }

    .empty-state {
      border: 1px dashed var(--md-sys-color-outline, #2a303c);
      border-radius: 12px;
      padding: 48px 24px;
      text-align: center;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .error {
      background: var(--md-sys-color-error-container, #5c2626);
      color: var(--md-sys-color-on-error-container, #ffb4ab);
      padding: 12px 16px;
      border-radius: 8px;
    }

    .notice {
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 13px;
    }
  `;

  @state() private projects: Project[] = [];

  @state() private modalOpen = false;

  @state() private isLoading = true;

  @state() private error: string | null = null;

  @state() private syncSnapshot: SyncManagerSnapshot | null = null;

  @state() private syncModalProjectId = '';

  connectedCallback(): void {
    super.connectedCallback();
    this.syncSnapshot = syncManager.getSnapshot();
    syncManager.addEventListener('change', this.handleSyncChange);
    void this.loadProjects();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    syncManager.removeEventListener('change', this.handleSyncChange);
  }

  private handleSyncChange = (event: Event): void => {
    const wasRunning = this.isRunActive(this.syncSnapshot);
    const prevProjectIds = new Set(this.syncSnapshot?.projects.map((p) => p.localProjectId) ?? []);
    const prevSessionCount = this.syncSnapshot?.sessions.length ?? 0;
    this.syncSnapshot = (event as CustomEvent<SyncManagerSnapshot>).detail;
    const runEnded = wasRunning && !this.isRunActive(this.syncSnapshot);
    const hasNewProjects =
      this.syncSnapshot?.projects.some((p) => !prevProjectIds.has(p.localProjectId)) ?? false;
    const sessionCount = this.syncSnapshot?.sessions.length ?? 0;
    const hasNewSessions = sessionCount > prevSessionCount;
    if (runEnded || hasNewProjects || hasNewSessions) {
      void this.loadProjects();
    }
  };

  private isRunActive(snapshot: SyncManagerSnapshot | null): boolean {
    if (!snapshot?.activeRun) return false;
    return snapshot.activeRun.state === 'running' || snapshot.activeRun.state === 'queued';
  }

  private loadingLock = false;

  private async loadProjects(): Promise<void> {
    if (this.loadingLock) return;
    this.loadingLock = true;
    this.isLoading = true;
    try {
      await dbClient.ensureReady();
      this.projects = await dbClient.getProjects();
      this.error = null;
    } catch (error) {
      this.error = `Failed to load projects: ${(error as Error).message}`;
    } finally {
      this.loadingLock = false;
      this.isLoading = false;
    }
  }

  private openModal(): void {
    this.modalOpen = true;
  }

  private closeModal(): void {
    this.modalOpen = false;
  }

  private async getLocalProjectIds(): Promise<string[]> {
    const projects = await dbClient.getProjects();
    return projects
      .map((project) => project.readable_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  }

  private async handleProjectCreate(
    event: CustomEvent<{ name: string; description: string; readableId: string }>,
  ): Promise<void> {
    const { name, description, readableId } = event.detail;
    const now = Date.now();
    const project: Project = {
      id: `project-${now}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      description,
      created_at: now,
      updated_at: now,
      session_count: 0,
      readable_id: readableId,
    };

    try {
      await dbClient.createProject(project);
      this.modalOpen = false;
      await this.loadProjects();
    } catch (error) {
      this.error = `Failed to create project: ${(error as Error).message}`;
    }
  }

  private openProject(project: Project): void {
    const slug = project.readable_id || project.id;
    navigateTo(`/projects/${slug}`);
  }

  private isProjectSyncing(project: Project): boolean {
    if (project.sync_status === 'syncing') return true;
    const snapshot = this.syncSnapshot;
    if (!snapshot) return false;
    return snapshot.projects.some(
      (p) => p.localProjectId === project.id && (p.status === 'running' || p.status === 'queued'),
    );
  }

  private openSyncModal(project: Project): void {
    if (!project.readable_id) return;
    this.syncModalProjectId = project.readable_id;
  }

  private closeSyncModal(): void {
    this.syncModalProjectId = '';
  }

  private async handleDeleteProject(event: Event, project: Project): Promise<void> {
    event.stopPropagation();
    const confirmed = window.confirm(
      `Delete project "${project.name}"? All of its sessions will be removed as well.`,
    );
    if (!confirmed) return;

    try {
      await dbClient.deleteProject(project.id);
      await this.loadProjects();
    } catch (error) {
      this.error = `Failed to delete project: ${(error as Error).message}`;
    }
  }

  private async handleExportDatabase(): Promise<void> {
    try {
      await dbClient.exportAndDownload();
    } catch (error) {
      this.error = `Failed to export database: ${(error as Error).message}`;
    }
  }

  render() {
    return html`
      <div class="home-page">
        <div class="page-header">
          <h1>Projects</h1>
          <div class="page-header-actions">
            <button class="secondary" @click=${this.handleExportDatabase}>Export Database</button>
            <button class="primary" @click=${this.openModal}>+ New Project</button>
          </div>
        </div>

        ${this.error ? html`<div class="error">${this.error}</div>` : ''}
        ${
          this.isLoading
            ? html`<p class="notice">Loading projects…</p>`
            : this.projects.length === 0
              ? html`
              <div class="empty-state">
                <p>No projects yet. Create one to get started!</p>
              </div>
            `
              : html`
              <div class="projects-grid">
                ${repeat(
                  this.projects,
                  (project) => project.id,
                  (project) => html`
                    <div
                      class="project-card"
                      role="button"
                      tabindex="0"
                      @click=${() => this.openProject(project)}
                      @keydown=${(event: KeyboardEvent) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          this.openProject(project);
                        }
                      }}
                    >
                      <h3>
                        ${project.name}
                        ${
                          this.isProjectSyncing(project)
                            ? html`
                              <project-sync-indicator
                                @indicator-click=${() => this.openSyncModal(project)}
                              ></project-sync-indicator>
                            `
                            : ''
                        }
                      </h3>
                      <p class="description">${project.description || 'No description'}</p>
                      <div class="project-card-footer">
                        <span class="project-meta">
                          ${project.session_count} session${project.session_count === 1 ? '' : 's'} •
                          ${new Date(project.updated_at).toLocaleDateString()}
                        </span>
                        <button
                          class="delete-button"
                          @click=${(event: Event) => this.handleDeleteProject(event, project)}
                        >
                          Delete Project
                        </button>
                      </div>
                    </div>
                  `,
                )}
              </div>
            `
        }

        <project-modal
          .open=${this.modalOpen}
          .getLocalProjectIds=${this.getLocalProjectIds}
          @project-create=${this.handleProjectCreate}
          @modal-close=${this.closeModal}
        ></project-modal>

        <project-sync-status-modal
          .open=${this.syncModalProjectId !== ''}
          .projectId=${this.syncModalProjectId}
          @modal-close=${this.closeSyncModal}
        ></project-sync-status-modal>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'home-page': HomePage;
  }
}
