import type { ProjectListItem } from '@lucasschirm/sal-db';
import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

export interface ProjectWorkspaceValue {
  readonly projectId: string;
  readonly isNewProject: boolean;
  readonly workspaceId: string;
  readonly sessionId: string;
}

/**
 * Project, workspace, and session identity inputs for a manual import.
 *
 * The user selects an existing canonical project or names a new one, optionally
 * enters a workspace, and confirms the native session id derived from the
 * uploaded transcript.
 */
@customElement('manual-import-project-workspace')
export class ManualImportProjectWorkspace extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .project-workspace {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    label {
      font-size: 13px;
      font-weight: 600;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    input,
    select {
      padding: 10px 12px;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      background: var(--md-sys-color-surface, #171a21);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      font-size: 14px;
    }

    input:focus-visible,
    select:focus-visible {
      outline: 2px solid var(--md-sys-color-primary, #4f8cff);
      outline-offset: 1px;
    }

    .new-project-row {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .hint {
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }
  `;

  @property({ type: Array }) projects: ProjectListItem[] = [];

  @property({ type: String }) projectId = '';

  @property({ type: Boolean }) isNewProject = false;

  @property({ type: String }) newProjectName = '';

  @property({ type: String }) workspaceId = '';

  @property({ type: String }) sessionId = '';

  private emitChange(overrides: Partial<ProjectWorkspaceValue> = {}): void {
    const value: ProjectWorkspaceValue = {
      projectId: this.isNewProject ? this.newProjectName : this.projectId,
      isNewProject: this.isNewProject,
      workspaceId: this.workspaceId,
      sessionId: this.sessionId,
      ...overrides,
    };
    this.dispatchEvent(
      new CustomEvent('value-changed', {
        detail: { value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleProjectSelect(event: Event): void {
    const target = event.target as HTMLSelectElement;
    const value = target.value;
    if (value === '__new__') {
      this.isNewProject = true;
      this.projectId = '';
    } else {
      this.isNewProject = false;
      this.projectId = value;
      this.newProjectName = '';
    }
    this.emitChange();
  }

  private handleNewProjectInput(event: Event): void {
    this.newProjectName = (event.target as HTMLInputElement).value;
    this.emitChange({ projectId: this.newProjectName });
  }

  private handleWorkspaceInput(event: Event): void {
    this.workspaceId = (event.target as HTMLInputElement).value;
    this.emitChange();
  }

  private handleSessionInput(event: Event): void {
    this.sessionId = (event.target as HTMLInputElement).value;
    this.emitChange();
  }

  render() {
    return html`
      <div class="project-workspace">
        <div class="field">
          <label for="project-select">Project</label>
          <select id="project-select" .value=${this.isNewProject ? '__new__' : this.projectId} @change=${this.handleProjectSelect}>
            <option value="">Select a project</option>
            ${repeat(
              this.projects,
              (project) => project.projectId,
              (project) => html`
                <option value="${project.name}" ?selected=${this.projectId === project.name}>
                  ${project.name} (${project.sessionCount} sessions)
                </option>
              `,
            )}
            <option value="__new__">+ New project</option>
          </select>
          ${
            this.isNewProject
              ? html`
                <div class="new-project-row">
                  <input
                    type="text"
                    placeholder="New project name"
                    .value=${this.newProjectName}
                    @input=${this.handleNewProjectInput}
                  />
                </div>
              `
              : ''
          }
        </div>

        <div class="field">
          <label for="workspace-input">Workspace (optional)</label>
          <input
            id="workspace-input"
            type="text"
            placeholder="e.g. default"
            .value=${this.workspaceId}
            @input=${this.handleWorkspaceInput}
          />
        </div>

        <div class="field">
          <label for="session-input">Session id</label>
          <input
            id="session-input"
            type="text"
            .value=${this.sessionId}
            @input=${this.handleSessionInput}
          />
          <span class="hint">Derived from the transcript file name; edit if needed.</span>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'manual-import-project-workspace': ManualImportProjectWorkspace;
  }
}
