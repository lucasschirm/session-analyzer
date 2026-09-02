import LitTypeahead, { type TypeaheadItem } from '@lucasschirm/litjs-typeahead';
import { css, html, LitElement, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { dbClient } from '../db/db-client';
import { navigateTo } from '../router';
import { type SyncManagerSnapshot, syncManager } from '../sync/sync-manager';
import type { Project } from '../types';

// Register the <lit-typeahead> custom element.
void LitTypeahead;

/**
 * Header project selector.
 *
 * Wraps `<lit-typeahead>` with an "All" default option and the list of
 * projects loaded from the control database. Selecting a project navigates
 * to `/#/projects/<slug>`; selecting "All" navigates to `/#/`. The selector
 * is only rendered when at least one project exists.
 *
 * The `value` property mirrors the currently selected project slug (or `''`
 * for "All"). Callers can set it to keep the selector in sync with the
 * current route without triggering navigation.
 */
@customElement('header-project-selector')
export class HeaderProjectSelector extends LitElement {
  static styles = css`
    :host {
      display: inline-block;
      min-width: 220px;
    }

    lit-typeahead {
      width: 100%;
    }
  `;

  /** Currently selected project slug (`''` = "All"). Setting it does NOT navigate. */
  @property({ type: String }) value = '';

  /** Whether the selector should be shown (true once projects are loaded). */
  @property({ type: Boolean }) hidden = false;

  @state() private projects: Project[] = [];

  @state() private syncSnapshot: SyncManagerSnapshot | null = null;

  private loadingLock = false;

  connectedCallback(): void {
    super.connectedCallback();
    this.syncSnapshot = syncManager.getSnapshot();
    syncManager.addEventListener('change', this.handleSyncChange);
    void this.loadProjects();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    syncManager.removeEventListener('change', this.handleSyncChange);
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('value')) {
      // Mirror the value onto the underlying typeahead so its input shows the
      // matching label when the value is set externally (e.g. on route change).
      const typeahead = this.renderRoot?.querySelector('lit-typeahead');
      if (typeahead) {
        (typeahead as LitTypeahead).value = this.value;
      }
    }
  }

  private handleSyncChange = (event: Event): void => {
    const wasRunning = this.isRunActive(this.syncSnapshot);
    const prevProjectIds = new Set(this.syncSnapshot?.projects.map((p) => p.localProjectId) ?? []);
    const prevSessionCount = this.syncSnapshot?.sessions.length ?? 0;
    this.syncSnapshot = (event as CustomEvent<SyncManagerSnapshot>).detail;
    const runEnded = wasRunning && !this.isRunActive(this.syncSnapshot);
    const hasNewProjects =
      this.syncSnapshot?.projects.some((p) => !prevProjectIds.has(p.localProjectId)) ?? false;
    const sessionCount = this.syncSnapshot?.sessions.length ?? 0;
    const hasNewSessions = sessionCount > prevSessionCount;
    if (runEnded || hasNewProjects || hasNewSessions) {
      void this.loadProjects();
    }
  };

  private isRunActive(snapshot: SyncManagerSnapshot | null): boolean {
    if (!snapshot?.activeRun) return false;
    return snapshot.activeRun.state === 'running' || snapshot.activeRun.state === 'queued';
  }

  private async loadProjects(): Promise<void> {
    if (this.loadingLock) return;
    this.loadingLock = true;
    try {
      await dbClient.ensureReady();
      this.projects = await dbClient.getProjects();
    } catch {
      // Non-fatal: the selector simply stays hidden until projects load.
    } finally {
      this.loadingLock = false;
    }
  }

  private get items(): TypeaheadItem[] {
    return [
      { label: 'All', value: '' },
      ...this.projects.map((project) => ({
        label: project.name,
        value: project.readable_id || project.id,
      })),
    ];
  }

  private handleChange(event: CustomEvent<{ value: string }>): void {
    const selected = event.detail.value;
    this.value = selected;
    if (selected) {
      navigateTo(`/projects/${selected}`);
    } else {
      navigateTo('/');
    }
  }

  render() {
    if (this.hidden || this.projects.length === 0) return null;
    return html`
      <lit-typeahead
        .items=${this.items}
        .value=${this.value}
        placeholder="All projects"
        @change=${this.handleChange}
      ></lit-typeahead>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'header-project-selector': HeaderProjectSelector;
  }
}
