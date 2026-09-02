import type { SessionEventRow } from '@lucasschirm/sal-db';
import type { LitElement } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import '../../src/pages/session-evidence/session-evidence-events-table';
import type { SessionEvidenceEventsTable } from '../../src/pages/session-evidence/session-evidence-events-table';

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

function eventFixture(overrides: Partial<SessionEventRow> = {}): SessionEventRow {
  return {
    id: `e-${Math.random().toString(36).slice(2)}`,
    timestamp: '2024-01-01T00:00:00.000Z',
    turnNumber: 1,
    kind: 'tool',
    name: 'read_file',
    target: 'src/a.ts',
    tokens: 10,
    durationMs: 50,
    status: 'completed',
    ...overrides,
  };
}

describe('session-evidence-events-table', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders a wrapper table with every row when unfiltered, and the "no filters active" counter', async () => {
    const el = document.createElement(
      'session-evidence-events-table',
    ) as SessionEvidenceEventsTable;
    el.events = [eventFixture({ id: '1' }), eventFixture({ id: '2', name: 'write_file' })];
    await mount(el);
    const root = shadow(el);

    expect(root.querySelectorAll('tbody tr.event-row').length).toBe(2);
    expect(root.textContent).toContain('2 events · no filters active');
  });

  it('filters live per keystroke with an accurate "X of Y" counter', async () => {
    const el = document.createElement(
      'session-evidence-events-table',
    ) as SessionEvidenceEventsTable;
    el.events = [
      eventFixture({ id: '1', name: 'read_file' }),
      eventFixture({ id: '2', name: 'write_file' }),
    ];
    await mount(el);
    const root = shadow(el);

    const input = root.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = 'write';
    input.dispatchEvent(new Event('input'));
    await el.updateComplete;

    expect(root.querySelectorAll('tbody tr.event-row').length).toBe(1);
    expect(root.textContent).toContain('1 of 2 events');
  });

  it('tool dropdown options are derived from the unfiltered list and stay stable as other filters narrow rows', async () => {
    const el = document.createElement(
      'session-evidence-events-table',
    ) as SessionEvidenceEventsTable;
    el.events = [
      eventFixture({ id: '1', name: 'read_file', status: 'completed' }),
      eventFixture({ id: '2', name: 'write_file', status: 'failed' }),
    ];
    await mount(el);
    const root = shadow(el);

    const checkbox = root.querySelector('input[type="checkbox"]') as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    await el.updateComplete;

    const options = Array.from(root.querySelectorAll('select option')).map((o) => o.textContent);
    expect(options).toContain('read_file');
    expect(options).toContain('write_file');
  });

  it('expands a row on click, showing pretty-printed Input/Result JSON', async () => {
    const el = document.createElement(
      'session-evidence-events-table',
    ) as SessionEvidenceEventsTable;
    el.events = [
      eventFixture({
        id: '1',
        inputPayload: { payloadId: 'p1', content: '{"a":1}', truncated: false },
        resultPayload: { payloadId: 'p2', content: '{"b":2}', truncated: false },
      }),
    ];
    await mount(el);
    const root = shadow(el);

    expect(root.querySelector('.expanded-row')).toBeNull();
    (root.querySelector('tr.event-row') as HTMLElement).click();
    await el.updateComplete;

    const expanded = root.querySelector('.expanded-row');
    expect(expanded).not.toBeNull();
    expect(expanded?.textContent).toContain('"a": 1');
    expect(expanded?.textContent).toContain('"b": 2');
  });

  it('flags error rows with a tinted class and a badge visible while collapsed', async () => {
    const el = document.createElement(
      'session-evidence-events-table',
    ) as SessionEvidenceEventsTable;
    el.events = [eventFixture({ id: '1', status: 'failed' })];
    await mount(el);
    const root = shadow(el);

    const row = root.querySelector('tr.event-row') as HTMLElement;
    expect(row.classList.contains('error-row')).toBe(true);
    expect(row.querySelector('.error-badge')).not.toBeNull();
  });

  it('renders a dismissible turn-filter chip and clears it via the × button', async () => {
    const el = document.createElement(
      'session-evidence-events-table',
    ) as SessionEvidenceEventsTable;
    el.events = [eventFixture({ id: '1', turnNumber: 3 })];
    el.turnFilter = 3;
    await mount(el);
    const root = shadow(el);

    const chip = root.querySelector('.turn-chip');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('Turn 3');

    let cleared = false;
    el.addEventListener('turn-filter-changed', () => {
      cleared = true;
    });
    (chip as HTMLElement).querySelector<HTMLButtonElement>('button')?.click();
    expect(cleared).toBe(true);
  });

  it('shows the distinct "no events match" empty affordance when filters exclude every row', async () => {
    const el = document.createElement(
      'session-evidence-events-table',
    ) as SessionEvidenceEventsTable;
    el.events = [eventFixture({ id: '1', name: 'read_file' })];
    await mount(el);
    const root = shadow(el);

    const select = root.querySelector('select') as HTMLSelectElement;
    select.value = 'nonexistent';
    // jsdom/happy-dom won't have the option, so simulate directly via property.
    (el as unknown as { toolFilter: string }).toolFilter = 'does-not-exist';
    await el.updateComplete;

    expect(root.textContent).toContain('No events match the current filters.');
  });

  it('caps DOM rows at the render window and offers a "Show more" control for large sets', async () => {
    const el = document.createElement(
      'session-evidence-events-table',
    ) as SessionEvidenceEventsTable;
    el.events = Array.from({ length: 500 }, (_, i) => eventFixture({ id: `e${i}` }));
    await mount(el);
    const root = shadow(el);

    const rendered = root.querySelectorAll('tbody tr.event-row').length;
    expect(rendered).toBeLessThan(500);
    expect(root.querySelector('.show-more')).not.toBeNull();

    (root.querySelector('.show-more') as HTMLButtonElement).click();
    await el.updateComplete;
    expect(root.querySelectorAll('tbody tr.event-row').length).toBeGreaterThan(rendered);
  });

  it('renders within a reasonable frame budget for a 5,000-event fixture by capping DOM rows', async () => {
    const el = document.createElement(
      'session-evidence-events-table',
    ) as SessionEvidenceEventsTable;
    const events = Array.from({ length: 5000 }, (_, i) =>
      eventFixture({ id: `e${i}`, turnNumber: (i % 200) + 1 }),
    );

    const start = performance.now();
    el.events = events;
    await mount(el);
    const elapsed = performance.now() - start;

    const root = shadow(el);
    const renderedRows = root.querySelectorAll('tbody tr.event-row').length;

    // The DOM-row cap (ROW_WINDOW) keeps a single render bounded regardless
    // of how many of the 5,000 events matched the filter — this is the
    // "virtualize or paginate the DOM" mitigation from issue #172's perf
    // requirement, verified here rather than assumed.
    expect(renderedRows).toBeLessThanOrEqual(200);
    // Generous upper bound for a bounded-row render in a test environment
    // (happy-dom, no real paint/layout) — this is a regression guard, not a
    // precise frame-budget measurement (see the perf review notes for the
    // real-browser numbers).
    expect(elapsed).toBeLessThan(1000);
  });
});
