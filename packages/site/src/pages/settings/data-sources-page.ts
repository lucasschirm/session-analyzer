import { css, html, LitElement } from 'lit';
import { customElement } from 'lit/decorators.js';
import '../../components/connect-modal';

/**
 * Settings > Data Sources page.
 *
 * Embeds the connection management modal in inline mode, preserving the
 * full S3 connection CRUD, test, sync, passkey, and delete-confirmation
 * flows that previously lived behind the header "Connect" button.
 */
@customElement('data-sources-page')
export class DataSourcesPage extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: 24px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      max-width: 800px;
    }

    h1 {
      margin: 0 0 8px;
      font-size: 24px;
    }

    p.description {
      margin: 0 0 24px;
      font-size: 14px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }
  `;

  render() {
    return html`
      <h1>Data Sources</h1>
      <p class="description">
        Manage remote S3 connections for syncing session data. Connections can be saved to local
        storage (encrypted with a passkey) or kept in-memory for the current session.
      </p>
      <connect-modal inline></connect-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'data-sources-page': DataSourcesPage;
  }
}
