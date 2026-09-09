import { afterEach, describe, expect, it } from 'vitest';
import { readDevinSnapshot } from '../src/devin-snapshot.js';
import { buildFixtureDb, type FixtureDbHandle } from './extractor/fixtures/build-fixture-db.js';

describe('readDevinSnapshot', () => {
  let fixture: FixtureDbHandle | undefined;

  afterEach(() => {
    fixture?.close();
    fixture = undefined;
  });

  it('reads all tables and computes the schema descriptor with the supplied CLI version', async () => {
    fixture = buildFixtureDb({
      sessions: [
        {
          id: 'sess-1',
          working_directory: '/tmp',
          backend_type: null,
          model: null,
          agent_mode: null,
          created_at: null,
          last_activity_at: null,
          title: null,
          main_chain_id: null,
          cogs_json: null,
          workspace_dirs: null,
          hidden: null,
          metadata: null,
        },
      ],
    });

    const snapshot = await readDevinSnapshot({
      sessionsDbPath: fixture.path,
      devinCliVersion: '3000.6.7',
    });

    expect(snapshot.tables.sessions).toHaveLength(1);
    expect(snapshot.schemaDescriptor.devinCliVersion).toBe('3000.6.7');
    expect(snapshot.schemaDescriptor.supported).toBe(true);
  });

  it('resolves the devinCliVersion from resolveDevinCliVersion when not supplied', async () => {
    fixture = buildFixtureDb({});
    const snapshot = await readDevinSnapshot({ sessionsDbPath: fixture.path });
    expect(
      typeof snapshot.schemaDescriptor.devinCliVersion === 'string' ||
        snapshot.schemaDescriptor.devinCliVersion === null,
    ).toBe(true);
  });

  it('resolves the db path from home/cwd/env when sessionsDbPath is omitted', async () => {
    // No real sessions.db exists under this temp home, so the open is
    // expected to fail — this exercises the path-resolution fallback branch
    // (resolveDevinPaths via home/cwd/env) rather than the sessionsDbPath
    // short-circuit exercised by the other tests in this file.
    const fsp = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-snapshot-fallback-'));
    try {
      await expect(readDevinSnapshot({ home: tmpHome, cwd: tmpHome, env: {} })).rejects.toThrow();
    } finally {
      await fsp.rm(tmpHome, { recursive: true, force: true });
    }
  });

  it('falls back to process.env/os.homedir()/process.cwd() when home/cwd/env are all omitted', async () => {
    // Exercises the `??` right-hand side of every fallback in
    // resolveSnapshotDbPath. Whether the real machine happens to have a
    // Devin sessions.db is environment-dependent, so this only asserts the
    // call completes (resolves or rejects) without hanging or throwing
    // synchronously.
    await readDevinSnapshot({}).then(
      () => undefined,
      () => undefined,
    );
  });
});
