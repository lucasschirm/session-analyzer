import { css, html, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { ModalBase, type ModalStyles } from './modal-base';

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
export class SyncConfirmModal extends ModalBase {
  overlayClass = 'sync-confirm-modal';
  ariaLabel = 'Confirm sync';

  static styles: ModalStyles = [
    ModalBase.styles,
    css`
      .panel {
        width: min(440px, 100%);
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
    `,
  ];

  @property({ type: String }) connectionId = '';

  @property({ type: String }) connectionName = '';

  @state() private syncOnlyNew = false;

  private localStorageKey(): string {
    return `sal-sync-only-new:${this.connectionId}`;
  }

  willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (changed.has('open') && this.open && this.connectionId) {
      const stored = localStorage.getItem(this.localStorageKey());
      this.syncOnlyNew = stored === 'true';
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
    this.close();
    this.open = false;
  }

  private handleCheckboxChange(event: Event): void {
    this.syncOnlyNew = (event.target as HTMLInputElement).checked;
  }

  renderPanel(): TemplateResult {
    return html`
      <h2>Sync ${this.connectionName}</h2>
      <p>
        Unchanged sessions are skipped automatically. Choose how to sync sessions from this data
        source.
      </p>
      <label class="checkbox-label">
        <input type="checkbox" .checked=${this.syncOnlyNew} @change=${this.handleCheckboxChange} />
        Sync only new sessions
      </label>
      <div class="actions">
        <button type="button" class="secondary" @click=${this.handleClose}>Cancel</button>
        <button type="button" class="primary" @click=${this.handleConfirm}>Start Sync</button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sync-confirm-modal': SyncConfirmModal;
  }
}
