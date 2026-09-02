import { css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { PageLitElement, pageHostStyles } from './page-lit-element';

/**
 * Placeholder page for top-level navigation entries that do not yet have a
 * dedicated view (Agents, Skills, Tools, MCP). Renders a distinct, non-silent
 * empty state so users can see the route is reachable while the real view is
 * being built.
 */
@customElement('tbd-page')
export class TbdPage extends PageLitElement {
  static styles = [
    pageHostStyles,
    css`
    :host {
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .tbd-page {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    h1 {
      margin: 0;
      font-size: 24px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .empty-state {
      border: 1px dashed var(--md-sys-color-outline, #2a303c);
      border-radius: 12px;
      padding: 48px 24px;
      text-align: center;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .empty-state strong {
      display: block;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      font-size: 16px;
      margin-bottom: 8px;
    }
  `,
  ];

  /** Human-readable label shown in the heading (e.g. "Agents"). */
  @property() label = '';

  render() {
    return html`
      <div class="tbd-page">
        <h1>${this.label}</h1>
        <div class="empty-state" role="status">
          <strong>Not available yet</strong>
          <p>The ${this.label.toLowerCase()} view is not implemented yet. Check back soon.</p>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'tbd-page': TbdPage;
  }
}
