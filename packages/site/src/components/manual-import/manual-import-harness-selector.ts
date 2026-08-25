import type { ManualIngestionDetection } from '@lucasschirm/sal-db';
import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

/**
 * Harness selection for a manual import.
 *
 * Displays schema-detection evidence and, when detection is ambiguous,
 * requires the user to pick one candidate. The parent owns the final
 * `selectedHarness` value.
 */
@customElement('manual-import-harness-selector')
export class ManualImportHarnessSelector extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .harness-selector {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .detection-card {
      background: var(--md-sys-color-surface, #171a21);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      padding: 12px 16px;
    }

    .detection-matched {
      border-color: var(--md-sys-color-success, #3ecf8e);
    }

    .detection-ambiguous {
      border-color: var(--md-sys-color-warning, #e8a838);
    }

    .detection-unmatched {
      border-color: var(--md-sys-color-error, #ff6b6b);
    }

    .detection-title {
      font-weight: 600;
      font-size: 14px;
      margin-bottom: 4px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .detection-reason {
      font-size: 13px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .candidate-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 8px;
    }

    .candidate-option {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .candidate-option input {
      accent-color: var(--md-sys-color-primary, #4f8cff);
    }
  `;

  @property({ attribute: false }) detection: ManualIngestionDetection | null = null;

  @property({ type: String }) selectedHarness = '';

  private handleSelect(harness: string): void {
    this.selectedHarness = harness;
    this.dispatchEvent(
      new CustomEvent('harness-changed', {
        detail: { harness },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    if (!this.detection) {
      return html`<div class="harness-selector">
        <p>Upload files to detect the session harness.</p>
      </div>`;
    }

    const cardClass =
      this.detection.kind === 'matched'
        ? 'detection-matched'
        : this.detection.kind === 'ambiguous'
          ? 'detection-ambiguous'
          : 'detection-unmatched';

    return html`
      <div class="harness-selector">
        <div class="detection-card ${cardClass}">
          <div class="detection-title">
            ${
              this.detection.kind === 'matched'
                ? `Detected harness: ${this.detection.harness}`
                : this.detection.kind === 'ambiguous'
                  ? 'Ambiguous detection'
                  : 'No harness detected'
            }
          </div>
          <div class="detection-reason">${this.detection.reason}</div>

          ${
            this.detection.kind === 'ambiguous'
              ? html`
                <div class="candidate-list" role="radiogroup" aria-label="Choose a harness">
                  ${repeat(
                    this.detection.candidates ?? [],
                    (harness) => harness,
                    (harness) => html`
                      <label class="candidate-option">
                        <input
                          type="radio"
                          name="harness"
                          .value=${harness}
                          .checked=${this.selectedHarness === harness}
                          @change=${() => this.handleSelect(harness)}
                        />
                        ${harness}
                      </label>
                    `,
                  )}
                </div>
              `
              : ''
          }
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'manual-import-harness-selector': ManualImportHarnessSelector;
  }
}
