import { css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { PageLitElement, pageHostStyles } from '../page-lit-element';
import '../../components/connect-modal';
import '../../components/settings-tabs';

/**
 * Settings > Data Sources page.
 *
 * Embeds the connection management modal in inline mode, preserving the
 * full S3 connection CRUD, test, sync, passkey, and delete-confirmation
 * flows that previously lived behind the header "Connect" button.
 */
@customElement('data-sources-page')
export class DataSourcesPage extends PageLitElement {
  /** Optional connection id from the route (`/settings/data-sources/:connectionId`).
   * Passed down to the inline connect-modal so it can auto-open the edit form
   * for that connection (or the "new connection" form when the id is `new`). */
  @property({ type: String }) connectionId = '';

  static styles = [
    pageHostStyles,
    css`
    :host {
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
  `,
  ];

  render() {
    return html`
      <settings-tabs></settings-tabs>
      <h1>Data Sources</h1>
      <p class="description">
        Manage remote S3 connections for syncing session data. Connections can be saved to local
        storage (encrypted with a passkey) or kept in-memory for the current session.
      </p>
      <connect-modal inline .connectionId=${this.connectionId}></connect-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'data-sources-page': DataSourcesPage;
  }
}
