import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { inkTokens, rampStep, rampTokens, surfaceTokens } from '../../styles/tokens';
import type { ChartSeries, HeatmapCellKind } from './chart-types';
import { classifyHeatmapCell, formatChartValue } from './chart-types';

interface HeatmapCell {
  key: string;
  x: string;
  y: string;
  value: number | null;
  kind: HeatmapCellKind;
  /** Value normalized against the series max, precomputed once per render
   * (rather than re-derived per cell) so `cellStyle` stays O(1) per cell. */
  fraction: number;
}

function sortedUnique(items: string[]): string[] {
  return [...new Set(items)].sort((a, b) => a.localeCompare(b));
}

function maxOf(values: readonly (number | null)[]): number {
  const present = values.filter((v): v is number => v !== null);
  return present.length > 0 ? Math.max(...present) : 0;
}

/**
 * DOM-rendered heatmap grid — deliberately not an ECharts series. The
 * missing-vs-zero distinction (`.agents/rules/missing-is-never-zero.md`)
 * needs a DOM-assertable `data-missing` attribute per cell, and ECharts'
 * built-in heatmap series has no supported way to stamp custom attributes
 * onto individual cell shapes. This component owns cell layout directly,
 * the same rationale as `sparkline.ts` owning its own SVG geometry.
 */
@customElement('rd-heatmap-grid')
export class HeatmapGrid extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .rd-heatmap-grid {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .grid-scroll {
      overflow-x: auto;
    }

    .grid {
      display: grid;
      gap: 3px;
      width: max-content;
    }

    .row-label,
    .col-label {
      font-size: 11px;
      color: var(--rd-ink-faint, #7d8794);
      display: flex;
      align-items: center;
      padding: 0 4px;
      white-space: nowrap;
    }

    .col-label {
      justify-content: center;
    }

    .cell {
      width: 32px;
      height: 24px;
      border-radius: 3px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-variant-numeric: tabular-nums;
      box-sizing: border-box;
    }

    .cell[data-missing='true'] {
      border: 1px dashed var(--rd-border-3, #2a303c);
      background: var(--rd-surface-inset, #12151c);
      color: var(--rd-ink-faint, #7d8794);
    }

    .legend {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      color: var(--rd-ink-faint, #7d8794);
    }

    .ramp {
      height: 8px;
      width: 120px;
      border-radius: 4px;
    }

    .rd-heatmap-grid:focus-visible {
      outline: 2px solid var(--md-sys-color-primary, #4f8cff);
      outline-offset: 2px;
      border-radius: 8px;
    }

    .empty {
      font-size: 13px;
      color: var(--rd-ink-muted, #9aa4b2);
    }
  `;

  @property({ type: Object, attribute: false }) series: ChartSeries | null = null;

  /** Textual summary announced to assistive tech, passed through from
   * `echarts-base`'s `ariaDescription` (itself `analytics-chart`'s
   * `textualSummary(series, state)`). */
  @property({ type: String }) ariaDescription = '';

  private get rows(): string[] {
    if (!this.series) return [];
    const label = this.series.label;
    return sortedUnique(this.series.buckets.map((b) => b.series ?? label));
  }

  private get columns(): string[] {
    if (!this.series) return [];
    return sortedUnique(this.series.buckets.map((b) => String(b.x)));
  }

  private get maxValue(): number {
    return this.series ? maxOf(this.series.buckets.map((b) => b.y)) : 0;
  }

  private get cellsByRow(): Map<string, HeatmapCell[]> {
    const cellsByRow = new Map<string, HeatmapCell[]>();
    if (!this.series) return cellsByRow;
    const label = this.series.label;
    const max = this.maxValue;
    const byKey = new Map(
      this.series.buckets.map((b) => [`${String(b.x)}::${b.series ?? label}`, b.y]),
    );

    for (const y of this.rows) {
      const cells = this.columns.map((x) => {
        const value = byKey.get(`${x}::${y}`) ?? null;
        const fraction = value !== null && max > 0 ? value / max : 0;
        return { key: `${x}::${y}`, x, y, value, kind: classifyHeatmapCell(value, max), fraction };
      });
      cellsByRow.set(y, cells);
    }
    return cellsByRow;
  }

  private cellStyle(cell: HeatmapCell): string {
    if (cell.kind === 'missing') return '';
    const background = rampStep(cell.fraction);
    const ink = cell.kind === 'high' ? surfaceTokens.surfacePage : inkTokens.inkSecondary;
    return `background:${background};color:${ink};`;
  }

  private renderCell(cell: HeatmapCell) {
    const isMissing = cell.kind === 'missing';
    return html`
      <div
        class="cell"
        style=${this.cellStyle(cell)}
        data-missing=${isMissing ? 'true' : 'false'}
        title="${cell.y} · ${cell.x}: ${formatChartValue(cell.value, this.series?.unit)}"
      >
        ${isMissing ? '—' : formatChartValue(cell.value, this.series?.unit)}
      </div>
    `;
  }

  private renderLegend() {
    const gradient = [...rampTokens].join(', ');
    return html`
      <div class="legend" aria-hidden="true">
        <span>0</span>
        <span class="ramp" style="background: linear-gradient(to right, ${gradient});"></span>
        <span>${formatChartValue(this.maxValue, this.series?.unit)}</span>
      </div>
    `;
  }

  private renderGrid() {
    const rows = this.rows;
    const columns = this.columns;
    const cellsByRow = this.cellsByRow;

    return html`
      <div class="grid-scroll">
        <div class="grid" style="grid-template-columns: max-content repeat(${columns.length}, 32px);">
          <div></div>
          ${repeat(
            columns,
            (x) => x,
            (x) => html`<div class="col-label">${x}</div>`,
          )}
          ${repeat(
            rows,
            (y) => y,
            (y) => html`
              <div class="row-label">${y}</div>
              ${repeat(
                cellsByRow.get(y) ?? [],
                (cell) => cell.key,
                (cell) => this.renderCell(cell),
              )}
            `,
          )}
        </div>
      </div>
      ${this.renderLegend()}
    `;
  }

  render() {
    const hasData = this.rows.length > 0 && this.columns.length > 0;
    return html`
      <div
        class="rd-heatmap-grid"
        role="img"
        tabindex="0"
        aria-label=${this.ariaDescription || 'Heatmap'}
      >
        ${hasData ? this.renderGrid() : html`<p class="empty">No data</p>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'rd-heatmap-grid': HeatmapGrid;
  }
}
