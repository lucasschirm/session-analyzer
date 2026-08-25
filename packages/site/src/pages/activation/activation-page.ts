import { css, html, LitElement } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ANALYTICS_ACTIVATION_DISCLOSURE } from '../../db/activation-disclosure';
import {
  type AnalyticsActivationState,
  DATABASE_EXPORT_METADATA,
  DEFAULT_SOURCE_RETENTION,
  type SourceRetentionControls,
} from '../../db/activation-state';
import { dbClient } from '../../db/db-client';
import { navigateTo } from '../../router';

/**
 * Fresh analytics database activation page.
 *
 * - Discloses the reset, source-retention implications, and re-sync/re-import
 *   path before activation.
 * - Captures source-retention controls for transcripts, Sub Agents, and
 *   configuration artifacts.
 * - Activates the new analytics database (one-way for analytics data).
 * - Lets the user roll back to legacy mode and/or export the legacy database
 *   read-only during the bounded rollback window.
 */
@customElement('activation-page')
export class ActivationPage extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .activation-page {
      display: flex;
      flex-direction: column;
      gap: 20px;
      max-width: 800px;
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
      gap: 12px;
    }

    .section h2 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .section p {
      margin: 0;
      font-size: 14px;
      line-height: 1.5;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .notice {
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 13px;
    }

    .warning {
      background: var(--md-sys-color-error-container, #5c2626);
      color: var(--md-sys-color-on-error-container, #ffb4ab);
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 13px;
    }

    .success {
      background: var(--md-sys-color-success-container, #1b4d3e);
      color: var(--md-sys-color-on-success-container, #e6f9f0);
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 13px;
    }

    ul {
      margin: 0;
      padding-left: 20px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    li {
      font-size: 14px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .control {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      font-size: 14px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .control input[type='checkbox'] {
      margin-top: 2px;
      width: 18px;
      height: 18px;
      accent-color: var(--md-sys-color-primary, #4f8cff);
    }

    .control label {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .control .hint {
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
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

    button.secondary:hover:not(:disabled) {
      background: var(--md-sys-color-surface-container-hover, #262d3a);
    }

    button.danger {
      background: var(--md-sys-color-error-container, #5c2626);
      color: var(--md-sys-color-on-error-container, #ffb4ab);
      border: 1px solid var(--md-sys-color-error, #ff6b6b);
    }

    button.danger:hover:not(:disabled) {
      filter: brightness(1.1);
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
    }

    .status-badge.new {
      color: var(--md-sys-color-success, #3ecf8e);
      border-color: var(--md-sys-color-success, #3ecf8e);
    }

    .status-badge.legacy {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      border-color: var(--md-sys-color-outline, #2a303c);
    }
  `;

  @state() private state: AnalyticsActivationState | null = null;

  @state() private retention: SourceRetentionControls = { ...DEFAULT_SOURCE_RETENTION };

  @state() private isLoading = true;

  @state() private isActivating = false;

  @state() private isExporting = false;

  @state() private isRollingBack = false;

  @state() private message: { text: string; kind: 'success' | 'warning' | 'error' } | null = null;

  async firstUpdated(): Promise<void> {
    await this.loadState();
  }

  private async loadState(): Promise<void> {
    this.isLoading = true;
    try {
      const stored = await dbClient.getAnalyticsActivationState();
      this.state = stored;
      this.retention = stored?.retention ?? { ...DEFAULT_SOURCE_RETENTION };
    } catch (error) {
      this.message = { text: `Failed to load state: ${(error as Error).message}`, kind: 'warning' };
    } finally {
      this.isLoading = false;
    }
  }

  private get mode(): 'legacy' | 'new' {
    return this.state?.mode ?? 'legacy';
  }

  private handleRetentionChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.retention = { ...this.retention, [target.name]: target.checked };
  }

  private async handleActivate(): Promise<void> {
    const confirmed = window.confirm(
      'Activate the new analytics database? Your existing analytics data will be reset and you will need to re-sync or re-import your sessions.',
    );
    if (!confirmed) return;

    this.isActivating = true;
    this.message = null;
    try {
      this.state = await dbClient.activateAnalyticsDatabase(this.retention);
      this.retention = this.state.retention;
      this.message = {
        text: 'New analytics database activated. Re-sync or re-import your sessions to populate it.',
        kind: 'success',
      };
    } catch (error) {
      this.message = { text: `Activation failed: ${(error as Error).message}`, kind: 'error' };
    } finally {
      this.isActivating = false;
    }
  }

  private async handleRollback(): Promise<void> {
    const confirmed = window.confirm(
      'Roll back to the legacy database? The new analytics database will remain available for re-activation until the rollback window closes.',
    );
    if (!confirmed) return;

    this.isRollingBack = true;
    this.message = null;
    try {
      this.state = await dbClient.rollbackToLegacyMode();
      this.retention = this.state.retention;
      this.message = {
        text: 'Rolled back to legacy mode. Use the legacy export to save a copy.',
        kind: 'success',
      };
    } catch (error) {
      this.message = { text: `Rollback failed: ${(error as Error).message}`, kind: 'error' };
    } finally {
      this.isRollingBack = false;
    }
  }

  private async handleExportLegacy(): Promise<void> {
    this.isExporting = true;
    this.message = null;
    try {
      await dbClient.exportAndDownloadLegacy();
      this.message = {
        text: 'Legacy database exported. The downloaded file contains retained source/configuration content and should be treated as sensitive.',
        kind: 'warning',
      };
    } catch (error) {
      this.message = { text: `Export failed: ${(error as Error).message}`, kind: 'error' };
    } finally {
      this.isExporting = false;
    }
  }

  private handleReSync(): void {
    navigateTo('/');
  }

  private handleReImport(): void {
    navigateTo('/manual-import');
  }

  render() {
    const disclosure = ANALYTICS_ACTIVATION_DISCLOSURE;

    return html`
      <div class="activation-page">
        <div class="page-header">
          <h1>${disclosure.title}</h1>
          <span class="status-badge ${this.mode}">
            ${this.mode === 'new' ? 'New Analytics' : 'Legacy Mode'}
          </span>
        </div>

        ${this.message ? html`<div class="${this.message.kind}">${this.message.text}</div>` : ''}

        <div class="section">
          <h2>What is changing</h2>
          <p>${disclosure.body}</p>
        </div>

        <div class="section">
          <h2>Reset notice</h2>
          <p>${disclosure.resetNotice}</p>
          <p class="warning">
            Existing projects and sessions in the old analytics format will no longer be visible
            until they are re-imported or re-synced.
          </p>
        </div>

        <div class="section">
          <h2>Re-sync / re-import path</h2>
          <p>${disclosure.resyncPath}</p>
          <div class="actions">
            <button class="secondary" @click=${this.handleReSync} ?disabled=${this.isLoading}>
              Go to projects &amp; sync
            </button>
            <button class="secondary" @click=${this.handleReImport} ?disabled=${this.isLoading}>
              Open manual import
            </button>
          </div>
        </div>

        <div class="section">
          <h2>Source retention controls</h2>
          <p>
            ${disclosure.sourceRetention} Transcript and Sub Agent source retention is
            user-controlled. Configuration artifacts required for diffing are retained locally when
            safely capturable.
          </p>

          <label class="control">
            <input
              type="checkbox"
              name="retainTranscripts"
              .checked=${this.retention.retainTranscripts}
              @change=${this.handleRetentionChange}
            />
            <span>
              Retain main session transcripts
              <span class="hint">Source bytes used to derive metrics.</span>
            </span>
          </label>

          <label class="control">
            <input
              type="checkbox"
              name="retainSubAgents"
              .checked=${this.retention.retainSubAgents}
              @change=${this.handleRetentionChange}
            />
            <span>
              Retain Sub Agent transcripts
              <span class="hint">Child session source bytes.</span>
            </span>
          </label>

          <label class="control">
            <input
              type="checkbox"
              name="retainConfigurationArtifacts"
              .checked=${this.retention.retainConfigurationArtifacts}
              @change=${this.handleRetentionChange}
            />
            <span>
              Retain configuration artifacts
              <span class="hint">Rules, Skills, Agents, MCP, settings, and plugins needed for diffing.</span>
            </span>
          </label>
        </div>

        <div class="section">
          <h2>Legacy database export</h2>
          <p>${disclosure.rollbackWindow}</p>
          <p class="warning">
            This export may contain retained source/configuration content, normalized sensitive
            fields, and local digest values. Treat it as sensitive and do not copy it across
            unrelated key domains without an explicit rekey.
          </p>

          <p>Retained content in the export includes:</p>
          <ul>
            ${DATABASE_EXPORT_METADATA.retainedContent.map((item) => html`<li>${item}</li>`)}
          </ul>

          <p>Sensitive fields to be aware of:</p>
          <ul>
            ${DATABASE_EXPORT_METADATA.sensitiveFields.map((item) => html`<li>${item}</li>`)}
          </ul>

          <div class="actions">
            <button
              class="secondary"
              @click=${this.handleExportLegacy}
              ?disabled=${this.isExporting || this.isLoading}
            >
              ${this.isExporting ? 'Exporting…' : 'Export legacy database'}
            </button>
          </div>
        </div>

        <div class="section">
          <h2>Activation</h2>
          <p>
            Activating is a one-way operation for analytics data. Control data such as connections,
            encrypted credentials, passkey state, source checkpoints, and UI preferences are
            preserved.
          </p>

          <div class="actions">
            <button
              class="primary"
              @click=${this.handleActivate}
              ?disabled=${this.isActivating || this.isLoading}
            >
              ${this.isActivating ? 'Activating…' : 'Activate new analytics database'}
            </button>

            ${
              this.mode === 'new'
                ? html`
                  <button
                    class="danger"
                    @click=${this.handleRollback}
                    ?disabled=${this.isRollingBack || this.isLoading}
                  >
                    ${this.isRollingBack ? 'Rolling back…' : 'Roll back to legacy mode'}
                  </button>
                `
                : ''
            }
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'activation-page': ActivationPage;
  }
}
