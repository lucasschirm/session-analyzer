import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';

/**
 * Dashboard metrics card.
 *
 * Displays a single indicator (value, label, optional sub-detail). When
 * `clickable` is set it renders as a native button and dispatches
 * `card-click` so the dashboard can route to the Indicator Details page.
 */
@customElement('metrics-card')
export class MetricsCard extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .metrics-card {
      width: 100%;
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 12px;
      padding: 16px;
      display: flex;
      align-items: center;
      gap: 12px;
      color: inherit;
      font: inherit;
      text-align: left;
    }

    button.metrics-card {
      cursor: pointer;
      transition: background-color 0.15s ease, border-color 0.15s ease;
    }

    button.metrics-card:hover {
      background: var(--md-sys-color-surface-container-hover, #262d3a);
      border-color: var(--md-sys-color-primary, #4f8cff);
    }

    button.metrics-card:focus-visible {
      outline: 2px solid var(--md-sys-color-primary, #4f8cff);
      outline-offset: 2px;
    }

    .icon {
      font-size: 22px;
      width: 42px;
      height: 42px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--md-sys-color-primary-container, #1c2b4a);
      border-radius: 10px;
    }

    .content {
      flex: 1;
      min-width: 0;
    }

    .value {
      font-size: 24px;
      font-weight: 700;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      line-height: 1.2;
    }

    .label {
      font-size: 13px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      margin-top: 2px;
    }

    .sub {
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      opacity: 0.8;
      margin-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;

  @property({ type: String }) label = '';

  @property({ type: String }) value = '';

  /** Full/exact value shown as a hover tooltip - for compactly-formatted numbers (e.g. "1.4M"). */
  @property({ type: String }) valueTitle = '';

  @property({ type: String }) icon = '';

  @property({ type: String }) sub = '';

  @property({ type: Boolean }) clickable = false;

  private handleClick(): void {
    this.dispatchEvent(
      new CustomEvent('card-click', {
        detail: { label: this.label },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private renderContent() {
    return html`
      <div class="icon" aria-hidden="true">${this.icon}</div>
      <div class="content">
        <div class="value" title=${ifDefined(this.valueTitle || undefined)}>${this.value}</div>
        <div class="label">${this.label}</div>
        ${this.sub ? html`<div class="sub">${this.sub}</div>` : ''}
      </div>
    `;
  }

  render() {
    if (this.clickable) {
      return html`
        <button
          class="metrics-card"
          type="button"
          @click=${this.handleClick}
        >
          ${this.renderContent()}
        </button>
      `;
    }

    return html`<div class="metrics-card">${this.renderContent()}</div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'metrics-card': MetricsCard;
  }
}
