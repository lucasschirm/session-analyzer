import { css, html, LitElement } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { UploadedFile } from '../../lib/subagents';
import '../../components/upload-zone';

export interface ManualUploadSelection {
  readonly files: UploadedFile[];
  readonly pathPreserved: boolean;
}

/**
 * Manual-import upload wrapper.
 *
 * Re-uses the generic `<upload-zone>` and exposes a higher-level
 * `manual-files-selected` event that includes a `pathPreserved` flag. The flag
 * is true when a folder was dropped and/or any uploaded file carries a
 * directory-relative path, and false for flat file-picker selections. This is
 * surfaced in the UI as a classification limitation disclosure.
 */
@customElement('manual-import-upload')
export class ManualImportUpload extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .manual-import-upload {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .path-disclosure {
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      padding: 12px 16px;
      font-size: 13px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .path-disclosure.limited {
      border-color: var(--md-sys-color-warning, #e8a838);
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }
  `;

  @state() private pathPreserved = true;

  private handleFilesSelected(
    event: CustomEvent<{ files: UploadedFile[]; pathPreserved: boolean }>,
  ): void {
    const { files, pathPreserved } = event.detail;
    this.pathPreserved = pathPreserved;
    this.dispatchEvent(
      new CustomEvent<ManualUploadSelection>('manual-files-selected', {
        detail: { files, pathPreserved },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    return html`
      <div class="manual-import-upload">
        <upload-zone @files-selected=${this.handleFilesSelected}></upload-zone>
        <div
          class="path-disclosure ${this.pathPreserved ? '' : 'limited'}"
          role="note"
        >
          ${
            this.pathPreserved
              ? html`Directory-relative paths are preserved; configuration files can be classified by path.`
              : html`
                Directory-relative paths are <strong>not</strong> available. Path-based
                configuration classification is limited; only content-based and
                transcript-supported metrics are reliable.
              `
          }
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'manual-import-upload': ManualImportUpload;
  }
}
