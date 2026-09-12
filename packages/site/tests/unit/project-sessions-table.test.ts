import { afterEach, describe, expect, it } from 'vitest';
import '../../src/components/project-sessions-table';
import type { ProjectSessionListItem } from '@lucasschirm/sal-db';
import type { ProjectSessionsTable } from '../../src/components/project-sessions-table';

afterEach(() => {
  document.body.innerHTML = '';
  window.location.hash = '';
});

async function mountTable(
  props: Partial<ProjectSessionsTable> = {},
): Promise<ProjectSessionsTable> {
  const el = document.createElement('project-sessions-table') as ProjectSessionsTable;
  Object.assign(el, props);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('project-sessions-table', () => {
  const mockSessions: ProjectSessionListItem[] = [
    {
      sessionId: 'sess-1',
      rootSessionId: 'sess-1',
      harness: 'claude',
      finality: 'final',
      title: 'Fix issue with login',
      subagentCount: 2,
      startedAt: '2026-09-10T10:00:00Z',
      coverage: 'complete',
    },
    {
      sessionId: 'sess-2',
      rootSessionId: 'sess-2',
      harness: 'devin',
      finality: 'final',
      title: 'Refactor database',
      subagentCount: 0,
      startedAt: '2026-09-09T15:30:00Z',
      coverage: 'complete',
    },
  ];

  it('renders columns: title, start date, sub agents', async () => {
    const el = await mountTable({ sessions: mockSessions });
    const root = el.shadowRoot as ShadowRoot;
    const headers = Array.from(root.querySelectorAll('th')).map((th) => th.textContent?.trim());
    expect(headers).toEqual(['Title', 'Start date', 'Sub agents']);

    const rows = Array.from(root.querySelectorAll('tbody tr'));
    expect(rows.length).toBe(2);

    const firstRowTitle = rows[0]?.querySelector('.session-title-link')?.textContent?.trim();
    expect(firstRowTitle).toBe('Fix issue with login');

    const firstRowSubagents = rows[0]?.querySelector('.subagents-badge')?.textContent?.trim();
    expect(firstRowSubagents).toBe('2');

    const secondRowSubagents = rows[1]?.querySelector('.subagents-badge')?.textContent?.trim();
    expect(secondRowSubagents).toBe('0');
  });

  it('renders empty state when no sessions found', async () => {
    const el = await mountTable({ sessions: [] });
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('.empty-state')?.textContent).toContain(
      'No sessions found in this project.',
    );
  });

  it('renders search empty state when searchQuery has no matches', async () => {
    const el = await mountTable({ sessions: [], searchQuery: 'missing' });
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('.empty-state')?.textContent).toContain(
      'No sessions matching "missing".',
    );
  });

  it('renders loading notice when loading is true', async () => {
    const el = await mountTable({ sessions: [], loading: true });
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('.loading-notice')?.textContent).toContain('Loading sessions…');
  });

  it('renders error banner when error is set', async () => {
    const el = await mountTable({ sessions: [], error: 'Failed to fetch sessions' });
    const root = el.shadowRoot as ShadowRoot;
    const errorBanner = root.querySelector('.error-banner');
    expect(errorBanner?.textContent).toContain('Failed to fetch sessions');
    expect(errorBanner?.getAttribute('role')).toBe('alert');
  });

  it('navigates to session page when session title link is clicked', async () => {
    window.location.hash = '#/projects/p1';
    const el = await mountTable({ sessions: mockSessions });
    const root = el.shadowRoot as ShadowRoot;
    const link = root.querySelector('.session-title-link') as HTMLElement;
    expect(link).not.toBeNull();
    link.click();
    expect(window.location.hash).toBe('#/sessions/sess-1');
  });

  it('navigates to session page when table row is clicked', async () => {
    window.location.hash = '#/projects/p1';
    const el = await mountTable({ sessions: mockSessions });
    const root = el.shadowRoot as ShadowRoot;
    const rows = root.querySelectorAll('tbody tr');
    const secondRow = rows[1] as HTMLElement;
    expect(secondRow).not.toBeNull();
    secondRow.click();
    expect(window.location.hash).toBe('#/sessions/sess-2');
  });
});
