/**
 * Typed message protocol between the main thread (db-client) and the
 * database Web Worker (db-worker). All SQLite transactions happen in the
 * worker so the UI thread never blocks on database I/O.
 */

import type {
  Connection,
  PasskeyState,
  Project,
  SessionFileRecord,
  SessionStub,
  SessionSyncStatus,
  StoredS3Credentials,
  SyncManifest,
} from '../types';
import type { CommittedGenerationReceipt, FallbackReason, SourceCheckpoint } from './database';

export interface DbDatabaseHandle {
  filename: string;
  pointer: number;
}

export type DbRequest =
  | { id: number; type: 'init' }
  | { id: number; type: 'createProject'; project: Project }
  | { id: number; type: 'getProjects' }
  | { id: number; type: 'getProject'; projectId: string }
  | {
      id: number;
      type: 'updateProject';
      projectId: string;
      fields: { name?: string; description?: string; readable_id?: string };
    }
  | { id: number; type: 'deleteProject'; projectId: string }
  | { id: number; type: 'createConnection'; connection: Connection }
  | {
      id: number;
      type: 'updateConnection';
      connectionId: string;
      fields: Partial<Pick<Connection, 'name' | 'sync_only_new' | 'last_sync_at'>>;
    }
  | { id: number; type: 'deleteConnection'; connectionId: string }
  | { id: number; type: 'getConnections' }
  | { id: number; type: 'saveS3Credentials'; credentials: StoredS3Credentials }
  | { id: number; type: 'getS3Credentials'; connectionId: string }
  | { id: number; type: 'deleteAllCredentials' }
  | { id: number; type: 'getPasskeyState' }
  | { id: number; type: 'savePasskeyState'; state: PasskeyState }
  | { id: number; type: 'getProjectByReadableId'; readableId: string }
  | { id: number; type: 'setProjectSyncStatus'; projectId: string; status: 'in_sync' | 'syncing' }
  | { id: number; type: 'backfillReadableIds' }
  | { id: number; type: 'getSessionBySyncId'; projectId: string; syncSessionId: string }
  | { id: number; type: 'upsertSessionStub'; stub: SessionStub }
  | {
      id: number;
      type: 'setSessionSyncStatus';
      sessionId: string;
      status: SessionSyncStatus;
      details?: string;
    }
  | { id: number; type: 'updateSessionManifest'; sessionId: string; manifest: SyncManifest }
  | { id: number; type: 'getSessionSyncManifest'; sessionId: string }
  | { id: number; type: 'getSyncRunCount'; sessionId: string }
  | { id: number; type: 'failStaleSessions'; projectId: string; details: string }
  | { id: number; type: 'reconcileSyncStates'; sessionDetails: string }
  | { id: number; type: 'getSessionFiles'; sessionId: string }
  | { id: number; type: 'upsertSessionFile'; file: SessionFileRecord }
  | { id: number; type: 'deleteSessionFiles'; sessionId: string }
  | {
      id: number;
      type: 'commitSourceCheckpoint';
      sourceId: string;
      checkpoint: SourceCheckpoint;
      receipt: CommittedGenerationReceipt;
    }
  | { id: number; type: 'getSourceCheckpoint'; sourceId: string }
  | { id: number; type: 'getSourceCheckpoints' }
  | { id: number; type: 'setUiPreference'; key: string; value: string }
  | { id: number; type: 'getUiPreference'; key: string }
  | { id: number; type: 'exportControlDatabase' }
  | { id: number; type: 'getControlDb' };

export interface DbSuccessResponse {
  id: number;
  ok: true;
  /** JSON-serializable result for every request except exportControlDatabase. */
  result?: unknown;
  /** Raw SQLite file bytes for exportControlDatabase (transferred, not copied). */
  bytes?: Uint8Array;
  /** Storage backend reported by init. */
  storage?: 'opfs' | 'memory';
  /** Reason when init falls back to in-memory (empty/omitted when opfs opens). */
  fallbackReason?: FallbackReason;
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
