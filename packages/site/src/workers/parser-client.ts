/**
 * Helper for offloading session file parsing to the parser Web Worker.
 * A fresh worker is spawned per parse and terminated afterwards, keeping the
 * main thread free during large file processing.
 */

import type { ParsedSession } from '../types';
import type { ParseErrorResponse, ParseRequest, ParseResponse } from './session-parser.worker';

const PARSE_TIMEOUT_MS = 60_000;

export interface ParseFileOptions {
  projectId: string;
  title?: string;
  createWorker?: () => Worker;
}

/** Parses a session file's text content inside a dedicated Web Worker. */
export async function parseInWorker(
  payload: string,
  options: ParseFileOptions,
): Promise<ParsedSession> {
  const createWorker =
    options.createWorker ??
    (() => new Worker(new URL('./session-parser.worker.ts', import.meta.url), { type: 'module' }));
  const worker = createWorker();

  try {
    const result = await new Promise<ParsedSession>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Session parsing timed out'));
      }, PARSE_TIMEOUT_MS);

      worker.onmessage = (event: MessageEvent<ParseResponse | ParseErrorResponse>) => {
        clearTimeout(timer);
        if (event.data.type === 'result') {
          resolve(event.data.result);
        } else {
          reject(new Error(event.data.message));
        }
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(`Parser worker error: ${event.message}`));
      };

      const request: ParseRequest = {
        type: 'parse',
        payload,
        projectId: options.projectId,
        title: options.title,
      };
      worker.postMessage(request);
    });

    return result;
  } finally {
    worker.terminate();
  }
}
