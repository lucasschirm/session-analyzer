import { LitElement, html, css } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';

/**
 * New Project modal.
 *
 * Input component: `open` controls visibility; submitting emits
 * `project-create` with `{ name, description }`. The parent owns persistence
 * and closing the modal. Emits `modal-close` when dismissed.
 */
@customElement('project-modal')
export class ProjectModal extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }

    .project-modal {
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

    label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      margin-bottom: 6px;
    }

    input,
    textarea {
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

    input:focus-visible,
    textarea:focus-visible {
      outline: 2px solid var(--md-sys-color-primary, #4f8cff);
      outline-offset: 1px;
    }

    textarea {
      resize: vertical;
      min-height: 64px;
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

  @state() private name = '';

  @state() private description = '';

  @query('#project-name-input') private nameInput!: HTMLInputElement;

  updated(changed: Map<string, unknown>): void {
    if (changed.has('open') && this.open) {
      this.name = '';
      this.description = '';
      this.updateComplete.then(() => this.nameInput?.focus());
    }
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

  private handleSubmit(event: Event): void {
    event.preventDefault();
    const name = this.name.trim();
    if (!name) return;

    this.dispatchEvent(
      new CustomEvent('project-create', {
        detail: { name, description: this.description.trim() },
        bubbles: true,
        composed: true,
      })
    );
  }

  private close(): void {
    this.dispatchEvent(
      new CustomEvent('modal-close', { bubbles: true, composed: true })
    );
  }

  render() {
    if (!this.open) return html``;

    return html`
      <div
        class="project-modal"
        @click=${this.handleOverlayClick}
        @keydown=${this.handleKeydown}
      >
        <div class="panel" role="dialog" aria-modal="true" aria-label="New project">
          <h2>New Project</h2>
          <form @submit=${this.handleSubmit}>
            <label for="project-name-input">Project name</label>
            <input
              id="project-name-input"
              type="text"
              .value=${this.name}
              placeholder="e.g. session-analyzer"
              required
              @input=${(event: Event) => {
                this.name = (event.target as HTMLInputElement).value;
              }}
            />

            <label for="project-description-input">Description (optional)</label>
            <textarea
              id="project-description-input"
              .value=${this.description}
              placeholder="What is this project about?"
              @input=${(event: Event) => {
                this.description = (event.target as HTMLTextAreaElement).value;
              }}
            ></textarea>

            <div class="actions">
              <button type="button" class="secondary" @click=${this.close}>Cancel</button>
              <button
                type="submit"
                class="primary"
                ?disabled=${this.name.trim().length === 0}
              >
                Create Project
              </button>
            </div>
          </form>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'project-modal': ProjectModal;
  }
}
