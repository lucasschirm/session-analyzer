import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import type { Project } from '../types';

/**
 * Project selector dropdown.
 *
 * Input component: receives `value` (selected project id) as a property and
 * emits `value-changed` with the newly selected id. Internal selection state
 * is only mirrored from the property, never mutated in place.
 */
@customElement('project-selector')
export class ProjectSelector extends LitElement {
  static styles = css`
    :host {
      display: inline-block;
    }

    .project-selector {
      padding: 8px 12px;
      font-size: 14px;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      background: var(--md-sys-color-surface, #171a21);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      min-width: 220px;
    }

    .project-selector:focus-visible {
      outline: 2px solid var(--md-sys-color-primary, #4f8cff);
      outline-offset: 1px;
    }
  `;

  @property({ type: Array }) projects: Project[] = [];

  @property({ type: String }) value = '';

  private handleChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.dispatchEvent(
      new CustomEvent('value-changed', {
        detail: { value: target.value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    return html`
      <select
        class="project-selector"
        .value=${this.value}
        @change=${this.handleChange}
      >
        <option value="">Select a project</option>
        ${repeat(
          this.projects,
          (project) => project.id,
          (project) => html`
            <option value="${project.id}">
              ${project.name} (${project.session_count} session${project.session_count === 1 ? '' : 's'})
            </option>
          `,
        )}
      </select>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'project-selector': ProjectSelector;
  }
}
