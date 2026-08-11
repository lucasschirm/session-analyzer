import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { dbClient } from '../db/db-client';
import { navigateTo } from '../router';
import { parseInWorker } from '../workers/parser-client';
import type { DashboardSession, Project } from '../types';
import '../components/metrics-card';
import '../components/session-list';
import '../components/upload-zone';

/**
 * Project View: session upload + session list for one project.
 *
 * Split layout with a drag-and-drop upload zone at the top, a search bar
 * (filters by session title or transcript content) and the sessions list
 * below, sorted by date descending.
 */
@customElement('project-view')
export class ProjectView extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .project-view {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .back-link {
      color: var(--md-sys-color-primary, #4f8cff);
      text-decoration: none;
      font-size: 14px;
    }

    .back-link:hover {
      text-decoration: underline;
    }

    h1 {
      margin: 4px 0 0;
      font-size: 24px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .project-description {
      margin: 4px 0 0;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-size: 14px;
    }

    .metrics-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }

    .sessions-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    h2 {
      margin: 0;
      font-size: 18px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .search-input {
      padding: 9px 14px;
      font-size: 14px;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      background: var(--md-sys-color-surface, #171a21);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      min-width: 260px;
    }

    .search-input:focus-visible {
      outline: 2px solid var(--md-sys-color-primary, #4f8cff);
      outline-offset: 1px;
    }

    .error {
      background: var(--md-sys-color-error-container, #5c2626);
      color: var(--md-sys-color-on-error-container, #ffb4ab);
      padding: 12px 16px;
      border-radius: 8px;
    }

    .notice {
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 13px;
    }
  `;

  @property({ type: String, attribute: 'project-id' }) projectId = '';

  @state() private project: Project | null = null;

  @state() private sessions: DashboardSession[] = [];

  @state() private totalTokens = 0;

  @state() private totalToolExecutions = 0;

  @state() private searchQuery = '';

  @state() private isLoading = true;

  @state() private isUploading = false;

  @state() private error: string | null = null;

  willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('projectId') && this.projectId) {
      void this.loadData();
    }
  }

  private async loadData(): Promise<void> {
    this.isLoading = true;
    try {
      const [project, sessions, metrics] = await Promise.all([
        dbClient.getProject(this.projectId),
        dbClient.getSessionsByProject(this.projectId),
        dbClient.getProjectMetrics(this.projectId),
      ]);
      this.project = project;
      this.sessions = sessions;
      this.totalTokens = metrics.total_input_tokens + metrics.total_output_tokens;
      this.totalToolExecutions = metrics.total_tool_executions;
      this.error = null;
    } catch (error) {
      this.error = `Failed to load project: ${(error as Error).message}`;
    } finally {
      this.isLoading = false;
    }
  }

  private async handleFilesSelected(event: CustomEvent<{ files: File[] }>): Promise<void> {
    const { files } = event.detail;
    this.isUploading = true;
    this.error = null;

    try {
      for (const file of files) {
        const content = await file.text();
        const parsed = await parseInWorker(content, {
          projectId: this.projectId,
          title: file.name,
        });

        if (parsed.parseErrors.length > 0 && parsed.session.total_tokens === 0 &&
            parsed.session.tool_executions.length === 0 && parsed.session.events.length === 0) {
          throw new Error(
            `Could not parse "${file.name}": ${parsed.parseErrors[0]?.message ?? 'unknown format'}`
          );
        }

        await dbClient.saveSession(parsed.session);
      }
      await this.loadData();
    } catch (error) {
      this.error = `Upload failed: ${(error as Error).message}`;
    } finally {
      this.isUploading = false;
    }
  }

  private async handleSearchInput(event: Event): Promise<void> {
    const query = (event.target as HTMLInputElement).value;
    this.searchQuery = query;

    try {
      this.sessions = query.trim()
        ? await dbClient.searchSessions(this.projectId, query.trim())
        : await dbClient.getSessionsByProject(this.projectId);
    } catch (error) {
      this.error = `Search failed: ${(error as Error).message}`;
    }
  }

  private handleSessionClick(event: CustomEvent<{ sessionId: string }>): void {
    navigateTo(`/sessions/${event.detail.sessionId}`);
  }

  render() {
    if (!this.project && !this.isLoading) {
      return html`
        <div class="project-view">
          <a class="back-link" href="#/">← Back to Projects</a>
          <p class="notice">Project not found.</p>
        </div>
      `;
    }

    return html`
      <div class="project-view">
        <a class="back-link" href="#/">← Back to Projects</a>

        <div>
          <h1>${this.project?.name ?? 'Project'}</h1>
          ${this.project?.description
            ? html`<p class="project-description">${this.project.description}</p>`
            : ''}
        </div>

        ${this.error ? html`<div class="error">${this.error}</div>` : ''}
        ${this.isUploading ? html`<p class="notice">Parsing and saving session files…</p>` : ''}

        <upload-zone
          ?disabled=${this.isUploading}
          @files-selected=${this.handleFilesSelected}
        ></upload-zone>

        <div class="metrics-row">
          <metrics-card
            label="Sessions"
            value="${this.project?.session_count ?? 0}"
            icon="📊"
          ></metrics-card>
          <metrics-card
            label="Total Tokens"
            value="${this.totalTokens.toLocaleString()}"
            icon="🔤"
          ></metrics-card>
          <metrics-card
            label="Tool Executions"
            value="${this.totalToolExecutions.toLocaleString()}"
            icon="🛠️"
          ></metrics-card>
        </div>

        <div class="sessions-header">
          <h2>Sessions</h2>
          <input
            class="search-input"
            type="search"
            placeholder="Search by title or message content…"
            aria-label="Search sessions"
            .value=${this.searchQuery}
            @input=${this.handleSearchInput}
          />
        </div>

        ${this.isLoading
          ? html`<p class="notice">Loading sessions…</p>`
          : html`
            <session-list
              .sessions=${this.sessions}
              @session-click=${this.handleSessionClick}
            ></session-list>
          `}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'project-view': ProjectView;
  }
}
