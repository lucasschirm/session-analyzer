import { afterEach, describe, expect, it } from 'vitest';
import { filterSessionsForCwd, listDevinSessions } from '../../src/cli/project.js';
import { buildFixtureDb, type FixtureDbHandle } from '../extractor/fixtures/build-fixture-db.js';

describe('listDevinSessions', () => {
  let fixture: FixtureDbHandle | undefined;

  afterEach(() => {
    fixture?.close();
    fixture = undefined;
  });

  it('reads sessions directly from sessions.db, not from `devin list`', async () => {
    fixture = buildFixtureDb({
      sessions: [
        {
          id: 'sess-a',
          working_directory: '/home/user/project-a',
          backend_type: 'anthropic',
          model: 'devin-1',
          agent_mode: 'default',
          created_at: 1000,
          last_activity_at: 2000,
          title: 'Session A',
          main_chain_id: null,
          cogs_json: null,
          workspace_dirs: null,
          hidden: 0,
          metadata: null,
        },
        {
          id: 'sess-b',
          working_directory: '/home/user/project-b',
          backend_type: 'anthropic',
          model: 'devin-1',
          agent_mode: 'default',
          created_at: 1000,
          last_activity_at: 3000,
          title: 'Session B',
          main_chain_id: null,
          cogs_json: null,
          workspace_dirs: null,
          hidden: 0,
          metadata: null,
        },
      ],
    });

    const sessions = await listDevinSessions({ sessionsDbPath: fixture.path });
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(['sess-a', 'sess-b']);
  });

  it('returns every session regardless of a simulated different cwd (proving no `devin list` cwd-scoping)', async () => {
    fixture = buildFixtureDb({
      sessions: [
        {
          id: 'sess-a',
          working_directory: '/home/user/project-a',
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

    // A totally unrelated invoking cwd must not filter out sess-a — unlike
    // `devin list --format json`, which is verified cwd-scoped (Part A2).
    const sessions = await listDevinSessions({
      sessionsDbPath: fixture.path,
      cwd: '/somewhere/completely/different',
    });
    expect(sessions.map((s) => s.sessionId)).toEqual(['sess-a']);
  });

  it('returns an empty array for an empty database', async () => {
    fixture = buildFixtureDb({});
    const sessions = await listDevinSessions({ sessionsDbPath: fixture.path });
    expect(sessions).toEqual([]);
  });
});

describe('filterSessionsForCwd', () => {
  const sessions = [
    { sessionId: 'a', workingDirectory: '/proj/one', lastActivityAt: null, title: null },
    { sessionId: 'b', workingDirectory: '/proj/two', lastActivityAt: null, title: null },
    { sessionId: 'c', workingDirectory: null, lastActivityAt: null, title: null },
  ];

  it('filters to sessions whose working_directory matches exactly', () => {
    expect(filterSessionsForCwd(sessions, '/proj/one').map((s) => s.sessionId)).toEqual(['a']);
  });

  it('excludes sessions with a null working_directory', () => {
    expect(filterSessionsForCwd(sessions, '/proj/nonexistent')).toEqual([]);
  });

  it('normalizes a trailing slash before comparing', () => {
    expect(filterSessionsForCwd(sessions, '/proj/one/').map((s) => s.sessionId)).toEqual(['a']);
  });
});
