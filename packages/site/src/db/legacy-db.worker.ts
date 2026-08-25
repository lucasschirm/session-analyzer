/**
 * Legacy Database Web Worker
 *
 * Hosts the read-only legacy `session-analyzer.sqlite3` database in its own
 * worker so its OPFS lock never overlaps with the analytics/control worker.
 */

import { LegacyDatabase } from './legacy-database';
import type { LegacyDbRequest, LegacyDbResponse } from './legacy-db-client';

const db = new LegacyDatabase();

type LegacyDbRequestOf<K extends LegacyDbRequest['type']> = Extract<LegacyDbRequest, { type: K }>;

type Handler = (request: LegacyDbRequest) => LegacyDbResponse | Promise<LegacyDbResponse>;

const handlers: Record<LegacyDbRequest['type'], Handler> = {
  init: async (request) => {
    const req = request as LegacyDbRequestOf<'init'>;
    const storage = await db.initialize(req.filename);
    return { id: request.id, ok: true, storage, fallbackReason: db.fallbackReason };
  },
  exportDatabase: (request) => ({
    id: request.id,
    ok: true,
    bytes: db.exportDatabase(),
  }),
  close: (request) => {
    db.close();
    return { id: request.id, ok: true };
  },
};

async function handleRequest(request: LegacyDbRequest): Promise<LegacyDbResponse> {
  const handler = handlers[request.type];
  try {
    return await handler(request);
  } catch (error) {
    return { id: request.id, ok: false, error: (error as Error).message };
  }
}

let queue: Promise<void> = Promise.resolve();

self.onmessage = (event: MessageEvent<LegacyDbRequest>) => {
  queue = queue.then(() =>
    handleRequest(event.data).then((response) => {
      if (response.ok && response.bytes) {
        self.postMessage(response, [response.bytes.buffer as ArrayBuffer]);
      } else {
        self.postMessage(response);
      }
    }),
  );
};
