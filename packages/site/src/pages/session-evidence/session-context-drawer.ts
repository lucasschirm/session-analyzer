import type { ContextTimingPoint } from '@lucasschirm/sal-db';
import { css, html, LitElement, type PropertyValues } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { formatChartValue } from '../../components/charts/chart-types';
import { formatDateTime } from '../../lib/format';
import { renderMarkdown } from '../../lib/markdown';
import { CONTEXT_BAR_COLORS } from './session-evidence-chart-helpers';

/**
 * Slide-in drawer displaying full details for a selected message in a session:
 * turn/message number, role badge, timestamp, model, context tokens, input/output/cache
 * token breakdown, thinking tokens, reasoning effort, and formatted message content.
 *
 * @fires drawer-close
 */
@customElement('session-context-drawer')
export class SessionContextDrawer extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }

    .drawer-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(2px);
      z-index: 99;
      animation: fadeIn 0.2s ease-out;
    }

    .drawer-panel {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: min(520px, 94vw);
      background: var(--md-sys-color-surface, #171a21);
      border-left: 1px solid var(--md-sys-color-outline, #2a303c);
      box-shadow: -8px 0 32px rgba(0, 0, 0, 0.5);
      z-index: 100;
      display: flex;
      flex-direction: column;
      animation: slideInRight 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      overflow: hidden;
    }

    .drawer-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 16px 20px;
      border-bottom: 1px solid var(--md-sys-color-outline, #2a303c);
      background: var(--md-sys-color-surface-container, #1f242e);
    }

    .header-info {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .drawer-title {
      margin: 0;
      font-size: 18px;
      font-weight: 700;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .role-badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      text-transform: capitalize;
      letter-spacing: 0.03em;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      background: var(--md-sys-color-surface, #171a21);
    }

    .role-badge.user {
      color: var(--md-sys-color-primary, #4f8cff);
      border-color: rgba(79, 140, 255, 0.4);
      background: rgba(79, 140, 255, 0.1);
    }

    .role-badge.assistant {
      color: #34d399;
      border-color: rgba(52, 211, 153, 0.4);
      background: rgba(52, 211, 153, 0.1);
    }

    .role-badge.system {
      color: var(--md-sys-color-tertiary, #ffb86c);
      border-color: rgba(255, 184, 108, 0.4);
      background: rgba(255, 184, 108, 0.1);
    }

    /* Tool / Skill / Agent domain badge: the same classification the context
       growth chart colors by, spelled out in text. Its colors come from
       CONTEXT_BAR_COLORS (session-evidence-chart-helpers.ts) and are applied
       inline, so this file never restates a palette of its own. */
    .kind-badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.03em;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      background: var(--md-sys-color-surface, #171a21);
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      text-transform: capitalize;
    }

    .close-button {
      background: transparent;
      border: none;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-size: 20px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 6px;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background-color 0.15s ease, color 0.15s ease;
    }

    .close-button:hover {
      background: var(--md-sys-color-surface-container-hover, #262d3a);
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .drawer-body {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 10px;
    }

    .stat-card {
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .stat-label {
      font-size: 11px;
      font-weight: 500;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .stat-value {
      font-size: 16px;
      font-weight: 700;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      word-break: break-all;
    }

    .stat-value.highlight {
      color: var(--md-sys-color-primary, #4f8cff);
    }

    .stat-value.timestamp {
      font-size: 13px;
    }

    .stat-card.full-width {
      grid-column: 1 / -1;
    }

    .content-section {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .content-heading-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    /* Parsed (rendered markdown) vs raw (formatted JSON) view toggle. */
    .view-toggle {
      display: inline-flex;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      overflow: hidden;
      flex-shrink: 0;
    }

    .view-toggle button {
      background: var(--md-sys-color-surface, #171a21);
      border: none;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.04em;
      padding: 6px 14px;
      text-transform: uppercase;
    }

    .view-toggle button + button {
      border-left: 1px solid var(--md-sys-color-outline, #2a303c);
    }

    .view-toggle button:hover {
      background: var(--md-sys-color-surface-container-hover, #262d3a);
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .view-toggle button[aria-pressed='true'] {
      background: var(--md-sys-color-primary, #4f8cff);
      color: var(--md-sys-color-on-primary, #fff);
    }

    /* Raw view: the message record as formatted JSON. The .content-box pre rule
       above already supplies the monospace box, border, and horizontal scroll;
       this only pins the layout so JSON indentation survives. */
    .content-box pre.raw-json {
      margin: 0;
      white-space: pre;
      word-break: normal;
    }

    .section-heading {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .content-box {
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      padding: 14px 16px;
      font-size: 14px;
      line-height: 1.6;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      word-break: break-word;
    }

    .content-box pre {
      background: var(--md-sys-color-surface, #171a21);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 6px;
      padding: 10px 12px;
      overflow-x: auto;
      font-size: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .content-box code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      background: rgba(255, 255, 255, 0.06);
      padding: 2px 4px;
      border-radius: 4px;
    }

    .content-box pre code {
      background: transparent;
      padding: 0;
    }

    .content-box p:first-child {
      margin-top: 0;
    }

    .content-box p:last-child {
      margin-bottom: 0;
    }

    .empty-text {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-style: italic;
      margin: 0;
    }

    @keyframes slideInRight {
      from {
        transform: translateX(100%);
      }
      to {
        transform: translateX(0);
      }
    }

    @keyframes fadeIn {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }
  `;

  @property({ attribute: false }) message: ContextTimingPoint | null = null;

  /**
   * Which view of the message body is shown: `false` renders the parsed
   * (markdown-formatted) content, `true` the raw message record as formatted
   * JSON. Defaults to parsed and resets whenever a different message is
   * selected, so opening the next bar never inherits the previous choice.
   */
  @state() private showingRaw = false;

  @query('.close-button') private closeButtonEl?: HTMLButtonElement;
  @query('.drawer-body') private drawerBodyEl?: HTMLElement;

  private cachedRenderedHtml: string | null = null;
  private isKeydownAttached = false;
  private previouslyFocusedElement: HTMLElement | null = null;

  willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    if (changed.has('message')) {
      this.showingRaw = false;
      this.cachedRenderedHtml = this.message?.content ? renderMarkdown(this.message.content) : null;
    }
  }

  updated(changed: PropertyValues<this>): void {
    super.updated(changed);
    if (changed.has('message')) {
      if (this.message) {
        if (this.drawerBodyEl) {
          this.drawerBodyEl.scrollTop = 0;
        }
        if (!this.isKeydownAttached) {
          this.previouslyFocusedElement = document.activeElement as HTMLElement | null;
          window.addEventListener('keydown', this.handleKeyDown);
          this.isKeydownAttached = true;
          this.closeButtonEl?.focus();
        }
      } else if (this.isKeydownAttached) {
        window.removeEventListener('keydown', this.handleKeyDown);
        this.isKeydownAttached = false;
        this.restoreFocus();
      }
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.isKeydownAttached) {
      window.removeEventListener('keydown', this.handleKeyDown);
      this.isKeydownAttached = false;
    }
    this.restoreFocus();
  }

  private restoreFocus(): void {
    if (
      this.previouslyFocusedElement &&
      typeof this.previouslyFocusedElement.focus === 'function'
    ) {
      this.previouslyFocusedElement.focus();
    }
    this.previouslyFocusedElement = null;
  }

  private trapTabKey(e: KeyboardEvent): void {
    const focusables = Array.from(
      this.shadowRoot?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter(
      (el) =>
        !el.hasAttribute('disabled') &&
        !el.hasAttribute('hidden') &&
        el.getAttribute('aria-hidden') !== 'true',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = this.shadowRoot?.activeElement;
    if (!active || !focusables.includes(active as HTMLElement)) {
      e.preventDefault();
      first.focus();
      return;
    }
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (!this.message) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    } else if (e.key === 'Tab') {
      this.trapTabKey(e);
    }
  };

  private close = (): void => {
    this.dispatchEvent(
      new CustomEvent<void>('drawer-close', {
        bubbles: true,
        composed: true,
      }),
    );
  };

  private renderStatCard(label: string, value: string, highlight = false) {
    return html`
      <div class="stat-card">
        <span class="stat-label">${label}</span>
        <span class=${classMap({ 'stat-value': true, highlight })}>${value}</span>
      </div>
    `;
  }

  private renderTokenStats(m: ContextTimingPoint) {
    const fmt = (v: number | null | undefined) => (v != null ? formatChartValue(v) : '—');
    const removed = m.compactedTokens ?? m.removedTokens;
    return html`
      ${this.renderStatCard('Context Tokens', fmt(m.contextTokens), true)}
      ${removed != null && removed > 0 ? this.renderStatCard('Compacted Tokens', fmt(removed)) : ''}
      ${this.renderStatCard('Generation Tokens', fmt(m.generationTokens))}
      ${this.renderStatCard('Total Tokens', fmt(m.totalTokens))}
      ${this.renderStatCard('Input Tokens', fmt(m.inputTokens))}
      ${this.renderStatCard('Cache Read', fmt(m.cacheReadTokens))}
      ${this.renderStatCard('Cache Creation', fmt(m.cacheCreationTokens))}
    `;
  }

  private renderMetadataStats(m: ContextTimingPoint) {
    const formattedDate = m.timestamp ? formatDateTime(m.timestamp) : '';
    return html`
      ${m.thinkingTokens != null ? this.renderStatCard('Thinking Tokens', formatChartValue(m.thinkingTokens)) : ''}
      ${m.effort ? this.renderStatCard('Reasoning Effort', m.effort) : ''}
      ${m.model ? html`<div class="stat-card full-width"><span class="stat-label">Model</span><span class="stat-value">${m.model}</span></div>` : ''}
      ${formattedDate ? html`<div class="stat-card full-width"><span class="stat-label">Timestamp</span><span class="stat-value timestamp">${formattedDate}</span></div>` : ''}
    `;
  }

  private setView(raw: boolean): void {
    this.showingRaw = raw;
  }

  /** The selected message record, pretty-printed. `ContextTimingPoint` is the
   *  canonical per-message fact set the read contract exposes, so this is the
   *  message as the analytics layer actually stores and serves it. */
  private get rawJson(): string {
    if (!this.message) return '';
    try {
      return JSON.stringify(this.message, null, 2);
    } catch {
      return '"<unserializable message>"';
    }
  }

  private renderContent() {
    return html`
      <div class="content-section">
        <div class="content-heading-row">
          <h3 class="section-heading">Message Content</h3>
          <div class="view-toggle" role="group" aria-label="Message content format">
            <button
              type="button"
              aria-pressed=${!this.showingRaw}
              @click=${() => this.setView(false)}
            >
              Parsed
            </button>
            <button
              type="button"
              aria-pressed=${this.showingRaw}
              @click=${() => this.setView(true)}
            >
              Raw
            </button>
          </div>
        </div>
        <div class="content-box">
          ${
            this.showingRaw
              ? html`<pre class="raw-json">${this.rawJson}</pre>`
              : this.cachedRenderedHtml
                ? unsafeHTML(this.cachedRenderedHtml)
                : html`<p class="empty-text">No content recorded for this message.</p>`
          }
        </div>
      </div>
    `;
  }

  private renderHeader(
    index: number,
    role: string,
    invocationKind?: ContextTimingPoint['invocationKind'],
  ) {
    const kindColor = invocationKind ? CONTEXT_BAR_COLORS[invocationKind] : undefined;
    return html`
      <div class="drawer-header">
        <div class="header-info">
          <h2 class="drawer-title">Message #${index}</h2>
          <span class=${classMap({ 'role-badge': true, [role]: Boolean(role) })}>${role}</span>
          ${
            invocationKind && kindColor
              ? html`<span
                  class="kind-badge"
                  data-kind=${invocationKind}
                  style="color: ${kindColor}; border-color: ${kindColor}; background: color-mix(in srgb, ${kindColor} 12%, transparent)"
                >
                  ${invocationKind} message
                </span>`
              : ''
          }
        </div>
        <button class="close-button" type="button" aria-label="Close message details" @click=${this.close}>
          ✕
        </button>
      </div>
    `;
  }

  render() {
    if (!this.message) return null;
    const m = this.message;
    const index = m.messageIndex ?? m.turnNumber;
    const role = m.role ?? 'unknown';

    return html`
      <div class="drawer-backdrop" @click=${this.close} aria-hidden="true"></div>
      <aside class="drawer-panel" role="dialog" aria-modal="true" aria-label="Message ${index} details">
        ${this.renderHeader(index, role, m.invocationKind)}
        <div class="drawer-body">
          <div class="stats-grid">
            ${this.renderTokenStats(m)}
            ${this.renderMetadataStats(m)}
          </div>
          ${this.renderContent()}
        </div>
      </aside>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-context-drawer': SessionContextDrawer;
  }
}
