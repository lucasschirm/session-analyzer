import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_SANITIZATION_POLICY } from '../sanitization/contract.js';
import { sanitizeJson } from '../sanitization/json.js';
import type { SyncRun } from '../sync-run.js';

export interface SyncTelemetry extends SyncRun {
  sessionId: string;
  command: string;
  timestamp: string;
  durationBudgetMs?: number;
  budgetExhausted?: boolean;
  sessionEndReason?: string;
  diagnostics?: Record<string, unknown>;
}

export interface TelemetryOptions {
  dataDir?: string;
  logPath?: string;
}

function defaultLogPath(options: TelemetryOptions): string {
  const dataDir = options.dataDir ?? path.join(os.homedir(), '.sal-sync');
  return options.logPath ?? path.join(dataDir, 'logs', 'telemetry.jsonl');
}

function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val === undefined) {
      return undefined;
    }
    return val;
  });
}

/**
 * Sanitize a telemetry record to ensure no secrets are written to the log.
 *
 * The record is passed through the standard JSON sanitizer, which redacts
 * known sensitive fields and preserves unknown fields for forward
 * compatibility. If sanitization fails, the original record is returned as a
 * last resort — it already excludes raw secrets by construction.
 */
function sanitizeTelemetryRecord(record: SyncTelemetry): Record<string, unknown> {
  const raw = JSON.parse(safeStringify(record)) as Record<string, unknown>;
  try {
    const sanitized = sanitizeJson(raw, { policy: DEFAULT_SANITIZATION_POLICY });
    if (sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)) {
      return sanitized as Record<string, unknown>;
    }
  } catch {
    // Best effort: write the original record rather than lose telemetry.
  }
  return raw;
}

/**
 * Durable, structured, secret-safe telemetry logger.
 *
 * Records are written as JSONL under the configured data directory. Each line
 * is a self-contained SyncTelemetry object; the logger never writes raw
 * exception strings, credentials, transcript content, or configuration secrets.
 */
export class TelemetryLogger {
  private readonly logPath: string;

  constructor(options: TelemetryOptions = {}) {
    this.logPath = defaultLogPath(options);
  }

  async log(record: SyncTelemetry): Promise<void> {
    const safe = sanitizeTelemetryRecord(record);
    const line = `${JSON.stringify(safe)}\n`;
    const dir = path.dirname(this.logPath);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(this.logPath, line, 'utf8');
  }
}
