import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

/**
 * Dimension filter chip (issue #167) — Project/Harness/Model. Shows
 * `label: value` (or `label: All` when unset) with a chevron; the chip
 * itself is a native `<select>` styled to read as a chip, which gives
 * keyboard/screen-reader behavior for free (precedent: `project-selector.ts`).
 *
 * Input component: receives `value` + `options` as properties and emits
 * `value-changed` with the newly selected value (`''` means "All" /
 * cleared) — it never mutates a passed-in array or object.
 *
 * `fixed` renders a locked, non-interactive chip showing `value` without a
 * `<select>` — used by the project drill-down page to pin the Project chip.
 */
@customElement('dimension-chip')
export class DimensionChip extends LitElement {
  static styles = css`
    :host {
      display: inline-block;
    }

    .dimension-chip {
      position: relative;
      display: inline-flex;
    }

    select {
      appearance: none;
      font: inherit;
      font-size: 13px;
      color: var(--rd-ink-primary, #e6e9ef);
      background: var(--rd-surface-inset, #12151c);
      border: 1px solid var(--rd-border-2, #232936);
      border-radius: 999px;
      padding: 7px 28px 7px 12px;
      cursor: pointer;
      max-width: 220px;
      text-overflow: ellipsis;
    }

    select:hover {
      border-color: var(--rd-border-emphasis, #313947);
    }

    select:focus-visible {
      outline: 2px solid var(--rd-accent, #4f8cff);
      outline-offset: 1px;
    }

    .chevron {
      pointer-events: none;
      position: absolute;
      right: 10px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--rd-ink-muted, #9aa4b2);
      font-size: 10px;
    }

    .fixed-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 13px;
      color: var(--rd-ink-secondary, #c9d4e3);
      background: var(--rd-accent-container, #1c2b4a);
      border: 1px solid var(--rd-border-2, #232936);
      border-radius: 999px;
      padding: 7px 12px;
    }

    .fixed-chip .lock {
      color: var(--rd-ink-faint, #7d8794);
      font-size: 11px;
    }
  `;

  @property({ type: String }) label = '';

  @property({ type: String }) value = '';

  @property({ type: Array }) options: string[] = [];

  @property({ type: Boolean }) fixed = false;

  private handleChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.dispatchEvent(
      new CustomEvent<string>('value-changed', {
        detail: target.value,
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    return this.fixed ? this.renderFixed() : this.renderSelect();
  }

  private renderFixed() {
    return html`
      <span class="dimension-chip fixed-chip" title="${this.label} is locked">
        <span class="lock" aria-hidden="true">&#128274;</span>
        ${this.label}: ${this.value || 'All'}
      </span>
    `;
  }

  private renderSelect() {
    return html`
      <span class="dimension-chip">
        <select
          aria-label=${this.label}
          .value=${this.value}
          @change=${this.handleChange}
        >
          <option value="">${this.label}: All</option>
          ${repeat(
            this.options,
            (option) => option,
            (option) => html`<option value=${option}>${this.label}: ${option}</option>`,
          )}
        </select>
        <span class="chevron" aria-hidden="true">&#9662;</span>
      </span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dimension-chip': DimensionChip;
  }
}
