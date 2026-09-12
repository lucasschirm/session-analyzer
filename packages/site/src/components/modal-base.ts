import { css, html, LitElement, type PropertyValues, type TemplateResult } from 'lit';
import { property, query } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { ifDefined } from 'lit/directives/if-defined.js';

export type ModalStyles = ReturnType<typeof css> | Array<ModalStyles>;

/**
 * Shared base class for site modal dialogs.
 *
 * Provides the common overlay, panel, scroll, focus-trap, Escape/overlay-close,
 * and focus-restore behavior. Subclasses only need to provide their panel
 * content via `renderPanel()` and any modal-specific CSS.
 *
 * @fires modal-close {void} when the user dismisses the modal via Escape,
 *   overlay click, or a subclass calling `close()`.
 */
export abstract class ModalBase extends LitElement {
  static styles: ModalStyles = css`
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
      max-height: calc(100vh - 32px);
      overflow-y: auto;
      box-sizing: border-box;
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
    }
  `;

  @property({ type: Boolean, reflect: true }) open = false;

  /** Optional extra class added to the overlay for test hooks or extra styles. */
  @property({ type: String }) overlayClass = '';

  /** `aria-label` for the dialog panel. */
  @property({ type: String }) ariaLabel = '';

  /** `aria-labelledby` for the dialog panel. */
  @property({ type: String, attribute: 'aria-labelledby' }) ariaLabelledBy = '';

  /** `aria-describedby` for the dialog panel. */
  @property({ type: String, attribute: 'aria-describedby' }) ariaDescribedBy = '';

  /** Optional `tabindex` for the panel itself. */
  @property({ type: Number }) panelTabIndex?: number;

  /** Element to return focus to when the modal closes. */
  @property({ attribute: false }) trigger?: HTMLElement;

  @query('.panel') protected panel!: HTMLElement;

  private previouslyFocused?: HTMLElement;

  private readonly focusableSelector =
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

  abstract renderPanel(): TemplateResult;

  willUpdate(changed: PropertyValues): void {
    if (changed.has('open') && this.open) {
      this.previouslyFocused = this.trigger ?? (document.activeElement as HTMLElement);
    }
  }

  updated(changed: PropertyValues): void {
    if (changed.has('open')) {
      if (this.open) {
        this.updateComplete.then(() => this.focusFirst());
      } else {
        this.restoreFocus();
      }
    }
  }

  protected focusFirst(): void {
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

  protected handleOverlayClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.close();
    }
  }

  protected handleKeydown(event: KeyboardEvent): void {
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

  protected close(): void {
    this.dispatchEvent(new CustomEvent<void>('modal-close', { bubbles: true, composed: true }));
  }

  render(): TemplateResult {
    if (!this.open) return html``;

    const overlayClasses: Record<string, boolean> = { modal: true };
    if (this.overlayClass) {
      overlayClasses[this.overlayClass] = true;
    }

    return html`
      <div
        class=${classMap(overlayClasses)}
        @click=${this.handleOverlayClick}
        @keydown=${this.handleKeydown}
      >
        <div
          class="panel"
          role="dialog"
          aria-modal="true"
          aria-label=${ifDefined(this.ariaLabel || undefined)}
          aria-labelledby=${ifDefined(this.ariaLabelledBy || undefined)}
          aria-describedby=${ifDefined(this.ariaDescribedBy || undefined)}
          tabindex=${ifDefined(this.panelTabIndex)}
        >
          ${this.renderPanel()}
        </div>
      </div>
    `;
  }
}
