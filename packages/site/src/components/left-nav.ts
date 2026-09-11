import type { ProjectSessionListItem } from '@lucasschirm/sal-db';
import { css, html, LitElement, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { analyticsClient } from '../db/analytics-client';
import { dbClient } from '../db/db-client';
import { formatDate, formatSessionTitle } from '../lib/format';
import { navigateTo } from '../router';
import { type SyncManagerSnapshot, syncManager } from '../sync/sync-manager';
import type { Project } from '../types';

function formatRelativeDate(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) return 'Updated today';
  if (diff < 2 * day) return 'Updated yesterday';
  if (diff < 7 * day) return `Updated ${Math.floor(diff / day)} days ago`;
  return formatDate(timestamp);
}

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
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 6px 12px;
      border-radius: 6px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      text-decoration: none;
      font-size: 13px;
    }

    .nav-child-name {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .nav-child-stats {
      font-size: 11px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      opacity: 0.7;
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

    .nav-project-group {
      display: flex;
      flex-direction: column;
    }

    .nav-project-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-radius: 6px;
      transition: background-color 0.15s ease;
    }

    .nav-project-row:hover {
      background: var(--md-sys-color-surface-container, #1f242e);
    }

    .nav-project-row .nav-child {
      flex: 1;
      min-width: 0;
    }

    .nav-project-row:hover .nav-child {
      background: transparent;
    }

    .project-chevron-btn {
      background: transparent;
      border: none;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      padding: 8px 10px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      font-size: 9px;
      flex-shrink: 0;
      transition: color 0.15s ease;
    }

    .project-chevron-btn:hover {
      color: var(--md-sys-color-on-surface, #e6e9ef);
      background: var(--md-sys-color-surface-container-hover, #262d3a);
    }

    .project-chevron-btn .chevron {
      display: inline-block;
      transition: transform 0.15s ease;
    }

    .project-chevron-btn.expanded .chevron {
      transform: rotate(90deg);
    }

    .nav-sessions-list {
      display: flex;
      flex-direction: column;
      gap: 1px;
      padding: 2px 0 4px 10px;
      border-left: 1px solid var(--md-sys-color-outline, #2a303c);
      margin-left: 16px;
      margin-top: 2px;
      margin-bottom: 4px;
    }

    .nav-session-item {
      display: flex;
      align-items: center;
      padding: 6px 10px;
      border-radius: 6px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      text-decoration: none;
      font-size: 12px;
      transition: background-color 0.15s ease, color 0.15s ease;
      cursor: pointer;
    }

    .nav-session-item:hover {
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .nav-session-item.active {
      background: var(--md-sys-color-primary-container, #1c2b4a);
      color: var(--md-sys-color-primary, #4f8cff);
      font-weight: 600;
    }

    .nav-session-title {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 170px;
    }

    .nav-session-loading,
    .nav-session-empty {
      font-size: 11px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      padding: 4px 8px;
      font-style: italic;
    }

    .nav-session-error {
      font-size: 11px;
      color: var(--md-sys-color-error, #f28b82);
      padding: 4px 8px;
      font-style: italic;
    }
  `;

  /** Current hash path (e.g. `/`, `/projects`, `/settings/storage`). */
  @property() path = '/';

  @state() private projects: Project[] = [];

  @state() private projectsExpanded = false;

  @state() private projectSessions: Record<string, ProjectSessionListItem[]> = {};

  @state() private projectSessionsError: Record<string, string> = {};

  @state() private expandedProjectSlugs: Set<string> = new Set();

  @state() private sessionsLoading: Record<string, boolean> = {};

  @state() private syncSnapshot: SyncManagerSnapshot | null = null;

  private loadingLock = false;

  connectedCallback(): void {
    super.connectedCallback();
    this.syncSnapshot = syncManager.getSnapshot();
    syncManager.addEventListener('change', this.handleSyncChange);
    void this.loadProjects();
    // Auto-expand when viewing a specific project or session route.
    this.projectsExpanded = /^\/(projects|sessions)\/[^/]+/.test(this.path);
    if (/^\/projects\/[^/]+/.test(this.path)) {
      const match = this.path.match(/^\/projects\/([^/]+)/);
      if (match) {
        const slug = decodeURIComponent(match[1]);
        this.expandedProjectSlugs.add(slug);
        void this.loadSessionsForProject(slug);
      }
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    syncManager.removeEventListener('change', this.handleSyncChange);
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    // Keep expansion in sync when navigating between dashboard/projects routes.
    // Auto-expand when viewing a specific project. Do not auto-collapse when navigating
    // to the projects route if already expanded.
    if (changed.has('path')) {
      if (/^\/projects\/[^/]+/.test(this.path)) {
        this.projectsExpanded = true;
        const match = this.path.match(/^\/projects\/([^/]+)/);
        if (match) {
          const slug = decodeURIComponent(match[1]);
          const project = this.projects.find(
            (p) => (p.readable_id || p.id) === slug || p.id === slug,
          );
          const pId = project ? project.id : slug;
          const next = new Set(this.expandedProjectSlugs);
          next.add(pId);
          next.add(slug);
          this.expandedProjectSlugs = next;
          void this.loadSessionsForProject(pId, slug);
        }
      } else if (/^\/sessions\/[^/]+/.test(this.path)) {
        this.projectsExpanded = true;
      } else if (!this.path.startsWith('/projects') && !this.path.startsWith('/sessions')) {
        this.projectsExpanded = false;
      }
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
      const uniqueProjectIds = new Set<string>();
      for (const key of this.expandedProjectSlugs) {
        const match = this.projects.find(
          (p) => p.id === key || (p.readable_id || p.id) === key || p.name === key,
        );
        uniqueProjectIds.add(match ? match.id : key);
      }
      for (const pId of uniqueProjectIds) {
        void this.loadSessionsForProject(pId, undefined, undefined, true);
      }
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
      if (/^\/projects\/[^/]+/.test(this.path)) {
        const match = this.path.match(/^\/projects\/([^/]+)/);
        if (match) {
          const slug = decodeURIComponent(match[1]);
          const project = this.projects.find(
            (p) => (p.readable_id || p.id) === slug || p.id === slug || p.name === slug,
          );
          const pId = project ? project.id : slug;
          const next = new Set(this.expandedProjectSlugs);
          next.add(pId);
          this.expandedProjectSlugs = next;
          void this.loadSessionsForProject(pId, slug, project?.name);
        }
      }
    } catch {
      // Non-fatal: the projects list stays empty until the DB is ready.
    } finally {
      this.loadingLock = false;
    }
  }

  private handleProjectClick(slug: string, projectId: string, projectName?: string): void {
    const next = new Set(this.expandedProjectSlugs);
    next.add(projectId);
    this.expandedProjectSlugs = next;
    void this.loadSessionsForProject(projectId, slug, projectName);
  }

  private toggleProjectSessions(
    e: Event,
    projectId: string,
    slug: string,
    projectName?: string,
  ): void {
    e.preventDefault();
    e.stopPropagation();
    const next = new Set(this.expandedProjectSlugs);
    if (next.has(projectId) || next.has(slug)) {
      next.delete(projectId);
      next.delete(slug);
    } else {
      next.add(projectId);
      void this.loadSessionsForProject(projectId, slug, projectName);
    }
    this.expandedProjectSlugs = next;
  }

  private handleSessionClick(e: MouseEvent, sessionId: string): void {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    navigateTo(`/sessions/${encodeURIComponent(sessionId)}`);
  }

  private shouldSkipSessionLoad(projectId: string, slug?: string, force?: boolean): boolean {
    if (force) return false;
    return Boolean(
      this.sessionsLoading[projectId] ||
        (slug && this.sessionsLoading[slug]) ||
        this.projectSessions[projectId] ||
        (slug && this.projectSessions[slug]),
    );
  }

  private setSessionLoading(projectId: string, slug: string | undefined, loading: boolean): void {
    this.sessionsLoading = {
      ...this.sessionsLoading,
      [projectId]: loading,
      ...(slug ? { [slug]: loading } : {}),
    };
  }

  private async resolveTargetProjectId(
    projectId: string,
    slug?: string,
    projectName?: string,
  ): Promise<string> {
    const fromId = await analyticsClient?.resolveProjectId?.(projectId);
    if (fromId) return fromId;
    if (projectName) {
      const fromName = await analyticsClient?.resolveProjectId?.(projectName);
      if (fromName) return fromName;
    }
    if (slug) {
      const fromSlug = await analyticsClient?.resolveProjectId?.(slug);
      if (fromSlug) return fromSlug;
    }
    return projectId;
  }

  private storeLoadedSessions(keys: (string | undefined)[], items: ProjectSessionListItem[]): void {
    const next = { ...this.projectSessions };
    for (const key of keys) {
      if (key) next[key] = items;
    }
    this.projectSessions = next;
  }

  private storeSessionError(keys: (string | undefined)[], error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error);
    const next = { ...this.projectSessionsError };
    for (const key of keys) {
      if (key) next[key] = msg;
    }
    this.projectSessionsError = next;
  }

  private clearSessionErrors(keys: (string | undefined)[]): void {
    const next = { ...this.projectSessionsError };
    for (const key of keys) {
      if (key) delete next[key];
    }
    this.projectSessionsError = next;
  }

  private async loadSessionsForProject(
    projectId: string,
    slug?: string,
    projectName?: string,
    force = false,
  ): Promise<void> {
    if (this.shouldSkipSessionLoad(projectId, slug, force)) return;
    this.setSessionLoading(projectId, slug, true);
    const keys = [projectId, slug, projectName];
    this.clearSessionErrors(keys);

    try {
      const targetId = await this.resolveTargetProjectId(projectId, slug, projectName);
      const page = await analyticsClient?.search?.getProjectSessionList?.(targetId, { limit: 20 });
      if (page) {
        this.storeLoadedSessions([...keys, targetId], [...page.items]);
      }
    } catch (err) {
      this.storeSessionError(keys, err);
    } finally {
      this.setSessionLoading(projectId, slug, false);
    }
  }

  private toggleProjects(event: Event): void {
    event.preventDefault();
    this.projectsExpanded = !this.projectsExpanded;
    if (this.projects.length === 0) {
      void this.loadProjects();
    }
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
                    const sessionLabel = `${project.session_count} session${project.session_count === 1 ? '' : 's'}`;
                    const isExpanded =
                      this.expandedProjectSlugs.has(project.id) ||
                      this.expandedProjectSlugs.has(slug);
                    const sessions =
                      this.projectSessions[project.id] ?? this.projectSessions[slug] ?? [];
                    const isLoading =
                      this.sessionsLoading[project.id] || this.sessionsLoading[slug];

                    return html`
                      <div class="nav-project-group">
                        <div class="nav-project-row">
                          <a
                            href=${href}
                            class="nav-child ${this.path === `/projects/${slug}` ? 'active' : ''}"
                            @click=${() => this.handleProjectClick(slug, project.id, project.name)}
                          >
                            <span class="nav-child-name">${project.name}</span>
                            <span class="nav-child-stats">${sessionLabel} · ${formatRelativeDate(project.updated_at)}</span>
                          </a>
                          <button
                            type="button"
                            class="project-chevron-btn ${isExpanded ? 'expanded' : ''}"
                            aria-label="Toggle sessions for ${project.name}"
                            aria-expanded=${isExpanded ? 'true' : 'false'}
                            @click=${(e: Event) => this.toggleProjectSessions(e, project.id, slug, project.name)}
                          >
                            <span class="chevron">▶</span>
                          </button>
                        </div>
                        ${
                          isExpanded
                            ? html`
                            <div class="nav-sessions-list">
                              ${
                                isLoading
                                  ? html`<div class="nav-session-loading">Loading sessions...</div>`
                                  : (
                                        this.projectSessionsError[project.id] ??
                                          (slug ? this.projectSessionsError[slug] : undefined)
                                      )
                                    ? html`<div class="nav-session-error">Failed to load sessions</div>`
                                    : sessions.length === 0
                                      ? html`<div class="nav-session-empty">No sessions</div>`
                                      : repeat(
                                          sessions,
                                          (session) => session.sessionId,
                                          (session) => {
                                            const isSessionActive =
                                              this.path === `/sessions/${session.sessionId}` ||
                                              this.path ===
                                                `/sessions/${encodeURIComponent(session.sessionId)}`;
                                            const displayTitle = formatSessionTitle(
                                              session.title,
                                              session.startedAt,
                                            );
                                            return html`
                                              <a
                                                href="#/sessions/${encodeURIComponent(session.sessionId)}"
                                                class="nav-session-item ${isSessionActive ? 'active' : ''}"
                                                title=${displayTitle}
                                                @click=${(e: MouseEvent) => this.handleSessionClick(e, session.sessionId)}
                                              >
                                                <span class="nav-session-title">${displayTitle}</span>
                                              </a>
                                            `;
                                          },
                                        )
                              }
                            </div>
                          `
                            : ''
                        }
                      </div>
                    `;
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
    if (
      this.path === '/' ||
      this.path.startsWith('/projects') ||
      this.path.startsWith('/sessions') ||
      this.path === '/agents' ||
      this.path === '/skills' ||
      this.path === '/tools' ||
      this.path === '/mcp'
    ) {
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
