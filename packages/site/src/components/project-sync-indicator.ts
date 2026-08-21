import { css, html, LitElement, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/**
 * Small spinner indicator for a project that is currently syncing.
 *
 * Clicking the indicator emits `indicator-click` so the parent can open the
 * project sync status modal.
 */
@customElement('project-sync-indicator')
export class ProjectSyncIndicator extends LitElement {
  static styles = css`
    :host {
      display: inline-flex;
    }

    .indicator {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-primary, #4f8cff);
      font-size: 12px;
      cursor: pointer;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      animation: spin 1.2s linear infinite;
    }

    .indicator:hover {
      background: var(--md-sys-color-surface-container-hover, #262d3a);
    }

    @keyframes spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }
  `;

  @property({ type: Boolean }) active = true;

  private handleClick(): void {
    this.dispatchEvent(new CustomEvent('indicator-click', { bubbles: true, composed: true }));
  }

  render(): TemplateResult {
    if (!this.active) return html``;

    return html`
      <span class="indicator" title="Syncing…" @click=${this.handleClick}>⠋</span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'project-sync-indicator': ProjectSyncIndicator;
  }
}
