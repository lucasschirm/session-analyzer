import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import type { StatStripItem } from './analytics-card-types';

/**
 * Hairline-separated horizontal strip of compact stats, used on
 * drill-down pages. Items are data (`StatStripItem[]`), rendered with
 * `repeat()` keyed by label.
 */
@customElement('stat-strip')
export class StatStrip extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .stat-strip {
      display: flex;
      background: var(--rd-surface-card, #171b24);
      border: 1px solid var(--rd-border-2, #232936);
      border-radius: 14px;
      overflow: hidden;
    }

    .item {
      flex: 1;
      min-width: 0;
      padding: 14px 16px;
      border-left: 1px solid var(--rd-border-1, #20242e);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .item:first-child {
      border-left: none;
    }

    .value {
      font-size: 26px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      color: var(--rd-ink-primary, #e6e9ef);
      line-height: 1.1;
    }

    .label {
      font-size: 12px;
      color: var(--rd-ink-muted, #9aa4b2);
    }

    .caption {
      font-size: 11px;
      color: var(--rd-ink-faint, #7d8794);
    }
  `;

  @property({ type: Array, attribute: false }) items: StatStripItem[] = [];

  private renderItem(item: StatStripItem) {
    return html`
      <div class="item">
        <div class="value">${item.value}</div>
        <div class="label">${item.label}</div>
        ${item.sampleLabel ? html`<div class="caption">${item.sampleLabel}</div>` : null}
      </div>
    `;
  }

  render() {
    return html`
      <div class="stat-strip">
        ${repeat(
          this.items,
          (item) => item.label,
          (item) => this.renderItem(item),
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'stat-strip': StatStrip;
  }
}
