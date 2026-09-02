import { css, html, LitElement } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import '../components/header-project-selector';
import '../components/left-nav';
import '../components/sync-progress-bar';
import '../components/sync-status-bar';
import '../components/toast-container';
import { dbClient } from '../db/db-client';
import { currentHashPath, HashRouter, navigateTo } from '../router';
import { syncManager } from '../sync/sync-manager';
import type { Project } from '../types';
import './projects-page';
import './portfolio/portfolio-view';
import './project-behavior/project-behavior-view';
import './session-evidence/session-evidence-view';
import './manual-import/manual-import-page';
import './component-ecosystem/component-ecosystem-view';
import './artifact-diff/artifact-diff-view';
import './settings/data-sources-page';
import './settings/storage-page';
import './tbd-page';

/**
 * Root application shell: header, left navigation, hash-based routing outlet
 * and database lifecycle.
 *
 * Routes:
 *
 * - `#/`                                   -> Dashboard (Portfolio analytics view)
 * - `#/projects`                           -> Projects list (CRUD)
 * - `#/projects/:projectId`                -> Project Behavior (precomputed analytics view)
 * - `#/sessions/:sessionId`                -> Session Evidence (precomputed analytics view)
 * - `#/manual-import`                      -> Manual Import (transcript/partial upload)
 * - `#/artifacts`                          -> Artifact Ecosystem (was "Components")
 * - `#/artifacts/:componentId`             -> Artifact Ecosystem with a selected component
 * - `#/artifact-diff`                      -> Artifact Diff
 * - `#/agents`, `#/skills`, `#/tools`, `#/mcp` -> TBD placeholder pages
 * - `#/settings/data-sources`              -> Settings: Data Sources (S3 connections)
 * - `#/settings/storage`                   -> Settings: Storage (DB management)
 *
 * Legacy redirects: `#/portfolio` -> `#/`, `#/components` -> `#/artifacts`,
 * `#/projects/:id/behavior` -> `#/projects/:id` (handled by the router).
 */
