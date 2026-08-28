import { css, html, LitElement, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';

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
export class DeleteConfirmationModal extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }

    .delete-confirmation-modal {
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
    }

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
  `;

  @property({ type: Boolean, reflect: true }) open = false;

  @property({ type: String }) message = '';

  @property({ type: String }) confirmLabel = 'Delete';

  @property({ type: String }) cancelLabel = 'Cancel';

  @property({ type: String }) titleText = 'Delete?';

  @property({ attribute: false }) trigger?: HTMLElement;

  @query('.panel') private panel!: HTMLDivElement;

  private previouslyFocused?: HTMLElement;

  private readonly focusableSelector =
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

  willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('open') && this.open) {
      this.previouslyFocused = this.trigger ?? (document.activeElement as HTMLElement);
    }
  }

  updated(changed: PropertyValues<this>): void {
    if (changed.has('open')) {
      if (this.open) {
        this.updateComplete.then(() => this.focusFirst());
      } else {
        this.restoreFocus();
      }
    }
  }

  private focusFirst(): void {
    const focusable = this.getFocusable();
    const target = focusable[0] ?? this.panel;
    target?.focus();
  }

  private getFocusable(): HTMLElement[] {
    if (!this.panel) return [];
    return Array.from(this.panel.querySelectorAll(this.focusableSelector)).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && !el.hasAttribute('disabled'),
    );
  }

  private activeFocusable(): HTMLElement | null {
    const root = this.panel?.getRootNode();
    const active =
      root instanceof ShadowRoot
        ? (root.activeElement as HTMLElement)
        : (document.activeElement as HTMLElement);
    return active ?? null;
  }

  private restoreFocus(): void {
    if (this.previouslyFocused?.isConnected) {
      this.previouslyFocused.focus();
    }
  }

  private handleOverlayClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.close();
    }
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.close();
      return;
    }

    if (event.key === 'Tab') {
      const focusable = this.getFocusable();
      if (focusable.length === 0) return;

      const active = this.activeFocusable();
      const currentIndex = active ? focusable.indexOf(active) : -1;
      event.preventDefault();

      if (event.shiftKey) {
        const prevIndex = currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1;
        focusable[prevIndex].focus();
      } else {
        const nextIndex =
          currentIndex === -1 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1;
        focusable[nextIndex].focus();
      }
    }
  }

  private close(): void {
    this.dispatchEvent(new CustomEvent<void>('modal-close', { bubbles: true, composed: true }));
  }

  private confirm(): void {
    this.dispatchEvent(
      new CustomEvent<void>('delete-confirmed', { bubbles: true, composed: true }),
    );
  }

  render(): TemplateResult {
    if (!this.open) return html``;

    return html`
      <div
        class="delete-confirmation-modal"
        @click=${this.handleOverlayClick}
        @keydown=${this.handleKeydown}
      >
        <div
          class="panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dialog-title"
          aria-describedby="dialog-message"
          tabindex="-1"
        >
          <h2 id="dialog-title">${this.titleText}</h2>
          <p id="dialog-message">${this.message}</p>
          <div class="actions">
            <button
              type="button"
              class="secondary"
              @click=${this.close}
            >
              ${this.cancelLabel}
            </button>
            <button
              type="button"
              class="danger"
              @click=${this.confirm}
            >
              ${this.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'delete-confirmation-modal': DeleteConfirmationModal;
  }
}
