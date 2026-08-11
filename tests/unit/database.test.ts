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
    total_tokens: 150,
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
      expect(loaded?.total_tokens).toBe(150);
      expect(loaded?.tool_executions.length).toBe(1);
      expect(loaded?.tool_executions[0].target).toBe('src/app.ts');
      expect(loaded?.events[0].metadata).toEqual({ type: 'message_start' });
      expect(loaded?.messages[0].content).toContain("it's broken");
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