function decodeRouteParam(value: string | undefined): string {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

@customElement('app-root')
export class AppRoot extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: var(--md-sys-color-background, #0f1115);
      color: var(--md-sys-color-on-background, #e6e9ef);
    }

    header {
      background: var(--md-sys-color-surface, #171a21);
      padding: 10px 24px;
      border-bottom: 1px solid var(--md-sys-color-outline, #2a303c);
      display: flex;
      align-items: center;
      gap: 16px;
      position: sticky;
      top: 0;
      z-index: 10;
      height: 56px;
    }

    .logo {
      font-size: 18px;
      font-weight: 700;
      color: var(--md-sys-color-primary, #4f8cff);
      text-decoration: none;
      flex-shrink: 0;
    }

    header-project-selector {
      flex-shrink: 0;
    }

    nav.header-nav {
      display: flex;
      gap: 4px;
      flex-shrink: 0;
    }

    nav.header-nav a {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      text-decoration: none;
      padding: 7px 14px;
      border-radius: 8px;
      font-size: 14px;
      transition: background-color 0.15s ease;
    }

    nav.header-nav a:hover {
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-left: auto;
    }

    .settings-button {
      background: transparent;
      border: none;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      cursor: pointer;
      padding: 8px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background-color 0.15s ease, color 0.15s ease;
    }

    .settings-button:hover {
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .settings-button svg {
      width: 20px;
      height: 20px;
    }

    .app-body {
      display: flex;
      min-height: calc(100vh - 56px);
    }

    main {
      flex: 1;
      padding: 24px;
      padding-bottom: 56px;
      min-width: 0;
    }

    .app-error {
      background: var(--md-sys-color-error-container, #5c2626);
      color: var(--md-sys-color-on-error-container, #ffb4ab);
      padding: 16px;
      border-radius: 8px;
      margin-bottom: 16px;
    }
  `;

  private router = new HashRouter(
    this,
    [
      {
        path: '/',
        render: () => html`<portfolio-view></portfolio-view>`,
      },
      {
        path: '/projects',
        render: () => html`<projects-page></projects-page>`,
      },
      {
        path: '/projects/:projectId*',
        render: (params) =>
          html`<project-behavior-view
            project-id=${decodeRouteParam(params.projectId)}
          ></project-behavior-view>`,
      },
      {
        path: '/sessions/:sessionId',
        render: (params) =>
          html`<session-evidence-view
            session-id=${decodeRouteParam(params.sessionId)}
          ></session-evidence-view>`,
      },
      {
        path: '/manual-import',
        render: () => html`<manual-import-page></manual-import-page>`,
      },
      {
        path: '/artifacts',
        render: () => html`<component-ecosystem-view></component-ecosystem-view>`,
      },
      {
        path: '/artifacts/:componentId',
        render: (params) =>
          html`<component-ecosystem-view
            component-id=${decodeRouteParam(params.componentId)}
          ></component-ecosystem-view>`,
      },
      {
        path: '/artifact-diff*',
        render: () => html`<artifact-diff-view></artifact-diff-view>`,
      },
      {
        path: '/agents',
        render: () => html`<tbd-page label="Agents"></tbd-page>`,
      },
      {
        path: '/skills',
        render: () => html`<tbd-page label="Skills"></tbd-page>`,
      },
      {
        path: '/tools',
        render: () => html`<tbd-page label="Tools"></tbd-page>`,
      },
      {
        path: '/mcp',
        render: () => html`<tbd-page label="MCP"></tbd-page>`,
      },
      {
        path: '/settings',
        render: () => html`<data-sources-page></data-sources-page>`,
      },
      {
        path: '/settings/data-sources',
        render: () => html`<data-sources-page></data-sources-page>`,
      },
      {
        path: '/settings/storage',
        render: () => html`<storage-page></storage-page>`,
      },
    ],
    {
      render: () => html`
        <p>Page not found. <a href="#/">Go back home</a>.</p>
      `,
    },
  );

  @state() private dbError: string | null = null;

  @state() private currentPath = '/';

  @state() private selectedProjectSlug = '';

  @state() private projects: Project[] = [];

  private hashChangeHandler = (): void => {
    this.currentPath = currentHashPath();
    void this.syncProjectSelector();
  };

  async firstUpdated(): Promise<void> {
    try {
      await dbClient.ensureReady();
      await syncManager.init();
      this.currentPath = currentHashPath();
      await this.loadProjects();
      void this.syncProjectSelector();
    } catch (error) {
      this.dbError = `Failed to initialize database: ${(error as Error).message}`;
    }
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('hashchange', this.hashChangeHandler);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('hashchange', this.hashChangeHandler);
  }

  private async loadProjects(): Promise<void> {
    try {
      this.projects = await dbClient.getProjects();
    } catch {
      // Non-fatal — selector stays hidden.
    }
  }

  private async syncProjectSelector(): Promise<void> {
    const path = this.currentPath;
    const projectMatch = path.match(/^\/projects\/([^/]+)/);
    if (projectMatch) {
      const slug = decodeURIComponent(projectMatch[1]);
      // If the slug is in our project list, use it directly.
      const found = this.projects.find((p) => (p.readable_id || p.id) === slug);
      if (found) {
        this.selectedProjectSlug = slug;
      } else {
        // Try resolving via DB (the slug may be a readable_id we haven't loaded yet).
        try {
          const project = await dbClient.getProjectByReadableId(slug);
          if (project) {
            this.selectedProjectSlug = slug;
            if (!this.projects.find((p) => p.id === project.id)) {
              this.projects = [...this.projects, project];
            }
          } else {
            this.selectedProjectSlug = slug;
          }
        } catch {
          this.selectedProjectSlug = slug;
        }
      }
    } else {
      this.selectedProjectSlug = '';
    }
  }

  private handleSettingsClick(): void {
    navigateTo('/settings/data-sources');
  }

  render() {
    const showLeftNav =
      this.currentPath === '/' ||
      this.currentPath.startsWith('/projects') ||
      this.currentPath.startsWith('/settings');

    return html`
      <header>
        <a href="#/" class="logo">SAL</a>
        <header-project-selector
          .value=${this.selectedProjectSlug}
        ></header-project-selector>
        <nav class="header-nav">
          <a href="#/">Dashboard</a>
          <a href="#/artifacts">Artifacts</a>
        </nav>
        <div class="header-right">
          <sync-progress-bar></sync-progress-bar>
          <button
            type="button"
            class="settings-button"
            title="Settings"
            aria-label="Settings"
            @click=${this.handleSettingsClick}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
              ></path>
            </svg>
          </button>
        </div>
      </header>

      <div class="app-body">
        ${showLeftNav ? html`<left-nav .path=${this.currentPath}></left-nav>` : ''}
        <main>
          ${this.dbError ? html`<div class="app-error">${this.dbError}</div>` : ''}
          ${this.router.outlet()}
        </main>
      </div>

      <sync-status-bar></sync-status-bar>

      <toast-container></toast-container>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-root': AppRoot;
  }
}
