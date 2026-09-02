import { css, html, LitElement } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import '../components/header-project-selector';
import '../components/icon-rail';
import '../components/passkey-modal';
import '../components/sync-progress-bar';
import '../components/sync-status-bar';
import '../components/toast-container';
import { analyticsClient } from '../db/analytics-client';
import { dbClient } from '../db/db-client';
import { currentHashPath, HashRouter, navigateTo } from '../router';
import { setPasskeyPrompt } from '../sync/passkey-prompt';
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

/**
 * Module-level resolver for the passkey prompt promise. Set when the sync
 * manager requests a passkey unlock (via `setPasskeyPrompt`); cleared once
 * the passkey modal emits `passkey-unlocked`, `passkey-forgotten`, or
 * `modal-close`.
 */
let passkeyResolve: ((unlocked: boolean) => void) | null = null;

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

    nav.header-nav a.active {
      color: var(--md-sys-color-on-surface, #e6e9ef);
      border-bottom: 2px solid var(--md-sys-color-primary, #4f8cff);
      border-radius: 0;
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

    /* The Portfolio route has no global header (see showGlobalHeader in the
     * TS class below) — its own title row supplies that vertical space
     * instead, so the sticky/fixed offsets below collapse to 0 rather than
     * leaving a 56px gap above the icon rail and sync chrome. */
    .app-body.no-header {
      min-height: 100vh;
    }

    icon-rail {
      position: sticky;
      top: 56px;
      align-self: flex-start;
      height: calc(100vh - 56px);
    }

    .app-body.no-header icon-rail {
      top: 0;
      height: 100vh;
    }

    main {
      flex: 1;
      padding: 24px;
      padding-bottom: 56px;
      min-width: 0;
    }

    /* Global chrome that must stay mounted across every route and every
     * sync run transition. Fixed just below the 56px header (not inside
     * its flex layout, so a header-cleanup PR can remove the header from
     * a route without unmounting this) and clear of it vertically at any
     * viewport width, so it can never overlap header-nav/
     * header-project-selector the way an overlapping right-offset would
     * once the progress bar's content grows or the header narrows. On the
     * header-less Portfolio route this collapses to the same 8px inset the
     * header would otherwise leave beneath it. */
    .sync-chrome {
      position: fixed;
      top: 64px;
      right: 24px;
      z-index: 15;
    }

    .sync-chrome.no-header {
      top: 8px;
    }

    .app-error {
      background: var(--md-sys-color-error-container, #5c2626);
      color: var(--md-sys-color-on-error-container, #ffb4ab);
      padding: 16px;
      border-radius: 8px;
      margin-bottom: 16px;
    }

    .app-loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 60vh;
      gap: 16px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-size: 16px;
    }

    .app-loading .spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--md-sys-color-outline, #2a303c);
      border-top-color: var(--md-sys-color-primary, #4f8cff);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    .reprocess-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      z-index: 200;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .reprocess-panel {
      background: var(--md-sys-color-surface, #171a21);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 12px;
      padding: 32px;
      width: min(440px, 90vw);
      text-align: center;
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
    }

    .reprocess-panel h2 {
      margin: 0 0 8px;
      font-size: 18px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .reprocess-panel .reprocess-reason {
      margin: 0 0 20px;
      font-size: 14px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .reprocess-panel .reprocess-step {
      font-size: 14px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      margin-bottom: 12px;
    }

    .reprocess-panel .reprocess-bar {
      width: 100%;
      height: 6px;
      background: var(--md-sys-color-outline, #2a303c);
      border-radius: 3px;
      overflow: hidden;
      margin-bottom: 8px;
    }

    .reprocess-panel .reprocess-bar-fill {
      height: 100%;
      background: var(--md-sys-color-primary, #4f8cff);
      border-radius: 3px;
      transition: width 0.3s ease;
    }

    .reprocess-panel .reprocess-percent {
      font-size: 13px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .reprocess-panel .reprocess-error {
      background: var(--md-sys-color-error-container, #5c2626);
      color: var(--md-sys-color-on-error-container, #ffb4ab);
      padding: 12px;
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 16px;
      text-align: left;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .reprocess-panel button {
      background: var(--md-sys-color-primary, #4f8cff);
      color: #fff;
      border: none;
      padding: 8px 24px;
      border-radius: 8px;
      font-size: 14px;
      cursor: pointer;
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
        path: '/settings/data-sources/:connectionId',
        render: (params) =>
          html`<data-sources-page
            .connectionId=${decodeRouteParam(params.connectionId)}
          ></data-sources-page>`,
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

  @state() private appReady = false;

  @state() private currentPath = '/';

  @state() private selectedProjectSlug = '';

  @state() private projects: Project[] = [];

  @state() private reprocessing = false;

  @state() private reprocessReason = '';

  @state() private reprocessStep = '';

  @state() private reprocessPercent = 0;

  @state() private reprocessError: string | null = null;

  @state() private passkeyOpen = false;

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
      this.appReady = true;
    } catch (error) {
      this.dbError = `Failed to initialize database: ${(error as Error).message}`;
      this.appReady = true;
    }
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('hashchange', this.hashChangeHandler);
    analyticsClient.addEventListener('reprocess-started', this.handleReprocessStarted);
    analyticsClient.addEventListener('reprocess-progress', this.handleReprocessProgress);
    analyticsClient.addEventListener('reprocess-completed', this.handleReprocessCompleted);
    // Register the passkey prompt so the sync manager can request a
    // vault unlock when a sync run needs S3 credentials. The prompt opens
    // the passkey modal in unlock mode; the modal calls `unlock()`
    // internally and emits `passkey-unlocked` on success.
    setPasskeyPrompt(
      () =>
        new Promise<boolean>((resolve) => {
          passkeyResolve = resolve;
          this.passkeyOpen = true;
        }),
    );
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('hashchange', this.hashChangeHandler);
    analyticsClient.removeEventListener('reprocess-started', this.handleReprocessStarted);
    analyticsClient.removeEventListener('reprocess-progress', this.handleReprocessProgress);
    analyticsClient.removeEventListener('reprocess-completed', this.handleReprocessCompleted);
  }

  private handleReprocessStarted = (event: Event): void => {
    const detail = (event as CustomEvent).detail as { reason: string };
    this.reprocessing = true;
    this.reprocessReason = detail.reason ?? 'Updating analytics data…';
    this.reprocessStep = '';
    this.reprocessPercent = 0;
    this.reprocessError = null;
  };

  private handleReprocessProgress = (event: Event): void => {
    const detail = (event as CustomEvent).detail as {
      step: string;
      completed: number;
      total: number;
    };
    this.reprocessStep = detail.step;
    this.reprocessPercent =
      detail.total > 0 ? Math.round((detail.completed / detail.total) * 100) : 0;
  };

  private handleReprocessCompleted = (event: Event): void => {
    const detail = (event as CustomEvent).detail as { ok: boolean; error?: string };
    this.reprocessPercent = 100;
    if (detail.ok) {
      this.reprocessing = false;
      this.reprocessError = null;
    } else {
      this.reprocessError = detail.error ?? 'An unknown error occurred during reprocessing.';
    }
  };

  private dismissReprocessError(): void {
    this.reprocessing = false;
    this.reprocessError = null;
  }

  /**
   * Called when the passkey modal successfully unlocks the vault. The
   * modal calls `unlock()` internally before emitting this event, so the
   * vault is already unlocked — we just need to resolve the pending
   * prompt promise.
   */
  private handlePasskeyUnlocked(): void {
    this.passkeyOpen = false;
    const resolve = passkeyResolve;
    passkeyResolve = null;
    resolve?.(true);
  }

  /**
   * Called when the passkey modal is dismissed (cancel, overlay click, or
   * Escape) without unlocking. Resolves the prompt promise to `false` so
   * the sync manager aborts the run gracefully.
   */
  private handlePasskeyCancel(event: Event): void {
    event.stopPropagation();
    this.passkeyOpen = false;
    const resolve = passkeyResolve;
    passkeyResolve = null;
    resolve?.(false);
  }

  /**
   * Called when the user forgets the passkey from inside the unlock modal.
   * All credentials are wiped, so the pending sync run cannot proceed.
   */
  private handlePasskeyForgotten(): void {
    this.passkeyOpen = false;
    const resolve = passkeyResolve;
    passkeyResolve = null;
    resolve?.(false);
  }

  private async loadProjects(): Promise<void> {
    try {
      this.projects = await dbClient.getProjects();
    } catch {
      // Non-fatal — selector stays hidden.
    }
  }

  private isDashboardActive(): boolean {
    return (
      this.currentPath === '/' ||
      this.currentPath.startsWith('/projects') ||
      this.currentPath.startsWith('/sessions') ||
      this.currentPath.startsWith('/manual-import')
    );
  }

  private isArtifactsActive(): boolean {
    return (
      this.currentPath.startsWith('/artifacts') || this.currentPath.startsWith('/artifact-diff')
    );
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

  /**
   * The Portfolio route (`/`) renders a page-owned title row
   * (`portfolio-view`'s `.title-row`, issue #170) in place of this global
   * header — project selection moves into the filter bar's Project chip and
   * Export moves into the page's own Export button, per the shell
   * sub-issue's disposition table. Every other route keeps the global
   * header. `sync-progress-bar`/`sync-status-bar` stay mounted below
   * regardless of route — the page's sync chip only complements them.
   *
   * Known, deliberate trade-off: `header-project-selector`'s type-ahead
   * "jump straight to any project by name" search is not replicated on `/`.
   * The filter bar's Project chip only *scopes* the Portfolio view, it does
   * not navigate. From `/`, reaching a specific project's page still takes
   * one action — a project leaderboard row click (carries the current
   * filter context as `returnContext`), or the icon rail's Projects
   * destination, which has its own full, searchable list. Every other
   * route keeps the fast type-ahead selector.
   */
  private get showGlobalHeader(): boolean {
    return this.currentPath !== '/';
  }

  private renderGlobalHeader() {
    if (!this.showGlobalHeader) return null;
    return html`
      <header>
        <a href="#/" class="logo">SAL</a>
        <header-project-selector
          .value=${this.selectedProjectSlug}
        ></header-project-selector>
        <nav class="header-nav">
          <a href="#/" class=${this.isDashboardActive() ? 'active' : ''}>Dashboard</a>
          <a href="#/artifacts" class=${this.isArtifactsActive() ? 'active' : ''}>Artifacts</a>
        </nav>
        <div class="header-right">
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
    `;
  }

  render() {
    return html`
      ${this.renderGlobalHeader()}

      <div class="app-body ${this.showGlobalHeader ? '' : 'no-header'}">
        ${this.appReady ? html`<icon-rail .path=${this.currentPath}></icon-rail>` : ''}
        <main>
          ${
            this.dbError
              ? html`<div class="app-error">${this.dbError}</div>`
              : !this.appReady
                ? html`
                  <div class="app-loading">
                    <div class="spinner"></div>
                    <span>Loading…</span>
                  </div>
                `
                : this.router.outlet()
          }
        </main>
      </div>

      ${
        this.reprocessing
          ? html`
          <div class="reprocess-overlay">
            <div class="reprocess-panel">
              <h2>Updating analytics data</h2>
              <p class="reprocess-reason">${this.reprocessReason}</p>
              ${
                this.reprocessError
                  ? html`
                    <div class="reprocess-error">${this.reprocessError}</div>
                    <button @click=${this.dismissReprocessError}>Close</button>
                  `
                  : html`
                    <div class="reprocess-step">
                      ${this.reprocessStep || 'Preparing…'}
                    </div>
                    <div class="reprocess-bar">
                      <div
                        class="reprocess-bar-fill"
                        style="width: ${this.reprocessPercent}%"
                      ></div>
                    </div>
                    <div class="reprocess-percent">${this.reprocessPercent}%</div>
                  `
              }
            </div>
          </div>
        `
          : ''
      }

      <div class="sync-chrome ${this.showGlobalHeader ? '' : 'no-header'}">
        <sync-progress-bar></sync-progress-bar>
      </div>
      <sync-status-bar></sync-status-bar>

      <passkey-modal
        .open=${this.passkeyOpen}
        .mode=${'unlock'}
        @passkey-unlocked=${this.handlePasskeyUnlocked}
        @passkey-forgotten=${this.handlePasskeyForgotten}
        @modal-close=${this.handlePasskeyCancel}
      ></passkey-modal>

      <toast-container></toast-container>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-root': AppRoot;
  }
}
