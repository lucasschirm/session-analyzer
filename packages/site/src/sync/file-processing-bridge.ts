/**
 * Sync file processing bridge (TSK0008).
 *
 * Consumes `SESSION_FILE_DOWNLOADED` buffers from `SyncManager` and feeds them
 * into the same parser / database pipeline as manual uploads:
 *
 * - main transcript → `parseInWorker(ArrayBuffer)` → `upsertSessionByExternalId`
 * - subagent `.jsonl` → `parseInWorker` and paired with decoded `.meta.json`
 * - each completed `{jsonl, meta}` group → `mergeSubagentIntoSession` →
 *   `replaceSession`, reapplying sync mirror columns after every replace.
 *
 * Buffers are transferred into parser workers immediately and never buffered on
 * the main thread beyond a single in-flight dispatch.
 */

import type { ManifestArtifact } from '@lucasschirm/sal-sync-core';
import type { DbClient } from '../db/db-client';
import {
  classifySyncFile,
  mergeSubagentIntoSession,
  parseSubagentMeta,
  type SubagentMeta,
} from '../lib/subagents';
import type { DashboardSession, ParsedSession, SessionFileRecord, SyncManifest } from '../types';
import type { parseInWorker } from '../workers/parser-client';
import { generateId } from '../workers/session-builder';

/** A single downloaded file buffer handed to the bridge. */
export interface DownloadedFile {
  path: string;
  hash: string;
  size: number;
  content: ArrayBuffer;
}

type SessionFileRecordFile = Pick<DownloadedFile, 'path' | 'hash' | 'size'>;

interface PromiseWithResolvers<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

interface SubagentFileCompletion {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface SubagentGroupState {
  agentId: string;
  parsed?: DashboardSession;
  meta?: SubagentMeta;
  jsonlFile?: SessionFileRecordFile;
  metaFile?: SessionFileRecordFile;
  jsonlCompletion?: SubagentFileCompletion;
  metaCompletion?: SubagentFileCompletion;
  merged: boolean;
}

interface SessionBridgeState {
  sessionId: string;
  projectId: string;
  manifest?: SyncManifest;
  opQueue: Promise<void>;
  mainTranscriptPromise: Promise<void>;
  resolveMain: () => void;
  rejectMain: (error: Error) => void;
  mergeQueue: Promise<void>;
  groups: Map<string, SubagentGroupState>;
}

function createPromiseWithResolvers<T>(): PromiseWithResolvers<T> {
  const resolvers: {
    resolve?: (value: T) => void;
    reject?: (error: Error) => void;
  } = {};
  const promise = new Promise<T>((resolve, reject) => {
    resolvers.resolve = resolve;
    resolvers.reject = reject;
  });
  if (!resolvers.resolve || !resolvers.reject) throw new Error('Promise constructor did not run');
  return { promise, resolve: resolvers.resolve, reject: resolvers.reject };
}

/** Parses the manifest's artifact list to decide whether an agent sidecar was expected. */
function isSidecarExpected(manifest: SyncManifest | undefined, agentId: string): boolean {
  if (!manifest) return false;
  const sidecarPath = `subagents/agent-${agentId}.meta.json`;
  return (manifest.artifacts as ManifestArtifact[]).some(
    (artifact) =>
      artifact.scope === 'session' &&
      artifact.status === 'uploaded' &&
      artifact.relativePath === sidecarPath,
  );
}

function fileScope(file: string): 'session' | 'workspace' | 'global' | 'runtime' {
  const scope = file.split('/')[0];
  if (scope === 'workspace' || scope === 'global' || scope === 'runtime') return scope;
  return 'session';
}

/**
 * Creates the `onFileDownloaded` consumer for `SyncManager`.
 *
 * The returned function is bound to its own internal state; each call is an
 * independent dispatch but per-session ordering and grouping is serialized
 * through an in-memory queue so merges land in the database sequentially.
 */
export function createFileProcessingBridge(
  db: DbClient,
  parse: typeof parseInWorker,
): {
  onFileDownloaded: (sessionId: string, file: DownloadedFile) => Promise<void>;
  onSyncComplete: (sessionId: string) => Promise<void>;
} {
  const bridge = new FileProcessingBridge(db, parse);
  return {
    onFileDownloaded: (sessionId, file) => bridge.onFileDownloaded(sessionId, file),
    onSyncComplete: (sessionId) => bridge.onSyncComplete(sessionId),
  };
}

class FileProcessingBridge {
  private readonly sessions = new Map<string, SessionBridgeState | Promise<SessionBridgeState>>();

