/**
 * Database Web Worker
 *
 * Hosts the SQLite WASM database (OPFS-backed when available) and executes
 * every transaction off the main thread. Communicates via the typed
 * DbRequest/DbResponse protocol defined in db-protocol.ts.
 */

import { DatabaseManager } from './database';
import type { DbRequest, DbResponse } from './db-protocol';

const manager = new DatabaseManager();

type DbRequestOf<K extends DbRequest['type']> = Extract<DbRequest, { type: K }>;

type Handler = (request: DbRequest) => DbResponse | Promise<DbResponse>;

/**
 * Router for every supported DbRequest type. Each handler is a short arrow
 * that delegates to DatabaseManager and returns a DbResponse.
 */
const handlers: Record<DbRequest['type'], Handler> = {
  init: async (request) => {
    const storage = await manager.initialize();
    return { id: request.id, ok: true, storage, fallbackReason: manager.fallbackReason };
  },
  createProject: (request) => {
    manager.createProject((request as DbRequestOf<'createProject'>).project);
    return { id: request.id, ok: true };
  },
  getProjects: (request) => ({ id: request.id, ok: true, result: manager.getProjects() }),
  getProject: (request) => ({
    id: request.id,
    ok: true,
    result: manager.getProject((request as DbRequestOf<'getProject'>).projectId),
  }),
  updateProject: (request) => {
    const req = request as DbRequestOf<'updateProject'>;
    manager.updateProject(req.projectId, req.fields);
    return { id: request.id, ok: true };
  },
  deleteProject: (request) => {
    manager.deleteProject((request as DbRequestOf<'deleteProject'>).projectId);
    return { id: request.id, ok: true };
  },

  createConnection: (request) => {
    manager.createConnection((request as DbRequestOf<'createConnection'>).connection);
    return { id: request.id, ok: true };
  },
  updateConnection: (request) => {
    const req = request as DbRequestOf<'updateConnection'>;
    manager.updateConnection(req.connectionId, req.fields);
    return { id: request.id, ok: true };
  },
  deleteConnection: (request) => {
    manager.deleteConnection((request as DbRequestOf<'deleteConnection'>).connectionId);
    return { id: request.id, ok: true };
  },
  getConnections: (request) => ({ id: request.id, ok: true, result: manager.getConnections() }),
  saveS3Credentials: (request) => {
    manager.saveS3Credentials((request as DbRequestOf<'saveS3Credentials'>).credentials);
    return { id: request.id, ok: true };
  },
  getS3Credentials: (request) => ({
    id: request.id,
    ok: true,
    result: manager.getS3Credentials((request as DbRequestOf<'getS3Credentials'>).connectionId),
  }),
  deleteAllCredentials: (request) => {
    manager.deleteAllCredentials();
    return { id: request.id, ok: true };
  },

  getPasskeyState: (request) => ({ id: request.id, ok: true, result: manager.getPasskeyState() }),
  savePasskeyState: (request) => {
    manager.savePasskeyState((request as DbRequestOf<'savePasskeyState'>).state);
    return { id: request.id, ok: true };
  },

  getProjectByReadableId: (request) => ({
    id: request.id,
    ok: true,
    result: manager.getProjectByReadableId(
      (request as DbRequestOf<'getProjectByReadableId'>).readableId,
    ),
  }),
  setProjectSyncStatus: (request) => {
    const req = request as DbRequestOf<'setProjectSyncStatus'>;
    manager.setProjectSyncStatus(req.projectId, req.status);
    return { id: request.id, ok: true };
  },
  backfillReadableIds: (request) => {
    manager.backfillReadableIds();
    return { id: request.id, ok: true };
  },

  getSessionBySyncId: (request) => {
    const req = request as DbRequestOf<'getSessionBySyncId'>;
    return {
      id: request.id,
      ok: true,
      result: manager.getSessionBySyncId(req.projectId, req.syncSessionId),
    };
  },
  upsertSessionStub: (request) => {
    manager.upsertSessionStub((request as DbRequestOf<'upsertSessionStub'>).stub);
    return { id: request.id, ok: true };
  },
  setSessionSyncStatus: (request) => {
    const req = request as DbRequestOf<'setSessionSyncStatus'>;
    manager.setSessionSyncStatus(req.sessionId, req.status, req.details);
    return { id: request.id, ok: true };
  },
  updateSessionManifest: (request) => {
    const req = request as DbRequestOf<'updateSessionManifest'>;
    manager.updateSessionManifest(req.sessionId, req.manifest);
    return { id: request.id, ok: true };
  },
  getSessionSyncManifest: (request) => ({
    id: request.id,
    ok: true,
    result: manager.getSessionSyncManifest(
      (request as DbRequestOf<'getSessionSyncManifest'>).sessionId,
    ),
  }),
  getSyncRunCount: (request) => ({
    id: request.id,
    ok: true,
    result: manager.getSyncRunCount((request as DbRequestOf<'getSyncRunCount'>).sessionId),
  }),
  failStaleSessions: (request) => {
    const req = request as DbRequestOf<'failStaleSessions'>;
    manager.failStaleSessions(req.projectId, req.details);
    return { id: request.id, ok: true };
  },
  reconcileSyncStates: (request) => {
    manager.reconcileSyncStates((request as DbRequestOf<'reconcileSyncStates'>).sessionDetails);
    return { id: request.id, ok: true };
  },

  getSessionFiles: (request) => ({
    id: request.id,
    ok: true,
    result: manager.getSessionFiles((request as DbRequestOf<'getSessionFiles'>).sessionId),
  }),
  upsertSessionFile: (request) => {
    manager.upsertSessionFile((request as DbRequestOf<'upsertSessionFile'>).file);
    return { id: request.id, ok: true };
  },
  deleteSessionFiles: (request) => {
    manager.deleteSessionFiles((request as DbRequestOf<'deleteSessionFiles'>).sessionId);
    return { id: request.id, ok: true };
  },

  commitSourceCheckpoint: (request) => {
    const req = request as DbRequestOf<'commitSourceCheckpoint'>;
    manager.commitSourceCheckpoint(req.sourceId, req.checkpoint, req.receipt);
    return { id: request.id, ok: true };
  },
  getSourceCheckpoint: (request) => ({
    id: request.id,
    ok: true,
    result: manager.getSourceCheckpoint((request as DbRequestOf<'getSourceCheckpoint'>).sourceId),
  }),
  getSourceCheckpoints: (request) => ({
    id: request.id,
    ok: true,
    result: manager.getSourceCheckpoints(),
  }),
  setUiPreference: (request) => {
    const req = request as DbRequestOf<'setUiPreference'>;
    manager.setUiPreference(req.key, req.value);
    return { id: request.id, ok: true };
  },
  getUiPreference: (request) => ({
    id: request.id,
    ok: true,
    result: manager.getUiPreference((request as DbRequestOf<'getUiPreference'>).key),
  }),
  exportControlDatabase: (request) => ({
    id: request.id,
    ok: true,
    bytes: manager.exportControlDatabase(),
  }),
  getControlDb: (request) => {
    const db = manager.getControlDb();
    return { id: request.id, ok: true, result: { filename: db.filename, pointer: db.pointer } };
  },
};

async function handleRequest(request: DbRequest): Promise<DbResponse> {
  const handler = handlers[request.type];
  try {
    return await handler(request);
  } catch (error) {
    return { id: request.id, ok: false, error: (error as Error).message };
  }
}

// Requests are processed strictly in arrival order (not concurrently): the
// 'init' request must finish opening the database before any query that
// depends on it is handled, otherwise a request issued immediately after
// 'init' (before it resolves) would race ahead and hit an uninitialized db.
let queue: Promise<void> = Promise.resolve();

self.onmessage = (event: MessageEvent<DbRequest>) => {
  queue = queue.then(() =>
    handleRequest(event.data).then((response) => {
      if (response.ok && response.bytes) {
        // Transfer the bytes instead of structured-cloning a copy.
        self.postMessage(response, [response.bytes.buffer as ArrayBuffer]);
      } else {
        self.postMessage(response);
      }
    }),
  );
};
