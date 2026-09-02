import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import './time-range-switch';
import './dimension-chip';
import {
  detectRangeSelection,
  type PortfolioParams,
  type RangePreset,
  resolveRangePreset,
  type SessionsScope,
} from '../../pages/portfolio/portfolio-params';

type StringFilterKey =
  | 'project'
  | 'harness'
  | 'model'
  | 'component'
  | 'search'
  | 'mode'
  | 'analysisRelease'
  | 'comparabilityGroup'
  | 'generation';

/**
 * Global filter bar (issue #167): dimension chips (Project/Harness/Model)
 * + the time-range segmented control + the sessions-scope control, with
 * the remaining legacy query params tucked behind a collapsed-by-default
 * "Advanced" disclosure.
 *
 * Input component: receives the whole `filters` object as a property and
 * emits `filters-changed` with the entire updated object — it never
 * mutates the passed-in object (`.agents/rules/frontend-coding-style.md`).
 */
@customElement('filter-bar')
export class FilterBar extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .filter-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      padding: 14px 16px;
      background: var(--rd-surface-card, #171b24);
      border: 1px solid var(--rd-border-2, #232936);
      border-radius: 14px;
    }

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      flex: 1 1 auto;
    }

    .sessions-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--rd-ink-muted, #9aa4b2);
    }

    .sessions-label select {
      font: inherit;
      font-size: 13px;
      color: var(--rd-ink-primary, #e6e9ef);
      background: var(--rd-surface-inset, #12151c);
      border: 1px solid var(--rd-border-2, #232936);
      border-radius: 8px;
      padding: 7px 10px;
    }

    .range-slot {
      margin-left: auto;
    }

    details.advanced {
      flex-basis: 100%;
    }

    details.advanced summary {
      cursor: pointer;
      font-size: 12px;
      color: var(--rd-ink-muted, #9aa4b2);
      user-select: none;
    }

    .advanced-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 10px;
    }

    .advanced-grid label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 11px;
      color: var(--rd-ink-faint, #7d8794);
      min-width: 130px;
    }

    .advanced-grid input,
    .advanced-grid select {
      font: inherit;
      font-size: 13px;
      color: var(--rd-ink-primary, #e6e9ef);
      background: var(--rd-surface-inset, #12151c);
      border: 1px solid var(--rd-border-2, #232936);
      border-radius: 6px;
      padding: 6px 8px;
    }

    button.reset {
      background: transparent;
      color: var(--rd-accent, #4f8cff);
      border: 1px solid var(--rd-border-2, #232936);
      border-radius: 8px;
      padding: 7px 12px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
  `;

  @property({ type: Object }) filters: PortfolioParams = {};

  @property({ type: Array }) projectOptions: string[] = [];

  @property({ type: Array }) harnessOptions: string[] = [];

  @property({ type: Array }) modelOptions: string[] = [];

  @property({ type: Boolean }) projectFixed = false;

  @property({ type: Boolean }) harnessFixed = false;

  @property({ type: Boolean }) modelFixed = false;

  private emit(next: PortfolioParams): void {
    this.dispatchEvent(
      new CustomEvent<PortfolioParams>('filters-changed', {
        detail: next,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private updateStringField(key: StringFilterKey, value: string): void {
    const next: PortfolioParams = { ...this.filters };
    if (value === '') {
      delete next[key];
    } else {
      next[key] = value;
    }
    this.emit(next);
  }

  private updateSessions(value: string): void {
    this.emit({ ...this.filters, sessions: value as SessionsScope });
  }

  private handleRangeChanged(event: CustomEvent<RangePreset>): void {
    const range = resolveRangePreset(event.detail);
    this.emit({ ...this.filters, timeStart: range.timeStart, timeEnd: range.timeEnd });
  }

  private resetFilters(): void {
    this.emit({ sessions: 'main' });
  }

  private renderChip(
    label: string,
    key: 'project' | 'harness' | 'model',
    options: string[],
    fixed: boolean,
  ) {
    return html`
      <dimension-chip
        label=${label}
        value=${this.filters[key] ?? ''}
        .options=${options}
        ?fixed=${fixed}
        @value-changed=${(e: CustomEvent<string>) => this.updateStringField(key, e.detail)}
      ></dimension-chip>
    `;
  }

  private renderSessionsControl() {
    return html`
      <label class="sessions-label">
        Sessions
        <select
          .value=${this.filters.sessions ?? 'main'}
          @change=${(e: Event) => this.updateSessions((e.target as HTMLSelectElement).value)}
        >
          <option value="main">Main</option>
          <option value="all">All</option>
          <option value="sub_agents">Sub Agents</option>
        </select>
      </label>
    `;
  }

  private renderAdvanced() {
    const f = this.filters;
    const set = (key: StringFilterKey) => (e: Event) =>
      this.updateStringField(key, (e.target as HTMLInputElement | HTMLSelectElement).value);
    return html`
      <details class="advanced">
        <summary>Advanced</summary>
        <div class="advanced-grid">
          <label>Mode
            <select .value=${f.mode ?? ''} @change=${set('mode')}>
              <option value="">All</option>
              <option value="auto">Auto</option>
              <option value="plan">Plan</option>
            </select>
          </label>
          <label>Component<input type="text" .value=${f.component ?? ''} @change=${set('component')} /></label>
          <label>Search<input type="text" .value=${f.search ?? ''} @change=${set('search')} /></label>
          <label>Analysis release<input type="text" .value=${f.analysisRelease ?? ''} @change=${set('analysisRelease')} /></label>
          <label>Comparability group<input type="text" .value=${f.comparabilityGroup ?? ''} @change=${set('comparabilityGroup')} /></label>
          <label>Generation<input type="text" .value=${f.generation ?? ''} @change=${set('generation')} /></label>
        </div>
      </details>
    `;
  }

  render() {
    const rangeSelection = detectRangeSelection(this.filters);
    return html`
      <div class="filter-bar">
        <div class="chips">
          ${this.renderChip('Project', 'project', this.projectOptions, this.projectFixed)}
          ${this.renderChip('Harness', 'harness', this.harnessOptions, this.harnessFixed)}
          ${this.renderChip('Model', 'model', this.modelOptions, this.modelFixed)}
          ${this.renderSessionsControl()}
        </div>
        <div class="range-slot">
          <time-range-switch
            .selection=${rangeSelection}
            @range-changed=${this.handleRangeChanged}
          ></time-range-switch>
        </div>
        <button class="reset" type="button" @click=${this.resetFilters}>Reset</button>
        ${this.renderAdvanced()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'filter-bar': FilterBar;
  }
}
