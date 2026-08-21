import { css, html, LitElement, type TemplateResult } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { createPasskey, forgetPasskey, isUnlocked, lock, unlock } from '../sync/credential-crypto';

/**
 * Passkey modal: create, unlock, or confirm forgetting the global vault
 * passkey. Emits `passkey-created`, `passkey-unlocked`, and
 * `passkey-forgotten` so parents own navigation and persistence.
 */
@customElement('passkey-modal')
export class PasskeyModal extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }

    .passkey-modal {
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
      margin: 0 0 16px;
      font-size: 18px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    p {
      margin: 0 0 16px;
      font-size: 14px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      line-height: 1.4;
    }

    label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      margin-bottom: 6px;
    }

    input {
      width: 100%;
      box-sizing: border-box;
      padding: 10px 12px;
      font-size: 14px;
      font-family: inherit;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      margin-bottom: 16px;
    }

    input:focus-visible {
      outline: 2px solid var(--md-sys-color-primary, #4f8cff);
      outline-offset: 1px;
    }

    .error {
      color: var(--md-sys-color-error, #ff8a8a);
      font-size: 13px;
      margin-bottom: 16px;
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

    button.danger {
      background: var(--md-sys-color-error, #ff8a8a);
      color: #000;
    }

    button.danger:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    button.link {
      background: transparent;
      color: var(--md-sys-color-primary, #4f8cff);
      padding: 0;
      font-size: 13px;
      text-decoration: underline;
    }

    .forgot-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
  `;

  @property({ type: Boolean, reflect: true }) open = false;

  @property({ type: String, reflect: true }) mode: 'create' | 'unlock' | 'forgot' = 'create';

  @state() private passkey = '';

  @state() private confirmPasskey = '';

  @state() private error = '';

  @state() private pending = false;

  @query('#passkey-input') private passkeyInput!: HTMLInputElement;

  updated(changed: Map<string, unknown>): void {
    if (changed.has('open') && this.open) {
      this.reset();
      this.updateComplete.then(() => this.focusFirstInput());
    }
  }

  private reset(): void {
    this.passkey = '';
    this.confirmPasskey = '';
    this.error = '';
    this.pending = false;
    if (!isUnlocked()) {
      lock();
    }
  }

  private focusFirstInput(): void {
    if (this.mode === 'create' || this.mode === 'unlock') {
      this.passkeyInput?.focus();
    }
  }

  private close(): void {
    this.dispatchEvent(new CustomEvent('modal-close', { bubbles: true, composed: true }));
  }

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

  private handlePasskeyInput(event: Event): void {
    this.passkey = (event.target as HTMLInputElement).value;
    this.error = '';
  }

  private handleConfirmInput(event: Event): void {
    this.confirmPasskey = (event.target as HTMLInputElement).value;
    this.error = '';
  }

  private async handleCreateSubmit(event: Event): Promise<void> {
    event.preventDefault();

    if (this.passkey.length < 8) {
      this.error = 'Passkey must be at least 8 characters.';
      return;
    }

    if (this.passkey !== this.confirmPasskey) {
      this.error = 'Passkeys do not match.';
      return;
    }

    this.pending = true;
    try {
      await createPasskey(this.passkey);
      this.reset();
      this.dispatchEvent(new CustomEvent('passkey-created', { bubbles: true, composed: true }));
    } catch {
      this.error = 'Could not create passkey.';
    } finally {
      this.pending = false;
    }
  }

  private async handleUnlockSubmit(event: Event): Promise<void> {
    event.preventDefault();
    this.pending = true;

    try {
      const ok = await unlock(this.passkey);
      if (ok) {
        this.reset();
        this.dispatchEvent(new CustomEvent('passkey-unlocked', { bubbles: true, composed: true }));
      } else {
        this.error = 'Incorrect passkey.';
      }
    } catch {
      this.error = 'Could not unlock vault.';
    } finally {
      this.pending = false;
    }
  }

  private handleForgotClick(): void {
    this.mode = 'forgot';
    this.reset();
  }

  private handleForgotCancel(): void {
    this.mode = 'unlock';
    this.reset();
  }

  private async handleForgotConfirm(): Promise<void> {
    this.pending = true;
    try {
      await forgetPasskey();
      this.reset();
      this.dispatchEvent(new CustomEvent('passkey-forgotten', { bubbles: true, composed: true }));
    } catch {
      this.error = 'Could not forget passkey.';
    } finally {
      this.pending = false;
    }
  }

  private renderCreate(): TemplateResult {
    return html`
      <h2>Create passkey</h2>
      <p>Choose a passkey to protect saved connection secrets.</p>
      <form @submit=${this.handleCreateSubmit}>
        <label for="passkey-input">Passkey</label>
        <input
          id="passkey-input"
          type="password"
          .value=${this.passkey}
          @input=${this.handlePasskeyInput}
          minlength="8"
          required
          autocomplete="new-password"
        />

        <label for="confirm-passkey-input">Confirm passkey</label>
        <input
          id="confirm-passkey-input"
          type="password"
          .value=${this.confirmPasskey}
          @input=${this.handleConfirmInput}
          required
          autocomplete="new-password"
        />

        ${this.error ? html`<p class="error">${this.error}</p>` : ''}

        <div class="actions">
          <button type="button" class="secondary" @click=${this.close}>Cancel</button>
          <button
            type="submit"
            class="primary"
            ?disabled=${this.pending}
          >
            Create Passkey
          </button>
        </div>
      </form>
    `;
  }

  private renderUnlock(): TemplateResult {
    return html`
      <h2>Unlock vault</h2>
      <form @submit=${this.handleUnlockSubmit}>
        <label for="passkey-input">Passkey</label>
        <input
          id="passkey-input"
          type="password"
          .value=${this.passkey}
          @input=${this.handlePasskeyInput}
          required
          autocomplete="current-password"
        />

        ${this.error ? html`<p class="error">${this.error}</p>` : ''}

        <p>
          <button type="button" class="link" @click=${this.handleForgotClick}>
            Forgot passkey?
          </button>
        </p>

        <div class="actions">
          <button type="button" class="secondary" @click=${this.close}>Cancel</button>
          <button
            type="submit"
            class="primary"
            ?disabled=${this.pending}
          >
            Unlock
          </button>
        </div>
      </form>
    `;
  }

  private renderForgot(): TemplateResult {
    return html`
      <h2>Forget passkey?</h2>
      <p>
        Forgetting your passkey will delete all saved connection secrets.
        Connection records will remain.
      </p>

      ${this.error ? html`<p class="error">${this.error}</p>` : ''}

      <div class="forgot-actions">
        <button type="button" class="secondary" @click=${this.handleForgotCancel}>
          Cancel
        </button>
        <button
          type="button"
          class="danger"
          ?disabled=${this.pending}
          @click=${this.handleForgotConfirm}
        >
          Delete all saved secrets
        </button>
      </div>
    `;
  }

  private renderContent(): TemplateResult {
    switch (this.mode) {
      case 'create':
        return this.renderCreate();
      case 'unlock':
        return this.renderUnlock();
      case 'forgot':
        return this.renderForgot();
      default:
        return this.renderCreate();
    }
  }

  render(): TemplateResult {
    if (!this.open) {
      return html``;
    }

    return html`
      <div
        class="passkey-modal"
        @click=${this.handleOverlayClick}
        @keydown=${this.handleKeydown}
      >
        <div class="panel" role="dialog" aria-modal="true" aria-label="Passkey">
          ${this.renderContent()}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'passkey-modal': PasskeyModal;
  }
}
