/**
 * Typed message protocol between the main thread (db-client) and the
 * database Web Worker (db-worker). All SQLite transactions happen in the
 * worker so the UI thread never blocks on database I/O.
 */

import type { DashboardSession, Project } from '../types';

export type DbRequest =
  | { id: number; type: 'init' }
  | { id: number; type: 'createProject'; project: Project }
  | { id: number; type: 'getProjects' }
  | { id: number; type: 'getProject'; projectId: string }
  | {
      id: number;
      type: 'updateProject';
      projectId: string;
      fields: { name?: string; description?: string };
    }
  | { id: number; type: 'deleteProject'; projectId: string }
  | { id: number; type: 'saveSession'; session: DashboardSession }
  | { id: number; type: 'upsertSessionByExternalId'; session: DashboardSession }
  | { id: number; type: 'replaceSession'; session: DashboardSession }
  | { id: number; type: 'findSessionByExternalId'; projectId: string; externalId: string }
  | { id: number; type: 'getSessionsByProject'; projectId: string }
  | { id: number; type: 'searchSessions'; projectId: string; query: string }
  | { id: number; type: 'getSession'; sessionId: string }
  | { id: number; type: 'deleteSession'; sessionId: string }
  | { id: number; type: 'getProjectMetrics'; projectId: string }
  | { id: number; type: 'exportDatabase' };

export interface DbSuccessResponse {
  id: number;
  ok: true;
  /** JSON-serializable result for every request except exportDatabase. */
  result?: unknown;
  /** Raw SQLite file bytes for exportDatabase (transferred, not copied). */
  bytes?: Uint8Array;
  /** Storage backend reported by init. */
  storage?: 'opfs' | 'memory';
}

export interface DbErrorResponse {
  id: number;
  ok: false;
  error: string;
}

export type DbResponse = DbSuccessResponse | DbErrorResponse;

/** Distributive Omit so the union members keep their specific payload keys. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** Request payload as posted from the main thread (id is assigned there). */
export type DbRequestPayload = DistributiveOmit<DbRequest, 'id'>;
