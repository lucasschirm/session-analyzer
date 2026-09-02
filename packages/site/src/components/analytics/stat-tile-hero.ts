import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import '../charts/sparkline';
import type { CardClickDetail, StatDelta } from './analytics-card-types';
import { cardSurfaceStyles } from './card-surface-styles';
import { deltaChipStyles, renderDeltaChip } from './delta-chip';

/**
 * Hero stat tile: uppercase label, large display value, delta chip, an
 * inline sparkline (via the shared `rd-sparkline`), and a footnote line.
 * Used for the top KPI band on the Portfolio view.
 */
@customElement('stat-tile-hero')
export class StatTileHero extends LitElement {
  static styles = [
    cardSurfaceStyles,
    deltaChipStyles,
    css`
      .card-surface.accent {
        background: linear-gradient(
          160deg,
          var(--rd-accent-container, #1c2b4a),
          var(--rd-surface-card, #171b24)
        );
      }

      .label {
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
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

      .spark {
        margin-top: 2px;
      }

      .footnote {
        font-size: 12px;
        color: var(--rd-ink-faint, #7d8794);
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

  @property({ type: Array, attribute: false }) sparklinePoints: number[] = [];

  @property({ type: String }) footnote = '';

  @property({ type: String }) sampleLabel = '';

  @property({ type: Boolean }) accent = false;

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

  private renderContent() {
    return html`
      <div class="label">${this.label}</div>
      <div class="value-row">
        <span class="value">${this.value}</span>
        ${renderDeltaChip(this.delta)}
      </div>
      <rd-sparkline
        class="spark"
        .points=${this.sparklinePoints}
        height="34"
        area
      ></rd-sparkline>
      ${this.footnote ? html`<div class="footnote">${this.footnote}</div>` : null}
      ${this.sampleLabel ? html`<div class="caption">${this.sampleLabel}</div>` : null}
    `;
  }

  render() {
    const classes = classMap({ 'card-surface': true, 'stat-tile-hero': true, accent: this.accent });

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
    'stat-tile-hero': StatTileHero;
  }
}
