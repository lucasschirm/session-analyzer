// @vitest-environment node
/**
 * Unit tests for the E2E export content verifier helper.
 *
 * The helper runs in the Playwright Node runner, but is exercised here with
 * Vitest and a real `DatabaseManager` export so it can be validated without
 * launching a browser.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../../src/db/database';
import type { Project, SessionStub } from '../../src/types';
import { type ExportRowCounts, verifyExportContents } from '../e2e/helpers/export-verify';

describe('verifyExportContents', () => {
  let tempDir: string;
  let manager: DatabaseManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'export-verify-'));
    manager = new DatabaseManager();
    await manager.initialize();
  });

  afterEach(async () => {
    manager.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeProject(id: string): Project {
    const now = Date.now();
    return {
      id,
      name: 'Export Verify Project',
      description: '',
      created_at: now,
      updated_at: now,
      session_count: 0,
    };
  }

  function makeSessionStub(projectId: string, id: string): SessionStub {
    return {
      id,
      project_id: projectId,
      source: 'claude',
      title: 'Export Verify Session',
      started_at: '2024-01-01T00:00:00.000Z',
      ended_at: '2024-01-01T01:00:00.000Z',
      sync_session_id: 'sync-1',
      sync_status: 'pending',
    };
  }

  it('returns correct row counts for a valid exported database', async () => {
    manager.createProject(makeProject('proj-1'));
    manager.upsertSessionStub({
      ...makeSessionStub('proj-1', 'sess-1'),
      sync_session_id: 'sync-1',
    });
    manager.upsertSessionStub({
      ...makeSessionStub('proj-1', 'sess-2'),
      sync_session_id: 'sync-2',
    });

    const bytes = manager.exportControlDatabase();
    const counts = await verifyExportContents(bytes);

    expect(counts).toEqual<ExportRowCounts>({
      projects: 1,
      sessions: 2,
      session_files: 0,
      connections: 0,
      connection_s3_credentials: 0,
      passkey_state: 0,
      source_checkpoints: 0,
      ui_preferences: 0,
    });
  });

  it('reads row counts from a file path', async () => {
    manager.createProject(makeProject('proj-path'));

    const bytes = manager.exportControlDatabase();
    const filePath = join(tempDir, 'export.sqlite');
    await writeFile(filePath, bytes);

    const counts = await verifyExportContents(filePath);
    expect(counts.projects).toBe(1);
    expect(counts.sessions).toBe(0);
  });

  it('throws a clear error for a non-SQLite text file', async () => {
    const filePath = join(tempDir, 'bad.sqlite');
    await writeFile(filePath, 'this is not a database');

    await expect(verifyExportContents(filePath)).rejects.toThrow(
      /SQLite format 3|not a valid SQLite/i,
    );
  });

  it('throws a clear error for a small buffer of random bytes', async () => {
    const bad = new Uint8Array([0x00, 0x01, 0x02, 0x03]);

    await expect(verifyExportContents(bad)).rejects.toThrow(/valid SQLite database/i);
  });

  it('throws when the file has a SQLite header but invalid body', async () => {
    const bad = new TextEncoder().encode('SQLite format 3\0extra garbage');
    const filePath = join(tempDir, 'header-only.sqlite');
    await writeFile(filePath, bad);

    await expect(verifyExportContents(filePath)).rejects.toThrow(/not a valid SQLite database/i);
  });
});
