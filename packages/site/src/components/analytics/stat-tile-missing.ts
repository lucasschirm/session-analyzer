import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { cardSurfaceStyles } from './card-surface-styles';

/**
 * Renders a missing metric. This is the ONLY way a missing metric may be
 * rendered anywhere in the dashboard — never as `0`. See
 * `.agents/rules/missing-is-never-zero.md`. Always dashed-bordered, always
 * shows an em-dash, the caller-supplied `reason`, and the fixed policy line.
 */
@customElement('stat-tile-missing')
export class StatTileMissing extends LitElement {
  static styles = [
    cardSurfaceStyles,
    css`
    .card-surface.stat-tile-missing {
      background: var(--rd-surface-inset, #12151c);
      border-style: dashed;
      border-color: var(--rd-border-3, #2a303c);
      gap: 6px;
    }

    .label-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .label {
      font-size: 12px;
      font-weight: 600;
      color: var(--rd-ink-muted, #9aa4b2);
    }

    .info-icon {
      flex-shrink: 0;
      color: var(--rd-ink-faint, #7d8794);
    }

    .value {
      font-size: 34px;
      font-weight: 700;
      color: var(--rd-ink-faint, #7d8794);
      line-height: 1.1;
    }

    .reason {
      font-size: 12px;
      color: var(--rd-ink-secondary, #c9d4e3);
    }

    .policy {
      font-size: 12px;
      color: var(--rd-ink-faint, #7d8794);
    }
  `,
  ];

  @property({ type: String }) label = '';

  @property({ type: String }) reason = '';

  private renderInfoIcon() {
    return html`
      <svg class="info-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <circle cx="6" cy="6" r="5.25" fill="none" stroke="currentColor" stroke-width="1.2" />
        <line x1="6" y1="5.25" x2="6" y2="8.75" stroke="currentColor" stroke-width="1.2" />
        <circle cx="6" cy="3.25" r="0.75" fill="currentColor" />
      </svg>
    `;
  }

  render() {
    return html`
      <div class="card-surface stat-tile-missing">
        <div class="label-row">
          <span class="label">${this.label}</span>
          ${this.renderInfoIcon()}
        </div>
        <div class="value" aria-label="missing">—</div>
        ${this.reason ? html`<div class="reason">${this.reason}</div>` : null}
        <div class="policy">Never estimated · shown only when native</div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'stat-tile-missing': StatTileMissing;
  }
}
