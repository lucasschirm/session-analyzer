import { css, html, LitElement, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';

/**
 * Per-sync confirmation modal that asks the user whether to sync only new
 * sessions each time they click sync.
 *
 * The last choice is persisted to `localStorage` keyed by connection id so the
 * checkbox is pre-selected with the previous value, but the user can change it
 * every time.
 *
 * Emits:
 *   - `sync-confirmed` with `{ connectionId, syncOnlyNew }` when the user
 *     confirms. The parent owns starting the run and closing the modal.
 *   - `modal-close` when the user cancels via the Cancel button, overlay click,
 *     or Escape. The parent sets `open` to false.
 */
@customElement('sync-confirm-modal')
export class SyncConfirmModal extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }

    .sync-confirm-modal {
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
      width: min(440px, 100%);
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
    }

    h2 {
      margin: 0 0 8px;
      font-size: 18px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    p {
      margin: 0 0 16px;
      font-size: 14px;
      line-height: 1.4;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .checkbox-label {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 20px;
      font-size: 14px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      cursor: pointer;
    }

    .checkbox-label input {
      width: auto;
      margin: 0;
      accent-color: var(--md-sys-color-primary, #4f8cff);
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

    button:focus-visible {
      outline: 2px solid var(--md-sys-color-primary, #4f8cff);
      outline-offset: 2px;
    }

    button.secondary {
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
    }

    button.primary {
      background: var(--md-sys-color-primary, #4f8cff);
      color: #fff;
    }
  `;

  @property({ type: Boolean, reflect: true }) open = false;

  @property({ type: String }) connectionId = '';

  @property({ type: String }) connectionName = '';

  @state() private syncOnlyNew = false;

  @query('.actions button.secondary') private cancelButton!: HTMLButtonElement;

  private localStorageKey(): string {
    return `sal-sync-only-new:${this.connectionId}`;
  }

  willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('open') && this.open && this.connectionId) {
      const stored = localStorage.getItem(this.localStorageKey());
      this.syncOnlyNew = stored === 'true';
    }
  }

  async updated(changed: PropertyValues<this>): Promise<void> {
    if (changed.has('open') && this.open) {
      // Move focus to the Cancel button so keyboard users have a visible
      // focus indicator and can close the modal with Escape (the keydown
      // listener is inside this shadow tree).
      await this.updateComplete;
      this.cancelButton?.focus();
    }
  }

  private handleConfirm(): void {
    localStorage.setItem(this.localStorageKey(), String(this.syncOnlyNew));
    this.dispatchEvent(
      new CustomEvent('sync-confirmed', {
        detail: { connectionId: this.connectionId, syncOnlyNew: this.syncOnlyNew },
        bubbles: true,
        composed: true,
      }),
    );
    this.open = false;
  }

  private handleClose(): void {
    this.dispatchEvent(new CustomEvent('modal-close', { bubbles: true, composed: true }));
    this.open = false;
  }

  private handleOverlayClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.handleClose();
    }
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.handleClose();
    }
  }

  private handleCheckboxChange(event: Event): void {
    this.syncOnlyNew = (event.target as HTMLInputElement).checked;
  }

  render(): TemplateResult {
    if (!this.open) return html``;
    return html`
      <div
        class="sync-confirm-modal"
        @click=${this.handleOverlayClick}
        @keydown=${this.handleKeydown}
      >
        <div class="panel" role="dialog" aria-modal="true" aria-label="Confirm sync">
          <h2>Sync ${this.connectionName}</h2>
          <p>Choose how to sync sessions from this data source.</p>
          <label class="checkbox-label">
            <input
              type="checkbox"
              .checked=${this.syncOnlyNew}
              @change=${this.handleCheckboxChange}
            />
            Sync only new sessions
          </label>
          <div class="actions">
            <button type="button" class="secondary" @click=${this.handleClose}>Cancel</button>
            <button type="button" class="primary" @click=${this.handleConfirm}>Start Sync</button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sync-confirm-modal': SyncConfirmModal;
  }
}
