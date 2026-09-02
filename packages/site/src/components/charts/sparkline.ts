import { css, html, LitElement, svg } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** Line + optional area path geometry for a sparkline SVG, in viewBox units. */
export interface SparklineGeometry {
  linePath: string;
  areaPath: string;
}

/**
 * Builds the SVG path data for a sparkline. Pure and presentation-only: it
 * places already-computed values, it does not derive them.
 *
 * - Empty input -> `null` (nothing to render, never a NaN-laden path).
 * - A single point -> a flat horizontal line at that value's height.
 * - 2+ points -> a polyline scaled to fill the viewBox, with an optional
 *   closed area path down to the baseline.
 */
export function buildSparklineGeometry(
  points: readonly number[],
  width: number,
  height: number,
): SparklineGeometry | null {
  if (points.length === 0) return null;
  if (points.length === 1) return flatLineGeometry(width, height);

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min;
  const step = width / (points.length - 1);

  const coords = points.map((value, index) => {
    const x = index * step;
    const y = range === 0 ? height / 2 : height - ((value - min) / range) * height;
    return [x, y] as const;
  });

  const linePath = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
  const [firstX] = coords[0] as [number, number];
  const [lastX] = coords[coords.length - 1] as [number, number];
  const areaPath = `${linePath} L${lastX},${height} L${firstX},${height} Z`;

  return { linePath, areaPath };
}

function flatLineGeometry(width: number, height: number): SparklineGeometry {
  const y = height / 2;
  const linePath = `M0,${y} L${width},${y}`;
  const areaPath = `${linePath} L${width},${height} L0,${height} Z`;
  return { linePath, areaPath };
}

/**
 * Lightweight inline-SVG sparkline. Shared by `stat-tile-hero`, the chart
 * layer, and leaderboard rows — do not fork a second implementation.
 */
@customElement('rd-sparkline')
export class Sparkline extends LitElement {
  static styles = css`
    :host {
      display: inline-block;
      line-height: 0;
    }

    svg {
      display: block;
    }

    .line {
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .area {
      stroke: none;
    }
  `;

  @property({ type: Array, attribute: false }) points: number[] = [];

  @property({ type: Number }) width = 120;

  @property({ type: Number }) height = 34;

  @property({ type: Number }) strokeWidth = 2;

  @property({ type: Boolean }) area = false;

  @property({ type: String }) color = 'var(--rd-accent, #4f8cff)';

  private renderArea(geometry: SparklineGeometry) {
    if (!this.area) return null;
    return svg`<path class="area" d=${geometry.areaPath} fill=${this.color} opacity="0.16" />`;
  }

  render() {
    const geometry = buildSparklineGeometry(this.points, this.width, this.height);
    if (!geometry) return html``;

    return html`
      <svg
        width=${this.width}
        height=${this.height}
        viewBox="0 0 ${this.width} ${this.height}"
        aria-hidden="true"
      >
        ${this.renderArea(geometry)}
        <path
          class="line"
          d=${geometry.linePath}
          stroke=${this.color}
          stroke-width=${this.strokeWidth}
        />
      </svg>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'rd-sparkline': Sparkline;
  }
}
