import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildLogFileName,
  formatAbortMessage,
  formatErrorLogContent,
  formatLogTimestamp,
  LOG_FOLDER_ENV,
  resolveLogFolder,
  writeErrorLog,
} from '../../src/cli/logger.js';

describe('resolveLogFolder', () => {
  it('honors DEVIN_SYNC_LOG_PATH_FOLDER when set', () => {
    expect(resolveLogFolder({ [LOG_FOLDER_ENV]: '/custom/logs' })).toBe('/custom/logs');
  });

  it('defaults to <dataDir>/logs', () => {
    const folder = resolveLogFolder({});
    expect(folder.endsWith(path.join('.sal-sync', 'logs'))).toBe(true);
  });
});

describe('buildLogFileName', () => {
  it('includes the command name', () => {
    expect(buildLogFileName('sync', '20260101-000000')).toBe('sync-log-20260101-000000.log');
  });

  it('falls back to devin-sync for an unknown command', () => {
    expect(buildLogFileName(undefined, '20260101-000000')).toBe(
      'devin-sync-log-20260101-000000.log',
    );
  });
});

describe('formatLogTimestamp', () => {
  it('formats as YYYYMMDD-HHMMSS', () => {
    const ts = formatLogTimestamp(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)));
    expect(ts).toBe('20260102-030405');
  });
});

describe('formatErrorLogContent', () => {
  it('includes the error name, message, and stack', () => {
    const content = formatErrorLogContent(new Error('boom'), 'sync');
    expect(content).toContain('devin-sync sync');
    expect(content).toContain('Error: Error: boom');
  });

  it('handles a non-Error thrown value', () => {
    const content = formatErrorLogContent('raw string error', undefined);
    expect(content).toContain('raw string error');
  });

  it('includes a chained cause', () => {
    const cause = new Error('root cause');
    const err = new Error('outer', { cause });
    const content = formatErrorLogContent(err, 'sync');
    expect(content).toContain('root cause');
  });

  it('recurses through a doubly-nested cause chain', () => {
    const rootCause = new Error('deepest cause');
    const middleCause = new Error('middle cause', { cause: rootCause });
    const err = new Error('outer', { cause: middleCause });
    const content = formatErrorLogContent(err, 'sync');
    expect(content).toContain('middle cause');
    expect(content).toContain('deepest cause');
  });

  it('formats a non-Error cause value', () => {
    const err = new Error('outer', { cause: 'a plain string cause' });
    const content = formatErrorLogContent(err, 'sync');
    expect(content).toContain('a plain string cause');
  });
});

describe('writeErrorLog / formatAbortMessage', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-logger-'));
  });

  afterEach(async () => {
    await fsp.rm(folder, { recursive: true, force: true });
  });

  it('writes a log file and formats the abort message with its path', async () => {
    const result = await writeErrorLog({ [LOG_FOLDER_ENV]: folder }, 'sync', new Error('boom'));
    expect(result.written).toBe(true);
    const content = await fsp.readFile(result.logPath, 'utf8');
    expect(content).toContain('boom');
    expect(formatAbortMessage(new Error('boom'), result)).toContain('Check log in');
  });

  it('falls back to the raw error message when the log cannot be written', async () => {
    const badFolder = path.join(folder, 'nested', String.fromCharCode(0));
    const result = { logPath: path.join(badFolder, 'x.log'), written: false };
    expect(formatAbortMessage(new Error('boom'), result)).toContain('boom');
  });

  it('reports written:false when the log directory cannot be created (ENOTDIR)', async () => {
    // Create a plain file, then try to use its path as a directory segment —
    // mkdir(recursive) fails with ENOTDIR, exercising writeErrorLog's real
    // catch branch (not just a manually-constructed AbortLogResult).
    const blockerFile = path.join(folder, 'blocker');
    await fsp.writeFile(blockerFile, 'not a directory');
    const result = await writeErrorLog(
      { [LOG_FOLDER_ENV]: path.join(blockerFile, 'logs') },
      'sync',
      new Error('boom'),
    );
    expect(result.written).toBe(false);
    expect(formatAbortMessage(new Error('boom'), result)).toContain('failed to write log');
  });
});
