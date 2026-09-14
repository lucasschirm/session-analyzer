import type { ProjectSessionListItem } from '@lucasschirm/sal-db';
import { css, html, LitElement, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { analyticsClient } from '../db/analytics-client';
import { dbClient } from '../db/db-client';
import { formatDate } from '../lib/format';
import { type SyncManagerSnapshot, syncManager } from '../sync/sync-manager';
import type { Project } from '../types';

/** Sessions shown in the project/session menus: the 10 most recent. */
const SESSION_LIST_LIMIT = 10;

/** A project row in the home menu, merged from control + analytics data. */
interface NavProject {
  /** Route slug for `#/projects/<slug>` (control readable id, or native id). */
  slug: string;
  name: string;
  sessionCount: number;
  /** Epoch ms of the most recent session activity, when known. */
  lastSessionAt: number | null;
}

function formatLastSession(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) return 'today';
  if (diff < 2 * day) return 'yesterday';
  if (diff < 7 * day) return `${Math.floor(diff / day)} days ago`;
  return formatDate(timestamp);
}

function sessionTitle(item: ProjectSessionListItem): string {
  return item.title?.trim() || 'Unknown';
}

/**
 * Route-aware left navigation. One flat menu per page - no dropdowns:
 *
 * - Home (`/`, `/projects`, `/manual-import`, `/agents`, `/skills`, `/tools`,
 *   `/mcp`): a "Projects" section listing every project with a session-count
 *   and last-session summary, plus the Agents/Skills/Tools/MCP links.
 * - Project (`/projects/:slug*`): a "‹ Dashboard" back link and a "Sessions"
 *   section listing the project's 10 most recent sessions.
 * - Session (`/sessions/:id`): a "‹ Project" back link to the session's
 *   project and the same "Sessions" section with the current session
 *   highlighted.
 * - Settings (`/settings*`, `/storage*`): Data Sources and Storage links.
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

    .nav-back {
      font-weight: 600;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .nav-section-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      padding: 12px 12px 4px;
    }

    .nav-project {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 6px 12px;
      border-radius: 6px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      text-decoration: none;
      font-size: 13px;
    }

    .nav-project:hover {
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .nav-project.active {
      color: var(--md-sys-color-primary, #4f8cff);
      font-weight: 600;
    }

    .nav-project-name {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .nav-project-stats {
      font-size: 11px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      opacity: 0.7;
    }

    .nav-session-item {
      display: flex;
      align-items: center;
      padding: 6px 12px;
      border-radius: 6px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      text-decoration: none;
      font-size: 13px;
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
    }

    .nav-session-loading,
    .nav-session-empty {
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      padding: 4px 12px;
      font-style: italic;
    }

    .nav-session-error {
      font-size: 12px;
      color: var(--md-sys-color-error, #f28b82);
      padding: 4px 12px;
      font-style: italic;
    }
  `;

  /** Current hash path (e.g. `/`, `/projects/foo`, `/settings/storage`). */
  @property() path = '/';

  @state() private projects: NavProject[] = [];

  @state() private sessions: ProjectSessionListItem[] = [];

  @state() private sessionsLoading = false;

  @state() private sessionsError: string | null = null;

  /** Route slug of the project that owns the currently viewed session. */
  @state() private sessionProjectSlug: string | null = null;

  @state() private syncSnapshot: SyncManagerSnapshot | null = null;

  private sessionsLoadSeq = 0;

  connectedCallback(): void {
    super.connectedCallback();
    this.syncSnapshot = syncManager.getSnapshot();
    syncManager.addEventListener('change', this.handleSyncChange);
    analyticsClient.addEventListener('data-change', this.handleDataChange);
    void this.loadProjects();
    void this.loadContextSessions();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    syncManager.removeEventListener('change', this.handleSyncChange);
    analyticsClient.removeEventListener('data-change', this.handleDataChange);
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('path')) {
      void this.loadContextSessions();
    }
  }

  private get projectSlug(): string | null {
    const match = this.path.match(/^\/projects\/([^/]+)/);
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  private get sessionIdParam(): string | null {
    const match = this.path.match(/^\/sessions\/([^/]+)/);
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  private isRunActive(snapshot: SyncManagerSnapshot | null): boolean {
    if (!snapshot?.activeRun) return false;
    return snapshot.activeRun.state === 'running' || snapshot.activeRun.state === 'queued';
  }

  private handleSyncChange = (event: Event): void => {
    const wasRunning = this.isRunActive(this.syncSnapshot);
    const prevProjectIds = new Set(this.syncSnapshot?.projects.map((p) => p.localProjectId) ?? []);
    const prevSessionCount = this.syncSnapshot?.sessions.length ?? 0;
    this.syncSnapshot = (event as CustomEvent<SyncManagerSnapshot>).detail;
    const runEnded = wasRunning && !this.isRunActive(this.syncSnapshot);
    const hasNewProjects =
      this.syncSnapshot?.projects.some((p) => !prevProjectIds.has(p.localProjectId)) ?? false;
    const hasNewSessions = (this.syncSnapshot?.sessions.length ?? 0) > prevSessionCount;
    if (runEnded || hasNewProjects || hasNewSessions) {
      void this.loadProjects();
      void this.loadContextSessions();
    }
  };

  private handleDataChange = (): void => {
    void this.loadProjects();
    void this.loadContextSessions();
  };

  /**
   * Loads projects for the home menu. Control-DB projects are merged with the
   * analytics project list so the session count and last-session summary are
   * accurate for both synced and manually imported sessions; analytics-only
   * projects (no control row) are appended.
   */
  private async loadProjects(): Promise<void> {
    try {
      await dbClient.ensureReady();
      const [controlProjects, analyticsPage] = await Promise.all([
        dbClient.getProjects(),
        analyticsClient.portfolio.getProjectList({ limit: 100 }).catch(() => null),
      ]);

      const byNativeId = new Map(
        (analyticsPage?.items ?? []).map((item) => [item.name, item] as const),
      );
      const matched = new Set<string>();

      const merged: NavProject[] = controlProjects.map((project: Project) => {
        const analytics =
          (project.readable_id ? byNativeId.get(project.readable_id) : undefined) ??
          byNativeId.get(project.name) ??
          byNativeId.get(project.id);
        if (analytics) matched.add(analytics.projectId);
        const lastSessionAt = analytics?.lastSessionAt
          ? Date.parse(analytics.lastSessionAt)
          : project.session_count > 0
            ? project.updated_at
            : null;
        return {
          slug: project.readable_id || project.id,
          name: project.name,
          sessionCount: Math.max(analytics?.sessionCount ?? 0, project.session_count),
          lastSessionAt,
        };
      });

      for (const item of analyticsPage?.items ?? []) {
        if (matched.has(item.projectId)) continue;
        merged.push({
          slug: item.name,
          name: item.name,
          sessionCount: item.sessionCount,
          lastSessionAt: item.lastSessionAt ? Date.parse(item.lastSessionAt) : null,
        });
      }

      merged.sort((a, b) => (b.lastSessionAt ?? 0) - (a.lastSessionAt ?? 0));
      this.projects = merged;
    } catch {
      // Non-fatal: the projects list stays empty until the DB is ready.
    }
  }

  /**
   * Loads the 10 most recent sessions for the project or session menu.
   * On project routes the slug is resolved to an analytics project id; on
   * session routes the session's owning project is resolved first so the
   * "‹ Project" back link can point at it.
   */
  private async loadContextSessions(): Promise<void> {
    const seq = ++this.sessionsLoadSeq;
    const slug = this.projectSlug;
    const sessionId = this.sessionIdParam;
    if (!slug && !sessionId) {
      this.sessions = [];
      this.sessionsError = null;
      this.sessionsLoading = false;
      this.sessionProjectSlug = null;
      return;
    }

    this.sessionsLoading = true;
    this.sessionsError = null;
    try {
      let projectId: string | null = null;
      if (slug) {
        projectId = await this.resolveProjectSlug(slug);
        this.sessionProjectSlug = null;
      } else if (sessionId) {
        const ref = await analyticsClient.search.getSessionProjectRef(sessionId);
        this.sessionProjectSlug = ref?.nativeProjectId ?? ref?.projectId ?? null;
        projectId = ref?.projectId ?? null;
      }
      if (seq !== this.sessionsLoadSeq) return;

      if (!projectId) {
        this.sessions = [];
        return;
      }
      const page = await analyticsClient.search.getProjectSessionList(projectId, {
        limit: SESSION_LIST_LIMIT,
      });
      if (seq !== this.sessionsLoadSeq) return;
      this.sessions = [...page.items];
    } catch (error) {
      if (seq !== this.sessionsLoadSeq) return;
      this.sessions = [];
      this.sessionsError = error instanceof Error ? error.message : String(error);
    } finally {
      if (seq === this.sessionsLoadSeq) this.sessionsLoading = false;
    }
  }

  /**
   * Resolves a `/projects/:slug` route param to an analytics project id.
   * Mirrors the project-behavior-view fallback: try the slug directly (it may
   * be an analytics id, native project id, or project name), then resolve via
   * the control-DB project record's name/id when the slug is a readable id
   * that never reached the analytics DB.
   */
  private async resolveProjectSlug(slug: string): Promise<string> {
    const direct = await analyticsClient.resolveProjectId(slug);
    if (direct) return direct;
    const project =
      (await dbClient.getProjectByReadableId?.(slug)) ?? (await dbClient.getProject?.(slug));
    if (project) {
      return (
        (await analyticsClient.resolveProjectId(project.name)) ??
        (await analyticsClient.resolveProjectId(project.id)) ??
        slug
      );
    }
    return slug;
  }

  private isActive(href: string): boolean {
    const target = href.startsWith('#') ? href.slice(1) : href;
    if (target === '/') return this.path === '/';
    return this.path === target || this.path.startsWith(`${target}/`);
  }

  private renderSessionList() {
    if (this.sessionsLoading) {
      return html`<div class="nav-session-loading">Loading sessions…</div>`;
    }
    if (this.sessionsError) {
      return html`<div class="nav-session-error">Failed to load sessions</div>`;
    }
    if (this.sessions.length === 0) {
      return html`<div class="nav-session-empty">No sessions</div>`;
    }
    const currentSessionId = this.sessionIdParam;
    return repeat(
      this.sessions,
      (session) => session.sessionId,
      (session) => {
        const title = sessionTitle(session);
        return html`
          <a
            href="#/sessions/${encodeURIComponent(session.sessionId)}"
            class="nav-session-item ${session.sessionId === currentSessionId ? 'active' : ''}"
            title=${title}
          >
            <span class="nav-session-title">${title}</span>
          </a>
        `;
      },
    );
  }

  private renderHomeNav() {
    return html`
      <div class="nav-section-label">Projects</div>
      <nav>
        ${repeat(
          this.projects,
          (project) => project.slug,
          (project) => {
            const sessionLabel = `${project.sessionCount} session${project.sessionCount === 1 ? '' : 's'}`;
            const stats = project.lastSessionAt
              ? `${sessionLabel} · last session ${formatLastSession(project.lastSessionAt)}`
              : sessionLabel;
            return html`
              <a
                href="#/projects/${encodeURIComponent(project.slug)}"
                class="nav-project ${this.path === `/projects/${project.slug}` ? 'active' : ''}"
              >
                <span class="nav-project-name">${project.name}</span>
                <span class="nav-project-stats">${stats}</span>
              </a>
            `;
          },
        )}
        ${this.projects.length === 0 ? html`<span class="nav-session-empty">No projects</span>` : ''}
      </nav>
      <div class="nav-section-label">Dashboard</div>
      <nav>
        <a href="#/agents" class="nav-item ${this.isActive('/agents') ? 'active' : ''}">
          <span>Agents</span>
        </a>
        <a href="#/skills" class="nav-item ${this.isActive('/skills') ? 'active' : ''}">
          <span>Skills</span>
        </a>
        <a href="#/tools" class="nav-item ${this.isActive('/tools') ? 'active' : ''}">
          <span>Tools</span>
        </a>
        <a href="#/mcp" class="nav-item ${this.isActive('/mcp') ? 'active' : ''}">
          <span>MCP</span>
        </a>
      </nav>
    `;
  }

  private renderProjectNav() {
    return html`
      <nav>
        <a href="#/" class="nav-item nav-back"><span>${'<'} Dashboard</span></a>
      </nav>
      <div class="nav-section-label">Sessions</div>
      <nav>
        ${this.renderSessionList()}
      </nav>
    `;
  }

  private renderSessionNav() {
    const backHref = this.sessionProjectSlug
      ? `#/projects/${encodeURIComponent(this.sessionProjectSlug)}`
      : '#/';
    const backLabel = this.sessionProjectSlug ? '< Project' : '< Dashboard';
    return html`
      <nav>
        <a href=${backHref} class="nav-item nav-back"><span>${backLabel}</span></a>
      </nav>
      <div class="nav-section-label">Sessions</div>
      <nav>
        ${this.renderSessionList()}
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
    if (this.path.startsWith('/projects/')) {
      return this.renderProjectNav();
    }
    if (this.path.startsWith('/sessions/')) {
      return this.renderSessionNav();
    }
    if (
      this.path === '/' ||
      this.path === '/projects' ||
      this.path.startsWith('/manual-import') ||
      this.path === '/agents' ||
      this.path === '/skills' ||
      this.path === '/tools' ||
      this.path === '/mcp'
    ) {
      return this.renderHomeNav();
    }
    if (this.path.startsWith('/settings') || this.path.startsWith('/storage')) {
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
