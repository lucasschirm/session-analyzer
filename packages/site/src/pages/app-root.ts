import { css, html, LitElement } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import '../components/header-project-selector';
import '../components/left-nav';
import '../components/passkey-modal';
import '../components/sync-progress-bar';
import '../components/toast-container';
import { analyticsClient } from '../db/analytics-client';
import { dbClient } from '../db/db-client';
import { currentHashPath, HashRouter, navigateTo } from '../router';
import { setPasskeyPrompt } from '../sync/passkey-prompt';
import { syncManager } from '../sync/sync-manager';
import type { Project } from '../types';
import './projects-page';
import './project-sessions-page';
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
 * - `#/projects/:projectId/sessions`       -> Project Sessions (paginated session list)
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

    .settings-button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
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

    .app-loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 65vh;
      padding: 24px;
    }

    .loading-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      background: var(--md-sys-color-surface, #171a21);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 16px;
      padding: 40px 48px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.4);
      max-width: 420px;
      width: 100%;
    }

    .spinner-container {
      position: relative;
      width: 56px;
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 20px;
    }

    .spinner-glow {
      position: absolute;
      inset: -8px;
      background: radial-gradient(circle, rgba(79, 140, 255, 0.25) 0%, transparent 70%);
      border-radius: 50%;
      animation: pulse-glow 2s ease-in-out infinite alternate;
    }

    .app-loading .spinner {
      width: 44px;
      height: 44px;
      border: 3px solid rgba(79, 140, 255, 0.15);
      border-top-color: var(--md-sys-color-primary, #4f8cff);
      border-right-color: var(--md-sys-color-primary, #4f8cff);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    .loading-text {
      margin-bottom: 20px;
    }

    .loading-title {
      font-size: 17px;
      font-weight: 600;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      letter-spacing: -0.01em;
      margin-bottom: 6px;
    }

    .loading-subtitle {
      font-size: 13px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      line-height: 1.4;
    }

    .loading-bar {
      width: 160px;
      height: 3px;
      background: rgba(79, 140, 255, 0.12);
      border-radius: 3px;
      overflow: hidden;
      position: relative;
    }

    .loading-bar-pulse {
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      width: 50%;
      background: linear-gradient(
        90deg,
        transparent 0%,
        var(--md-sys-color-primary, #4f8cff) 50%,
        transparent 100%
      );
      border-radius: 3px;
      animation: loading-shimmer 1.6s ease-in-out infinite;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    @keyframes pulse-glow {
      0% {
        transform: scale(0.9);
        opacity: 0.5;
      }
      100% {
        transform: scale(1.15);
        opacity: 0.9;
      }
    }

    @keyframes loading-shimmer {
      0% {
        transform: translateX(-100%);
      }
      100% {
        transform: translateX(250%);
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
      width: min(460px, 90vw);
      text-align: center;
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
    }

    .reprocess-panel h2 {
      margin: 0 0 8px;
      font-size: 18px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .reprocess-panel .reprocess-reason {
      margin: 0 0 16px;
      font-size: 14px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .reprocess-panel .reprocess-phase {
      display: inline-block;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--md-sys-color-primary, #4f8cff);
      background: rgba(79, 140, 255, 0.1);
      border: 1px solid rgba(79, 140, 255, 0.25);
      border-radius: 12px;
      padding: 3px 10px;
      margin-bottom: 10px;
    }

    .reprocess-panel .reprocess-step-row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin-bottom: 14px;
    }

    .reprocess-panel .reprocess-spinner {
      width: 14px;
      height: 14px;
      border: 2px solid var(--md-sys-color-outline, #2a303c);
      border-top-color: var(--md-sys-color-primary, #4f8cff);
      border-radius: 50%;
      animation: reprocess-spin 0.8s linear infinite;
      flex-shrink: 0;
    }

    @keyframes reprocess-spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }

    .reprocess-panel .reprocess-step {
      font-size: 14px;
      font-weight: 500;
      color: var(--md-sys-color-on-surface, #e6e9ef);
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

    .reprocess-panel .reprocess-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .reprocess-panel .reprocess-counts {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-size: 12px;
    }

    .reprocess-panel .reprocess-percent {
      color: var(--md-sys-color-primary, #4f8cff);
      font-weight: 600;
      margin-left: auto;
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
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
    }

    .reprocess-panel button:hover {
      background: #3b74db;
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
        path: '/projects/:projectId/sessions',
        render: (params) =>
          html`<project-sessions-page
            project-id=${decodeRouteParam(params.projectId)}
          ></project-sessions-page>`,
      },
      {
        path: '/projects/:projectId*',
        render: (params) =>
          html`<project-behavior-view
            project-id=${decodeRouteParam(params.projectId)}
          ></project-behavior-view>`,
      },
      {
        path: '/sessions/:sessionId*',
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

  @state() private reprocessCompleted = 0;

  @state() private reprocessTotal = 0;

  @state() private reprocessPhase?: number;

  @state() private reprocessTotalPhases?: number;

  @state() private reprocessUnit?: string;

  @state() private reprocessError: string | null = null;

  @state() private passkeyOpen = false;

  private hashChangeHandler = (): void => {
    this.currentPath = currentHashPath();
    void this.syncProjectSelector();
  };

  async firstUpdated(): Promise<void> {
    try {
      const analyticsInit = analyticsClient.ensureReady().catch((err) => {
        console.warn('Analytics engine eager initialization warning:', err);
      });
      await dbClient.ensureReady();
      await syncManager.init();
      this.currentPath = currentHashPath();
      await this.loadProjects();
      void this.syncProjectSelector();
      await analyticsInit;
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
    this.reprocessCompleted = 0;
    this.reprocessTotal = 0;
    this.reprocessPhase = undefined;
    this.reprocessTotalPhases = undefined;
    this.reprocessUnit = undefined;
    this.reprocessPercent = 0;
    this.reprocessError = null;
  };

  private handleReprocessProgress = (event: Event): void => {
    const detail = (event as CustomEvent).detail as {
      step: string;
      completed: number;
      total: number;
      phase?: number;
      totalPhases?: number;
      unit?: string;
    };
    this.reprocessStep = detail.step;
    this.reprocessCompleted = detail.completed;
    this.reprocessTotal = detail.total;
    this.reprocessPhase = detail.phase;
    this.reprocessTotalPhases = detail.totalPhases;
    this.reprocessUnit = detail.unit;
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
    if (!this.appReady) return;
    navigateTo('/settings/data-sources');
  }

  render() {
    const showLeftNav =
      this.currentPath === '/' ||
      this.currentPath.startsWith('/projects') ||
      this.currentPath.startsWith('/sessions') ||
      this.currentPath.startsWith('/settings') ||
      this.currentPath.startsWith('/agents') ||
      this.currentPath.startsWith('/skills') ||
      this.currentPath.startsWith('/tools') ||
      this.currentPath.startsWith('/mcp');

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
          <sync-progress-bar></sync-progress-bar>
          <button
            type="button"
            class="settings-button"
            title="Settings"
            aria-label="Settings"
            ?disabled=${!this.appReady}
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
        ${showLeftNav && this.appReady ? html`<left-nav .path=${this.currentPath}></left-nav>` : ''}
        <main>
          ${
            this.dbError
              ? html`<div class="app-error">${this.dbError}</div>`
              : !this.appReady
                ? html`
                  <div class="app-loading" role="status" aria-live="polite">
                    <div class="loading-card">
                      <div class="spinner-container">
                        <div class="spinner-glow"></div>
                        <div class="spinner"></div>
                      </div>
                      <div class="loading-text">
                        <div class="loading-title">Session Analyzer</div>
                        <div class="loading-subtitle">Initializing workspace and analytics engine…</div>
                      </div>
                      <div class="loading-bar">
                        <div class="loading-bar-pulse"></div>
                      </div>
                    </div>
                  </div>
                `
                : this.router.outlet()
          }
        </main>
      </div>

      ${
        this.reprocessing
          ? html`
          <div class="reprocess-overlay" role="dialog" aria-modal="true" aria-labelledby="reprocess-title">
            <div class="reprocess-panel">
              <h2 id="reprocess-title">Updating analytics data</h2>
              <p class="reprocess-reason">${this.reprocessReason}</p>
              ${
                this.reprocessError
                  ? html`
                    <div class="reprocess-error">${this.reprocessError}</div>
                    <button type="button" @click=${this.dismissReprocessError}>Close</button>
                  `
                  : html`
                    ${
                      this.reprocessPhase && this.reprocessTotalPhases
                        ? html`<div class="reprocess-phase">Phase ${this.reprocessPhase} of ${this.reprocessTotalPhases}</div>`
                        : ''
                    }
                    <div class="reprocess-step-row">
                      <span class="reprocess-spinner" aria-hidden="true"></span>
                      <span class="reprocess-step">
                        ${this.reprocessStep || 'Preparing…'}
                      </span>
                    </div>
                    <div class="reprocess-bar" role="progressbar" aria-valuenow="${this.reprocessPercent}" aria-valuemin="0" aria-valuemax="100">
                      <div
                        class="reprocess-bar-fill"
                        style="width: ${this.reprocessPercent}%"
                      ></div>
                    </div>
                    <div class="reprocess-meta">
                      <span class="reprocess-counts">
                        ${
                          this.reprocessTotal > 0
                            ? `${this.reprocessCompleted.toLocaleString()} / ${this.reprocessTotal.toLocaleString()}${this.reprocessUnit ? ` ${this.reprocessUnit}` : ''}`
                            : ''
                        }
                      </span>
                      <span class="reprocess-percent">${this.reprocessPercent}%</span>
                    </div>
                  `
              }
            </div>
          </div>
        `
          : ''
      }

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
