import { css } from 'lit';

/**
 * Shared card-surface chrome (surface, hairline border, radius, padding,
 * clickable button variant) reused by every analytics tile that renders
 * its own top-level card (`analytics-card`, `stat-tile-hero`,
 * `stat-tile-delta`). Each consumer supplies its own root class name via
 * the `--rd-card-surface-selector`-free composition below: apply these
 * rules to a `.<component-tag-name>` class in the consuming component.
 */
export const cardSurfaceStyles = css`
  :host {
    display: block;
    height: 100%;
  }

  .card-surface {
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    background: var(--rd-surface-card, #171b24);
    border: 1px solid var(--rd-border-2, #232936);
    border-radius: 14px;
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    color: inherit;
    font: inherit;
    text-align: left;
  }

  button.card-surface {
    cursor: pointer;
    transition: border-color 0.15s ease;
  }

  button.card-surface:hover {
    border-color: var(--rd-border-emphasis, #313947);
  }

  button.card-surface:focus-visible {
    outline: 2px solid var(--rd-accent, #4f8cff);
    outline-offset: 2px;
  }
`;
