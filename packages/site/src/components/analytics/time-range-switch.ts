import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import type { RangeSelection } from '../../pages/portfolio/portfolio-params';

interface SegmentDef {
  readonly value: RangeSelection;
  readonly label: string;
}

/** `custom` is display-only — shown when an old bookmarked URL carries an
 * arbitrary range, never a segment the user can click into. */
const SEGMENTS: readonly SegmentDef[] = [
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
  { value: 'all', label: 'All' },
];

const CUSTOM_SEGMENT: SegmentDef = { value: 'custom', label: 'Custom' };

/**
 * Segmented time-range control (issue #167). Input component: receives
 * `selection` and emits `range-changed` with the newly chosen preset — it
 * never mutates its own state as the source of truth. Keyboard: arrow
 * keys move a roving tabindex across segments; Enter/Space activates the
 * focused segment.
 */
@customElement('time-range-switch')
export class TimeRangeSwitch extends LitElement {
  static styles = css`
    :host {
      display: inline-flex;
    }

    .time-range-switch {
      display: inline-flex;
      gap: 2px;
      padding: 4px;
      background: var(--rd-surface-inset, #12151c);
      border: 1px solid var(--rd-border-2, #232936);
      border-radius: 11px;
    }

    button {
      appearance: none;
      border: none;
      background: transparent;
      color: var(--rd-ink-muted, #9aa4b2);
      font: inherit;
      font-weight: 500;
      font-size: 13px;
      padding: 6px 12px;
      border-radius: 7px;
      cursor: pointer;
      transition: background 0.12s ease, color 0.12s ease;
    }

    button:hover {
      color: var(--rd-ink-primary, #e6e9ef);
    }

    button:focus-visible {
      outline: 2px solid var(--rd-accent, #4f8cff);
      outline-offset: 1px;
    }

    button[aria-selected='true'] {
      background: var(--rd-accent, #4f8cff);
      color: var(--rd-surface-page, #0c0e13);
      font-weight: 600;
    }

    button.is-custom[aria-selected='true'] {
      background: var(--rd-ink-faint, #7d8794);
    }
  `;

  @property({ type: String }) selection: RangeSelection = '30d';

  private handleClick(value: RangeSelection): void {
    this.emitChange(value);
  }

  private handleKeydown(event: KeyboardEvent, index: number): void {
    const delta = keyDelta(event.key);
    if (delta === 0) return;

    event.preventDefault();
    const next = SEGMENTS[(index + delta + SEGMENTS.length) % SEGMENTS.length];
    this.emitChange(next.value);
    this.focusSegment(next.value);
  }

  private focusSegment(value: RangeSelection): void {
    const button = this.renderRoot.querySelector<HTMLButtonElement>(
      `button[data-value="${value}"]`,
    );
    button?.focus();
  }

  private emitChange(value: RangeSelection): void {
    if (value === 'custom') return;
    this.dispatchEvent(
      new CustomEvent<RangeSelection>('range-changed', {
        detail: value,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private renderSegment(segment: SegmentDef, index: number) {
    const selected = this.selection === segment.value;
    const tabindex = this.tabIndexFor(segment.value);
    return html`
      <button
        type="button"
        role="tab"
        data-value=${segment.value}
        aria-selected=${selected}
        tabindex=${tabindex}
        @click=${() => this.handleClick(segment.value)}
        @keydown=${(e: KeyboardEvent) => this.handleKeydown(e, index)}
      >${segment.label}</button>
    `;
  }

  private tabIndexFor(value: RangeSelection): number {
    const rovingValue = this.selection === 'custom' ? SEGMENTS[0].value : this.selection;
    return value === rovingValue ? 0 : -1;
  }

  render() {
    const showCustom = this.selection === 'custom';
    return html`
      <div class="time-range-switch" role="tablist" aria-label="Time range">
        ${repeat(
          SEGMENTS,
          (s) => s.value,
          (s, i) => this.renderSegment(s, i),
        )}
        ${
          showCustom
            ? html`<button
                type="button"
                class="is-custom"
                role="tab"
                data-value="custom"
                aria-selected="true"
                tabindex="0"
                disabled
              >${CUSTOM_SEGMENT.label}</button>`
            : ''
        }
      </div>
    `;
  }
}

function keyDelta(key: string): number {
  if (key === 'ArrowRight' || key === 'ArrowDown') return 1;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return -1;
  return 0;
}

declare global {
  interface HTMLElementTagNameMap {
    'time-range-switch': TimeRangeSwitch;
  }
}
