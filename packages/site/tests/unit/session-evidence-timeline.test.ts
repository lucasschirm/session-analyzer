import type { SessionEventRow, TurnTimeline } from '@lucasschirm/sal-db';
import type { LitElement } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import '../../src/pages/session-evidence/session-evidence-timeline';
import type { SessionEvidenceTimeline } from '../../src/pages/session-evidence/session-evidence-timeline';

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

const events: SessionEventRow[] = [
  {
    id: 'u1',
    timestamp: '2024-01-01T00:00:00.000Z',
    turnNumber: 1,
    kind: 'user_message',
    name: 'user',
    status: 'completed',
  },
  {
    id: 'inv1',
    timestamp: '2024-01-01T00:00:01.000Z',
    turnNumber: 2,
    kind: 'tool',
    name: 'read_file',
    status: 'completed',
  },
];

const timeline: TurnTimeline = {
  token: {
    analysisReleaseId: 'r',
    generationId: 'g',
    comparabilityGroupId: 'c',
    eligibleN: 2,
    knownN: 2,
    unknownCount: 0,
    coverage: 'complete',
    measurementClass: 'derived',
    confidence: 'high',
    metricVersion: '0.1.0',
    evidenceLinks: [],
  },
  sessionId: 's1',
  totalDurationMs: 2000,
  segments: [
    { kind: 'user', startMs: 0, durationMs: 500, sourceId: 'u1' },
    {
      kind: 'invocation',
      startMs: 500,
      durationMs: 1500,
      invocationKind: 'tool',
      sourceId: 'inv1',
    },
  ],
};

describe('session-evidence-timeline', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders one segment per DTO segment with proportional widths', async () => {
    const el = document.createElement('session-evidence-timeline') as SessionEvidenceTimeline;
    el.timeline = timeline;
    el.events = events;
    await mount(el);
    const root = shadow(el);

    const segments = root.querySelectorAll('.segment');
    expect(segments.length).toBe(2);
    expect((segments[0] as HTMLElement).style.width).toBe('25%');
    expect((segments[1] as HTMLElement).style.width).toBe('75%');
  });

  it('renders the legend with the invocation band never labelled "Tool"', async () => {
    const el = document.createElement('session-evidence-timeline') as SessionEvidenceTimeline;
    el.timeline = timeline;
    el.events = events;
    await mount(el);
    const root = shadow(el);

    expect(root.textContent).toContain('Invocation activity');
    const legendItems = Array.from(root.querySelectorAll('.legend-item')).map((i) =>
      i.textContent?.trim(),
    );
    expect(legendItems).not.toContain('Tool');
  });

  it('dispatches timeline-segment-click with the resolved turn number on click', async () => {
    const el = document.createElement('session-evidence-timeline') as SessionEvidenceTimeline;
    el.timeline = timeline;
    el.events = events;
    await mount(el);
    const root = shadow(el);

    let detail: { turn: number } | undefined;
    el.addEventListener('timeline-segment-click', (e) => {
      detail = (e as CustomEvent<{ turn: number }>).detail;
    });

    (root.querySelectorAll('.segment')[1] as HTMLButtonElement).click();
    expect(detail).toEqual({ turn: 2 });
  });

  it('shows the "no timestamped evidence" affordance when totalDurationMs is unavailable', async () => {
    const el = document.createElement('session-evidence-timeline') as SessionEvidenceTimeline;
    el.timeline = { ...timeline, totalDurationMs: null };
    el.events = events;
    await mount(el);
    const root = shadow(el);

    expect(root.textContent).toContain('No timestamped turn evidence available yet.');
    expect(root.querySelectorAll('.segment').length).toBe(0);
  });
});
