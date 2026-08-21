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
import type { DashboardSession, ParsedSession, SyncManifest } from '../types';
import type { parseInWorker } from '../workers/parser-client';

/** A single downloaded file buffer handed to the bridge. */
export interface DownloadedFile {
  path: string;
  hash: string;
  size: number;
  content: ArrayBuffer;
}

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
): (sessionId: string, file: DownloadedFile) => Promise<void> {
  const bridge = new FileProcessingBridge(db, parse);
  return (sessionId, file) => bridge.onFileDownloaded(sessionId, file);
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
    return this.enqueue(state, () => this.processMain(state, parsed));
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
        this.enqueue(state, () => this.updateGroupWithMeta(state, agentId, meta, resolve, reject));
      });
    }
    const parsed = await this.parse(file.content, { projectId: state.projectId });
    return new Promise<void>((resolve, reject) => {
      this.enqueue(state, () => this.updateGroupWithJsonl(state, agentId, parsed, resolve, reject));
    });
  }

  private enqueue(state: SessionBridgeState, work: () => Promise<void> | void): Promise<void> {
    const next = state.opQueue.then(work);
    state.opQueue = next;
    return next;
  }

  private async processMain(state: SessionBridgeState, parsed: ParsedSession): Promise<void> {
    try {
      const sessionId = await this.db.upsertSessionByExternalId(parsed.session);
      await this.reapplySyncState(sessionId, state);
      state.resolveMain();
    } catch (error) {
      state.rejectMain(error as Error);
      throw error;
    }
  }

  private updateGroupWithJsonl(
    state: SessionBridgeState,
    agentId: string,
    parsed: ParsedSession,
    resolve: () => void,
    reject: (error: Error) => void,
  ): void {
    const group = this.getOrCreateGroup(state, agentId);
    group.parsed = parsed.session;
    group.jsonlCompletion = { resolve, reject };
    this.tryMergeGroup(state, group);
  }

  private updateGroupWithMeta(
    state: SessionBridgeState,
    agentId: string,
    meta: SubagentMeta,
    resolve: () => void,
    reject: (error: Error) => void,
  ): void {
    const group = this.getOrCreateGroup(state, agentId);
    group.meta = meta;
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

  private tryMergeGroup(state: SessionBridgeState, group: SubagentGroupState): void {
    if (group.merged) return;
    if (group.parsed === undefined) return;
    if (isSidecarExpected(state.manifest, group.agentId) && group.meta === undefined) return;
    group.merged = true;
    state.mergeQueue = state.mergeQueue.then(() => this.mergeSubagentGroup(state, group));
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
      group.jsonlCompletion?.resolve();
      group.metaCompletion?.resolve();
    } catch (error) {
      group.jsonlCompletion?.reject(error as Error);
      group.metaCompletion?.reject(error as Error);
      throw error;
    }
  }

  private async reapplySyncState(sessionId: string, state: SessionBridgeState): Promise<void> {
    if (!state.manifest) return;
    await this.db.updateSessionManifest(sessionId, state.manifest);
    await this.db.setSessionSyncStatus(sessionId, 'processing');
  }
}
