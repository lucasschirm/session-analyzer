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

async function handleRequest(request: DbRequest): Promise<DbResponse> {
  try {
    switch (request.type) {
      case 'init': {
        const storage = await manager.initialize();
        return { id: request.id, ok: true, storage };
      }
      case 'createProject':
        manager.createProject(request.project);
        return { id: request.id, ok: true };
      case 'getProjects':
        return { id: request.id, ok: true, result: manager.getProjects() };
      case 'getProject':
        return { id: request.id, ok: true, result: manager.getProject(request.projectId) };
      case 'updateProject':
        manager.updateProject(request.projectId, request.fields);
        return { id: request.id, ok: true };
      case 'deleteProject':
        manager.deleteProject(request.projectId);
        return { id: request.id, ok: true };
      case 'saveSession':
        manager.saveSession(request.session);
        return { id: request.id, ok: true };
      case 'upsertSessionByExternalId':
        return {
          id: request.id,
          ok: true,
          result: manager.upsertSessionByExternalId(request.session),
        };
      case 'replaceSession':
        manager.replaceSession(request.session);
        return { id: request.id, ok: true };
      case 'findSessionByExternalId':
        return {
          id: request.id,
          ok: true,
          result: manager.findSessionByExternalId(request.projectId, request.externalId),
        };
      case 'getSessionsByProject':
        return { id: request.id, ok: true, result: manager.getSessionsByProject(request.projectId) };
      case 'searchSessions':
        return {
          id: request.id,
          ok: true,
          result: manager.searchSessions(request.projectId, request.query),
        };
      case 'getSession':
        return { id: request.id, ok: true, result: manager.getSession(request.sessionId) };
      case 'deleteSession':
        manager.deleteSession(request.sessionId);
        return { id: request.id, ok: true };
      case 'getProjectMetrics':
        return { id: request.id, ok: true, result: manager.getProjectMetrics(request.projectId) };
      case 'exportDatabase': {
        const bytes = manager.exportDatabase();
        return { id: request.id, ok: true, bytes };
      }
      default: {
        const exhaustive: never = request;
        return { id: -1, ok: false, error: `Unknown request: ${JSON.stringify(exhaustive)}` };
      }
    }
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
    })
  );
};

export {};
