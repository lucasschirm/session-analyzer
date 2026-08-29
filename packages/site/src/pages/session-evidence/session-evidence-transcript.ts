import type { EvidencePage, EvidenceRow } from '@lucasschirm/sal-db';
import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { renderMarkdown } from '../../lib/markdown';

/**
 * Paginated chat-like transcript view rendered via marked and sanitized
 * with DOMPurify.
 */
@customElement('session-evidence-transcript')
export class SessionEvidenceTranscript extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .transcript-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .message {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-width: 90%;
      padding: 10px 14px;
      border-radius: 12px;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      background: var(--md-sys-color-surface, #171a21);
    }

    .message.user {
      align-self: flex-end;
      border-bottom-right-radius: 4px;
    }

    .message.assistant {
      align-self: flex-start;
      border-bottom-left-radius: 4px;
    }

    .message.system {
      align-self: flex-start;
      background: var(--md-sys-color-surface-container, #1f242e);
    }

    .message.tombstone {
      align-self: center;
      border-color: var(--md-sys-color-tertiary, #ffb86c);
      background: var(--md-sys-color-surface-container, #1f242e);
    }

    .message-header {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .message-role {
      font-weight: 600;
      text-transform: capitalize;
    }

    .message-turn {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .message-body {
      font-size: 14px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      line-height: 1.5;
      word-break: break-word;
    }

    .message-body :first-child {
      margin-top: 0;
    }

    .message-body :last-child {
      margin-bottom: 0;
    }

    .pagination {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 12px;
      margin-top: 16px;
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

  @property({ type: Boolean }) loading = false;

  @property({ type: String }) state: 'ok' | 'tombstone' | 'empty' | 'loading' = 'loading';

  private roleFor(row: EvidenceRow): string {
    const match = row.summary.match(/^Message \d+ \(([^)]+)\)/);
    return match?.[1]?.toLowerCase() ?? 'unknown';
  }

  private renderMarkdown(summary: string): string {
    return renderMarkdown(summary);
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
      return html`<p class="empty">Loading transcript…</p>`;
    }
    if (
      this.state === 'tombstone' ||
      this.page?.items.some((row) => row.entityType === 'tombstone')
    ) {
      const tombstone = this.page?.items.find((row) => row.entityType === 'tombstone');
      return html`<p class="empty" role="alert">${tombstone?.summary ?? 'Transcript is no longer available.'}</p>`;
    }
    if (!this.page || this.page.items.length === 0 || this.state === 'empty') {
      return html`<p class="empty">No transcript messages found.</p>`;
    }

    return html`
      <div class="transcript-list" role="log" aria-label="Session transcript" aria-live="polite">
        ${this.page.items.map((row) => {
          const role = this.roleFor(row);
          return html`
              <div class="message ${role}">
                <div class="message-header">
                  <span class="message-role">${role}</span>
                  ${row.turnNumber ? html`<span class="message-turn">Turn ${row.turnNumber}</span>` : ''}
                  ${row.timestamp ? html`<span>${new Date(row.timestamp).toLocaleString()}</span>` : ''}
                </div>
                <div class="message-body">${unsafeHTML(this.renderMarkdown(row.summary))}</div>
              </div>
            `;
        })}
      </div>
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
    'session-evidence-transcript': SessionEvidenceTranscript;
  }
}
