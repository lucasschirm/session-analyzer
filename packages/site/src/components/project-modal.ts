import { CAS_NAMESPACE_ROOT, validateProjectId } from '@lucasschirm/sal-sync-core';
import { css, html, LitElement } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';

/**
 * Detail emitted by `project-create` when the modal is in create or
 * sync-discovery mode.
 */
export interface ProjectCreateEventDetail {
  /** Display name for the project. */
  name: string;
  /** Optional project description. */
  description: string;
  /** URL-safe project id / bucket folder name. */
  readableId: string;
}

/**
 * Detail emitted by `project-edit` when the modal is in edit mode.
 */
export interface ProjectEditEventDetail extends ProjectCreateEventDetail {
  /** Primary project id to update. */
  projectId: string;
}

/**
 * Project modal supporting creation, sync-discovery prefill and edit.
 *
 * - `create` (default): user enters a name; the Project ID auto-slugs from the
 *   name and dedupes against local ids and, when supplied, the remote folder
 *   list.
 * - `sync-discovery`: the Project ID is the remote folder name and is
 *   read-only; the user supplies name + description.
 * - `edit`: all three fields are editable and the existing id is pre-filled.
 *
 * The parent owns persistence and closing. `modal-close` is emitted on
 * dismiss (including overlay clicks and Escape), so callers can treat cancel as
 * a skip for a sync-discovered folder.
 *
 * @fires project-create {ProjectCreateEventDetail}
 * @fires project-edit {ProjectEditEventDetail}
 * @fires modal-close
 */
