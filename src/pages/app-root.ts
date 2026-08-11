import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Router } from '@lit-labs/router';
import type { RouteConfig } from '@lit-labs/router';
import { dbManager } from '../db/database';
import type { Project, DashboardSession, SessionMetrics, ParsedSession } from '../types';

/**
 * Main App Component with Routing
 */
@customElement('app-root')
export class AppRoot extends LitElement {
  private router = new Router(this, [
    { path: '/', render: () => this.renderHome() },
    { path: '/projects', render: () => this.renderProjects() },
    { path: '/projects/:id', render: (params: Record<string, string>) => this.renderProjectDetail(params.id) },
    { path: '/sessions/:id', render: (params: Record<string, string>) => this.renderSessionDetail(params.id) },
    { path: '/upload', render: () => this.renderUpload() },
  ] as RouteConfig[]);

  @state() private projects: Project[] = [];
  @state() private selectedProjectId = '';
  @state() private currentSession: DashboardSession | null = null;
  @state() private metrics: SessionMetrics | null = null;
  @state() private isLoading = false;
  @state() private error: string | null = null;
  @state() private currentPath = '/';

  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: var(--md-sys-color-background, #fafafa);
      color: var(--md-sys-color-on-background, #333);
    }

    header {
      background: var(--md-sys-color-surface, #fff);
      padding: 16px 24px;
      border-bottom: 1px solid var(--md-sys-color-outline, #e0e0e0);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .logo {
      font-size: 20px;
      font-weight: 700;
      color: var(--md-sys-color-primary, #1976d2);
      text-decoration: none;
    }

    nav {
      display: flex;
      gap: 16px;
    }

    nav a {
      color: var(--md-sys-color-on-surface-variant, #666);
      text-decoration: none;
      padding: 8px 16px;
      border-radius: 8px;
      transition: background-color 0.2s;
    }

    nav a:hover {
      background: var(--md-sys-color-surface-container, #f5f5f5);
    }

    nav a.active {
      background: var(--md-sys-color-primary-container, #bbdefb);
      color: var(--md-sys-color-on-primary-container, #0d47a1);
    }

    main {
      padding: 24px;
      max-width: 1200px;
      margin: 0 auto;
    }

    .error {
      background: var(--md-sys-color-error-container, #ffcdd2);
      color: var(--md-sys-color-on-error-container, #b71c1c);
      padding: 16px;
      border-radius: 8px;
      margin-bottom: 16px;
    }

    .loading {
      text-align: center;
      padding: 48px;
      color: var(--md-sys-color-on-surface-variant, #666);
    }

    button {
      background: var(--md-sys-color-primary, #1976d2);
      color: white;
      border: none;
      padding: 12px 24px;
      border-radius: 8px;
      font-size: 14px;
      cursor: pointer;
      transition: background-color 0.2s;
    }

    button:hover {
      background: var(--md-sys-color-primary-dark, #1565c0);
    }

    button.secondary {
      background: var(--md-sys-color-secondary-container, #e8eaf6);
      color: var(--md-sys-color-on-secondary-container, #1a237e);
    }
  `;

  async firstUpdated() {
    await this.initializeDatabase();
    // Track current path for active link styling
    this.currentPath = window.location.pathname;
    window.addEventListener('popstate', () => {
      this.currentPath = window.location.pathname;
    });
  }

  private navigate(path: string) {
    window.history.pushState({}, '', path);
    this.currentPath = path;
    this.router.goto(path);
  }

  private async initializeDatabase() {
    try {
      this.isLoading = true;
      await dbManager.initialize();
      await this.loadProjects();
    } catch (e) {
      this.error = `Failed to initialize database: ${(e as Error).message}`;
    } finally {
      this.isLoading = false;
    }
  }

  private async loadProjects() {
    try {
      this.projects = await dbManager.getProjects();
    } catch (e) {
      this.error = `Failed to load projects: ${(e as Error).message}`;
    }
  }

  render() {
    return html`
      <header>
        <a href="/" class="logo">Session Analyzer</a>
        <nav>
          <a href="/" class=${this.currentPath === '/' ? 'active' : ''}>Home</a>
          <a href="/projects" class=${this.currentPath.startsWith('/projects') ? 'active' : ''}>Projects</a>
          <a href="/upload" class=${this.currentPath === '/upload' ? 'active' : ''}>Upload</a>
        </nav>
      </header>

      <main>
        ${this.error ? html`<div class="error">${this.error}</div>` : ''}
        ${this.isLoading ? html`<div class="loading">Loading...</div>` : this.router.outlet()}
      </main>
    `;
  }

  private renderHome() {
    return html`
      <h1>Welcome to Session Analyzer</h1>
      <p>Visualize and manage your agentic coding sessions offline.</p>
      
      <div style="margin-top: 24px;">
        <button @click=${() => this.navigate('/projects')}>View Projects</button>
        <button class="secondary" style="margin-left: 8px;" @click=${() => this.navigate('/upload')}>
          Upload Session
        </button>
      </div>

      ${this.projects.length > 0 ? html`
        <h2 style="margin-top: 32px;">Recent Projects</h2>
        <project-selector 
          .projects=${this.projects}
          .selectedProjectId=${this.selectedProjectId}
          @project-change=${(e: CustomEvent) => {
            this.selectedProjectId = e.detail.projectId;
            if (e.detail.projectId) {
              this.navigate(`/projects/${e.detail.projectId}`);
            }
          }}
        ></project-selector>
      ` : html`
        <p style="margin-top: 24px; color: #666;">No projects yet. Create one to get started!</p>
      `}
    `;
  }

  private renderProjects() {
    return html`
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
        <h1>Projects</h1>
        <button @click=${() => this.createProject()}>+ New Project</button>
      </div>

      ${this.projects.length === 0 
        ? html`<p>No projects found. Create your first project!</p>`
        : html`
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px;">
            ${this.projects.map(project => html`
              <div 
                style="padding: 16px; background: white; border: 1px solid #e0e0e0; border-radius: 8px; cursor: pointer;"
                @click=${() => this.navigate(`/projects/${project.id}`)}
              >
                <h3 style="margin: 0 0 8px 0;">${project.name}</h3>
                <p style="margin: 0; color: #666; font-size: 14px;">
                  ${project.session_count} sessions • Updated ${new Date(project.updated_at).toLocaleDateString()}
                </p>
              </div>
            `)}
          </div>
        `}
    `;
  }

  private async createProject() {
    const name = prompt('Enter project name:');
    if (!name) return;

    try {
      const project: Project = {
        id: `project-${Date.now()}`,
        name,
        created_at: Date.now(),
        updated_at: Date.now(),
        session_count: 0,
      };
      await dbManager.createProject(project);
      await this.loadProjects();
    } catch (e) {
      this.error = `Failed to create project: ${(e as Error).message}`;
    }
  }

  private async renderProjectDetail(projectId: string) {
    try {
      const project = await dbManager.getProject(projectId);
      if (!project) {
        return html`<p>Project not found</p>`;
      }

      const sessions = await dbManager.getSessionsByProject(projectId);
      const metrics = await dbManager.getProjectMetrics(projectId);

      return html`
        <div style="margin-bottom: 24px;">
          <a href="/projects" style="color: #1976d2; text-decoration: none;">← Back to Projects</a>
        </div>

        <h1>${project.name}</h1>
        
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin: 24px 0;">
          <metrics-card 
            label="Total Sessions" 
            value="${metrics.total_sessions.toString()}"
            icon="📊"
          ></metrics-card>
          <metrics-card 
            label="Total Tokens" 
            value="${metrics.total_input_tokens + metrics.total_output_tokens}".toLocaleString()
            icon="🔤"
          ></metrics-card>
          <metrics-card 
            label="Tool Executions" 
            value="${metrics.total_tool_executions.toString()}"
            icon="🛠️"
          ></metrics-card>
          <metrics-card 
            label="Est. Cost" 
            value="$${metrics.total_cost_usd.toFixed(4)}"
            icon="💰"
          ></metrics-card>
        </div>

        <h2>Sessions</h2>
        <session-list 
          .sessions=${sessions}
          @session-click=${(e: CustomEvent) => {
            this.navigate(`/sessions/${e.detail.sessionId}`);
          }}
        ></session-list>

        <div style="margin-top: 24px;">
          <button @click=${() => this.navigate('/upload')}>Upload Session</button>
          <button class="secondary" style="margin-left: 8px;" @click=${() => this.exportData()}>
            Export Data
          </button>
        </div>
      `;
    } catch (e) {
      return html`<p>Error loading project: ${(e as Error).message}</p>`;
    }
  }

  private async renderSessionDetail(sessionId: string) {
    try {
      const session = await dbManager.getSession(sessionId);
      if (!session) {
        return html`<p>Session not found</p>`;
      }

      return html`
        <div style="margin-bottom: 24px;">
          <a href="/projects" style="color: #1976d2; text-decoration: none;">← Back to Projects</a>
        </div>

        <h1>Session Details</h1>
        
        <div style="background: white; padding: 16px; border-radius: 8px; border: 1px solid #e0e0e0; margin-bottom: 24px;">
          <p><strong>Source:</strong> ${session.source}</p>
          <p><strong>Model:</strong> ${session.model || 'N/A'}</p>
          <p><strong>Started:</strong> ${new Date(session.started_at).toLocaleString()}</p>
          <p><strong>Duration:</strong> ${((session.ended_at - session.started_at) / 1000).toFixed(1)}s</p>
          <p><strong>Input Tokens:</strong> ${session.input_tokens.toLocaleString()}</p>
          <p><strong>Output Tokens:</strong> ${session.output_tokens.toLocaleString()}</p>
          <p><strong>Total Tokens:</strong> ${session.total_tokens.toLocaleString()}</p>
          ${session.cost_usd ? html`<p><strong>Cost:</strong> $${session.cost_usd.toFixed(4)}</p>` : ''}
        </div>

        <h2>Tool Executions (${session.tool_executions.length})</h2>
        ${session.tool_executions.length > 0 
          ? html`
            <events-table 
              .events=${session.tool_executions.map(te => ({
                id: te.id,
                timestamp: te.timestamp,
                event_type: te.tool_name,
                description: te.target || '',
              }))}
            ></events-table>
          ` 
          : html`<p>No tool executions recorded</p>`}

        <h2 style="margin-top: 24px;">Events (${session.events.length})</h2>
        <events-table 
          .events=${session.events}
          .showMetadata=${true}
        ></events-table>
      `;
    } catch (e) {
      return html`<p>Error loading session: ${(e as Error).message}</p>`;
    }
  }

  private renderUpload() {
    return html`
      <h1>Upload Session</h1>
      
      <div style="max-width: 600px;">
        <p style="color: #666; margin-bottom: 24px;">
          Upload session files from Claude, Agentic Pi, Antigravity, OpenCode/Codex, MCP, or local runners.
        </p>

        <div style="margin-bottom: 16px;">
          <label style="display: block; margin-bottom: 8px;"><strong>Select Project:</strong></label>
          <project-selector 
            .projects=${this.projects}
            .selectedProjectId=${this.selectedProjectId}
            @project-change=${(e: CustomEvent) => {
              this.selectedProjectId = e.detail.projectId;
            }}
          ></project-selector>
        </div>

        <div style="border: 2px dashed #e0e0e0; padding: 32px; text-align: center; border-radius: 8px; margin-bottom: 16px;">
          <input 
            type="file" 
            id="fileInput" 
            accept=".json,.jsonl"
            style="display: none;"
            @change=${(e: Event) => this.handleFileUpload(e)}
          />
          <label for="fileInput" style="cursor: pointer;">
            <span style="font-size: 48px;">📁</span>
            <p>Click to select file or drag and drop</p>
          </label>
        </div>

        <button 
          @click=${() => document.getElementById('fileInput')?.click()}
          :disabled=${!this.selectedProjectId}
        >
          Select File
        </button>
      </div>
    `;
  }

  private async handleFileUpload(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !this.selectedProjectId) return;

    try {
      this.isLoading = true;
      this.error = null;

      const content = await file.text();
      
      // Create Web Worker for parsing
      const worker = new Worker(
        new URL('../workers/session-parser.worker.ts', import.meta.url),
        { type: 'module' }
      );

      // Send parse request to worker
      worker.postMessage({
        type: 'parse',
        payload: content,
        projectId: this.selectedProjectId,
      });

      // Wait for result from worker
      const result = await new Promise<ParsedSession>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent) => {
          if (e.data.type === 'result') {
            resolve(e.data.result);
          } else {
            reject(new Error('Unexpected worker response'));
          }
        };
        worker.onerror = (e) => {
          reject(new Error(`Worker error: ${e.message}`));
        };
        // Timeout after 30 seconds
        setTimeout(() => reject(new Error('Worker timeout')), 30000);
      });

      // Terminate worker
      worker.terminate();

      if (result.parseErrors.length > 0) {
        console.warn('Parse warnings:', result.parseErrors);
      }

      await dbManager.saveSession(result.session);
      await this.loadProjects();
      
      alert('Session uploaded successfully!');
      this.navigate(`/projects/${this.selectedProjectId}`);
    } catch (e) {
      this.error = `Failed to upload session: ${(e as Error).message}`;
    } finally {
      this.isLoading = false;
      input.value = '';
    }
  }

  private async exportData() {
    try {
      const exportData = await dbManager.exportDatabase();
      const blob = new Blob([exportData], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `session-export-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      this.error = `Failed to export data: ${(e as Error).message}`;
    }
  }
}
