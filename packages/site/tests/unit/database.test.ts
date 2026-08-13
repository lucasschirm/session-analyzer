// @vitest-environment node
/**
 * DatabaseManager tests run against the real SQLite WASM build (in-memory,
 * since OPFS is unavailable in Node) - the same code path the db worker uses
 * in the browser minus the OpfsDb constructor.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../../src/db/database';
import type { DashboardSession, Project } from '../../src/types';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: `project-${Math.random().toString(36).slice(2)}`,
    name: 'Test Project',
    description: 'A test project',
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    session_count: 0,
    ...overrides,
  };
}

function makeSession(projectId: string, overrides: Partial<DashboardSession> = {}): DashboardSession {
  // Resolve the id first so child rows (tools/events/messages) always
  // reference the final session id, keeping FK integrity when tests
  // override `id`.
  const id = overrides.id ?? `session-${Math.random().toString(36).slice(2)}`;
  return {
    id,
    project_id: projectId,
    source: 'claude',
    title: 'session.jsonl',
    started_at: 1_700_000_000_000,
    ended_at: 1_700_000_060_000,
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_tokens: 20,
    cache_read_tokens: 10,
    total_tokens: 180,
    models: [
      { model: 'claude-sonnet-5', input_tokens: 100, output_tokens: 50, cache_creation_tokens: 20, cache_read_tokens: 10 },
    ],
    context_compactions: 0,
    total_turns: 2,
    files_read: 1,
    files_written: 0,
    agent_invocations: 0,
    tool_executions: [
      {
        id: `${id}-tool-1`,
        session_id: id,
        timestamp: 1_700_000_010_000,
        tool_name: 'read_file',
        tool_type: 'tool_use',
        target: 'src/app.ts',
        success: true,
        parameters: { file_path: 'src/app.ts' },
        result: 'export function app() {}',
        result_uuid: 'u2',
      },
    ],
    events: [
      {
        id: `${id}-event-1`,
        session_id: id,
        timestamp: 1_700_000_020_000,
        event_type: 'message_start',
        description: "Claude event: message_start with 'quotes'",
        metadata: { type: 'message_start' },
      },
    ],
    messages: [
      {
        id: `${id}-msg-1`,
        session_id: id,
        role: 'user',
        content: "Please fix the bug in app.ts; it's broken",
        timestamp: 1_700_000_005_000,
        uuid: 'u1',
        parent_uuid: undefined,
      },
    ],
    tasks: [
      {
        id: '1',
        subject: 'Fix the bug',
        description: 'Track down and fix the reported bug in app.ts',
        status: 'completed',
        first_seen_at: 1_700_000_000_000,
        completed_at: 1_700_000_030_000,
      },
    ],
    external_id: 'ext-session-id',
    subagents: [
      {
        agent_id: 'agent-1',
        agent_type: 'general-purpose',
        description: 'Update AGENTS.md',
        model: 'claude-haiku-4-5',
        input_tokens: 5,
        output_tokens: 10,
        cache_creation_tokens: 2,
        cache_read_tokens: 1,
        total_tokens: 18,
        tool_call_count: 3,
        started_at: 1_700_000_000_000,
        ended_at: 1_700_000_010_000,
      },
    ],
    ...overrides,
  };
}

describe('DatabaseManager', () => {
  let manager: DatabaseManager;

  beforeEach(async () => {
    manager = new DatabaseManager();
    const storage = await manager.initialize();
    expect(storage).toBe('memory');
  });

  describe('project CRUD', () => {
    it('creates and lists projects', async () => {
      const project = makeProject();
      manager.createProject(project);

      const projects = manager.getProjects();
      expect(projects.length).toBe(1);
      expect(projects[0].name).toBe('Test Project');
      expect(projects[0].description).toBe('A test project');
    });

    it('survives SQL-hostile project names (parameterized queries)', () => {
      const project = makeProject({ name: "Bobby'; DROP TABLE projects; --" });
      manager.createProject(project);

      const loaded = manager.getProject(project.id);
      expect(loaded?.name).toBe("Bobby'; DROP TABLE projects; --");
      expect(manager.getProjects().length).toBe(1);
    });

    it('gets a single project by id and returns null for unknown ids', () => {
      const project = makeProject();
      manager.createProject(project);

      expect(manager.getProject(project.id)?.id).toBe(project.id);
      expect(manager.getProject('nope')).toBeNull();
    });

    it('updates project fields', () => {
      const project = makeProject();
      manager.createProject(project);

      manager.updateProject(project.id, { name: 'Renamed', description: 'New description' });

      const updated = manager.getProject(project.id);
      expect(updated?.name).toBe('Renamed');
      expect(updated?.description).toBe('New description');
    });

    it('throws when updating a missing project', () => {
      expect(() => manager.updateProject('missing', { name: 'x' })).toThrow('Project not found');
    });

    it('deletes projects and cascades to sessions and child rows', () => {
      const project = makeProject();
      manager.createProject(project);
      manager.saveSession(makeSession(project.id));

      manager.deleteProject(project.id);

      expect(manager.getProject(project.id)).toBeNull();
      expect(manager.getSessionsByProject(project.id)).toEqual([]);
    });
  });

  describe('session storage', () => {
    it('saves and hydrates sessions with tools, events and messages', () => {
      const project = makeProject();
      manager.createProject(project);
      const session = makeSession(project.id);

      manager.saveSession(session);

      const loaded = manager.getSession(session.id);
      expect(loaded).not.toBeNull();
      expect(loaded?.title).toBe('session.jsonl');
      expect(loaded?.total_tokens).toBe(180);
      expect(loaded?.cache_creation_tokens).toBe(20);
      expect(loaded?.cache_read_tokens).toBe(10);
      expect(loaded?.models).toEqual([
        { model: 'claude-sonnet-5', input_tokens: 100, output_tokens: 50, cache_creation_tokens: 20, cache_read_tokens: 10 },
      ]);
      expect(loaded?.tool_executions.length).toBe(1);
      expect(loaded?.tool_executions[0].target).toBe('src/app.ts');
      expect(loaded?.tool_executions[0].parameters).toEqual({ file_path: 'src/app.ts' });
      expect(loaded?.tool_executions[0].result).toBe('export function app() {}');
      expect(loaded?.tool_executions[0].result_uuid).toBe('u2');
      expect(loaded?.events[0].metadata).toEqual({ type: 'message_start' });
      expect(loaded?.messages[0].content).toContain("it's broken");
      expect(loaded?.messages[0].uuid).toBe('u1');
      expect(loaded?.messages[0].parent_uuid).toBeUndefined();
      expect(loaded?.tasks).toEqual([
        {
          id: '1',
          subject: 'Fix the bug',
          description: 'Track down and fix the reported bug in app.ts',
          status: 'completed',
          first_seen_at: 1_700_000_000_000,
          completed_at: 1_700_000_030_000,
        },
      ]);
      expect(loaded?.external_id).toBe('ext-session-id');
      expect(loaded?.subagents).toEqual([
        {
          agent_id: 'agent-1',
          agent_type: 'general-purpose',
          description: 'Update AGENTS.md',
          model: 'claude-haiku-4-5',
          input_tokens: 5,
          output_tokens: 10,
          cache_creation_tokens: 2,
          cache_read_tokens: 1,
          total_tokens: 18,
          tool_call_count: 3,
          started_at: 1_700_000_000_000,
          ended_at: 1_700_000_010_000,
        },
      ]);
      expect(manager.getProject(project.id)?.session_count).toBe(1);
    });

    it('lists sessions by project ordered by date descending', () => {
      const project = makeProject();
      manager.createProject(project);
      manager.saveSession(makeSession(project.id, { id: 'older', started_at: 1000, ended_at: 2000 }));
      manager.saveSession(makeSession(project.id, { id: 'newer', started_at: 3000, ended_at: 4000 }));

      const sessions = manager.getSessionsByProject(project.id);
      expect(sessions.map((session) => session.id)).toEqual(['newer', 'older']);
    });

    it('stores optional cost and model as nullable', () => {
      const project = makeProject();
      manager.createProject(project);
      const session = makeSession(project.id, { cost_usd: undefined, model: undefined });

      manager.saveSession(session);

      const loaded = manager.getSession(session.id);
      expect(loaded?.cost_usd).toBeUndefined();
      expect(loaded?.model).toBeUndefined();
    });

    it('deletes a session and decrements the project counter', () => {
      const project = makeProject();
      manager.createProject(project);
      const session = makeSession(project.id);
      manager.saveSession(session);

      manager.deleteSession(session.id);

      expect(manager.getSession(session.id)).toBeNull();
      expect(manager.getProject(project.id)?.session_count).toBe(0);
    });

    it('never decrements below zero', () => {
      const project = makeProject();
      manager.createProject(project);
      const session = makeSession(project.id);
      manager.saveSession(session);

      manager.deleteSession(session.id);
      manager.deleteSession(session.id);

      expect(manager.getProject(project.id)?.session_count).toBe(0);
    });
  });

  describe('re-upload dedup (external_id)', () => {
    it('finds a session by its external_id within a project', () => {
      const project = makeProject();
      manager.createProject(project);
      const session = makeSession(project.id, { external_id: 'claude-ext-1' });
      manager.saveSession(session);

      expect(manager.findSessionByExternalId(project.id, 'claude-ext-1')?.id).toBe(session.id);
      expect(manager.findSessionByExternalId(project.id, 'no-such-id')).toBeNull();
    });

    it('does not match an external_id from a different project', () => {
      const projectA = makeProject({ id: 'a' });
      const projectB = makeProject({ id: 'b' });
      manager.createProject(projectA);
      manager.createProject(projectB);
      manager.saveSession(makeSession('a', { external_id: 'shared-ext-id' }));

      expect(manager.findSessionByExternalId('b', 'shared-ext-id')).toBeNull();
    });

    it('inserts a new session when no existing external_id matches', () => {
      const project = makeProject();
      manager.createProject(project);
      const session = makeSession(project.id, { external_id: 'ext-1' });

      const id = manager.upsertSessionByExternalId(session);

      expect(id).toBe(session.id);
      expect(manager.getSessionsByProject(project.id).length).toBe(1);
      expect(manager.getProject(project.id)?.session_count).toBe(1);
    });

    it('updates the existing session in place on a re-upload with the same external_id, keeping its id', () => {
      const project = makeProject();
      manager.createProject(project);
      const first = makeSession(project.id, { external_id: 'ext-1', total_tokens: 100, title: 'first-pass.jsonl' });
      const firstId = manager.upsertSessionByExternalId(first);

      const second = makeSession(project.id, {
        id: 'different-generated-id',
        external_id: 'ext-1',
        total_tokens: 999,
        title: 'second-pass.jsonl',
      });
      const secondId = manager.upsertSessionByExternalId(second);

      expect(secondId).toBe(firstId); // reused the original id, not the freshly generated one
      expect(manager.getSessionsByProject(project.id).length).toBe(1); // no duplicate row
      expect(manager.getProject(project.id)?.session_count).toBe(1); // not double-counted

      const loaded = manager.getSession(firstId);
      expect(loaded?.title).toBe('second-pass.jsonl');
      expect(loaded?.total_tokens).toBe(999);
    });

    it('replaceSession swaps child rows (no stale tool_executions from the previous version)', () => {
      const project = makeProject();
      manager.createProject(project);
      const session = makeSession(project.id, { external_id: 'ext-1' });
      manager.saveSession(session);

      const updated = makeSession(project.id, {
        id: session.id,
        external_id: 'ext-1',
        tool_executions: [
          {
            id: 'new-tool',
            session_id: session.id,
            timestamp: 1,
            tool_name: 'Write',
            tool_type: 'tool_use',
            target: 'new-file.ts',
            success: true,
          },
        ],
      });
      manager.replaceSession(updated);

      const loaded = manager.getSession(session.id);
      expect(loaded?.tool_executions.length).toBe(1);
      expect(loaded?.tool_executions[0].tool_name).toBe('Write');
    });
  });

  describe('search', () => {
    it('matches sessions by title', () => {
      const project = makeProject();
      manager.createProject(project);
      manager.saveSession(makeSession(project.id, { id: 's1', title: 'refactor auth.jsonl' }));
      manager.saveSession(makeSession(project.id, { id: 's2', title: 'bugfix.jsonl' }));

      const results = manager.searchSessions(project.id, 'refactor');
      expect(results.map((session) => session.id)).toEqual(['s1']);
    });

    it('matches sessions by transcript message content (case-insensitive)', () => {
      const project = makeProject();
      manager.createProject(project);
      manager.saveSession(makeSession(project.id, { id: 's1', title: 'a.jsonl' }));

      const results = manager.searchSessions(project.id, 'FIX THE BUG');
      expect(results.map((session) => session.id)).toEqual(['s1']);
    });

    it('does not match other projects', () => {
      const projectA = makeProject({ id: 'a' });
      const projectB = makeProject({ id: 'b' });
      manager.createProject(projectA);
      manager.createProject(projectB);
      manager.saveSession(makeSession('a', { title: 'unique-title.jsonl' }));

      expect(manager.searchSessions('b', 'unique-title')).toEqual([]);
    });
  });

  describe('metrics', () => {
    it('aggregates project metrics across sessions', () => {
      const project = makeProject();
      manager.createProject(project);
      manager.saveSession(
        makeSession(project.id, {
          id: 'm1',
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          cost_usd: 0.01,
          model: 'claude-sonnet',
          started_at: 0,
          ended_at: 60_000,
        })
      );
      manager.saveSession(
        makeSession(project.id, {
          id: 'm2',
          input_tokens: 200,
          output_tokens: 100,
          total_tokens: 300,
          model: 'claude-opus',
          started_at: 0,
          ended_at: 30_000,
        })
      );

      const metrics = manager.getProjectMetrics(project.id);

      expect(metrics.total_sessions).toBe(2);
      expect(metrics.total_input_tokens).toBe(300);
      expect(metrics.total_output_tokens).toBe(150);
      expect(metrics.total_cache_creation_tokens).toBe(40);
      expect(metrics.total_cache_read_tokens).toBe(20);
      expect(metrics.total_tokens).toBe(450);
      expect(metrics.total_cost_usd).toBeCloseTo(0.01);
      expect(metrics.total_tool_executions).toBe(2);
      expect(metrics.avg_session_duration_ms).toBe(45_000);
      expect(metrics.models_used.sort()).toEqual(['claude-opus', 'claude-sonnet']);
    });

    it('returns zeroed metrics for empty projects', () => {
      const project = makeProject();
      manager.createProject(project);

      const metrics = manager.getProjectMetrics(project.id);
      expect(metrics.total_sessions).toBe(0);
      expect(metrics.avg_session_duration_ms).toBe(0);
    });
  });

  describe('export', () => {
    it('exports a valid SQLite database file', () => {
      const project = makeProject();
      manager.createProject(project);
      manager.saveSession(makeSession(project.id));

      const bytes = manager.exportDatabase();

      expect(bytes.length).toBeGreaterThan(0);
      const header = new TextDecoder().decode(bytes.slice(0, 15));
      expect(header).toBe('SQLite format 3');
    });
  });

  describe('initialization guard', () => {
    it('rejects operations before initialize()', () => {
      const fresh = new DatabaseManager();
      expect(() => fresh.getProjects()).toThrow('Database not initialized');
      expect(() => fresh.exportDatabase()).toThrow('Database not initialized');
    });

    it('is idempotent', async () => {
      const storage = await manager.initialize();
      expect(storage).toBe('memory');
    });
  });
});
