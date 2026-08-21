import { css, html, LitElement, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { isUnlocked } from '../sync/credential-crypto';
import { type SyncManager, type SyncManagerSnapshot, syncManager } from '../sync/sync-manager';
import type { SessionSyncStatus } from '../types';

import './passkey-modal';

/**
 * Modal showing the details of a failed sync session and, when retryable, a
 * `Retry sync` button.
 *
 * Retry is hidden for `transcript_unavailable` sessions and for
 * `MANIFEST_UNSUPPORTED_SCHEMA` failures.
 */
@customElement('session-sync-error-modal')
export class SessionSyncErrorModal extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }

    .modal {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
      padding: 16px;
    }

    .panel {
      background: var(--md-sys-color-surface, #171a21);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 12px;
      padding: 24px;
      width: min(480px, 100%);
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    h2 {
      margin: 0;
      font-size: 18px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .details {
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      padding: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 240px;
      overflow-y: auto;
    }

    .muted {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-size: 14px;
      margin: 0;
    }

    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    button {
      border: none;
      padding: 10px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }

    button.primary {
      background: var(--md-sys-color-primary, #4f8cff);
      color: #fff;
    }

    button.primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    button.secondary {
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
    }
  `;

  @property({ type: Boolean, reflect: true }) open = false;

  @property({ type: String, attribute: 'connection-id' }) connectionId = '';

  @property({ type: String, attribute: 'project-id' }) projectId = '';

  @property({ type: String, attribute: 'session-id' }) sessionId = '';

  @property({ type: String, attribute: 'sync-details' }) syncDetails = '';

  @property({ type: String }) status: SessionSyncStatus | '' = '';

  @property({ attribute: false })
  syncManager: SyncManager = syncManager;

  @state() private passkeyOpen = false;

  @state() private syncSnapshot: SyncManagerSnapshot | null = null;

  connectedCallback(): void {
    super.connectedCallback();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.syncManager.removeEventListener('change', this.handleSyncChange);
  }

  willUpdate(changed: PropertyValues): void {
    if (changed.has('open')) {
      if (this.open) {
        this.syncSnapshot = this.syncManager.getSnapshot();
        this.syncManager.addEventListener('change', this.handleSyncChange);
      } else {
        this.syncSnapshot = null;
        this.syncManager.removeEventListener('change', this.handleSyncChange);
      }
    }
  }

  private handleSyncChange = (event: Event): void => {
    this.syncSnapshot = (event as CustomEvent<SyncManagerSnapshot>).detail;
  };

  private handleOverlayClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.close();
    }
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.close();
    }
  }

  private close(): void {
    this.dispatchEvent(new CustomEvent('modal-close', { bubbles: true, composed: true }));
  }

  private get isRetryable(): boolean {
    if (this.status === 'transcript_unavailable') return false;
    if (this.syncDetails.includes('MANIFEST_UNSUPPORTED_SCHEMA')) return false;
    return this.status === 'failed';
  }

  private get isLocked(): boolean {
    return !isUnlocked();
  }

  private handleRetryClick(): void {
    if (!this.isRetryable) return;
    if (this.isLocked) {
      this.passkeyOpen = true;
      return;
    }
    void this.doRetry();
  }

  private async doRetry(): Promise<void> {
    if (!this.connectionId || !this.projectId || !this.sessionId) return;
    try {
      await this.syncManager.retrySession(this.connectionId, this.projectId, this.sessionId);
      this.close();
    } catch {
      // The run will surface the failure via the progress bar / status modal.
    }
  }

  private handlePasskeyUnlocked(): void {
    this.passkeyOpen = false;
    if (isUnlocked()) {
      void this.doRetry();
    }
  }

  private handlePasskeyClose(): void {
    this.passkeyOpen = false;
  }

  private renderDetails(): TemplateResult {
    if (this.status === 'transcript_unavailable') {
      return html`
        <p class="muted">
          No transcript was uploaded for this remote session. It cannot be retried.
        </p>
      `;
    }
    return html`<pre class="details">${this.syncDetails || 'No details available'}</pre>`;
  }

  private renderActions(): TemplateResult {
    return html`
      <div class="actions">
        <button class="secondary" @click=${this.close} type="button">Close</button>
        ${
          this.isRetryable
            ? html`
              <button
                class="primary"
                ?disabled=${this.syncSnapshot?.readOnly}
                @click=${this.handleRetryClick}
                type="button"
              >
                Retry sync
              </button>
            `
            : ''
        }
      </div>
    `;
  }

  private renderPasskeyModal(): TemplateResult {
    return html`
      <passkey-modal
        .open=${this.passkeyOpen}
        mode="unlock"
        @passkey-unlocked=${this.handlePasskeyUnlocked}
        @modal-close=${this.handlePasskeyClose}
      ></passkey-modal>
    `;
  }

  render(): TemplateResult {
    if (!this.open) {
      return html``;
    }

    return html`
      <div
        class="modal"
        @click=${this.handleOverlayClick}
        @keydown=${this.handleKeydown}
      >
        <div class="panel" role="dialog" aria-modal="true" aria-label="Sync error">
          <h2>Sync error</h2>
          ${this.renderDetails()}
          ${this.renderActions()}
        </div>
      </div>

      ${this.renderPasskeyModal()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-sync-error-modal': SessionSyncErrorModal;
  }
}
