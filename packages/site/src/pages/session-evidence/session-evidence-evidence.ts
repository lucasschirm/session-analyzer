import type { EvidencePage, EvidenceRow } from '@lucasschirm/sal-db';
import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/**
 * Paginated evidence list for a session.
 */
@customElement('session-evidence-evidence')
export class SessionEvidenceEvidence extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .evidence-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .evidence-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 10px 12px;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      background: var(--md-sys-color-surface, #171a21);
    }

    .evidence-row.tombstone {
      border-color: var(--md-sys-color-tertiary, #ffb86c);
      background: var(--md-sys-color-surface-container, #1f242e);
    }

    .evidence-meta {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }

    .evidence-type {
      font-size: 11px;
      text-transform: uppercase;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
    }

    .evidence-turn {
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .evidence-time {
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .evidence-summary {
      font-size: 13px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      word-break: break-word;
    }

    .pagination {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 12px;
      margin-top: 12px;
    }

    .pagination-button {
      padding: 8px 14px;
      font-size: 13px;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      background: var(--md-sys-color-surface, #171a21);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      cursor: pointer;
    }

    .pagination-button:hover:not(:disabled) {
      background: var(--md-sys-color-surface-container-hover, #262d3a);
    }

    .pagination-button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .empty {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-size: 13px;
      padding: 12px 0;
    }
  `;

  @property({ type: Object }) page: EvidencePage | null = null;

  @property({ type: String }) baseHref = '';

  @property({ type: Boolean }) loading = false;

  @property({ type: String }) state: 'ok' | 'tombstone' | 'empty' | 'loading' = 'loading';

  private rowClasses(row: EvidenceRow): string {
    return `evidence-row ${row.entityType === 'tombstone' ? 'tombstone' : ''}`;
  }

  private emitCursor(cursor: string | undefined, direction: 'next' | 'previous') {
    this.dispatchEvent(
      new CustomEvent('page-change', {
        detail: { cursor, direction },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    if (this.loading) {
      return html`<p class="empty">Loading evidence…</p>`;
    }
    if (
      this.state === 'tombstone' ||
      this.page?.items.some((row) => row.entityType === 'tombstone')
    ) {
      const tombstone = this.page?.items.find((row) => row.entityType === 'tombstone');
      return html`<p class="empty" role="alert">${tombstone?.summary ?? 'Evidence is no longer available.'}</p>`;
    }
    if (!this.page || this.page.items.length === 0 || this.state === 'empty') {
      return html`<p class="empty">No evidence rows found.</p>`;
    }

    return html`
      <ul class="evidence-list" role="list" aria-label="Session evidence">
        ${this.page.items.map(
          (row) => html`
            <li class=${this.rowClasses(row)}>
              <div class="evidence-meta">
                <span class="evidence-type">${row.entityType}</span>
                ${row.turnNumber ? html`<span class="evidence-turn">Turn ${row.turnNumber}</span>` : ''}
                ${row.timestamp ? html`<span class="evidence-time">${new Date(row.timestamp).toLocaleString()}</span>` : ''}
              </div>
              <div class="evidence-summary">${row.summary}</div>
            </li>
          `,
        )}
      </ul>
      <div class="pagination">
        <button
          class="pagination-button"
          type="button"
          ?disabled=${!this.page.previousCursor}
          @click=${() => this.emitCursor(this.page?.previousCursor, 'previous')}
        >
          Previous
        </button>
        <button
          class="pagination-button"
          type="button"
          ?disabled=${!this.page.nextCursor}
          @click=${() => this.emitCursor(this.page?.nextCursor, 'next')}
        >
          Next
        </button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-evidence-evidence': SessionEvidenceEvidence;
  }
}
