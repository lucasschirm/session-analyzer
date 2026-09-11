import { css, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { ModalBase, type ModalStyles } from './modal-base';

/**
 * A small, focus-managed confirmation dialog for destructive actions.
 *
 * - `open` is controlled by the parent.
 * - `message` is the body text (the "what will be deleted" explanation).
 * - `confirmLabel` / `cancelLabel` can be customized per call site.
 * - `trigger` is the element that opened the dialog; focus returns to it when
 *   the dialog is closed, if it is still in the document.
 *
 * Emits:
 *   - `delete-confirmed` when the user explicitly confirms the destructive
 *     action. The parent owns the actual deletion and closing.
 *   - `modal-close` when the user cancels via the Cancel button, overlay click,
 *     or Escape. The parent sets `open` to false.
 */
@customElement('delete-confirmation-modal')
export class DeleteConfirmationModal extends ModalBase {
  overlayClass = 'delete-confirmation-modal';
  ariaLabelledBy = 'dialog-title';
  ariaDescribedBy = 'dialog-message';
  panelTabIndex = -1;

  static styles: ModalStyles = [
    ModalBase.styles,
    css`
      h2 {
        margin: 0 0 12px;
        font-size: 18px;
        color: var(--md-sys-color-on-surface, #e6e9ef);
      }

      p {
        margin: 0 0 20px;
        font-size: 14px;
        line-height: 1.4;
        color: var(--md-sys-color-on-surface-variant, #9aa4b2);
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

      button.secondary {
        background: var(--md-sys-color-surface-container, #1f242e);
        color: var(--md-sys-color-on-surface, #e6e9ef);
        border: 1px solid var(--md-sys-color-outline, #2a303c);
      }

      button.danger {
        background: var(--md-sys-color-error, #ff6b6b);
        color: #000;
      }

      button.danger:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    `,
  ];

  @property({ type: String }) message = '';

  @property({ type: String }) confirmLabel = 'Delete';

  @property({ type: String }) cancelLabel = 'Cancel';

  @property({ type: String }) titleText = 'Delete?';

  private confirm(): void {
    this.dispatchEvent(
      new CustomEvent<void>('delete-confirmed', { bubbles: true, composed: true }),
    );
  }

  renderPanel(): TemplateResult {
    return html`
      <h2 id="dialog-title">${this.titleText}</h2>
      <p id="dialog-message">${this.message}</p>
      <div class="actions">
        <button type="button" class="secondary" @click=${this.close}>
          ${this.cancelLabel}
        </button>
        <button type="button" class="danger" @click=${this.confirm}>
          ${this.confirmLabel}
        </button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'delete-confirmation-modal': DeleteConfirmationModal;
  }
}
