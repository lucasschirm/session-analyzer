import type {
  IngestionReceipt,
  ManualIngestionDetection,
  ProjectListItem,
} from '@lucasschirm/sal-db';
import { css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { PageLitElement, pageHostStyles } from '../page-lit-element';
import '../../components/manual-import/manual-import-harness-selector';
import '../../components/manual-import/manual-import-project-workspace';
import '../../components/manual-import/manual-import-state';
import '../../components/manual-import/manual-import-upload';
import type { ProjectWorkspaceValue } from '../../components/manual-import/manual-import-project-workspace';
import type { ManualImportPhase } from '../../components/manual-import/manual-import-state';
import type { ManualUploadSelection } from '../../components/manual-import/manual-import-upload';
import type {
  ManualArtifactPayload,
  ManualIngestionBundleRequest,
} from '../../db/analytics-client';
import { AnalyticsClient } from '../../db/analytics-client';
import type { UploadedFile } from '../../lib/uploaded-file';
import { navigateTo } from '../../router';

/**
 * Manual import/enrichment page.
 *
 * Accepts transcript-only or partial session uploads, records harness
 * choice/detection evidence, lets the user pick the canonical project and
 * workspace, and commits the bundle as a partial snapshot. Conflicts are
 * surfaced for explicit user resolution rather than silently replaced.
 */
@customElement('manual-import-page')
export class ManualImportPage extends PageLitElement {
  static styles = [
    pageHostStyles,
    css`
    .manual-import-page {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .page-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
    }

    h1 {
      margin: 0;
      font-size: 24px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .section {
      background: var(--md-sys-color-surface, #171a21);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 12px;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .section-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      margin: 0;
    }

    .file-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .file-list li {
      font-size: 13px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }

    .file-path {
      color: var(--md-sys-color-on-surface, #e6e9ef);
      word-break: break-all;
    }

    .actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
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

    button.primary:hover:not(:disabled) {
      filter: brightness(1.1);
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

    button.secondary:hover {
      background: var(--md-sys-color-surface-container-hover, #262d3a);
    }

    .error {
      background: var(--md-sys-color-error-container, #5c2626);
      color: var(--md-sys-color-on-error-container, #ffb4ab);
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 14px;
    }
  `,
  ];

  client: AnalyticsClient = new AnalyticsClient();

  @state() private files: UploadedFile[] = [];

  @state() private artifactPayloads: ManualArtifactPayload[] = [];

  @state() private detection: ManualIngestionDetection | null = null;

  @state() private selectedHarness = '';

  @state() private projects: ProjectListItem[] = [];

  @state() private projectId = '';

  @state() private isNewProject = false;

  @state() private newProjectName = '';

  @state() private workspaceId = '';

  @state() private sessionId = '';

  @state() private phase: ManualImportPhase = 'idle';

  @state() private receipt: IngestionReceipt | null = null;

  @state() private error = '';

  private pendingBundle: ManualIngestionBundleRequest | null = null;

  private isProcessingFiles = false;

  private hasPendingFiles = false;

  async firstUpdated(): Promise<void> {
    await this.loadProjects();
  }

  private async loadProjects(): Promise<void> {
    try {
      const page = await this.client.portfolio.getProjectList({});
      this.projects = [...page.items];
    } catch (err) {
      this.error = `Failed to load projects: ${(err as Error).message}`;
    }
  }

  private async handleFilesSelected(event: CustomEvent<ManualUploadSelection>): Promise<void> {
    const { files } = event.detail;

    // Accumulate repeated rapid drops instead of replacing the previous set.
    // Deduplicate by relative path so the same file dropped twice does not
    // appear twice in the list.
    const existingPaths = new Set(this.files.map((uploaded) => uploaded.relativePath));
    const newFiles = files.filter((uploaded) => !existingPaths.has(uploaded.relativePath));
    this.files = [...this.files, ...newFiles];
    this.receipt = null;
    this.error = '';

    if (this.isProcessingFiles) {
      this.hasPendingFiles = true;
      return;
    }

    await this.processFiles();
  }

  private async processFiles(): Promise<void> {
    this.isProcessingFiles = true;

    try {
      do {
        this.hasPendingFiles = false;
        this.phase = 'detecting';
        this.detection = null;
        this.selectedHarness = '';
        this.artifactPayloads = await this.readArtifacts(this.files);
        this.sessionId = this.deriveSessionId(this.files);

        if (this.artifactPayloads.length === 0) {
          this.phase = 'idle';
          this.error = 'No supported files were uploaded.';
          return;
        }

        await this.applyDetection();
      } while (this.hasPendingFiles);
    } finally {
      this.isProcessingFiles = false;
    }
  }

  private async applyDetection(): Promise<void> {
    try {
      const detection = await this.client.manual.detect(this.artifactPayloads);
      this.detection = detection;
      if (detection.kind === 'matched' && detection.harness) {
        this.selectedHarness = detection.harness;
        this.phase = 'ready';
      } else if (detection.kind === 'ambiguous') {
        this.selectedHarness = '';
        this.phase = 'ready';
      } else {
        this.selectedHarness = '';
        this.error = detection.reason ?? 'No harness matched these files.';
        this.phase = 'unsupported';
      }
    } catch (err) {
      this.error = `Detection failed: ${(err as Error).message}`;
      this.phase = 'unavailable';
    }
  }

  private async readArtifacts(files: UploadedFile[]): Promise<ManualArtifactPayload[]> {
    const payloads: ManualArtifactPayload[] = [];
    for (const { file, relativePath } of files) {
      try {
        const content = await file.text();
        const mediaType = this.inferMediaType(relativePath);
        payloads.push({ relativePath, mediaType, content });
      } catch (err) {
        this.error = `Failed to read ${relativePath}: ${(err as Error).message}`;
      }
    }
    return payloads;
  }

  private inferMediaType(relativePath: string): string {
    const normalized = relativePath.toLowerCase();
    if (normalized.endsWith('.jsonl')) return 'application/jsonl';
    if (normalized.endsWith('.json')) return 'application/json';
    if (normalized.endsWith('.md')) return 'text/markdown';
    if (normalized.endsWith('.log')) return 'text/plain';
    return 'application/octet-stream';
  }

  private deriveSessionId(files: UploadedFile[]): string {
    const transcript = files.find(({ relativePath }) => /\.jsonl$/i.test(relativePath));
    const target = transcript ?? files[0];
    if (!target) return '';
    const base = target.file.name.replace(/\.[^.]+$/, '');
    return base;
  }

  private handleProjectWorkspaceChanged(
    event: CustomEvent<{ value: ProjectWorkspaceValue }>,
  ): void {
    const { value } = event.detail;
    this.projectId = value.projectId;
    this.isNewProject = value.isNewProject;
    this.workspaceId = value.workspaceId;
    this.sessionId = value.sessionId;
  }

  private handleHarnessChanged(event: CustomEvent<{ harness: string }>): void {
    this.selectedHarness = event.detail.harness;
  }

  private get selectedProjectId(): string {
    return this.projectId;
  }

  private get canImport(): boolean {
    return (
      this.artifactPayloads.length > 0 &&
      this.sessionId.length > 0 &&
      this.projectId.length > 0 &&
      this.selectedHarness.length > 0
    );
  }

  private buildBundle(): ManualIngestionBundleRequest {
    const importBatchId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      artifacts: this.artifactPayloads,
      source: {
        sourceId: 'manual',
        projectId: this.selectedProjectId,
        sessionId: this.sessionId,
      },
      harness: this.selectedHarness,
      projectId: this.selectedProjectId,
      sessionId: this.sessionId,
      workspaceId: this.workspaceId || undefined,
      importBatchId,
    };
  }

  private async handleImport(): Promise<void> {
    const bundle = this.buildBundle();
    this.pendingBundle = bundle;
    this.phase = 'importing';
    this.receipt = null;
    this.error = '';

    try {
      const receipt = await this.client.manual.ingest(bundle);
      this.receipt = receipt;
      this.applyReceipt(receipt);
    } catch (err) {
      this.error = `Import failed: ${(err as Error).message}`;
      this.phase = 'unavailable';
    }
  }

  private applyReceipt(receipt: IngestionReceipt): void {
    if (receipt.status === 'committed' || receipt.status === 'superseded') {
      this.phase = 'partial';
      return;
    }
    if (receipt.issueIds.includes('manual_conflict')) {
      this.phase = 'conflict';
      this.error = `A different generation already exists for session ${receipt.sessionId}.`;
      return;
    }
    if (
      receipt.issueIds.includes('integrity_hash_mismatch') ||
      receipt.issueIds.includes('missing_artifact_hash')
    ) {
      this.phase = 'integrity-error';
      this.error = `Integrity check failed: ${receipt.issueIds.join(', ')}`;
      return;
    }
    if (
      receipt.issueIds.includes('manual_harness_unmatched') ||
      receipt.issueIds.includes('unsupported_harness')
    ) {
      this.phase = 'unsupported';
      this.error = `Unsupported harness: ${receipt.issueIds.join(', ')}`;
      return;
    }
    this.phase = 'unavailable';
    this.error = `Import failed: ${receipt.issueIds.join(', ') || 'unknown error'}`;
  }

  private async handleConflictResolution(
    event: CustomEvent<{ resolution: 'replace' | 'keep' }>,
  ): Promise<void> {
    const { resolution } = event.detail;
    if (resolution === 'keep' || !this.pendingBundle) {
      this.phase = 'idle';
      this.error = 'Existing session kept; no new generation imported.';
      return;
    }
    this.phase = 'importing';
    try {
      const receipt = await this.client.manual.resolveConflict(this.pendingBundle, 'replace');
      this.receipt = receipt;
      this.applyReceipt(receipt);
    } catch (err) {
      this.error = `Conflict resolution failed: ${(err as Error).message}`;
      this.phase = 'unavailable';
    }
  }

  private handleViewSession(): void {
    if (this.receipt) {
      navigateTo(`/sessions/${this.receipt.sessionId}`);
    }
  }

  private handleReset(): void {
    this.files = [];
    this.artifactPayloads = [];
    this.detection = null;
    this.selectedHarness = '';
    this.sessionId = '';
    this.phase = 'idle';
    this.receipt = null;
    this.error = '';
    this.pendingBundle = null;
  }

  render() {
    return html`
      <div class="manual-import-page">
        <div class="page-header">
          <h1>Manual Import</h1>
          <div class="actions">
            <button class="secondary" @click=${() => navigateTo('/')}>Back to projects</button>
          </div>
        </div>

        ${
          this.error &&
          this.phase !== 'conflict' &&
          this.phase !== 'unsupported' &&
          this.phase !== 'unavailable' &&
          this.phase !== 'integrity-error'
            ? html`<div class="error">${this.error}</div>`
            : ''
        }

        <div class="section">
          <h2 class="section-title">1. Upload transcript or partial folder</h2>
          <manual-import-upload @manual-files-selected=${this.handleFilesSelected}></manual-import-upload>

          ${
            this.files.length > 0
              ? html`
                <ul class="file-list">
                  ${repeat(
                    this.files,
                    (file) => file.relativePath,
                    (file) => html`
                      <li>
                        <span class="file-path">${file.relativePath}</span>
                        <span>${(file.file.size / 1024).toFixed(1)} KB</span>
                      </li>
                    `,
                  )}
                </ul>
              `
              : ''
          }
        </div>

        ${
          this.detection
            ? html`
              <div class="section">
                <h2 class="section-title">2. Harness</h2>
                <manual-import-harness-selector
                  .detection=${this.detection}
                  .selectedHarness=${this.selectedHarness}
                  @harness-changed=${this.handleHarnessChanged}
                ></manual-import-harness-selector>
              </div>
            `
            : ''
        }

        <div class="section">
          <h2 class="section-title">3. Project &amp; session identity</h2>
          <manual-import-project-workspace
            .projects=${this.projects}
            .projectId=${this.projectId}
            .isNewProject=${this.isNewProject}
            .newProjectName=${this.newProjectName}
            .workspaceId=${this.workspaceId}
            .sessionId=${this.sessionId}
            @value-changed=${this.handleProjectWorkspaceChanged}
          ></manual-import-project-workspace>
        </div>

        <div class="section">
          <h2 class="section-title">4. Import</h2>
          <manual-import-state
            .phase=${this.phase}
            .receipt=${this.receipt}
            .error=${this.error}
            @conflict-resolution=${this.handleConflictResolution}
          ></manual-import-state>

          <div class="actions">
            <button
              class="primary"
              ?disabled=${!this.canImport || this.phase === 'importing' || this.phase === 'detecting'}
              @click=${this.handleImport}
            >
              Import partial session
            </button>
            ${
              this.phase === 'partial' && this.receipt
                ? html`
                  <button class="secondary" @click=${this.handleViewSession}>
                    View session
                  </button>
                `
                : ''
            }
            <button class="secondary" @click=${this.handleReset}>Reset</button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'manual-import-page': ManualImportPage;
  }
}
