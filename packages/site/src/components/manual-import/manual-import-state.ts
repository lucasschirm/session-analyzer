import type { IngestionReceipt } from '@lucasschirm/sal-db';
import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export type ManualImportPhase =
  | 'idle'
  | 'detecting'
  | 'ready'
  | 'importing'
  | 'partial'
  | 'unsupported'
  | 'integrity-error'
  | 'unavailable'
  | 'conflict';

/**
 * Status panel for the manual import flow.
 *
 * Renders loading, empty, partial, unavailable, unsupported, integrity-error
 * and conflict states. Surfaces the partial-snapshot label and transcript-only
 * limitations required by the manual-import design.
 */
@customElement('manual-import-state')
export class ManualImportState extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .state-panel {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      width: fit-content;
    }

    .badge.loading {
      color: var(--md-sys-color-primary, #4f8cff);
      border-color: var(--md-sys-color-primary, #4f8cff);
    }

    .badge.partial {
      color: var(--md-sys-color-warning, #e8a838);
      border-color: var(--md-sys-color-warning, #e8a838);
    }

    .badge.unsupported,
    .badge.integrity-error,
    .badge.unavailable {
      color: var(--md-sys-color-error, #ff6b6b);
      border-color: var(--md-sys-color-error, #ff6b6b);
    }

    .state-message {
      font-size: 14px;
      line-height: 1.5;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .state-message p {
      margin: 0;
    }

    .state-message .hint {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-size: 13px;
    }

    .issue-list {
      margin: 0;
      padding-left: 20px;
      font-size: 13px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .conflict-actions {
      display: flex;
      gap: 12px;
      margin-top: 8px;
    }

    button {
      border: none;
      padding: 10px 18px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }

    button.primary {
      background: var(--md-sys-color-primary, #4f8cff);
      color: #fff;
    }

    button.primary:hover {
      filter: brightness(1.1);
    }

    button.secondary {
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
    }

    button.secondary:hover {
      background: var(--md-sys-color-surface-container-hover, #262d3a);
    }

    .hidden {
      display: none;
    }
  `;

  @property({ type: String }) phase: ManualImportPhase = 'idle';

  @property({ attribute: false }) receipt: IngestionReceipt | null = null;

  @property({ type: String }) error = '';

  @property({ type: String }) conflictResolution: 'replace' | 'keep' | '' = '';

  private handleReplace(): void {
    this.dispatchEvent(
      new CustomEvent('conflict-resolution', {
        detail: { resolution: 'replace' },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleKeep(): void {
    this.dispatchEvent(
      new CustomEvent('conflict-resolution', {
        detail: { resolution: 'keep' },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private renderStateContent() {
    switch (this.phase) {
      case 'idle':
        return html`
          <div class="badge">Idle</div>
          <div class="state-message">
            <p class="hint">Upload a transcript or partial session folder to begin.</p>
          </div>
        `;
      case 'detecting':
        return html`
          <div class="badge loading">Loading</div>
          <div class="state-message">
            <p>Detecting session harness from uploaded artifacts…</p>
          </div>
        `;
      case 'ready':
        return html`
          <div class="badge">Ready</div>
          <div class="state-message">
            <p>Choose a project and harness, then import the partial session.</p>
          </div>
        `;
      case 'importing':
        return html`
          <div class="badge loading">Importing</div>
          <div class="state-message">
            <p>Committing partial session to the analytics database…</p>
          </div>
        `;
      case 'partial':
        return html`
          <div class="badge partial">Partial Snapshot</div>
          <div class="state-message">
            <p>Imported as a partial generation.</p>
            <p class="hint">
              A later authoritative sync with matching source identity will enrich or
              replace this session without duplicating metrics. Manual sessions do not
              contribute configuration exposure denominators or lifecycle events.
            </p>
            ${
              this.receipt && this.receipt.issueIds.length > 0
                ? html`
                  <p class="hint">Recoverable issues:</p>
                  <ul class="issue-list">
                    ${this.receipt.issueIds.map((issue) => html`<li>${issue}</li>`)}
                  </ul>
                `
                : ''
            }
          </div>
        `;
      case 'unsupported':
        return html`
          <div class="badge unsupported">Unsupported</div>
          <div class="state-message">
            <p>No supported harness detected for the uploaded files.</p>
            <p class="hint">${this.error}</p>
          </div>
        `;
      case 'unavailable':
        return html`
          <div class="badge unavailable">Unavailable</div>
          <div class="state-message">
            <p>The session cannot be imported in its current state.</p>
            <p class="hint">${this.error}</p>
          </div>
        `;
      case 'integrity-error':
        return html`
          <div class="badge integrity-error">Integrity Error</div>
          <div class="state-message">
            <p>Artifact verification failed.</p>
            <p class="hint">${this.error}</p>
          </div>
        `;
      case 'conflict':
        return html`
          <div class="badge unavailable">Conflict</div>
          <div class="state-message">
            <p>A different generation already exists for this source/session.</p>
            <p class="hint">${this.error}</p>
            <div class="conflict-actions">
              <button class="primary" @click=${this.handleReplace}>Replace existing</button>
              <button class="secondary" @click=${this.handleKeep}>Keep existing</button>
            </div>
          </div>
        `;
      default:
        return html``;
    }
  }

  render() {
    return html`
      <div class="state-panel">
        ${this.renderStateContent()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'manual-import-state': ManualImportState;
  }
}
