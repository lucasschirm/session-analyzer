import { type CSSResult, css, LitElement } from 'lit';

/**
 * Shared `:host` styles for route-level page components.
 *
 * Pages extend {@link PageLitElement} and inherit these base styles. Pages
 * that need a narrower max-width (e.g. settings pages) can append their own
 * `static styles` that override `:host` properties.
 */
export const pageHostStyles: CSSResult = css`
  :host {
    display: block;
    width: 100%;
    padding: 24px;
    box-sizing: border-box;
  }
`;

/**
 * Base class for route-level page components.
 *
 * Provides a consistent full-width layout with standard padding so every
 * page renders in the same content frame.
 */
export class PageLitElement extends LitElement {
  static styles: CSSResult | CSSResult[] = pageHostStyles;
}
