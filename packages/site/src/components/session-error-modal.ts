import { css, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { ModalBase, type ModalStyles } from './modal-base';

/**
 * Error-details dialog for a failed session sync.
 *
 * Shows the stored `sync_details` failure log for one session. Focus,
 * Escape/overlay dismissal, and focus restore are inherited from
 * {@link ModalBase}; closing emits `modal-close`.
 */
@customElement('session-error-modal')
export class SessionErrorModal extends ModalBase {
  overlayClass = 'session-error-modal';
  ariaLabel = 'Session sync error details';

  static styles: ModalStyles = [
    ModalBase.styles,
    css`
      .panel {
        width: min(640px, 100%);
      }

      h3 {
        margin: 0 0 12px;
        font-size: 16px;
        color: var(--md-sys-color-on-surface, #e6e9ef);
      }

      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: 'Fira Code', 'Cascadia Code', 'SF Mono', monospace;
        font-size: 13px;
        line-height: 1.5;
        color: var(--md-sys-color-on-surface-variant, #9aa4b2);
        background: var(--md-sys-color-surface, #171a21);
        padding: 12px;
        border-radius: 6px;
        border: 1px solid var(--md-sys-color-outline, #2a303c);
      }

      .actions {
        display: flex;
        justify-content: flex-end;
        margin-top: 16px;
      }

      button {
        border: 1px solid var(--md-sys-color-outline, #2a303c);
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        background: var(--md-sys-color-surface-container, #1f242e);
        color: var(--md-sys-color-on-surface, #e6e9ef);
      }

      button:focus-visible {
        outline: 2px solid var(--md-sys-color-primary, #4f8cff);
        outline-offset: 2px;
      }
    `,
  ];

  @property({ type: String }) sessionTitle = '';

  @property({ type: String }) errorDetails = '';

  renderPanel(): TemplateResult {
    return html`
      <h3>Sync error: ${this.sessionTitle}</h3>
      <pre>${this.errorDetails}</pre>
      <div class="actions">
        <button type="button" @click=${() => this.close()}>Close</button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-error-modal': SessionErrorModal;
  }
}
