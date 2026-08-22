import { css, html, LitElement } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import '../components/connect-modal';
import '../components/passkey-modal';
import '../components/sync-progress-bar';
import '../components/sync-status-bar';
import '../components/toast-container';
import { dbClient } from '../db/db-client';
import { HashRouter } from '../router';
import { isUnlocked } from '../sync/credential-crypto';
import { syncManager } from '../sync/sync-manager';
import './home-page';
import './project-view';
import './session-dashboard';
import './indicator-details';
import './session-transcript-page';

/**
 * Root application shell: header, hash-based routing outlet and database
 * lifecycle. Routes:
 *
 * - `#/`                                   -> Home (projects CRUD)
 * - `#/projects/:projectId`                -> Project View (upload + sessions)
 * - `#/sessions/:sessionId`                -> Session Dashboard (metrics)
 * - `#/sessions/:sessionId/indicator/:key` -> Indicator Details (drill-down)
 * - `#/sessions/:sessionId/transcript`     -> Session Transcript (subagent cards inline, full width)
 * - `#/sessions/:sessionId/transcript/:agentId` -> Session Transcript, split with that subagent's column open
 */
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
      padding: 14px 24px;
      border-bottom: 1px solid var(--md-sys-color-outline, #2a303c);
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      z-index: 10;
    }

    .logo {
      font-size: 18px;
      font-weight: 700;
      color: var(--md-sys-color-primary, #4f8cff);
      text-decoration: none;
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .storage-badge {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .storage-badge.opfs {
      color: var(--md-sys-color-success, #3ecf8e);
      border-color: var(--md-sys-color-success, #3ecf8e);
    }

    nav {
      display: flex;
      gap: 8px;
    }

    nav a {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      text-decoration: none;
      padding: 7px 14px;
      border-radius: 8px;
      font-size: 14px;
      transition: background-color 0.15s ease;
    }

    nav a:hover {
      background: var(--md-sys-color-surface-container, #1f242e);
    }

    .connect-button {
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      padding: 7px 14px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background-color 0.15s ease;
    }

    .connect-button:hover {
      background: var(--md-sys-color-surface-container-hover, #262d3a);
    }

    main {
      padding: 24px;
      padding-bottom: 56px;
      max-width: 1200px;
      margin: 0 auto;
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
        render: () => html`<home-page></home-page>`,
      },
      {
        path: '/projects/:projectId',
        render: (params) =>
          html`<project-view project-id=${params.projectId ?? ''}></project-view>`,
      },
      {
        path: '/sessions/:sessionId',
        render: (params) =>
          html`<session-dashboard session-id=${params.sessionId ?? ''}></session-dashboard>`,
      },
      {
        path: '/sessions/:sessionId/indicator/:indicator',
        render: (params) =>
          html`<indicator-details
            session-id=${params.sessionId ?? ''}
            indicator=${params.indicator ?? ''}
          ></indicator-details>`,
      },
      {
        path: '/sessions/:sessionId/transcript',
        render: (params) =>
          html`<session-transcript-page
            session-id=${params.sessionId ?? ''}
          ></session-transcript-page>`,
      },
      {
        path: '/sessions/:sessionId/transcript/:agentId',
        render: (params) =>
          html`<session-transcript-page
            session-id=${params.sessionId ?? ''}
            agent-id=${params.agentId ?? ''}
          ></session-transcript-page>`,
      },
    ],
    {
      render: () => html`
        <p>Page not found. <a href="#/">Go back home</a>.</p>
      `,
    },
  );

  @state() private storage: 'opfs' | 'memory' | null = null;

  @state() private dbError: string | null = null;

  @state() private connectOpen = false;

  @state() private passkeyOpen = false;

  @state() private passkeyMode: 'create' | 'unlock' = 'create';

  @state() private hasConnections = false;

  @state() private hasPasskey = false;

  async firstUpdated(): Promise<void> {
    try {
      const storage = await dbClient.ensureReady();
      await syncManager.init();
      await this.loadSecurityState();
      this.storage = storage;
    } catch (error) {
      this.dbError = `Failed to initialize database: ${(error as Error).message}`;
    }
  }

  private async loadSecurityState(): Promise<void> {
    const [connections, passkeyState] = await Promise.all([
      dbClient.getConnections(),
      dbClient.getPasskeyState(),
    ]);
    this.hasConnections = connections.length > 0;
    this.hasPasskey = passkeyState !== null;
  }

  private handleConnectClick(): void {
    if (this.hasConnections && this.hasPasskey && !isUnlocked()) {
      this.passkeyMode = 'unlock';
      this.passkeyOpen = true;
      return;
    }
    this.connectOpen = true;
  }

  private handlePasskeySuccess(): void {
    this.passkeyOpen = false;
    this.connectOpen = true;
  }

  private handlePasskeyClose(): void {
    this.passkeyOpen = false;
  }

  private handlePasskeyForgotten(): void {
    this.passkeyOpen = false;
    void this.loadSecurityState();
  }

  private handleConnectClose(): void {
    this.connectOpen = false;
    this.passkeyOpen = false;
    void this.loadSecurityState();
  }

  render() {
    return html`
      <header>
        <a href="#/" class="logo">Session Analyzer</a>
        <div class="header-right">
          <sync-progress-bar></sync-progress-bar>
          ${
            this.storage
              ? html`<span class="storage-badge ${this.storage}" title="SQLite storage backend">
                ${this.storage === 'opfs' ? 'OPFS' : 'In-Memory'}
              </span>`
              : ''
          }
          <button type="button" class="connect-button" @click=${this.handleConnectClick}>
            Connect
          </button>
          <nav>
            <a href="#/">Home</a>
          </nav>
        </div>
      </header>

      <main>
        ${this.dbError ? html`<div class="app-error">${this.dbError}</div>` : ''}
        ${this.router.outlet()}
      </main>

      <connect-modal
        .open=${this.connectOpen}
        @modal-close=${this.handleConnectClose}
      ></connect-modal>

      <passkey-modal
        .open=${this.passkeyOpen}
        .mode=${this.passkeyMode}
        @passkey-created=${this.handlePasskeySuccess}
        @passkey-unlocked=${this.handlePasskeySuccess}
        @passkey-forgotten=${this.handlePasskeyForgotten}
        @modal-close=${this.handlePasskeyClose}
      ></passkey-modal>

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