@customElement('project-modal')
export class ProjectModal extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }

    .project-modal {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
      padding: 16px;
    }

    .panel {
      background: var(--md-sys-color-surface, #171a21);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 12px;
      padding: 24px;
      width: min(480px, 100%);
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
    }

    h2 {
      margin: 0 0 16px;
      font-size: 18px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      margin-bottom: 6px;
    }

    input,
    textarea {
      width: 100%;
      box-sizing: border-box;
      padding: 10px 12px;
      font-size: 14px;
      font-family: inherit;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      margin-bottom: 16px;
    }

    input:focus-visible,
    textarea:focus-visible {
      outline: 2px solid var(--md-sys-color-primary, #4f8cff);
      outline-offset: 1px;
    }

    input[aria-invalid='true'] {
      border-color: var(--md-sys-color-error, #ff6b6b);
    }

    input:read-only,
    input:disabled {
      cursor: not-allowed;
      opacity: 0.7;
    }

    textarea {
      resize: vertical;
      min-height: 64px;
    }

    .field-error {
      color: var(--md-sys-color-error, #ff6b6b);
      font-size: 13px;
      margin: -12px 0 16px;
    }

    .help-text {
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      margin: -12px 0 16px;
    }

    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    button {
      border: none;
      padding: 10px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }

    button.primary {
      background: var(--md-sys-color-primary, #4f8cff);
      color: #fff;
    }

    button.primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    button.secondary {
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
    }
  `;

  @property({ type: Boolean, reflect: true }) open = false;

  @property({ type: String }) mode: 'create' | 'edit' | 'sync-discovery' = 'create';

  @property({ type: String, attribute: 'project-id' }) projectId = '';

  @property({ type: String, attribute: 'initial-name' }) initialName = '';

  @property({ type: String, attribute: 'initial-description' }) initialDescription = '';

  @property({ type: String, attribute: 'initial-readable-id' }) initialReadableId = '';

  @property({ type: Boolean, attribute: 'readonly-id' }) readonlyId = false;

  /**
   * Optional callback that returns the current bucket's project folder names.
   * When supplied, slug generation is remote-aware and avoids colliding with
   * folders created from other devices.
   */
  @property({ attribute: false })
  getRemoteFolderNames?: () => Promise<string[]>;

  /**
   * Optional callback that returns the local project's existing `readable_id`
   * values. When supplied, slug generation avoids duplicate local ids.
   */
  @property({ attribute: false })
  getLocalProjectIds?: () => Promise<string[]>;

  @state() private name = '';

  @state() private description = '';

  @state() private readableId = '';

  @state() private idManuallyEdited = false;

  @state() private idError: string | null = null;

  @state() private takenIds = new Set<string>();

  @state() private isLoadingTaken = false;

  private takenIdsPromise: Promise<void> | null = null;

  @query('#project-id-input') private idInput!: HTMLInputElement;

  @query('#project-name-input') private nameInput!: HTMLInputElement;

  updated(changed: Map<string, unknown>): void {
    if (changed.has('open') && this.open) {
      this.resetFields();
      this.takenIdsPromise = this.loadTakenIds();
      this.updateComplete.then(() => this.nameInput?.focus());
    }
    if ((changed.has('name') || changed.has('takenIds')) && !this.idManuallyEdited) {
      this.syncSlugFromName();
    }
    if (changed.has('takenIds') || changed.has('readableId')) {
      this.idError = this.validateReadableId(this.readableId);
    }
  }

  private resetFields(): void {
    this.name = this.initialName;
    this.description = this.initialDescription;
    this.readableId = this.initialReadableId;
    this.idManuallyEdited = this.initialReadableId !== '' || this.mode !== 'create';
    this.idError = this.validateReadableId(this.readableId);
    this.takenIds = new Set([CAS_NAMESPACE_ROOT]);
    this.isLoadingTaken = false;
  }

  private async loadTakenIds(): Promise<void> {
    this.isLoadingTaken = true;
    try {
      await this.fetchTakenIds();
    } finally {
      // fetchTakenIds always sets the final state and isLoadingTaken.
    }
  }

  private async fetchTakenIds(): Promise<void> {
    const taken = new Set<string>();
    taken.add(CAS_NAMESPACE_ROOT);
    try {
      const [local, remote] = await Promise.all([
        this.safeList(this.getLocalProjectIds),
        this.safeList(this.getRemoteFolderNames),
      ]);
      for (const id of local) if (id) taken.add(id);
      for (const id of remote) if (id) taken.add(id);
    } finally {
      this.takenIds = taken;
      this.isLoadingTaken = false;
    }
  }

  private async safeList(source?: () => Promise<string[]>): Promise<string[]> {
    if (!source) return [];
    try {
      const ids = await source();
      return Array.isArray(ids) ? ids : [];
    } catch {
      return [];
    }
  }

  private takenIdsForSlug(): Set<string> {
    const taken = new Set(this.takenIds);
    if (this.initialReadableId) taken.delete(this.initialReadableId);
    return taken;
  }

  private syncSlugFromName(): void {
    const trimmed = this.name.trim();
    if (!trimmed) {
      this.readableId = '';
      return;
    }
    this.readableId = generateProjectSlug(trimmed, this.takenIdsForSlug());
  }

  private validateReadableId(id: string): string | null {
    if (!id) return null;
    try {
      validateProjectId(id);
    } catch {
      if (id === CAS_NAMESPACE_ROOT) return 'This project ID is reserved';
      return 'Project ID may only contain lowercase letters, numbers, and hyphens';
    }
    if (this.isDuplicate(id)) return 'This project ID is already in use';
    return null;
  }

  private isDuplicate(id: string): boolean {
    return id !== this.initialReadableId && this.takenIds.has(id);
  }

  private handleOverlayClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.close();
    }
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.close();
    }
  }

  private handleNameInput(event: Event): void {
    this.name = (event.target as HTMLInputElement).value;
  }

  private handleIdInput(event: Event): void {
    if (this.readonlyId) return;
    this.idManuallyEdited = true;
    this.readableId = (event.target as HTMLInputElement).value.toLowerCase();
  }

  private handleDescriptionInput(event: Event): void {
    this.description = (event.target as HTMLTextAreaElement).value;
  }

  private async handleSubmit(event: Event): Promise<void> {
    event.preventDefault();
    const name = this.name.trim();
    if (!name) return;

    await (this.takenIdsPromise ?? Promise.resolve());

    const readableId = this.readableId.trim();
    if (!readableId) {
      this.idError = 'Project ID is required';
      this.idInput?.focus();
      return;
    }

    this.idError = this.validateReadableId(readableId);
    if (this.idError) {
      this.idInput?.focus();
      return;
    }

    const detail: ProjectCreateEventDetail = {
      name,
      description: this.description.trim(),
      readableId,
    };

    if (this.mode === 'edit') {
      this.dispatchEvent(
        new CustomEvent<ProjectEditEventDetail>('project-edit', {
          detail: { ...detail, projectId: this.projectId },
          bubbles: true,
          composed: true,
        }),
      );
      return;
    }

    this.dispatchEvent(
      new CustomEvent<ProjectCreateEventDetail>('project-create', {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private close(): void {
    this.dispatchEvent(new CustomEvent('modal-close', { bubbles: true, composed: true }));
  }

  render() {
    if (!this.open) return html``;

    const title = this.mode === 'edit' ? 'Edit Project' : 'New Project';
    const submitLabel = this.mode === 'edit' ? 'Save Project' : 'Create Project';
    const idHintId = 'project-id-hint';
    const errorId = 'project-id-error';
    const describedBy = this.idError ? `${idHintId} ${errorId}` : idHintId;

    return html`
      <div
        class="project-modal"
        @click=${this.handleOverlayClick}
        @keydown=${this.handleKeydown}
      >
        <div class="panel" role="dialog" aria-modal="true" aria-label=${title}>
          <h2>${title}</h2>
          <form @submit=${this.handleSubmit}>
            <label for="project-id-input">Project ID</label>
            <input
              id="project-id-input"
              type="text"
              .value=${this.readableId}
              pattern="[a-z0-9-]*"
              ?required=${!this.readonlyId}
              ?readonly=${this.readonlyId}
              ?disabled=${this.readonlyId}
              autocomplete="off"
              aria-describedby=${describedBy}
              .aria-invalid=${this.idError ? 'true' : 'false'}
              @input=${this.handleIdInput}
            />
            <p id=${idHintId} class="help-text">
              Lowercase letters, numbers, and hyphens only.
            </p>
            ${this.idError ? html`<p id=${errorId} class="field-error">${this.idError}</p>` : ''}

            <label for="project-name-input">Project name</label>
            <input
              id="project-name-input"
              type="text"
              .value=${this.name}
              placeholder="e.g. session-analyzer"
              required
              @input=${this.handleNameInput}
            />

            <label for="project-description-input">Description (optional)</label>
            <textarea
              id="project-description-input"
              .value=${this.description}
              placeholder="What is this project about?"
              @input=${this.handleDescriptionInput}
            ></textarea>

            <div class="actions">
              <button type="button" class="secondary" @click=${this.close}>Cancel</button>
              <button
                type="submit"
                class="primary"
                ?disabled=${
                  this.name.trim().length === 0 || this.idError !== null || this.isLoadingTaken
                }
              >
                ${submitLabel}
              </button>
            </div>
          </form>
        </div>
      </div>
    `;
  }
}

/** Slugifies a project name and resolves collisions with the supplied set. */
function generateProjectSlug(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'project';
  if (!taken.has(base)) return base;
  let counter = 2;
  while (taken.has(`${base}-${counter}`)) counter++;
  return `${base}-${counter}`;
}

declare global {
  interface HTMLElementTagNameMap {
    'project-modal': ProjectModal;
  }
}
