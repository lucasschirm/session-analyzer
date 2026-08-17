import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { TelemetryLogger } from '../../src/telemetry/index.js';

describe('TelemetryLogger', () => {
  it('writes a JSONL record to the default log path', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'sal-sync-telemetry-'));
    const logger = new TelemetryLogger({ dataDir });

    await logger.log({
      sessionId: 'sess-1',
      command: 'capture',
      trigger: 'manual',
      timestamp: new Date().toISOString(),
      filesDiscovered: 1,
      filesChanged: 1,
      filesUploaded: 1,
      filesFailed: 0,
      filesSkipped: 0,
      bytesDiscovered: 100,
      bytesChanged: 100,
      bytesUploaded: 100,
      errors: [],
      discoveryDurationMs: 10,
      sanitizationDurationMs: 5,
      hashDurationMs: 3,
      uploadDurationMs: 20,
      totalDurationMs: 38,
    });

    const logPath = path.join(dataDir, 'logs', 'telemetry.jsonl');
    const contents = await readFile(logPath, 'utf8');
    const parsed = JSON.parse(contents.trim()) as unknown;

    expect(parsed).toMatchObject({
      sessionId: 'sess-1',
      command: 'capture',
      trigger: 'manual',
      filesUploaded: 1,
    });
  });

  it('redacts known sensitive fields before writing', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'sal-sync-telemetry-'));
    const logger = new TelemetryLogger({ dataDir });

    await logger.log({
      sessionId: 'sess-1',
      command: 'capture',
      trigger: 'manual',
      timestamp: new Date().toISOString(),
      filesDiscovered: 0,
      filesChanged: 0,
      filesUploaded: 0,
      filesFailed: 0,
      filesSkipped: 0,
      bytesDiscovered: 0,
      bytesChanged: 0,
      bytesUploaded: 0,
      errors: [],
      discoveryDurationMs: 0,
      sanitizationDurationMs: 0,
      hashDurationMs: 0,
      uploadDurationMs: 0,
      totalDurationMs: 0,
      diagnostics: {
        secret: 'should-be-redacted',
        token: 'also-redacted',
        safe: 'keep-me',
      },
    });

    const logPath = path.join(dataDir, 'logs', 'telemetry.jsonl');
    const contents = await readFile(logPath, 'utf8');
    const parsed = JSON.parse(contents.trim()) as Record<string, unknown>;

    expect(parsed.diagnostics).toMatchObject({
      secret: '[REDACTED]',
      token: '[REDACTED]',
      safe: 'keep-me',
    });
  });

  it('supports an explicit log path', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'sal-sync-telemetry-'));
    const logPath = path.join(dataDir, 'custom-telemetry.jsonl');
    const logger = new TelemetryLogger({ logPath });

    await logger.log({
      sessionId: 'sess-1',
      command: 'status',
      trigger: 'manual',
      timestamp: new Date().toISOString(),
      filesDiscovered: 0,
      filesChanged: 0,
      filesUploaded: 0,
      filesFailed: 0,
      filesSkipped: 0,
      bytesDiscovered: 0,
      bytesChanged: 0,
      bytesUploaded: 0,
      errors: [],
      discoveryDurationMs: 0,
      sanitizationDurationMs: 0,
      hashDurationMs: 0,
      uploadDurationMs: 0,
      totalDurationMs: 0,
    });

    const contents = await readFile(logPath, 'utf8');
    const parsed = JSON.parse(contents.trim()) as Record<string, unknown>;
    expect(parsed.command).toBe('status');
  });
});
