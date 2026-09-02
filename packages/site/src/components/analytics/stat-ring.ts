import { css, html, LitElement, svg } from 'lit';
import { customElement, property } from 'lit/decorators.js';

const RING_SIZE = 76;
const STROKE_WIDTH = 8;
const RADIUS = (RING_SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Clamps a ring fraction into [0, 100] so an out-of-range `percent` never
 * produces a dasharray offset outside the circle's circumference. */
function clampPercent(percent: number): number {
  if (Number.isNaN(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

/**
 * SVG ring gauge: an animated arc with a centered text label, plus a side
 * label, description, and sample-size line.
 */
@customElement('stat-ring')
export class StatRing extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .stat-ring {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .ring-track {
      stroke: var(--rd-border-2, #232936);
    }

    .ring-arc {
      stroke: var(--rd-accent, #4f8cff);
      stroke-linecap: round;
      transition: stroke-dashoffset 0.6s ease;
    }

    .center-text {
      font-size: 15px;
      font-weight: 700;
      fill: var(--rd-ink-primary, #e6e9ef);
      font-variant-numeric: tabular-nums;
      text-anchor: middle;
      dominant-baseline: central;
    }

    .side {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .label {
      font-size: 13px;
      font-weight: 600;
      color: var(--rd-ink-primary, #e6e9ef);
    }

    .description {
      font-size: 12px;
      color: var(--rd-ink-muted, #9aa4b2);
    }

    .caption {
      font-size: 12px;
      color: var(--rd-ink-faint, #7d8794);
    }
  `;

  @property({ type: Number }) percent = 0;

  @property({ type: String }) centerText = '';

  @property({ type: String }) label = '';

  @property({ type: String }) description = '';

  @property({ type: String }) sampleLabel = '';

  private renderRing() {
    const clamped = clampPercent(this.percent);
    const offset = CIRCUMFERENCE * (1 - clamped / 100);
    const center = RING_SIZE / 2;

    return svg`
      <svg width=${RING_SIZE} height=${RING_SIZE} viewBox="0 0 ${RING_SIZE} ${RING_SIZE}" aria-hidden="true">
        <circle class="ring-track" cx=${center} cy=${center} r=${RADIUS} fill="none" stroke-width=${STROKE_WIDTH} />
        <circle
          class="ring-arc"
          cx=${center}
          cy=${center}
          r=${RADIUS}
          fill="none"
          stroke-width=${STROKE_WIDTH}
          stroke-dasharray=${CIRCUMFERENCE}
          stroke-dashoffset=${offset}
          transform="rotate(-90 ${center} ${center})"
        />
        <text class="center-text" x=${center} y=${center}>${this.centerText}</text>
      </svg>
    `;
  }

  render() {
    return html`
      <div class="stat-ring">
        ${this.renderRing()}
        <div class="side">
          ${this.label ? html`<div class="label">${this.label}</div>` : null}
          ${this.description ? html`<div class="description">${this.description}</div>` : null}
          ${this.sampleLabel ? html`<div class="caption">${this.sampleLabel}</div>` : null}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'stat-ring': StatRing;
  }
}
