import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliHarnessAdapter } from '../../../src/cli/harness-adapter.js';
import {
  buildLogFileName,
  formatAbortMessage,
  formatErrorLogContent,
  resolveLogFolder,
  writeErrorLog,
} from '../../../src/cli/logger.js';

const FIXTURE_ADAPTER: CliHarnessAdapter = {
  profile: {
    harness: 'fixture',
    harnessVersion: '0.0.0',
    configDir: () => '/fixture',
    captureAllowlist: { version: 1, session: [], workspace: [], global: [] },
    sessionLayout: {
      mainTranscriptStorageName: 'transcript.jsonl',
      mainTranscriptFilePattern: '{sessionId}.jsonl',
      subagentTranscriptsPattern: 'subagents/*.jsonl',
      subagentMetaPattern: 'subagents/*.meta.json',
    },
    securityBlocklist: [],
  },
  binName: 'fixture-sync',
  packageName: '@fixture/harness-sync',
  logFolderEnvVar: 'FIXTURE_LOG_PATH_FOLDER',
  resolveConfigPaths: () => ({ local: '/local', project: '/project', userGlobal: '/user' }),
  localConfigDisplayPath: '.fixture/settings.local.json',
  migrateManifestHarness: 'fixture',
  helpText: '',
};

function makeTmpDir(): string {
  return path.join(
    os.tmpdir(),
    `sal-shared-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

describe('resolveLogFolder', () => {
  it('honors the adapter-specific log folder env var', () => {
    expect(resolveLogFolder(FIXTURE_ADAPTER, { FIXTURE_LOG_PATH_FOLDER: '/custom/logs' })).toBe(
      '/custom/logs',
    );
  });

  it('falls back to SAL_DATA_DIR/logs when unset', () => {
    expect(resolveLogFolder(FIXTURE_ADAPTER, { SAL_DATA_DIR: '/var/lib/sal' })).toBe(
      path.join('/var/lib/sal', 'logs'),
    );
  });
});

describe('buildLogFileName', () => {
  it('uses the given command', () => {
    expect(buildLogFileName(FIXTURE_ADAPTER, 'download', '20260101-000000')).toBe(
      'download-log-20260101-000000.log',
    );
  });

  it('falls back to adapter.binName for a missing command', () => {
    expect(buildLogFileName(FIXTURE_ADAPTER, undefined, '20260101-000000')).toBe(
      'fixture-sync-log-20260101-000000.log',
    );
  });
});

describe('formatErrorLogContent / formatAbortMessage', () => {
  it('includes the adapter binName in the header and abort message', () => {
    const content = formatErrorLogContent(FIXTURE_ADAPTER, new Error('boom'), 'sync');
    expect(content).toContain('fixture-sync sync — error log');
    expect(content).toContain('Error: Error: boom');

    const message = formatAbortMessage(FIXTURE_ADAPTER, new Error('boom'), {
      logPath: '/tmp/x.log',
      written: true,
    });
    expect(message).toBe('fixture-sync: aborted. Check log in /tmp/x.log');
  });

  it('surfaces the raw error message when the log could not be written', () => {
    const message = formatAbortMessage(FIXTURE_ADAPTER, new Error('boom'), {
      logPath: '/tmp/x.log',
      written: false,
    });
    expect(message).toBe('fixture-sync: aborted: boom (failed to write log at /tmp/x.log)');
  });
});

describe('writeErrorLog', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes a log file under the resolved folder', async () => {
    const result = await writeErrorLog(
      FIXTURE_ADAPTER,
      { FIXTURE_LOG_PATH_FOLDER: tmpDir },
      'download',
      new Error('boom'),
    );
    expect(result.written).toBe(true);
    expect(result.logPath.startsWith(tmpDir)).toBe(true);
    const content = await fsp.readFile(result.logPath, 'utf8');
    expect(content).toContain('fixture-sync download — error log');
  });
});
