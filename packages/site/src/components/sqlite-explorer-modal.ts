import { css, html, LitElement, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

export const DEFAULT_SQLITE_EXPLORER_URL = 'https://sqlite-explorer-ee0d4.web.app';
export const SQLITE_EXPLORER_STORAGE_KEY = 'sal-sqlite-explorer-url';

export const HANDOVER_MESSAGE_TYPE = 'sqlite-explorer:handover';
export const HANDOVER_ACK_TYPE = 'sqlite-explorer:handover:ack';
export const HANDOVER_NACK_TYPE = 'sqlite-explorer:handover:nack';

const HANDOVER_TIMEOUT_MS = 15_000;

export type HandoverState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * SQLite Explorer embedded iframe modal.
 *
 * Receives an exported SQLite database Blob and hands it over via `postMessage`
 * to the SQLite Explorer web app running in an embedded <iframe>.
 *
 * Provides controls to:
 * - Go fullscreen (occupies 100vw x 100vh)
 * - Return to partial screen (centered modal with backdrop)
 * - Close the overlay (Esc key or Close button)
 */
@customElement('sqlite-explorer-modal')
export class SqliteExplorerModal extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }

    .explorer-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(2px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 200;
      padding: 24px;
      box-sizing: border-box;
      transition: padding 0.2s ease-in-out;
    }

    .explorer-overlay.fullscreen {
      padding: 0;
    }

    .explorer-dialog {
      background: var(--md-sys-color-surface, #171a21);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 12px;
      width: min(1320px, 95vw);
      height: min(880px, 92vh);
      display: flex;
      flex-direction: column;
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
      overflow: hidden;
      transition: all 0.2s ease-in-out;
    }

    .explorer-overlay.fullscreen .explorer-dialog {
      width: 100vw;
      height: 100vh;
      max-width: 100vw;
      max-height: 100vh;
      border-radius: 0;
      border: none;
    }

    .explorer-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 16px;
      background: var(--md-sys-color-surface-container, #1f242e);
      border-bottom: 1px solid var(--md-sys-color-outline, #2a303c);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      user-select: none;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .header-title {
      font-size: 14px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
      white-space: nowrap;
    }

    .db-badge {
      background: rgba(99, 102, 241, 0.15);
      color: #818cf8;
      border: 1px solid rgba(99, 102, 241, 0.3);
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      padding: 2px 8px;
      border-radius: 9999px;
      background: var(--md-sys-color-surface, #171a21);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .status-pill.ready {
      color: #4ade80;
      border-color: rgba(74, 222, 128, 0.3);
    }

    .status-pill.error {
      color: var(--md-sys-color-error, #ff6b6b);
      border-color: var(--md-sys-color-error-container, #5c2626);
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }

    .status-dot.pulse {
      animation: pulse 1.2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 0.3; }
      50% { opacity: 1; }
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    .toolbar-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: transparent;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .toolbar-btn:hover {
      background: var(--md-sys-color-surface-container-hover, #262d3a);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      border-color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .toolbar-btn.close-btn:hover {
      background: rgba(255, 107, 107, 0.15);
      color: var(--md-sys-color-error, #ff6b6b);
      border-color: var(--md-sys-color-error-container, #5c2626);
    }

    .retry-btn {
      background: none;
      border: none;
      color: #818cf8;
      text-decoration: underline;
      cursor: pointer;
      padding: 0;
      font-size: 12px;
    }

    .retry-btn:hover {
      color: #a5b4fc;
    }

    .iframe-container {
      flex: 1;
      position: relative;
      background: #0f172a;
      overflow: hidden;
      display: flex;
    }

    iframe {
      width: 100%;
      height: 100%;
      border: none;
      flex: 1;
    }

    .icon-svg {
      width: 14px;
      height: 14px;
    }
  `;

  @property({ type: Boolean, reflect: true }) open = false;

  @property({ type: String }) dbName = '';

  @property({ type: String }) filename = '';

  @property({ attribute: false }) blob: Blob | null = null;

  @property({ type: String }) explorerUrl = '';

  @state() isFullscreen = false;

  @state() handoverState: HandoverState = 'idle';

  @state() errorMessage: string | null = null;

  private messageListener?: (event: MessageEvent) => void;

  private timeoutTimer?: number;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.handleKeydown);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.handleKeydown);
    this.cleanupHandover();
  }

  willUpdate(changed: PropertyValues): void {
    if (changed.has('open')) {
      if (this.open) {
        this.handoverState = 'loading';
        this.errorMessage = null;
      } else {
        this.cleanupHandover();
        this.isFullscreen = false;
        this.handoverState = 'idle';
      }
    }
  }

  protected computeExplorerUrl(): string {
    const base =
      this.explorerUrl ||
      localStorage.getItem(SQLITE_EXPLORER_STORAGE_KEY) ||
      DEFAULT_SQLITE_EXPLORER_URL;
    try {
      const url = new URL(base, window.location.href);
      url.searchParams.set('handoverOrigins', window.location.origin);
      return url.toString();
    } catch {
      return base;
    }
  }

  protected computeExplorerOrigin(): string {
    try {
      return new URL(this.computeExplorerUrl()).origin;
    } catch {
      return '*';
    }
  }

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (!this.open) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (this.isFullscreen) {
        // Esc exits fullscreen mode first if active
        this.isFullscreen = false;
      } else {
        this.close();
      }
    }
  };

  private cleanupHandover(): void {
    if (this.timeoutTimer !== undefined) {
      window.clearTimeout(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }
    if (this.messageListener) {
      window.removeEventListener('message', this.messageListener);
      this.messageListener = undefined;
    }
  }

  private handleIframeLoad(): void {
    this.sendHandover();
  }

  private sendHandover(): void {
    if (!this.blob) return;

    const iframe = this.renderRoot.querySelector('iframe') as HTMLIFrameElement | null;
    if (!iframe?.contentWindow) return;

    const targetOrigin = this.computeExplorerOrigin();
    this.cleanupHandover();

    this.handoverState = 'loading';
    this.errorMessage = null;

    this.timeoutTimer = window.setTimeout(() => {
      if (this.handoverState === 'loading') {
        this.handoverState = 'error';
        this.errorMessage = 'Handover timed out. Verify that the explorer is reachable.';
      }
    }, HANDOVER_TIMEOUT_MS);

    this.messageListener = (event: MessageEvent) => {
      if (event.origin !== targetOrigin) return;
      const data = event.data as Record<string, unknown> | undefined;
      if (!data || typeof data !== 'object') return;

      if (data.type === HANDOVER_ACK_TYPE) {
        this.cleanupHandover();
        this.handoverState = 'ready';
      } else if (data.type === HANDOVER_NACK_TYPE) {
        this.cleanupHandover();
        this.handoverState = 'error';
        this.errorMessage =
          typeof data.reason === 'string' ? data.reason : 'Handover rejected by explorer';
      }
    };

    window.addEventListener('message', this.messageListener);

    const safeName = (this.filename || 'database.sqlite').replace(/^\//, '');
    iframe.contentWindow.postMessage(
      {
        type: HANDOVER_MESSAGE_TYPE,
        name: safeName,
        blob: this.blob,
      },
      targetOrigin,
    );
  }

  private retryHandover(event: Event): void {
    event.stopPropagation();
    this.sendHandover();
  }

  toggleFullscreen(): void {
    this.isFullscreen = !this.isFullscreen;
  }

  close(): void {
    this.cleanupHandover();
    this.open = false;
    this.dispatchEvent(new CustomEvent('modal-close', { bubbles: true, composed: true }));
  }

  private handleOverlayClick(event: MouseEvent): void {
    if (event.target === event.currentTarget && !this.isFullscreen) {
      this.close();
    }
  }

  private renderStatus(): TemplateResult {
    switch (this.handoverState) {
      case 'loading':
        return html`
          <span class="status-pill" title="Transferring database to explorer...">
            <span class="status-dot pulse"></span>
            Transferring…
          </span>
        `;
      case 'ready':
        return html`
          <span class="status-pill ready" title="Database successfully loaded in explorer">
            <span class="status-dot"></span>
            Ready
          </span>
        `;
      case 'error':
        return html`
          <span class="status-pill error" title=${this.errorMessage ?? 'Handover failed'}>
            <span class="status-dot"></span>
            Failed: ${this.errorMessage ?? 'Error'}
            <button type="button" class="retry-btn" @click=${this.retryHandover}>Retry</button>
          </span>
        `;
      case 'idle':
      default:
        return html``;
    }
  }

  private renderFullscreenIcon(): TemplateResult {
    if (this.isFullscreen) {
      // Exit fullscreen (contract) icon
      return html`
        <svg
          class="icon-svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path>
        </svg>
      `;
    }
    // Enter fullscreen (expand) icon
    return html`
      <svg
        class="icon-svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"></path>
      </svg>
    `;
  }

  private renderCloseIcon(): TemplateResult {
    return html`
      <svg
        class="icon-svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M18 6L6 18M6 6l12 12"></path>
      </svg>
    `;
  }

  render(): TemplateResult {
    if (!this.open) return html``;

    const overlayClasses = {
      'explorer-overlay': true,
      fullscreen: this.isFullscreen,
    };

    return html`
      <div
        class=${classMap(overlayClasses)}
        @click=${this.handleOverlayClick}
        role="dialog"
        aria-modal="true"
        aria-label="SQLite Explorer"
      >
        <div class="explorer-dialog">
          <div class="explorer-header">
            <div class="header-left">
              <span class="header-title">SQLite Explorer</span>
              ${this.dbName ? html`<span class="db-badge">${this.dbName}</span>` : ''}
              ${this.renderStatus()}
            </div>
            <div class="header-actions">
              <button
                type="button"
                class="toolbar-btn"
                @click=${this.toggleFullscreen}
                title=${this.isFullscreen ? 'Return to partial screen (Esc)' : 'Go fullscreen'}
                aria-label=${this.isFullscreen ? 'Return to partial screen' : 'Go fullscreen'}
              >
                ${this.renderFullscreenIcon()}
                <span>${this.isFullscreen ? 'Partial screen' : 'Fullscreen'}</span>
              </button>
              <button
                type="button"
                class="toolbar-btn close-btn"
                @click=${this.close}
                title="Close overlay (Esc)"
                aria-label="Close overlay"
              >
                ${this.renderCloseIcon()}
                <span>Close</span>
              </button>
            </div>
          </div>
          <div class="iframe-container">
            <iframe
              credentialless
              allow="clipboard-read; clipboard-write"
              title="SQLite Explorer"
              src=${this.computeExplorerUrl()}
              @load=${this.handleIframeLoad}
            ></iframe>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sqlite-explorer-modal': SqliteExplorerModal;
  }
}
