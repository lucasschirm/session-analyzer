import type { SessionEventRow, TurnTimeline } from '@lucasschirm/sal-db';
import { describe, expect, it } from 'vitest';
import {
  buildTimelineSegmentViews,
  EMPTY_EVENT_FILTER,
  eventKindBadgeLabel,
  eventToolOptions,
  filterSessionEvents,
  firstUserMessageExcerpt,
  isErrorEventStatus,
  outcomeBadgeView,
  timelineBandColor,
  timelineBandLabel,
} from '../../src/pages/session-evidence/session-evidence-chart-helpers';

function eventFixture(overrides: Partial<SessionEventRow> = {}): SessionEventRow {
  return {
    id: 'e1',
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

describe('eventKindBadgeLabel', () => {
  it('keeps Tool/Skill/Agent/Sub Agent distinct and never labels anything "MCP"', () => {
    expect(eventKindBadgeLabel('tool')).toBe('Tool');
    expect(eventKindBadgeLabel('skill')).toBe('Skill');
    expect(eventKindBadgeLabel('agent')).toBe('Agent');
    expect(eventKindBadgeLabel('sub_agent')).toBe('Sub Agent');
    expect(eventKindBadgeLabel('user_message')).toBe('User');
    expect(eventKindBadgeLabel('assistant_message')).toBe('Assistant');
    const allKinds = [
      'tool',
      'skill',
      'agent',
      'sub_agent',
      'user_message',
      'assistant_message',
    ] as const;
    expect(allKinds.map(eventKindBadgeLabel).join()).not.toContain('MCP');
  });
});

describe('isErrorEventStatus', () => {
  it('flags failed and timeout, never completed/cancelled/started', () => {
    expect(isErrorEventStatus('failed')).toBe(true);
    expect(isErrorEventStatus('timeout')).toBe(true);
    expect(isErrorEventStatus('completed')).toBe(false);
    expect(isErrorEventStatus('cancelled')).toBe(false);
    expect(isErrorEventStatus('started')).toBe(false);
  });
});

describe('outcomeBadgeView', () => {
  it('returns null while not yet loaded (undefined)', () => {
    expect(outcomeBadgeView(undefined)).toBeNull();
  });

  it('renders a distinct badge for the unreadable-tail sentinel, never a clean outcome', () => {
    const view = outcomeBadgeView(null);
    expect(view?.tone).toBe('unknown');
    expect(view?.label).not.toBe('Clean');
  });

  it('maps each classified outcome to a distinct icon + label', () => {
    expect(outcomeBadgeView('clean')).toEqual({ icon: '✓', label: 'Clean', tone: 'good' });
    expect(outcomeBadgeView('ended_on_error')?.tone).toBe('critical');
    expect(outcomeBadgeView('interrupted_by_user')?.tone).toBe('warning');
  });
});

describe('timeline band colors/labels', () => {
  it('uses the issue-specified hex values and never labels the invocation band "Tool"', () => {
    expect(timelineBandColor('user')).toBe('#d95926');
    expect(timelineBandColor('assistant')).toBe('#4f8cff');
    expect(timelineBandColor('invocation')).toBe('#199e70');
    expect(timelineBandColor('sub_agent')).toBe('#d55181');
    expect(timelineBandLabel('invocation')).not.toBe('Tool');
    expect(timelineBandLabel('invocation')).toBe('Invocation activity');
  });
});

describe('buildTimelineSegmentViews', () => {
  const events: SessionEventRow[] = [
    eventFixture({ id: 'a', turnNumber: 1 }),
    eventFixture({ id: 'b', turnNumber: 2 }),
    eventFixture({ id: 'c', turnNumber: 3 }),
  ];

  const timeline: TurnTimeline = {
    token: {
      analysisReleaseId: 'r',
      generationId: 'g',
      comparabilityGroupId: 'c',
      eligibleN: 3,
      knownN: 3,
      unknownCount: 0,
      coverage: 'complete',
      measurementClass: 'derived',
      confidence: 'high',
      metricVersion: '0.1.0',
      evidenceLinks: [],
    },
    sessionId: 's1',
    totalDurationMs: 1000,
    segments: [
      { kind: 'user', startMs: 0, durationMs: 250, sourceId: 'a' },
      { kind: 'invocation', startMs: 250, durationMs: 500, invocationKind: 'tool', sourceId: 'b' },
      { kind: 'sub_agent', startMs: 750, durationMs: 250, sourceId: 'c' },
    ],
  };

  it('produces widths that sum to 100% (within floating-point rounding)', () => {
    const views = buildTimelineSegmentViews(timeline, events);
    const sum = views.reduce((total, v) => total + v.widthPercent, 0);
    expect(sum).toBeCloseTo(100, 6);
  });

  it('matches each segment width proportionally to its DTO duration', () => {
    const views = buildTimelineSegmentViews(timeline, events);
    expect(views[0].widthPercent).toBeCloseTo(25, 6);
    expect(views[1].widthPercent).toBeCloseTo(50, 6);
    expect(views[2].widthPercent).toBeCloseTo(25, 6);
  });

  it('resolves each segment turn number from the matching event by sourceId', () => {
    const views = buildTimelineSegmentViews(timeline, events);
    expect(views.map((v) => v.turnNumber)).toEqual([1, 2, 3]);
  });

  it('returns [] when totalDurationMs is unavailable (missing, not zero-width segments)', () => {
    expect(buildTimelineSegmentViews({ ...timeline, totalDurationMs: null }, events)).toEqual([]);
  });
});

describe('eventToolOptions', () => {
  it('derives sorted unique names from the unfiltered list', () => {
    const events = [
      eventFixture({ id: '1', name: 'write_file' }),
      eventFixture({ id: '2', name: 'read_file' }),
      eventFixture({ id: '3', name: 'read_file' }),
    ];
    expect(eventToolOptions(events)).toEqual(['read_file', 'write_file']);
  });
});

describe('filterSessionEvents', () => {
  const events: SessionEventRow[] = [
    eventFixture({ id: '1', turnNumber: 1, name: 'read_file', status: 'completed' }),
    eventFixture({
      id: '2',
      turnNumber: 2,
      name: 'run_tests',
      status: 'failed',
      target: 'suite-a',
      inputPayload: { payloadId: 'p1', content: 'pnpm test', truncated: false },
    }),
    eventFixture({ id: '3', turnNumber: 2, name: 'read_file', status: 'completed' }),
  ];

  it('returns every row when no filter is active', () => {
    expect(filterSessionEvents(events, EMPTY_EVENT_FILTER)).toHaveLength(3);
  });

  it('filters by turn equality', () => {
    const result = filterSessionEvents(events, { ...EMPTY_EVENT_FILTER, turn: 2 });
    expect(result.map((e) => e.id)).toEqual(['2', '3']);
  });

  it('filters by exact tool name', () => {
    const result = filterSessionEvents(events, { ...EMPTY_EVENT_FILTER, tool: 'read_file' });
    expect(result.map((e) => e.id)).toEqual(['1', '3']);
  });

  it('filters by errors-only', () => {
    const result = filterSessionEvents(events, { ...EMPTY_EVENT_FILTER, errorsOnly: true });
    expect(result.map((e) => e.id)).toEqual(['2']);
  });

  it('filters by case-insensitive text substring across name/target/payload', () => {
    const result = filterSessionEvents(events, { ...EMPTY_EVENT_FILTER, text: 'PNPM' });
    expect(result.map((e) => e.id)).toEqual(['2']);
  });

  it('AND-combines every active predicate', () => {
    const result = filterSessionEvents(events, {
      turn: 2,
      tool: 'read_file',
      errorsOnly: false,
      text: '',
    });
    expect(result.map((e) => e.id)).toEqual(['3']);
  });

  it('AND-combining a contradictory set of filters yields no rows', () => {
    const result = filterSessionEvents(events, {
      turn: 1,
      tool: 'read_file',
      errorsOnly: true,
      text: '',
    });
    expect(result).toEqual([]);
  });
});

describe('firstUserMessageExcerpt', () => {
  it('extracts and truncates the first user-role transcript message', () => {
    const page = {
      items: [
        {
          evidenceId: 'm1',
          entityType: 'message',
          summary: `Message 1 (user)\n\n${'x'.repeat(200)}`,
          evidenceLinks: [],
        },
      ],
      generationToken: 'g',
      analysisReleaseToken: 'r',
    };
    const excerpt = firstUserMessageExcerpt(page, 140);
    expect(excerpt?.length).toBe(141); // 140 chars + ellipsis
    expect(excerpt?.endsWith('…')).toBe(true);
  });

  it('returns null when no user-role message is present', () => {
    const page = {
      items: [
        {
          evidenceId: 'm1',
          entityType: 'message',
          summary: 'Message 1 (assistant)\n\nHi',
          evidenceLinks: [],
        },
      ],
      generationToken: 'g',
      analysisReleaseToken: 'r',
    };
    expect(firstUserMessageExcerpt(page)).toBeNull();
  });
});
