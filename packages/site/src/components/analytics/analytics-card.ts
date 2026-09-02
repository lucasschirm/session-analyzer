import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import type { CardClickDetail } from './analytics-card-types';
import { cardSurfaceStyles } from './card-surface-styles';

export type AnalyticsCardVariant = 'default' | 'inset' | 'dashed';

/**
 * Shared card container for the analytics redesign: hairline surface,
 * an optional header (title + caption), and a default slot for body
 * content. Variants: `default` (card surface), `inset` (recessed
 * surface), `dashed` (missing-state border, used by `stat-tile-missing`).
 *
 * When `clickable`, the whole card renders as a native `<button>` — any
 * slotted content must be non-interactive (no nested links/buttons/inputs),
 * to avoid invalid nested-interactive markup and broken focus order.
 */
@customElement('analytics-card')
export class AnalyticsCard extends LitElement {
  static styles = [
    cardSurfaceStyles,
    css`
      .analytics-card.inset {
        background: var(--rd-surface-inset, #12151c);
      }

      .analytics-card.dashed {
        background: var(--rd-surface-inset, #12151c);
        border-style: dashed;
        border-color: var(--rd-border-3, #2a303c);
      }

      .header {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .title {
        font-size: 16px;
        font-weight: 600;
        color: var(--rd-ink-primary, #e6e9ef);
      }

      .caption {
        font-size: 12px;
        color: var(--rd-ink-muted, #9aa4b2);
      }

      .body {
        flex: 1;
        min-height: 0;
      }
    `,
  ];

  @property({ type: String }) variant: AnalyticsCardVariant = 'default';

  @property({ type: String }) cardTitle = '';

  @property({ type: String }) caption = '';

  @property({ type: Boolean }) clickable = false;

  private handleClick(): void {
    this.dispatchEvent(
      new CustomEvent<CardClickDetail>('card-click', {
        detail: { label: this.cardTitle },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private renderHeader() {
    if (!this.cardTitle && !this.caption) return null;
    return html`
      <div class="header">
        ${this.cardTitle ? html`<div class="title">${this.cardTitle}</div>` : null}
        ${this.caption ? html`<div class="caption">${this.caption}</div>` : null}
      </div>
    `;
  }

  private renderContent() {
    return html`
      ${this.renderHeader()}
      <div class="body"><slot></slot></div>
    `;
  }

  render() {
    const classes = classMap({
      'card-surface': true,
      'analytics-card': true,
      inset: this.variant === 'inset',
      dashed: this.variant === 'dashed',
    });

    if (this.clickable) {
      return html`
        <button class=${classes} type="button" @click=${this.handleClick}>
          ${this.renderContent()}
        </button>
      `;
    }

    return html`<div class=${classes}>${this.renderContent()}</div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'analytics-card': AnalyticsCard;
  }
}
