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

function makeTmpDir(): string {
  return path.join(
    os.tmpdir(),
    `sal-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

describe('resolveLogFolder', () => {
  it('defaults to ~/.sal-sync/logs when both env vars are unset', () => {
    expect(resolveLogFolder({})).toBe(path.join(os.homedir(), '.sal-sync', 'logs'));
  });

  it('defaults to ~/.sal-sync/logs when CLAUDE_SYNC_LOG_PATH_FOLDER is empty', () => {
    expect(resolveLogFolder({ [LOG_FOLDER_ENV]: '' })).toBe(
      path.join(os.homedir(), '.sal-sync', 'logs'),
    );
  });

  it('defaults to ~/.sal-sync/logs when CLAUDE_SYNC_LOG_PATH_FOLDER is whitespace', () => {
    expect(resolveLogFolder({ [LOG_FOLDER_ENV]: '   ' })).toBe(
      path.join(os.homedir(), '.sal-sync', 'logs'),
    );
  });

  it('honors SAL_DATA_DIR as the base for the logs/ subfolder (via shared getDataDir)', () => {
    expect(resolveLogFolder({ SAL_DATA_DIR: '/var/lib/sal-sync' })).toBe('/var/lib/sal-sync/logs');
  });

  it('CLAUDE_SYNC_LOG_PATH_FOLDER overrides SAL_DATA_DIR entirely', () => {
    expect(
      resolveLogFolder({ SAL_DATA_DIR: '/var/lib/sal-sync', [LOG_FOLDER_ENV]: '/var/log/cs' }),
    ).toBe('/var/log/cs');
  });

  it('honors a configured absolute CLAUDE_SYNC_LOG_PATH_FOLDER', () => {
    expect(resolveLogFolder({ [LOG_FOLDER_ENV]: '/var/log/claude-sync' })).toBe(
      '/var/log/claude-sync',
    );
  });

  it('resolves a relative CLAUDE_SYNC_LOG_PATH_FOLDER against cwd', () => {
    expect(resolveLogFolder({ [LOG_FOLDER_ENV]: 'tmp/logs' })).toBe(path.resolve('tmp/logs'));
  });
});

describe('formatLogTimestamp', () => {
  it('produces a YYYYMMDD-HHMMSS UTC string', () => {
    const ts = formatLogTimestamp(new Date('2026-09-01T18:07:12.000Z'));
    expect(ts).toBe('20260901-180712');
  });

  it('zero-pads single-digit fields', () => {
    const ts = formatLogTimestamp(new Date('2026-01-02T03:04:05.000Z'));
    expect(ts).toBe('20260102-030405');
  });

  it('matches the expected filename pattern', () => {
    const ts = formatLogTimestamp();
    expect(ts).toMatch(/^\d{8}-\d{6}$/);
  });
});

describe('buildLogFileName', () => {
  it('produces <command>-log-<timestamp>.log', () => {
    expect(buildLogFileName('download', '20260901-180712')).toBe(
      'download-log-20260901-180712.log',
    );
  });

  it('falls back to claude-sync-log for missing command', () => {
    expect(buildLogFileName(undefined, '20260901-180712')).toBe(
      'claude-sync-log-20260901-180712.log',
    );
  });

  it('falls back to claude-sync-log for empty command', () => {
    expect(buildLogFileName('   ', '20260901-180712')).toBe('claude-sync-log-20260901-180712.log');
  });
});

describe('formatErrorLogContent', () => {
  it('includes the command label and ISO timestamp header', () => {
    const content = formatErrorLogContent(new Error('boom'), 'download');
    expect(content).toContain('claude-sync download — error log');
    expect(content).toMatch(/Timestamp: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('includes the error name, message, and stack trace', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at foo:1:2';
    const content = formatErrorLogContent(err, 'sync');
    expect(content).toContain('Error: Error: boom');
    expect(content).toContain('at foo:1:2');
  });

  it('notes when no stack trace is available', () => {
    const err = new Error('boom');
    err.stack = undefined;
    const content = formatErrorLogContent(err, 'download');
    expect(content).toContain('(no stack trace available)');
  });

  it('renders chained Error causes', () => {
    const root = new Error('root cause');
    const err = new Error('surface', { cause: root });
    err.stack = 'Error: surface\n    at top:1:1';
    const content = formatErrorLogContent(err, 'download');
    expect(content).toContain('Cause:');
    expect(content).toContain('root cause');
  });

  it('renders non-Error throwables via String()', () => {
    const content = formatErrorLogContent('a string error', 'download');
    expect(content).toContain('Error: a string error');
  });

  it('uses claude-sync as the command label for missing command', () => {
    const content = formatErrorLogContent(new Error('boom'), undefined);
    expect(content).toContain('claude-sync claude-sync — error log');
  });
});

describe('writeErrorLog', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = makeTmpDir();
    await fsp.mkdir(tmpRoot, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it('writes a log file under the configured folder and returns written: true', async () => {
    const logFolder = path.join(tmpRoot, 'logs');
    const err = new Error('aborted');
    err.stack = 'Error: aborted\n    at somewhere:1:1';

    const result = await writeErrorLog({ [LOG_FOLDER_ENV]: logFolder }, 'download', err);

    expect(result.written).toBe(true);
    expect(result.logPath).toMatch(/download-log-\d{8}-\d{6}\.log$/);
    expect(result.logPath.startsWith(logFolder)).toBe(true);

    const content = await fsp.readFile(result.logPath, 'utf8');
    expect(content).toContain('claude-sync download — error log');
    expect(content).toContain('Error: aborted');
    expect(content).toContain('at somewhere:1:1');
  });

  it('creates nested log folders that do not yet exist', async () => {
    const logFolder = path.join(tmpRoot, 'a', 'b', 'c');
    const result = await writeErrorLog({ [LOG_FOLDER_ENV]: logFolder }, 'sync', new Error('x'));
    expect(result.written).toBe(true);
    const stat = await fsp.stat(result.logPath);
    expect(stat.isFile()).toBe(true);
  });

  it('returns written: false (without throwing) when the folder cannot be created', async () => {
    // Point the log folder at a path whose parent is a file, so mkdir fails.
    const blockingFile = path.join(tmpRoot, 'blocking-file');
    await fsp.writeFile(blockingFile, 'x', 'utf8');
    const logFolder = path.join(blockingFile, 'logs');

    const result = await writeErrorLog({ [LOG_FOLDER_ENV]: logFolder }, 'download', new Error('x'));

    expect(result.written).toBe(false);
    expect(result.logPath.startsWith(logFolder)).toBe(true);
  });
});

describe('formatAbortMessage', () => {
  it('points at the log file when it was written successfully', () => {
    const result = formatAbortMessage(new Error('aborted'), {
      logPath: '/home/user/.claude-sync/logs/download-log-20260901-180712.log',
      written: true,
    });
    expect(result).toBe(
      'claude-sync: aborted. Check log in /home/user/.claude-sync/logs/download-log-20260901-180712.log',
    );
  });

  it('includes the original message and log path when writing failed', () => {
    const result = formatAbortMessage(new Error('aborted'), {
      logPath: '/bad/path/download-log-20260901-180712.log',
      written: false,
    });
    expect(result).toBe(
      'claude-sync: aborted: aborted (failed to write log at /bad/path/download-log-20260901-180712.log)',
    );
  });

  it('stringifies non-Error throwables in the fallback message', () => {
    const result = formatAbortMessage('something broke', {
      logPath: '/bad/path/x.log',
      written: false,
    });
    expect(result).toBe(
      'claude-sync: aborted: something broke (failed to write log at /bad/path/x.log)',
    );
  });
});
