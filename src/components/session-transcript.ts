import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type { TranscriptMessage } from '../types';
import { renderMarkdown } from '../lib/markdown';

/**
 * Chat-like session transcript.
 *
 * Renders user/assistant messages as alternating bubbles. Message content is
 * markdown and is sanitized through DOMPurify (see lib/markdown) before being
 * injected via unsafeHTML.
 */
@customElement('session-transcript')
export class SessionTranscript extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .session-transcript {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .message {
      max-width: 78%;
      padding: 12px 16px;
      border-radius: 12px;
      font-size: 14px;
      line-height: 1.55;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      overflow-wrap: break-word;
    }

    .message.user {
      align-self: flex-end;
      background: var(--md-sys-color-primary-container, #1c2b4a);
      border: 1px solid var(--md-sys-color-primary, #4f8cff);
      border-bottom-right-radius: 4px;
    }

    .message.assistant {
      align-self: flex-start;
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-bottom-left-radius: 4px;
    }

    .message.system {
      align-self: center;
      background: transparent;
      border: 1px dashed var(--md-sys-color-outline, #2a303c);
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-size: 13px;
    }

    .message .role {
      display: block;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      margin-bottom: 6px;
    }

    .message pre {
      background: var(--md-sys-color-background, #0f1115);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      padding: 12px;
      overflow-x: auto;
      font-size: 13px;
    }

    .message code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.92em;
    }

    .message p:first-of-type {
      margin-top: 0;
    }

    .message p:last-of-type {
      margin-bottom: 0;
    }

    .empty {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      text-align: center;
      padding: 24px;
      border: 1px dashed var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
    }
  `;

  @property({ type: Array }) messages: TranscriptMessage[] = [];

  private formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString();
  }

  render() {
    if (this.messages.length === 0) {
      return html`
        <div class="session-transcript">
          <p class="empty">No transcript messages recorded for this session.</p>
        </div>
      `;
    }

    return html`
      <div class="session-transcript">
        ${repeat(
          this.messages,
          (message) => message.id,
          (message) => html`
            <div class="message ${message.role}">
              <span class="role">${message.role} • ${this.formatTime(message.timestamp)}</span>
              ${unsafeHTML(renderMarkdown(message.content))}
            </div>
          `
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-transcript': SessionTranscript;
  }
}
