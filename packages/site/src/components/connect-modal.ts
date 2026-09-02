import { type S3ClientConfig, S3Error, S3FetchClient } from '@lucasschirm/sal-sync-core';
import { css, html, LitElement, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import './delete-confirmation-modal';
import './passkey-modal';
import './sync-confirm-modal';
import { dbClient } from '../db/db-client';
import { generateId } from '../lib/id';
import { hintForS3Error } from '../lib/s3-errors';
import { encryptField, isUnlocked } from '../sync/credential-crypto';
import { syncManager } from '../sync/sync-manager';
import type { Connection, StoredS3Credentials } from '../types';

/** View the modal is currently showing. */
type ModalView = 'list' | 'form';

/** Local form state for a connection being created or edited. */
interface FormData {
  name: string;
  storageType: 's3';
  region: string;
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretKey: string;
  sessionToken: string;
  saveToStorage: boolean;
  syncOnlyNew: boolean;
  secretTouched: boolean;
  sessionTokenTouched: boolean;
}

/** A connection listed in the modal, combining persisted and in-memory rows. */
interface ListItem {
  id: string;
  name: string;
  bucket: string;
  lastSyncAt?: number;
  syncOnlyNew: boolean;
  inMemory: boolean;
}

/** In-memory-only connection and S3 config for the current page session. */
interface InMemoryEntry {
  connection: Connection;
  s3Config: S3ClientConfig;
}

/** Result of a test-connection attempt. */
interface TestResult {
  ok: boolean;
  status: number;
  code: string;
  message: string;
  hint?: string;
  link?: string;
}

/** Builds a blank form for a new connection. */
function blankForm(): FormData {
  return {
    name: '',
    storageType: 's3',
    region: '',
    endpoint: '',
    bucket: '',
    accessKeyId: '',
    secretKey: '',
    sessionToken: '',
    saveToStorage: false,
    syncOnlyNew: false,
    secretTouched: false,
    sessionTokenTouched: false,
  };
}

/** Converts the current form into an S3 client config for test/sync. */
function s3ConfigFromForm(form: FormData): S3ClientConfig {
  return {
    accessKeyId: form.accessKeyId.trim(),
    secretAccessKey: form.secretKey,
    sessionToken: form.sessionToken.trim() || undefined,
    region: form.region.trim(),
    bucket: form.bucket.trim(),
    endpoint: form.endpoint.trim() || undefined,
  };
}

/** Returns a connection record from the current form. */
function connectionFromForm(form: FormData, id: string, now: number): Connection {
  return {
    id,
    name: form.name.trim(),
    storage_type: 's3',
    sync_only_new: form.syncOnlyNew,
    last_sync_at: undefined,
    created_at: now,
    updated_at: now,
  };
}

/** Returns a presentable timestamp, or a placeholder. */
function formatLastSync(timestamp?: number): string {
  if (!timestamp) return 'Never';
  return new Date(timestamp).toLocaleString();
}

/** True when the form is valid enough to test. */
function isFormValidForTest(form: FormData, isNew: boolean, inMemory: boolean): boolean {
  return (
    form.name.trim().length > 0 &&
    form.region.trim().length > 0 &&
    form.bucket.trim().length > 0 &&
    form.accessKeyId.trim().length > 0 &&
    (isNew || inMemory || form.secretTouched ? form.secretKey.length > 0 : true)
  );
}

/**
 * Builds a list of field errors for the form. Endpoint and session token are
 * intentionally optional.
 */
function validateForm(form: FormData, isNew: boolean, inMemory: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!form.name.trim()) errors.name = 'Connection name is required';
  if (!form.region.trim()) errors.region = 'Region is required';
  if (!form.bucket.trim()) errors.bucket = 'Bucket is required';
  if (!form.accessKeyId.trim()) errors.accessKeyId = 'Access key ID is required';
  const secretNeeded = isNew || inMemory || form.secretTouched;
  if (secretNeeded && !form.secretKey) errors.secretKey = 'Secret access key is required';
  return errors;
}

/**
 * The connection management modal.
 *
 * Supports creating, editing, testing and syncing S3 connections. Persisted
 * connections are stored in the site SQLite database; unsaved connections live
 * only in this component instance for the duration of the page session.
 *
 * @fires modal-close
 */
