import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { renderMarkdown } from '../lib/markdown';
import type { TranscriptMessage } from '../types';

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

    /*
     * Inline markers (e.g. the Session Transcript page's subagent cards)
     * rendered via renderAfter() - styled here, not in the parent page,
     * since renderAfter's template ends up inside THIS component's shadow
     * root, out of reach of the parent's stylesheet.
     */
    .subagent-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin: 2px 0 4px;
    }

    .subagent-card {
      --accent: #4f8cff;
      display: flex;
      flex-direction: column;
      gap: 4px;
      align-items: flex-start;
      min-width: 160px;
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-left: 3px solid var(--accent);
      border-radius: 8px;
      padding: 8px 14px 8px 12px;
      cursor: pointer;
      font: inherit;
      text-align: left;
      text-decoration: none;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      transition: background-color 0.15s ease, transform 0.1s ease;
    }

    .subagent-card:hover {
      background: var(--md-sys-color-surface-container-hover, #262d3a);
    }

    .subagent-card:active {
      transform: scale(0.98);
    }

    .subagent-card.active {
      background: var(--md-sys-color-surface-container-hover, #262d3a);
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }

    .subagent-card-title {
      font-size: 13px;
      font-weight: 600;
    }

    .subagent-card-meta {
      font-size: 11px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .subagent-card-tokens {
      font-size: 11px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--accent);
    }

    .subagent-card-hint {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }
  `;

  @property({ type: Array }) messages: TranscriptMessage[] = [];

  /**
   * Optional hook invoked after each rendered message, letting a parent
   * interleave extra content (e.g. the Session Transcript page's inline
   * subagent cards) at the point in the timeline it actually happened -
   * rather than only being able to prepend/append around the whole list.
   */
  @property({ attribute: false }) renderAfter?: (message: TranscriptMessage) => unknown;

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
            ${this.renderAfter?.(message)}
          `,
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