  constructor(
    private readonly db: DbClient,
    private readonly parse: typeof parseInWorker,
  ) {}

  onFileDownloaded(sessionId: string, file: DownloadedFile): Promise<void> {
    return this.stateFor(sessionId).then((state) => this.dispatchFile(state, file));
  }

  onSyncComplete(sessionId: string): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (!existing) return Promise.resolve();
    return Promise.resolve(existing).then((state) => this.forceCompleteSession(state));
  }

  private async stateFor(sessionId: string): Promise<SessionBridgeState> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const promise = this.loadSession(sessionId);
    this.sessions.set(sessionId, promise);
    try {
      const state = await promise;
      this.sessions.set(sessionId, state);
      return state;
    } catch (error) {
      this.sessions.delete(sessionId);
      throw error;
    }
  }

  private async loadSession(sessionId: string): Promise<SessionBridgeState> {
    const [session, manifest] = await Promise.all([
      this.db.getSession(sessionId),
      this.db.getSessionSyncManifest(sessionId),
    ]);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const main = createPromiseWithResolvers<void>();
    return {
      sessionId,
      projectId: session.project_id,
      manifest: manifest ?? undefined,
      opQueue: Promise.resolve(),
      mainTranscriptPromise: main.promise,
      resolveMain: main.resolve,
      rejectMain: main.reject,
      mergeQueue: main.promise,
      groups: new Map(),
    };
  }

  private dispatchFile(state: SessionBridgeState, file: DownloadedFile): Promise<void> {
    const classification = classifySyncFile(file.path);
    if (!classification) return Promise.resolve();
    if (classification.type === 'main') return this.dispatchMainFile(state, file);
    if (!classification.agentId || !classification.kind) return Promise.resolve();
    return this.dispatchSubagentFile(state, file, classification.agentId, classification.kind);
  }

  private async dispatchMainFile(state: SessionBridgeState, file: DownloadedFile): Promise<void> {
    const title = state.manifest?.sessionId ?? file.path;
    const parsed = await this.parse(file.content, { projectId: state.projectId, title });
    return this.enqueue(state, () => this.processMain(state, file, parsed));
  }

  private async processMain(
    state: SessionBridgeState,
    file: DownloadedFile,
    parsed: ParsedSession,
  ): Promise<void> {
    try {
      const sessionId = await this.db.upsertSessionByExternalId(parsed.session);
      state.sessionId = sessionId;
      await this.reapplySyncState(sessionId, state);
      await this.upsertSessionFile(sessionId, state.projectId, file);
      state.resolveMain();
    } catch (error) {
      state.rejectMain(error as Error);
      throw error;
    }
  }

  private async dispatchSubagentFile(
    state: SessionBridgeState,
    file: DownloadedFile,
    agentId: string,
    kind: 'jsonl' | 'meta',
  ): Promise<void> {
    if (kind === 'meta') {
      const meta = parseSubagentMeta(new TextDecoder().decode(file.content));
      return new Promise<void>((resolve, reject) => {
        this.enqueue(state, () =>
          this.updateGroupWithMeta(state, agentId, file, meta, resolve, reject),
        );
      });
    }
    const parsed = await this.parse(file.content, { projectId: state.projectId });
    return new Promise<void>((resolve, reject) => {
      this.enqueue(state, () =>
        this.updateGroupWithJsonl(state, agentId, file, parsed, resolve, reject),
      );
    });
  }

  private enqueue(state: SessionBridgeState, work: () => Promise<void> | void): Promise<void> {
    const next = state.opQueue.then(work);
    state.opQueue = next;
    return next;
  }

  private updateGroupWithJsonl(
    state: SessionBridgeState,
    agentId: string,
    file: DownloadedFile,
    parsed: ParsedSession,
    resolve: () => void,
    reject: (error: Error) => void,
  ): void {
    const group = this.getOrCreateGroup(state, agentId);
    group.parsed = parsed.session;
    group.jsonlFile = file;
    group.jsonlCompletion = { resolve, reject };
    this.tryMergeGroup(state, group);
  }

  private updateGroupWithMeta(
    state: SessionBridgeState,
    agentId: string,
    file: DownloadedFile,
    meta: SubagentMeta,
    resolve: () => void,
    reject: (error: Error) => void,
  ): void {
    const group = this.getOrCreateGroup(state, agentId);
    group.meta = meta;
    group.metaFile = file;
    group.metaCompletion = { resolve, reject };
    this.tryMergeGroup(state, group);
  }

  private getOrCreateGroup(state: SessionBridgeState, agentId: string): SubagentGroupState {
    let group = state.groups.get(agentId);
    if (!group) {
      group = { agentId, merged: false };
      state.groups.set(agentId, group);
    }
    return group;
  }

  private tryMergeGroup(state: SessionBridgeState, group: SubagentGroupState, force = false): void {
    if (group.merged) return;
    if (group.parsed === undefined) return;
    if (!force && isSidecarExpected(state.manifest, group.agentId) && group.meta === undefined)
      return;
    group.merged = true;
    state.mergeQueue = state.mergeQueue.then(() => this.mergeSubagentGroup(state, group));
  }

  private async forceCompleteSession(state: SessionBridgeState): Promise<void> {
    await state.opQueue;
    let chain: Promise<unknown> = state.mergeQueue.catch(() => undefined);
    for (const group of state.groups.values()) {
      if (group.merged) continue;
      if (group.parsed === undefined) continue;
      group.merged = true;
      chain = chain.then(() => this.mergeSubagentGroup(state, group).catch(() => undefined));
    }
    state.mergeQueue = chain as Promise<void>;
    await chain;
  }

  private async mergeSubagentGroup(
    state: SessionBridgeState,
    group: SubagentGroupState,
  ): Promise<void> {
    try {
      await state.mainTranscriptPromise;
      const session = await this.db.getSession(state.sessionId);
      if (!session) throw new Error(`Parent session not found: ${state.sessionId}`);
      if (!group.parsed) throw new Error(`Subagent transcript missing for ${group.agentId}`);
      mergeSubagentIntoSession(session, group.agentId, group.parsed, group.meta ?? {});
      await this.db.replaceSession(session);
      await this.reapplySyncState(state.sessionId, state);
      if (group.jsonlFile) {
        await this.upsertSessionFile(state.sessionId, state.projectId, group.jsonlFile);
      }
      if (group.metaFile) {
        await this.upsertSessionFile(state.sessionId, state.projectId, group.metaFile);
      }
      group.jsonlCompletion?.resolve();
      group.metaCompletion?.resolve();
    } catch (error) {
      group.jsonlCompletion?.reject(error as Error);
      group.metaCompletion?.reject(error as Error);
      throw error;
    }
  }

  private async upsertSessionFile(
    sessionId: string,
    projectId: string,
    file: SessionFileRecordFile,
  ): Promise<void> {
    const record: SessionFileRecord = {
      id: generateId(),
      project_id: projectId,
      session_id: sessionId,
      path: file.path,
      scope: fileScope(file.path),
      sha256: file.hash,
      size: file.size,
      status: 'processed',
      updated_at: Date.now(),
    };
    await this.db.upsertSessionFile(record);
  }

  private async reapplySyncState(sessionId: string, state: SessionBridgeState): Promise<void> {
    if (!state.manifest) return;
    await this.db.updateSessionManifest(sessionId, state.manifest);
    await this.db.setSessionSyncStatus(sessionId, 'processing');
  }
}
