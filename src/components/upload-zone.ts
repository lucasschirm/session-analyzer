import { LitElement, html, css } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';

/**
 * Drag-and-drop upload zone.
 *
 * Input component: accepts `.json`, `.jsonl` and `.log` files via the file
 * picker button or drag-and-drop, and emits `files-selected` with the
 * selected `File[]` in the event detail. The parent owns parsing/persistence.
 */
@customElement('upload-zone')
export class UploadZone extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .upload-zone {
      border: 2px dashed var(--md-sys-color-outline, #2a303c);
      border-radius: 12px;
      padding: 32px 24px;
      text-align: center;
      background: var(--md-sys-color-surface, #171a21);
      transition: border-color 0.15s ease, background-color 0.15s ease;
    }

    .upload-zone.dragging {
      border-color: var(--md-sys-color-primary, #4f8cff);
      background: var(--md-sys-color-primary-container, #1c2b4a);
    }

    .upload-zone.disabled {
      opacity: 0.55;
      pointer-events: none;
    }

    .upload-icon {
      font-size: 40px;
      line-height: 1;
      margin-bottom: 12px;
    }

    .upload-title {
      font-weight: 600;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      margin-bottom: 4px;
    }

    .upload-hint {
      font-size: 13px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      margin-bottom: 16px;
    }

    .upload-button {
      background: var(--md-sys-color-primary, #4f8cff);
      color: #fff;
      border: none;
      padding: 10px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }

    .upload-button:hover {
      filter: brightness(1.1);
    }

    input[type='file'] {
      display: none;
    }
  `;

  @property({ type: Boolean }) disabled = false;

  @state() private dragging = false;

  @query('input[type="file"]') private fileInput!: HTMLInputElement;

  private dragDepth = 0;

  private get acceptedExtensions(): string {
    return '.json,.jsonl,.log';
  }

  private openPicker(): void {
    this.fileInput?.click();
  }

  private handleInputChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.emitFiles(input.files);
    input.value = '';
  }

  private handleDragEnter(event: DragEvent): void {
    event.preventDefault();
    this.dragDepth++;
    this.dragging = true;
  }

  private handleDragOver(event: DragEvent): void {
    event.preventDefault();
  }

  private handleDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.dragging = false;
  }

  private handleDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragDepth = 0;
    this.dragging = false;
    this.emitFiles(event.dataTransfer?.files ?? null);
  }

  private emitFiles(fileList: FileList | null): void {
    const files = Array.from(fileList ?? []).filter((file) =>
      /\.(json|jsonl|log)$/i.test(file.name)
    );
    if (files.length === 0) return;

    this.dispatchEvent(
      new CustomEvent('files-selected', {
        detail: { files },
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    const zoneClasses = ['upload-zone', this.dragging ? 'dragging' : '', this.disabled ? 'disabled' : '']
      .filter(Boolean)
      .join(' ');

    return html`
      <div
        class=${zoneClasses}
        @dragenter=${this.handleDragEnter}
        @dragover=${this.handleDragOver}
        @dragleave=${this.handleDragLeave}
        @drop=${this.handleDrop}
      >
        <div class="upload-icon" aria-hidden="true">📁</div>
        <div class="upload-title">Drag &amp; drop session files here</div>
        <div class="upload-hint">Supports .json, .jsonl and .log files from all supported assistants</div>
        <button
          class="upload-button"
          type="button"
          ?disabled=${this.disabled}
          @click=${this.openPicker}
        >
          Upload Session
        </button>
        <input
          type="file"
          accept=${this.acceptedExtensions}
          multiple
          @change=${this.handleInputChange}
        />
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'upload-zone': UploadZone;
  }
}
