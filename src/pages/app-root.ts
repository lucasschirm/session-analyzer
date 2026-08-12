import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { dbClient } from '../db/db-client';
import { HashRouter } from '../router';
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
 * - `#/sessions/:sessionId/transcript`     -> Session Transcript (+ subagents)
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

    main {
      padding: 24px;
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
    ],
    {
      render: () => html`
        <p>Page not found. <a href="#/">Go back home</a>.</p>
      `,
    }
  );

  @state() private storage: 'opfs' | 'memory' | null = null;

  @state() private dbError: string | null = null;

  async firstUpdated(): Promise<void> {
    try {
      this.storage = await dbClient.ensureReady();
    } catch (error) {
      this.dbError = `Failed to initialize database: ${(error as Error).message}`;
    }
  }

  render() {
    return html`
      <header>
        <a href="#/" class="logo">Session Analyzer</a>
        <div class="header-right">
          ${this.storage
            ? html`<span class="storage-badge ${this.storage}" title="SQLite storage backend">
                ${this.storage === 'opfs' ? 'OPFS' : 'In-Memory'}
              </span>`
            : ''}
          <nav>
            <a href="#/">Home</a>
          </nav>
        </div>
      </header>

      <main>
        ${this.dbError ? html`<div class="app-error">${this.dbError}</div>` : ''}
        ${this.router.outlet()}
      </main>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-root': AppRoot;
  }
}
