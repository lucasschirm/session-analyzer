import { css, html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { dbClient } from '../db/db-client';
import { type SyncManagerSnapshot, syncManager } from '../sync/sync-manager';
import type { Project } from '../types';

/**
 * Route-aware left navigation.
 *
 * The items shown depend on the current route:
 *
 * - Dashboard (`/`): Projects (expandable, lists real projects), Agents,
 *   Skills, Tools, MCP.
 * - Settings (`/settings*`): Data Sources, Storage.
 * - All other routes: no left nav is rendered.
 *
 * Active items are highlighted. Clicking "Projects" both toggles the
 * expansion and navigates to `/projects`.
 */
@customElement('left-nav')
export class LeftNav extends LitElement {
  static styles = css`
    :host {
      display: block;
      width: 240px;
      flex-shrink: 0;
      background: var(--md-sys-color-surface, #171a21);
      border-right: 1px solid var(--md-sys-color-outline, #2a303c);
      padding: 16px 0;
      overflow-y: auto;
      max-height: calc(100vh - 56px);
      position: sticky;
      top: 56px;
    }

    nav {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 0 8px;
    }

    .nav-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 8px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      text-decoration: none;
      font-size: 14px;
      cursor: pointer;
      transition: background-color 0.15s ease, color 0.15s ease;
      user-select: none;
    }

    .nav-item:hover {
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .nav-item.active {
      background: var(--md-sys-color-primary-container, #1c2b4a);
      color: var(--md-sys-color-on-primary-container, #cfe0ff);
      font-weight: 600;
    }

    .nav-item .chevron {
      margin-left: auto;
      font-size: 10px;
      transition: transform 0.15s ease;
    }

    .nav-item.expanded .chevron {
      transform: rotate(90deg);
    }

    .nav-children {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 2px 0 2px 20px;
    }

    .nav-child {
      display: block;
      padding: 6px 12px;
      border-radius: 6px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      text-decoration: none;
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .nav-child:hover {
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .nav-child.active {
      color: var(--md-sys-color-primary, #4f8cff);
      font-weight: 600;
    }

    .nav-section-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      padding: 12px 12px 4px;
    }
  `;

  /** Current hash path (e.g. `/`, `/projects`, `/settings/storage`). */
  @property() path = '/';

  @state() private projects: Project[] = [];

  @state() private projectsExpanded = false;

  @state() private syncSnapshot: SyncManagerSnapshot | null = null;

  private loadingLock = false;

  connectedCallback(): void {
    super.connectedCallback();
    this.syncSnapshot = syncManager.getSnapshot();
    syncManager.addEventListener('change', this.handleSyncChange);
    void this.loadProjects();
    // Default-expand the Projects section when on a projects route.
    this.projectsExpanded = this.path.startsWith('/projects');
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    syncManager.removeEventListener('change', this.handleSyncChange);
  }

  protected updated(): void {
    // Keep expansion in sync when navigating between dashboard/projects routes.
    if (this.path.startsWith('/projects') && !this.projectsExpanded) {
      this.projectsExpanded = true;
    }
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

  private async loadProjects(): Promise<void> {
    if (this.loadingLock) return;
    this.loadingLock = true;
    try {
      await dbClient.ensureReady();
      this.projects = await dbClient.getProjects();
    } catch {
      // Non-fatal: the projects list stays empty until the DB is ready.
    } finally {
      this.loadingLock = false;
    }
  }

  private toggleProjects(event: Event): void {
    event.preventDefault();
    this.projectsExpanded = !this.projectsExpanded;
    // Navigating to /projects is also part of the click per the spec.
    window.location.hash = '#/projects';
  }

  private isActive(href: string): boolean {
    const target = href.startsWith('#') ? href.slice(1) : href;
    if (target === '/') return this.path === '/';
    return this.path === target || this.path.startsWith(`${target}/`);
  }

  private renderDashboardNav() {
    return html`
      <div class="nav-section-label">Dashboard</div>
      <nav>
        <a
          href="#/projects"
          class="nav-item ${this.projectsExpanded ? 'expanded' : ''} ${
            this.path.startsWith('/projects') ? 'active' : ''
          }"
          @click=${this.toggleProjects}
        >
          <span>Projects</span>
          <span class="chevron">▶</span>
        </a>
        ${
          this.projectsExpanded
            ? html`
              <div class="nav-children">
                ${repeat(
                  this.projects,
                  (project) => project.id,
                  (project) => {
                    const slug = project.readable_id || project.id;
                    const href = `#/projects/${slug}`;
                    return html`<a
                      href=${href}
                      class="nav-child ${this.path === `/projects/${slug}` ? 'active' : ''}"
                      >${project.name}</a
                    >`;
                  },
                )}
                ${
                  this.projects.length === 0
                    ? html`<span class="nav-child">No projects yet</span>`
                    : ''
                }
              </div>
            `
            : ''
        }
        <a
          href="#/agents"
          class="nav-item ${this.isActive('/agents') ? 'active' : ''}"
        >
          <span>Agents</span>
        </a>
        <a
          href="#/skills"
          class="nav-item ${this.isActive('/skills') ? 'active' : ''}"
        >
          <span>Skills</span>
        </a>
        <a
          href="#/tools"
          class="nav-item ${this.isActive('/tools') ? 'active' : ''}"
        >
          <span>Tools</span>
        </a>
        <a
          href="#/mcp"
          class="nav-item ${this.isActive('/mcp') ? 'active' : ''}"
        >
          <span>MCP</span>
        </a>
      </nav>
    `;
  }

  private renderSettingsNav() {
    return html`
      <div class="nav-section-label">Settings</div>
      <nav>
        <a
          href="#/settings/data-sources"
          class="nav-item ${this.isActive('/settings/data-sources') ? 'active' : ''}"
        >
          <span>Data Sources</span>
        </a>
        <a
          href="#/settings/storage"
          class="nav-item ${this.isActive('/settings/storage') ? 'active' : ''}"
        >
          <span>Storage</span>
        </a>
      </nav>
    `;
  }

  render() {
    if (this.path === '/' || this.path.startsWith('/projects')) {
      return this.renderDashboardNav();
    }
    if (this.path.startsWith('/settings')) {
      return this.renderSettingsNav();
    }
    // No left nav on other routes.
    return null;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'left-nav': LeftNav;
  }
}
