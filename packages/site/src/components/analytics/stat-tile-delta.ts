import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { styleMap } from 'lit/directives/style-map.js';
import type { CardClickDetail, StatBreakdownItem, StatDelta } from './analytics-card-types';
import { cardSurfaceStyles } from './card-surface-styles';
import { deltaChipStyles, renderDeltaChip } from './delta-chip';

/**
 * Stat tile with a value, a delta pill, and an optional sub-breakdown row
 * (colored-square legend + values), e.g. pass/fail counts under a total.
 */
@customElement('stat-tile-delta')
export class StatTileDelta extends LitElement {
  static styles = [
    cardSurfaceStyles,
    deltaChipStyles,
    css`
      .label {
        font-size: 12px;
        font-weight: 600;
        color: var(--rd-ink-muted, #9aa4b2);
      }

      .value-row {
        display: flex;
        align-items: baseline;
        gap: 8px;
        flex-wrap: wrap;
      }

      .value {
        font-size: 34px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--rd-ink-primary, #e6e9ef);
        line-height: 1.1;
      }

      .breakdown {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-top: 4px;
      }

      .breakdown-row {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--rd-ink-secondary, #c9d4e3);
      }

      .swatch {
        width: 8px;
        height: 8px;
        border-radius: 2px;
        flex-shrink: 0;
      }

      .breakdown-value {
        margin-left: auto;
        font-variant-numeric: tabular-nums;
        color: var(--rd-ink-primary, #e6e9ef);
      }

      .caption {
        font-size: 12px;
        color: var(--rd-ink-muted, #9aa4b2);
      }
    `,
  ];

  @property({ type: String }) label = '';

  @property({ type: String }) value = '';

  @property({ type: Object, attribute: false }) delta?: StatDelta;

  @property({ type: Array, attribute: false }) breakdown: StatBreakdownItem[] = [];

  @property({ type: String }) sampleLabel = '';

  @property({ type: Boolean }) clickable = false;

  private handleClick(): void {
    this.dispatchEvent(
      new CustomEvent<CardClickDetail>('card-click', {
        detail: { label: this.label },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private renderBreakdownRow(item: StatBreakdownItem) {
    return html`
      <div class="breakdown-row">
        <span class="swatch" style=${styleMap({ background: item.color })}></span>
        <span>${item.label}</span>
        <span class="breakdown-value">${item.value}</span>
      </div>
    `;
  }

  private renderBreakdown() {
    if (this.breakdown.length === 0) return null;
    return html`
      <div class="breakdown">
        ${repeat(
          this.breakdown,
          (item) => item.label,
          (item) => this.renderBreakdownRow(item),
        )}
      </div>
    `;
  }

  private renderContent() {
    return html`
      <div class="label">${this.label}</div>
      <div class="value-row">
        <span class="value">${this.value}</span>
        ${renderDeltaChip(this.delta)}
      </div>
      ${this.renderBreakdown()}
      ${this.sampleLabel ? html`<div class="caption">${this.sampleLabel}</div>` : null}
    `;
  }

  render() {
    if (this.clickable) {
      return html`
        <button class="card-surface stat-tile-delta" type="button" @click=${this.handleClick}>
          ${this.renderContent()}
        </button>
      `;
    }

    return html`<div class="card-surface stat-tile-delta">${this.renderContent()}</div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'stat-tile-delta': StatTileDelta;
  }
}
