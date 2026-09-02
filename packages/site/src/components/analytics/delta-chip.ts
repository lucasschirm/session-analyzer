import { css, html, svg } from 'lit';
import type { StatDelta } from './analytics-card-types';

/** Shared styles for `.delta-chip` + `.triangle`, included by each tile that
 * renders a delta chip via `renderDeltaChip` (Shadow DOM styles do not
 * cross component boundaries, so this is composed into each `static styles`). */
export const deltaChipStyles = css`
  .delta-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
  }

  .delta-chip.up {
    color: var(--rd-accent-success, #3ecf8e);
    background: color-mix(in srgb, var(--rd-accent-success, #3ecf8e) 16%, transparent);
  }

  .delta-chip.down {
    color: var(--rd-ink-faint, #7d8794);
    background: color-mix(in srgb, var(--rd-ink-faint, #7d8794) 14%, transparent);
  }

  .delta-chip.flat {
    color: var(--rd-ink-muted, #9aa4b2);
    background: color-mix(in srgb, var(--rd-ink-muted, #9aa4b2) 12%, transparent);
  }

  .triangle {
    fill: currentColor;
  }
`;

/**
 * Renders a delta pill: a direction triangle + text. Direction is always
 * encoded by both the triangle glyph and the CSS class — never by color
 * alone. Shared by `stat-tile-hero` and `stat-tile-delta`.
 */
export function renderDeltaChip(delta: StatDelta | undefined) {
  if (!delta) return null;

  return html`
    <span class="delta-chip ${delta.direction}">
      ${renderTriangle(delta.direction)}
      <span>${delta.text}</span>
    </span>
  `;
}

function renderTriangle(direction: StatDelta['direction']) {
  if (direction === 'flat') {
    return svg`<svg class="triangle" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
      <rect x="0" y="3.25" width="8" height="1.5" />
    </svg>`;
  }

  const points = direction === 'up' ? '4,0 8,8 0,8' : '0,0 8,0 4,8';
  return svg`<svg class="triangle" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
    <polygon points=${points} />
  </svg>`;
}