@customElement('connect-modal')
export class ConnectModal extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }

    .connect-modal {
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
      width: min(560px, 100%);
      max-height: 90vh;
      overflow-y: auto;
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
    }

    h2 {
      margin: 0 0 16px;
      font-size: 18px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    p {
      margin: 0;
    }

    label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      margin-bottom: 6px;
    }

    input,
    select {
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
    select:focus-visible {
      outline: 2px solid var(--md-sys-color-primary, #4f8cff);
      outline-offset: 1px;
    }

    input[aria-invalid='true'] {
      border-color: var(--md-sys-color-error, #ff6b6b);
    }

    input::placeholder {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
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
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .actions-left {
      margin-right: auto;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    button {
      border: none;
      padding: 10px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }

    button.primary {
      background: var(--md-sys-color-primary, #4f8cff);
      color: #fff;
    }

    button.primary:disabled,
    button.secondary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    button.secondary {
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
    }

    button.danger {
      background: var(--md-sys-color-error, #ff6b6b);
      color: #000;
    }

    button.link {
      background: transparent;
      color: var(--md-sys-color-primary, #4f8cff);
      padding: 0;
      font-size: 13px;
      text-decoration: underline;
    }

    .checkbox {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      cursor: pointer;
    }

    .checkbox input {
      width: auto;
      margin: 0;
      accent-color: var(--md-sys-color-primary, #4f8cff);
    }

    .list-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }

    .connection-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .connection-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
    }

    .connection-info {
      flex: 1;
      min-width: 0;
    }

    .connection-name {
      font-weight: 600;
      color: var(--md-sys-color-on-surface, #e6e9ef);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .connection-meta {
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      margin-top: 4px;
    }

    .connection-actions {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-shrink: 0;
    }

    .connection-actions button {
      padding: 6px 12px;
      font-size: 13px;
    }

    .badge {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--md-sys-color-primary, #4f8cff);
      color: #fff;
    }

    .badge.memory {
      background: var(--md-sys-color-tertiary, #7c4dff);
    }

    .empty {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      padding: 24px;
      text-align: center;
      border: 1px dashed var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
    }

    .test-result {
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 16px;
      font-size: 13px;
    }

    .test-result.ok {
      background: rgba(62, 207, 142, 0.12);
      color: var(--md-sys-color-success, #3ecf8e);
      border: 1px solid var(--md-sys-color-success, #3ecf8e);
    }

    .test-result.error {
      background: rgba(255, 107, 107, 0.12);
      color: var(--md-sys-color-error, #ff6b6b);
      border: 1px solid var(--md-sys-color-error, #ff6b6b);
    }

    .test-result a {
      color: inherit;
      text-decoration: underline;
    }

    .form-error {
      color: var(--md-sys-color-error, #ff6b6b);
      font-size: 13px;
      margin: -8px 0 16px;
    }

    details {
      margin-bottom: 16px;
    }

    summary {
      font-size: 13px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      cursor: pointer;
      margin-bottom: 8px;
    }
  `;

  @property({ type: Boolean, reflect: true }) open = false;

  /**
   * When true, renders the connection management UI inline (no fixed overlay,
   * no close button) for embedding in a page like Settings > Data Sources.
   * When `inline` is true, `open` is ignored — the panel is always visible.
   */
  @property({ type: Boolean, reflect: true }) inline = false;

  /**
   * Connection id from the data-sources route. When set (and `inline` is
   * true), the modal auto-opens the edit form for that connection. The
   * special value `new` opens the blank "new connection" form. An empty
   * value returns the modal to the connection list.
   */
  @property({ type: String }) connectionId = '';

  @state() private view: ModalView = 'list';

  @state() private items: ListItem[] = [];

  @state() private form: FormData = blankForm();

  @state() private editingId = '';

  @state() private editingInMemory = false;

  @state() private existingCredentials: StoredS3Credentials | null = null;

  @state() private testing = false;

  @state() private testResult: TestResult | null = null;

  @state() private saving = false;

  @state() private passkeyOpen = false;

  @state() private passkeyMode: 'create' | 'unlock' = 'create';

  @state() private pendingAction: 'save' | 'sync' | '' = '';

  @state() private syncReadOnly = false;

  @state() private activeConnectionIds = new Set<string>();

  @state() private loadError = '';

  @state() private formError = '';

  @state() private deleteDialogOpen = false;

  @state() private deleteItem: ListItem | undefined;

  private deleteTrigger?: HTMLElement;

  @state() private syncConfirmConnectionId = '';

  @state() private syncConfirmConnectionName = '';

  private inMemoryConnections = new Map<string, InMemoryEntry>();

  /**
   * Guard that suppresses the `connectionId` reaction in `willUpdate` when the
   * connectionId change originated from an explicit user action inside this
   * component (edit/new/cancel). Without it, updating the hash here would
   * update `connectionId`, which re-triggers the same handler and loops.
   */
  private suppressConnectionIdSync = false;

  connectedCallback(): void {
    super.connectedCallback();
    syncManager.addEventListener('change', this.handleSyncChange);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    syncManager.removeEventListener('change', this.handleSyncChange);
  }

  willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('open') && this.open) {
      this.resetToList();
      this.loadConnections().catch(() => undefined);
      this.handleSyncChange();
    }
    if (changed.has('open') && !this.open) {
      this.passkeyOpen = false;
      this.pendingAction = '';
    }
    // When inline, load connections on first render.
    if (changed.has('inline') && this.inline) {
      this.resetToList();
      this.loadConnections().catch(() => undefined);
      this.handleSyncChange();
    }
    // React to route-driven connectionId changes (inline mode only). When the
    // change originated from an explicit user action here, the guard is set and
    // we simply clear it so the subsequent property update is a no-op.
    if (changed.has('connectionId') && this.inline) {
      if (this.suppressConnectionIdSync) {
        this.suppressConnectionIdSync = false;
      } else if (this.connectionId && this.connectionId !== 'new') {
        this.handleEditConnection(this.connectionId);
      } else if (this.connectionId === 'new') {
        this.handleNewConnection();
      } else if (this.connectionId === '' && changed.get('connectionId')) {
        // Navigated back to the bare data-sources route — return to the list.
        this.resetToList();
      }
    }
  }

  private handleSyncChange = (): void => {
    const snapshot = syncManager.getSnapshot();
    this.syncReadOnly = snapshot.readOnly;
    const active = new Set<string>(snapshot.queuedRuns);
    const runState = snapshot.activeRun?.state;
    if ((runState === 'running' || runState === 'queued') && snapshot.activeRun) {
      active.add(snapshot.activeRun.connectionId);
    }
    this.activeConnectionIds = active;
  };

  private async loadConnections(): Promise<void> {
    this.loadError = '';
    try {
      const saved = await dbClient.getConnections();
      const items = await this.enrichSavedConnections(saved);
      for (const [id, entry] of this.inMemoryConnections) {
        items.push(this.listItemFromInMemory(id, entry));
      }
      items.sort((a, b) => this.sortByLastSync(a, b));
      this.items = items;
    } catch (error) {
      this.loadError = `Could not load connections: ${(error as Error).message}`;
    }
  }

  private async enrichSavedConnections(saved: Connection[]): Promise<ListItem[]> {
    return Promise.all(
      saved.map(async (connection) => {
        const credentials = await dbClient.getS3Credentials(connection.id);
        return {
          id: connection.id,
          name: connection.name,
          bucket: credentials?.bucket ?? '',
          lastSyncAt: connection.last_sync_at,
          syncOnlyNew: connection.sync_only_new,
          inMemory: false,
        };
      }),
    );
  }

  private listItemFromInMemory(id: string, entry: InMemoryEntry): ListItem {
    return {
      id,
      name: entry.connection.name,
      bucket: entry.s3Config.bucket,
      lastSyncAt: entry.connection.last_sync_at,
      syncOnlyNew: entry.connection.sync_only_new,
      inMemory: true,
    };
  }

  private sortByLastSync(a: ListItem, b: ListItem): number {
    if (a.inMemory !== b.inMemory) return a.inMemory ? -1 : 1;
    return (b.lastSyncAt ?? 0) - (a.lastSyncAt ?? 0);
  }

  private resetToList(): void {
    this.view = 'list';
    this.form = blankForm();
    this.editingId = '';
    this.editingInMemory = false;
    this.existingCredentials = null;
    this.testResult = null;
    this.formError = '';
    this.loadError = '';
    this.passkeyOpen = false;
    this.pendingAction = '';
    this.deleteDialogOpen = false;
    this.deleteItem = undefined;
    this.deleteTrigger = undefined;
    this.syncConfirmConnectionId = '';
    this.syncConfirmConnectionName = '';
  }

  private handleOverlayClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.close();
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (this.deleteDialogOpen) return;
    if (event.key === 'Escape') this.close();
  }

  private close(): void {
    this.dispatchEvent(new CustomEvent('modal-close', { bubbles: true, composed: true }));
  }

  private isNew(): boolean {
    return this.editingId === '';
  }

  private fieldErrors(): Record<string, string> {
    return validateForm(this.form, this.isNew(), this.editingInMemory);
  }

  private formIsValid(): boolean {
    return Object.keys(this.fieldErrors()).length === 0;
  }

  private setForm<K extends keyof FormData>(field: K, value: FormData[K]): void {
    this.form = { ...this.form, [field]: value };
    this.testResult = null;
    this.formError = '';
  }

  private setFormTouched<K extends 'secretTouched' | 'sessionTokenTouched'>(
    field: K,
    value: boolean,
  ): void {
    this.form = { ...this.form, [field]: value };
  }

  private handleNameInput(event: Event): void {
    this.setForm('name', (event.target as HTMLInputElement).value);
  }

  private handleRegionInput(event: Event): void {
    this.setForm('region', (event.target as HTMLInputElement).value);
  }

  private handleEndpointInput(event: Event): void {
    this.setForm('endpoint', (event.target as HTMLInputElement).value);
  }

  private handleBucketInput(event: Event): void {
    this.setForm('bucket', (event.target as HTMLInputElement).value);
  }

  private handleAccessKeyInput(event: Event): void {
    this.setForm('accessKeyId', (event.target as HTMLInputElement).value);
  }

  private handleSecretInput(event: Event): void {
    this.setForm('secretKey', (event.target as HTMLInputElement).value);
    this.setFormTouched('secretTouched', true);
  }

  private handleSessionTokenInput(event: Event): void {
    this.setForm('sessionToken', (event.target as HTMLInputElement).value);
    this.setFormTouched('sessionTokenTouched', true);
  }

  private handleSaveToStorageChange(event: Event): void {
    this.setForm('saveToStorage', (event.target as HTMLInputElement).checked);
  }

  private handleSyncOnlyNewChange(event: Event): void {
    this.setForm('syncOnlyNew', (event.target as HTMLInputElement).checked);
  }

  private handleNewConnection(): void {
    if (this.inline) {
      this.suppressConnectionIdSync = true;
      this.updateDataSourcesHash('new');
    }
    this.form = blankForm();
    this.editingId = '';
    this.editingInMemory = false;
    this.existingCredentials = null;
    this.testResult = null;
    this.formError = '';
    this.view = 'form';
  }

  private handleEditConnection(id: string): void {
    if (this.inline) {
      this.suppressConnectionIdSync = true;
      this.updateDataSourcesHash(id);
    }
    const inMemory = this.inMemoryConnections.get(id);
    if (inMemory) {
      this.populateFormFromInMemory(id, inMemory);
      return;
    }
    this.populateFormFromSaved(id).catch(() => undefined);
  }

  private populateFormFromInMemory(id: string, entry: InMemoryEntry): void {
    this.editingId = id;
    this.editingInMemory = true;
    this.existingCredentials = null;
    this.form = {
      ...blankForm(),
      name: entry.connection.name,
      region: entry.s3Config.region,
      endpoint: entry.s3Config.endpoint ?? '',
      bucket: entry.s3Config.bucket,
      accessKeyId: entry.s3Config.accessKeyId,
      secretKey: entry.s3Config.secretAccessKey,
      sessionToken: entry.s3Config.sessionToken ?? '',
      saveToStorage: false,
      syncOnlyNew: entry.connection.sync_only_new,
      secretTouched: false,
      sessionTokenTouched: false,
    };
    this.testResult = null;
    this.formError = '';
    this.view = 'form';
  }

  private async populateFormFromSaved(id: string): Promise<void> {
    try {
      const connections = await dbClient.getConnections();
      const connection = connections.find((c) => c.id === id);
      if (!connection) return;
      const credentials = await dbClient.getS3Credentials(id);
      this.editingId = id;
      this.editingInMemory = false;
      this.existingCredentials = credentials;
      this.form = {
        ...blankForm(),
        name: connection.name,
        region: credentials?.region ?? '',
        endpoint: credentials?.endpoint ?? '',
        bucket: credentials?.bucket ?? '',
        accessKeyId: credentials?.access_key_id ?? '',
        secretKey: '',
        sessionToken: '',
        saveToStorage: true,
        syncOnlyNew: connection.sync_only_new,
        secretTouched: false,
        sessionTokenTouched: false,
      };
      this.testResult = null;
      this.formError = '';
      this.view = 'form';
    } catch (error) {
      this.formError = `Could not load connection: ${(error as Error).message}`;
    }
  }

  /**
   * Updates the URL hash to reflect the current data-sources view without
   * triggering a hashchange event. Uses `history.replaceState` so the
   * router does not re-render the page (which would detach the form).
   * The `connectionId` property is NOT updated here — it only flows from
   * the parent (route) to this component. Internal state is tracked by
   * `this.view`.
   */
  private updateDataSourcesHash(connectionId: string): void {
    const hash =
      connectionId === '' ? '#/settings/data-sources' : `#/settings/data-sources/${connectionId}`;
    const url = `${window.location.pathname}${window.location.search}${hash}`;
    window.history.replaceState(null, '', url);
  }

  private handleCancelForm(): void {
    if (this.inline) {
      this.suppressConnectionIdSync = true;
      this.updateDataSourcesHash('');
    }
    this.view = 'list';
    this.form = blankForm();
    this.editingId = '';
    this.editingInMemory = false;
    this.existingCredentials = null;
    this.testResult = null;
    this.formError = '';
  }

  private async handleTestConnection(): Promise<void> {
    if (!isFormValidForTest(this.form, this.isNew(), this.editingInMemory)) {
      this.formError = 'Fill the required S3 fields before testing.';
      return;
    }
    this.testing = true;
    this.testResult = null;
    this.formError = '';
    try {
      const client = new S3FetchClient(s3ConfigFromForm(this.form));
      await client.headBucket();
      this.testResult = { ok: true, status: 200, code: 'OK', message: 'Connection OK' };
    } catch (error) {
      this.testResult = this.buildTestResult(error);
    } finally {
      this.testing = false;
    }
  }

  private buildTestResult(error: unknown): TestResult {
    if (error instanceof S3Error) {
      const { hint, link } = hintForS3Error(error);
      return {
        ok: false,
        status: error.status,
        code: error.code,
        message: error.message,
        hint,
        link,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      code: 'UnknownError',
      message,
      hint: 'Check the endpoint, credentials, and bucket details.',
    };
  }

  private async handleSave(): Promise<void> {
    await this.saveConnection(false);
  }

  private async handleSync(): Promise<void> {
    await this.saveConnection(true);
  }

  private async saveConnection(thenSync: boolean): Promise<void> {
    const errors = this.fieldErrors();
    if (Object.keys(errors).length > 0) {
      this.formError = 'Fix the highlighted fields before saving.';
      return;
    }
    if (this.form.saveToStorage && !isUnlocked()) {
      await this.promptForPasskey(thenSync ? 'sync' : 'save');
      return;
    }
    this.saving = true;
    try {
      if (this.editingInMemory && !this.form.saveToStorage) {
        this.updateInMemoryConnection();
      } else if (this.editingInMemory && this.form.saveToStorage) {
        await this.promoteInMemoryToSaved();
      } else if (this.isNew() && !this.form.saveToStorage) {
        this.addInMemoryConnection();
      } else {
        await this.persistConnectionToDatabase();
      }
      await this.afterSave(thenSync);
    } catch (error) {
      this.formError = `Could not save: ${(error as Error).message}`;
    } finally {
      this.saving = false;
    }
  }

  private async promptForPasskey(action: 'save' | 'sync'): Promise<void> {
    this.pendingAction = action;
    this.passkeyMode = (await dbClient.getPasskeyState()) ? 'unlock' : 'create';
    this.passkeyOpen = true;
  }

  private handlePasskeySuccess(): void {
    this.passkeyOpen = false;
    const action = this.pendingAction;
    this.pendingAction = '';
    if (action === 'save') this.handleSave();
    if (action === 'sync') this.handleSync();
  }

  private handlePasskeyClose(event: Event): void {
    event.stopPropagation();
    this.passkeyOpen = false;
    this.pendingAction = '';
  }

  private handlePasskeyForgotten(): void {
    this.passkeyOpen = false;
    this.pendingAction = '';
  }

  private addInMemoryConnection(): void {
    const id = generateId();
    const connection = connectionFromForm(this.form, id, Date.now());
    this.inMemoryConnections.set(id, { connection, s3Config: s3ConfigFromForm(this.form) });
    this.editingId = id;
    this.editingInMemory = true;
  }

  private updateInMemoryConnection(): void {
    const entry = this.inMemoryConnections.get(this.editingId);
    if (!entry) return;
    const now = Date.now();
    const connection: Connection = {
      ...entry.connection,
      name: this.form.name.trim(),
      sync_only_new: this.form.syncOnlyNew,
      updated_at: now,
    };
    this.inMemoryConnections.set(this.editingId, {
      connection,
      s3Config: s3ConfigFromForm(this.form),
    });
  }

  private async afterSave(thenSync: boolean): Promise<void> {
    if (thenSync && this.editingId) {
      this.startSync(this.editingId);
      return;
    }
    this.handleCancelForm();
    this.loadConnections().catch(() => undefined);
  }

  private async promoteInMemoryToSaved(): Promise<void> {
    this.inMemoryConnections.delete(this.editingId);
    this.editingInMemory = false;
    this.editingId = '';
    this.existingCredentials = null;
    await this.persistConnectionToDatabase();
  }

  private async persistConnectionToDatabase(): Promise<void> {
    const now = Date.now();
    const isNew = this.isNew();
    const connection = isNew
      ? connectionFromForm(this.form, generateId(), now)
      : await this.updatedConnectionFromForm(now);
    const credentials = await this.buildStoredCredentials(connection.id, now);
    this.editingId = connection.id;
    if (isNew) {
      await dbClient.createConnection(connection);
    } else {
      await dbClient.updateConnection(connection.id, {
        name: connection.name,
        sync_only_new: connection.sync_only_new,
      });
    }
    if (isNew && !credentials) throw new Error('Secret access key is required');
    if (credentials) await dbClient.saveS3Credentials(credentials);
  }

  private async updatedConnectionFromForm(now: number): Promise<Connection> {
    const existing = (await dbClient.getConnections()).find((c) => c.id === this.editingId);
    if (!existing) throw new Error('Connection not found');
    return {
      ...existing,
      name: this.form.name.trim(),
      sync_only_new: this.form.syncOnlyNew,
      updated_at: now,
    };
  }

  private async buildStoredCredentials(
    connectionId: string,
    now: number,
  ): Promise<StoredS3Credentials | null> {
    const existing = this.existingCredentials;
    const secret = await this.secretCiphertext(existing);
    const session = await this.sessionTokenCiphertext(existing);
    if (!secret.ct || !secret.iv) return null;
    return {
      connection_id: connectionId,
      region: this.form.region.trim(),
      endpoint: this.form.endpoint.trim() || undefined,
      bucket: this.form.bucket.trim(),
      access_key_id: this.form.accessKeyId.trim(),
      secret_access_key_ct: secret.ct,
      secret_access_key_iv: secret.iv,
      session_token_ct: session.ct,
      session_token_iv: session.iv,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
  }

  private async secretCiphertext(
    existing: StoredS3Credentials | null,
  ): Promise<{ iv: string; ct: string }> {
    if (this.isNew() || this.editingInMemory) {
      return this.encryptIfValue(this.form.secretKey);
    }
    if (this.form.secretTouched) return this.encryptIfValue(this.form.secretKey);
    if (existing?.secret_access_key_iv && existing?.secret_access_key_ct) {
      return { iv: existing.secret_access_key_iv, ct: existing.secret_access_key_ct };
    }
    return { iv: '', ct: '' };
  }

  private async sessionTokenCiphertext(
    existing: StoredS3Credentials | null,
  ): Promise<{ iv?: string; ct?: string }> {
    if (this.isNew() || this.editingInMemory) {
      return this.encryptIfValueOptional(this.form.sessionToken.trim());
    }
    if (this.form.sessionTokenTouched) {
      return this.encryptIfValueOptional(this.form.sessionToken.trim());
    }
    if (existing?.session_token_iv && existing?.session_token_ct) {
      return { iv: existing.session_token_iv, ct: existing.session_token_ct };
    }
    return {};
  }

  private async encryptIfValue(value: string): Promise<{ iv: string; ct: string }> {
    if (!value) return { iv: '', ct: '' };
    return encryptField(value);
  }

  private async encryptIfValueOptional(value: string): Promise<{ iv?: string; ct?: string }> {
    if (!value) return {};
    return encryptField(value);
  }

  private startSync(connectionId: string): void {
    // In-memory connections haven't been saved yet, so there is no
    // localStorage preference to pre-select; use the form value directly.
    if (this.editingInMemory) {
      this.registerEphemeralIfNeeded(connectionId);
      syncManager.requestRun(connectionId, { syncOnlyNew: this.form.syncOnlyNew });
      this.close();
      return;
    }
    // Saved connections go through the per-sync confirmation modal so the
    // user can confirm/change the "sync only new" choice each time.
    const item = this.items.find((i) => i.id === connectionId);
    this.syncConfirmConnectionId = connectionId;
    this.syncConfirmConnectionName = item?.name ?? (this.form.name.trim() || connectionId);
  }

  private handleDelete(event: Event, id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    this.deleteTrigger = event.currentTarget as HTMLElement;
    this.deleteItem = item;
    this.deleteDialogOpen = true;
  }

  private handleDeleteCancel(): void {
    this.deleteDialogOpen = false;
    this.deleteItem = undefined;
    this.deleteTrigger = undefined;
  }

  private async handleDeleteConfirm(): Promise<void> {
    this.deleteDialogOpen = false;

    const item = this.deleteItem;
    this.deleteItem = undefined;
    this.deleteTrigger = undefined;
    if (!item) return;

    if (item.inMemory) {
      this.inMemoryConnections.delete(item.id);
    } else {
      try {
        await dbClient.deleteConnection(item.id);
      } catch (error) {
        this.loadError = `Could not delete connection: ${(error as Error).message}`;
        return;
      }
    }

    await this.loadConnections().catch(() => undefined);
  }

  private handleRowSync(id: string): void {
    if (this.isRowSyncDisabled(id)) return;
    const item = this.items.find((i) => i.id === id);
    this.syncConfirmConnectionId = id;
    this.syncConfirmConnectionName = item?.name ?? id;
  }

  private handleSyncConfirmed(
    event: CustomEvent<{ connectionId: string; syncOnlyNew: boolean }>,
  ): void {
    const { connectionId, syncOnlyNew } = event.detail;
    this.syncConfirmConnectionId = '';
    this.syncConfirmConnectionName = '';
    this.registerEphemeralIfNeeded(connectionId);
    syncManager.requestRun(connectionId, { syncOnlyNew });
    this.close();
  }

  private handleSyncConfirmClose(): void {
    this.syncConfirmConnectionId = '';
    this.syncConfirmConnectionName = '';
  }

  /**
   * Registers an in-memory connection with the sync manager so it can be
   * synced without persisting credentials to the database. No-op for
   * connections that are already stored in the database.
   */
  private registerEphemeralIfNeeded(connectionId: string): void {
    const entry = this.inMemoryConnections.get(connectionId);
    if (entry) {
      syncManager.registerEphemeralConnection(entry.connection, entry.s3Config);
    }
  }

  private isRowSyncDisabled(id: string): boolean {
    if (this.syncReadOnly) return true;
    return this.activeConnectionIds.has(id);
  }

  private rowSyncTooltip(id: string): string {
    if (this.syncReadOnly) return 'Another tab is leading an active sync.';
    if (this.activeConnectionIds.has(id)) return 'A sync is already running for this connection.';
    return '';
  }

  private isFormSyncDisabled(): boolean {
    return (
      !this.formIsValid() ||
      this.syncReadOnly ||
      this.saving ||
      this.activeConnectionIds.has(this.editingId)
    );
  }

  private formSyncTooltip(): string {
    if (this.syncReadOnly) return 'Another tab is leading an active sync.';
    if (this.activeConnectionIds.has(this.editingId)) {
      return 'A sync is already running for this connection.';
    }
    if (!this.formIsValid()) return 'Fix the highlighted fields before syncing.';
    return '';
  }

  render(): TemplateResult {
    if (!this.open && !this.inline) return html``;
    if (this.inline) {
      return html`
        <div class="connect-inline">
          ${this.view === 'list' ? this.renderList() : this.renderForm()}
          <passkey-modal
            .open=${this.passkeyOpen}
            .mode=${this.passkeyMode}
            @passkey-created=${this.handlePasskeySuccess}
            @passkey-unlocked=${this.handlePasskeySuccess}
            @passkey-forgotten=${this.handlePasskeyForgotten}
            @modal-close=${this.handlePasskeyClose}
          ></passkey-modal>

          <delete-confirmation-modal
            .open=${this.deleteDialogOpen}
            .message=${this.deleteItem ? `Delete "${this.deleteItem.name}"? This cannot be undone.` : ''}
            .confirmLabel=${'Delete Connection'}
            .titleText=${'Delete connection?'}
            .trigger=${this.deleteTrigger}
            @delete-confirmed=${this.handleDeleteConfirm}
            @modal-close=${this.handleDeleteCancel}
          ></delete-confirmation-modal>

          <sync-confirm-modal
            ?open=${this.syncConfirmConnectionId !== ''}
            .connectionId=${this.syncConfirmConnectionId}
            .connectionName=${this.syncConfirmConnectionName}
            @sync-confirmed=${this.handleSyncConfirmed}
            @modal-close=${this.handleSyncConfirmClose}
          ></sync-confirm-modal>
        </div>
      `;
    }
    return html`
      <div class="connect-modal" @click=${this.handleOverlayClick} @keydown=${this.handleKeydown}>
        <div class="panel" role="dialog" aria-modal="true" aria-label="Connections">
          ${this.view === 'list' ? this.renderList() : this.renderForm()}
        </div>
        <passkey-modal
          .open=${this.passkeyOpen}
          .mode=${this.passkeyMode}
          @passkey-created=${this.handlePasskeySuccess}
          @passkey-unlocked=${this.handlePasskeySuccess}
          @passkey-forgotten=${this.handlePasskeyForgotten}
          @modal-close=${this.handlePasskeyClose}
        ></passkey-modal>

        <delete-confirmation-modal
          .open=${this.deleteDialogOpen}
          .message=${this.deleteItem ? `Delete "${this.deleteItem.name}"? This cannot be undone.` : ''}
          .confirmLabel=${'Delete Connection'}
          .titleText=${'Delete connection?'}
          .trigger=${this.deleteTrigger}
          @delete-confirmed=${this.handleDeleteConfirm}
          @modal-close=${this.handleDeleteCancel}
        ></delete-confirmation-modal>

        <sync-confirm-modal
          ?open=${this.syncConfirmConnectionId !== ''}
          .connectionId=${this.syncConfirmConnectionId}
          .connectionName=${this.syncConfirmConnectionName}
          @sync-confirmed=${this.handleSyncConfirmed}
          @modal-close=${this.handleSyncConfirmClose}
        ></sync-confirm-modal>
      </div>
    `;
  }

  private renderList(): TemplateResult {
    return html`
      <div class="list-header">
        <h2>Connections</h2>
        <button type="button" class="primary" @click=${this.handleNewConnection}>
          + New connection
        </button>
      </div>
      ${this.loadError ? html`<p class="form-error">${this.loadError}</p>` : ''}
      ${this.items.length === 0 ? this.renderEmptyList() : this.renderConnectionRows()}
    `;
  }

  private renderEmptyList(): TemplateResult {
    return html`
      <div class="empty">
        <p>No connections yet. Create one to start syncing from S3.</p>
      </div>
    `;
  }

  private renderConnectionRows(): TemplateResult {
    return html`
      <div class="connection-list" role="list">
        ${repeat(
          this.items,
          (item) => item.id,
          (item) => this.renderConnectionRow(item),
        )}
      </div>
    `;
  }

  private renderConnectionRow(item: ListItem): TemplateResult {
    const disabled = this.isRowSyncDisabled(item.id);
    const tooltip = this.rowSyncTooltip(item.id);
    return html`
      <div class="connection-row" role="listitem">
        <div class="connection-info">
          <div class="connection-name">${item.name}</div>
          <div class="connection-meta">
            <span class="badge ${classMap({ memory: item.inMemory })}">${item.inMemory ? 'In-Memory' : 'S3'}</span>
            ${item.bucket ? ` • ${item.bucket}` : ''} • Last sync: ${formatLastSync(item.lastSyncAt)}
          </div>
        </div>
        <div class="connection-actions">
          <button
            type="button"
            class="secondary"
            ?disabled=${disabled}
            title=${tooltip}
            @click=${() => this.handleRowSync(item.id)}
          >
            Sync
          </button>
          <button type="button" class="secondary" @click=${() => this.handleEditConnection(item.id)}>
            Edit
          </button>
          <button
            type="button"
            class="danger"
            @click=${(event: Event) => this.handleDelete(event, item.id)}
          >
            Delete
          </button>
        </div>
      </div>
    `;
  }

  private renderForm(): TemplateResult {
    const errors = this.fieldErrors();
    return html`
      <h2>${this.isNew() ? 'New Connection' : 'Edit Connection'}</h2>
      <form @submit=${(event: Event) => event.preventDefault()}>
        ${this.renderNameField(errors)} ${this.renderStorageField()}
        ${this.renderS3Fields(errors)} ${this.renderAdvancedField()}
        ${this.renderCheckboxes()} ${this.renderFormError()} ${this.renderTestResult()}
        ${this.renderFormActions()}
      </form>
    `;
  }

  private renderNameField(errors: Record<string, string>): TemplateResult {
    return this.renderTextField({
      id: 'connection-name',
      label: 'Connection name',
      value: this.form.name,
      error: errors.name,
      handler: this.handleNameInput,
    });
  }

  private renderStorageField(): TemplateResult {
    return html`
      <label for="connection-storage">Storage type</label>
      <select id="connection-storage" .value=${this.form.storageType} @change=${this.handleStorageTypeChange}>
        <option value="s3">S3</option>
        <option value="gcs" disabled>Google Cloud Storage (coming soon)</option>
        <option value="azure" disabled>Azure Blob (coming soon)</option>
      </select>
    `;
  }

  private handleStorageTypeChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (value === 's3') this.setForm('storageType', 's3');
  }

  private renderS3Fields(errors: Record<string, string>): TemplateResult {
    return html`
      ${this.renderRegionField(errors.region)}
      ${this.renderEndpointField()}
      ${this.renderBucketField(errors.bucket)}
      ${this.renderAccessKeyField(errors.accessKeyId)}
      ${this.renderSecretKeyField(errors.secretKey)}
    `;
  }

  private renderRegionField(error?: string): TemplateResult {
    return this.renderTextField({
      id: 'connection-region',
      label: 'Region',
      value: this.form.region,
      error,
      handler: this.handleRegionInput,
    });
  }

  private renderEndpointField(): TemplateResult {
    return this.renderTextField({
      id: 'connection-endpoint',
      label: 'Endpoint (optional)',
      value: this.form.endpoint,
      placeholder: 'https://s3.<region>.amazonaws.com',
      helpText: 'Leave blank to use AWS virtual-hosted URLs.',
      handler: this.handleEndpointInput,
    });
  }

  private renderBucketField(error?: string): TemplateResult {
    return this.renderTextField({
      id: 'connection-bucket',
      label: 'Bucket',
      value: this.form.bucket,
      error,
      handler: this.handleBucketInput,
    });
  }

  private renderAccessKeyField(error?: string): TemplateResult {
    return this.renderTextField({
      id: 'connection-access-key',
      label: 'Access key ID',
      value: this.form.accessKeyId,
      error,
      handler: this.handleAccessKeyInput,
    });
  }

  private renderSecretKeyField(error?: string): TemplateResult {
    return this.renderTextField({
      id: 'connection-secret-key',
      label: 'Secret access key',
      value: this.form.secretKey,
      error,
      type: 'password',
      placeholder: this.editingId ? 'Leave blank to keep existing' : '',
      handler: this.handleSecretInput,
    });
  }

  private renderAdvancedField(): TemplateResult {
    return html`
      <details>
        <summary>Advanced</summary>
        ${this.renderTextField({
          id: 'connection-session-token',
          label: 'Session token (optional)',
          value: this.form.sessionToken,
          type: 'password',
          placeholder: this.editingId ? 'Leave blank to keep existing' : '',
          handler: this.handleSessionTokenInput,
        })}
      </details>
    `;
  }

  private renderTextField(options: {
    id: string;
    label: string;
    value: string;
    type?: 'text' | 'password';
    error?: string;
    placeholder?: string;
    helpText?: string;
    handler: (event: Event) => void;
  }): TemplateResult {
    const type = options.type ?? 'text';
    return html`
      <label for=${options.id}>${options.label}</label>
      <input
        id=${options.id}
        type=${type}
        .value=${options.value}
        ?aria-invalid=${Boolean(options.error)}
        placeholder=${options.placeholder ?? ''}
        @input=${options.handler}
      />
      ${options.error ? html`<p class="field-error">${options.error}</p>` : ''}
      ${options.helpText ? html`<p class="help-text">${options.helpText}</p>` : ''}
    `;
  }

  private renderCheckboxes(): TemplateResult {
    const saveDisabled = !this.isNew() && !this.editingInMemory;
    return html`
      <label class="checkbox">
        <input
          type="checkbox"
          .checked=${this.form.saveToStorage}
          ?disabled=${saveDisabled}
          @change=${this.handleSaveToStorageChange}
        />
        Save to local storage
      </label>
      <p class="help-text">Uncheck to keep this connection in memory for this page session only. Sync works either way.</p>
    `;
  }

  private renderFormError(): TemplateResult {
    if (!this.formError) return html``;
    return html`<p class="form-error">${this.formError}</p>`;
  }

  private renderTestResult(): TemplateResult {
    if (!this.testResult) return html``;
    if (this.testResult.ok) {
      return html`
        <div class="test-result ok" role="status">
          ✓ Connection OK
        </div>
      `;
    }
    return html`
      <div class="test-result error" role="alert">
        <p><strong>HTTP ${this.testResult.status}</strong> • ${this.testResult.code}</p>
        <p>${this.testResult.message}</p>
        <p><strong>Hint:</strong> ${this.testResult.hint}</p>
        ${
          this.testResult.link
            ? html`<p><a href=${this.testResult.link} target="_blank" rel="noopener">CORS configuration docs</a></p>`
            : ''
        }
      </div>
    `;
  }

  private renderFormActions(): TemplateResult {
    const syncDisabled = this.isFormSyncDisabled();
    const syncTooltip = this.formSyncTooltip();
    return html`
      <div class="actions">
        ${this.renderSyncOnlyNewCheckbox()}
        <button type="button" class="secondary" ?disabled=${this.testing} @click=${this.handleTestConnection}>
          ${this.testing ? 'Testing...' : 'Test connection'}
        </button>
        <button type="button" class="secondary" ?disabled=${this.saving} @click=${this.handleSave}>Save</button>
        <button
          type="button"
          class="primary"
          ?disabled=${syncDisabled}
          title=${syncTooltip}
          @click=${this.handleSync}
        >
          Sync
        </button>
        <button type="button" class="secondary" @click=${this.handleCancelForm}>Cancel</button>
      </div>
    `;
  }

  private renderSyncOnlyNewCheckbox(): TemplateResult {
    return html`
      <div class="actions-left">
        <label class="checkbox">
          <input
            type="checkbox"
            .checked=${this.form.syncOnlyNew}
            @change=${this.handleSyncOnlyNewChange}
          />
          Sync only new sessions
        </label>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'connect-modal': ConnectModal;
  }
}
