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
export function parseInWorker(payload: string, options: ParseFileOptions): Promise<ParsedSession>;

/**
 * Parses a session file from an `ArrayBuffer` inside a dedicated Web Worker.
 * The buffer is transferred (not copied) into the worker via `postMessage`.
 */
export function parseInWorker(
  payload: ArrayBuffer,
  options: ParseFileOptions,
): Promise<ParsedSession>;

export async function parseInWorker(
  payload: string | ArrayBuffer,
  options: ParseFileOptions,
): Promise<ParsedSession> {
  const worker = (options.createWorker ?? defaultCreateWorker)();

  try {
    return await runWorkerParse(worker, payload, options);
  } finally {
    worker.terminate();
  }
}

function defaultCreateWorker(): Worker {
  return new Worker(new URL('./session-parser.worker.ts', import.meta.url), { type: 'module' });
}

function buildParseRequest(payload: string | ArrayBuffer, options: ParseFileOptions): ParseRequest {
  return {
    type: 'parse',
    payload,
    projectId: options.projectId,
    title: options.title,
  };
}

function parseWorkerMessage(
  event: MessageEvent<ParseResponse | ParseErrorResponse>,
): ParsedSession {
  if (event.data.type === 'result') {
    return event.data.result;
  }
  throw new Error(event.data.message);
}

function runWorkerParse(
  worker: Worker,
  payload: string | ArrayBuffer,
  options: ParseFileOptions,
): Promise<ParsedSession> {
  return new Promise<ParsedSession>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Session parsing timed out'));
    }, PARSE_TIMEOUT_MS);

    worker.onmessage = (event: MessageEvent<ParseResponse | ParseErrorResponse>) => {
      clearTimeout(timer);
      try {
        resolve(parseWorkerMessage(event));
      } catch (error) {
        reject(error as Error);
      }
    };

    worker.onerror = (event: ErrorEvent) => {
      clearTimeout(timer);
      reject(new Error(`Parser worker error: ${event.message}`));
    };

    const request = buildParseRequest(payload, options);
    if (typeof payload === 'string') {
      worker.postMessage(request);
    } else {
      worker.postMessage(request, [payload as Transferable]);
    }
  });
}
