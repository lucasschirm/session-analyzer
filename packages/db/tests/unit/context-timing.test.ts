import { describe, expect, it } from 'vitest';
import {
  collectSeriesModels,
  computeContextTimingPoints,
  computeRawTimingPoints,
  decodeContextSeries,
  encodeContextSeries,
  type TimingSourceRecord,
  timingRecordFromNormalizedRow,
} from '../../src/context-timing.js';

function record(overrides: Partial<TimingSourceRecord>): TimingSourceRecord {
  return {
    eventType: 'message',
    recordId: 'r-0',
    payload: {},
    ...overrides,
  };
}

describe('context-timing computation', () => {
  it('computes points from messages with model requests, including cache tokens', () => {
    const records: TimingSourceRecord[] = [
      record({
        eventType: 'turn',
        recordId: 't-1',
        payload: { ordinal: 1, role: 'human', timestamp: '2026-08-01T10:00:00.000Z' },
      }),
      record({
        eventType: 'message',
        recordId: 'm-1',
        parentId: 't-1',
        sourceEventId: 'u-1',
        payload: { role: 'human', content: 'hi', timestamp: '2026-08-01T10:00:00.000Z' },
      }),
      record({
        eventType: 'turn',
        recordId: 't-2',
        payload: { ordinal: 2, role: 'assistant', timestamp: '2026-08-01T10:00:05.000Z' },
      }),
      record({
        eventType: 'message',
        recordId: 'm-2',
        parentId: 't-2',
        sourceEventId: 'a-1',
        payload: {
          role: 'assistant',
          content: 'done',
          model: 'claude-3-7',
          timestamp: '2026-08-01T10:00:05.000Z',
        },
      }),
      record({
        eventType: 'model_request',
        recordId: 'req-1',
        parentId: 't-2',
        sourceEventId: 'a-1',
        payload: {
          requestOrder: 2,
          model: 'claude-3-7',
          inputTokens: 500,
          outputTokens: 50,
          cacheReadTokens: 200,
          cacheCreationTokens: 100,
          thinkingTokens: 20,
          effort: 'high',
          normalizedEffort: 'high',
          timestamp: '2026-08-01T10:00:05.000Z',
        },
      }),
    ];

    const points = computeContextTimingPoints(records);
    expect(points).toHaveLength(2);
    // m-1 carries no request → fill-forward inherits m-2's context.
    expect(points[0]?.contextTokens).toBe(800);
    expect(points[0]?.role).toBe('user');
    expect(points[1]?.contextTokens).toBe(800); // 500 + 200 + 100
    expect(points[1]?.generationTokens).toBe(50);
    expect(points[1]?.model).toBe('claude-3-7');
    expect(points[1]?.inputTokens).toBe(500);
    expect(points[1]?.cacheReadTokens).toBe(200);
    expect(points[1]?.cacheCreationTokens).toBe(100);
    expect(points[1]?.thinkingTokens).toBe(20);
    expect(points[1]?.effort).toBe('high');
    expect(points[1]?.content).toBe('done');
    expect(points[1]?.sourceEventId).toBe('a-1');
    expect(points[1]?.messageId).toBe('m-2');
  });

  it('resolves turn linkage regardless of record ordering (turn emitted after message)', () => {
    const records: TimingSourceRecord[] = [
      record({
        eventType: 'message',
        recordId: 'm-1',
        parentId: 't-1',
        payload: { role: 'user' },
      }),
      record({
        eventType: 'turn',
        recordId: 't-1',
        payload: { ordinal: 7 },
      }),
    ];
    const points = computeContextTimingPoints(records);
    expect(points).toHaveLength(1);
    expect(points[0]?.turnNumber).toBe(7);
  });

  it('keeps missing values missing — never zero', () => {
    const records: TimingSourceRecord[] = [
      record({
        eventType: 'message',
        recordId: 'm-1',
        payload: { role: 'assistant', timestamp: '2026-08-01T10:00:00.000Z' },
      }),
      record({
        eventType: 'model_request',
        recordId: 'req-1',
        sourceEventId: 'req-src-1',
        payload: { model: 'claude-3-7' }, // no token fields at all
      }),
    ];
    const points = computeContextTimingPoints(records);
    expect(points).toHaveLength(1);
    expect(points[0]?.contextTokens).toBeNull();
    expect(points[0]?.generationTokens).toBeNull();
    expect(points[0]?.inputTokens).toBeNull();
  });

  it('uses numTokensPreceding as the context source when no model request resolves', () => {
    // Devin transcript-only sessions emit a single session-level model_usage
    // record with all-null token fields; the per-node numTokensPreceding
    // checkpoint is the only real context signal.
    const records: TimingSourceRecord[] = [
      record({
        eventType: 'message',
        recordId: 'm-1',
        payload: { role: 'user', timestamp: '2026-08-01T10:00:00.000Z' },
      }),
      record({
        eventType: 'message',
        recordId: 'm-2',
        payload: {
          role: 'assistant',
          timestamp: '2026-08-01T10:00:01.000Z',
          numTokensPreceding: 18997,
        },
      }),
      record({
        eventType: 'model_usage',
        recordId: 'req-1',
        sourceEventId: 'sess-1',
        payload: { requestOrder: 1, model: 'unknown', inputTokens: null, outputTokens: null },
      }),
    ];
    const points = computeContextTimingPoints(records);
    expect(points).toHaveLength(2);
    expect(points[1]?.contextTokens).toBe(18997);
    // m-1 carries no checkpoint → carry-forward fill inherits m-2's context.
    expect(points[0]?.contextTokens).toBe(18997);
  });

  it('falls back to numTokensPreceding when the resolved request has all-null context fields', () => {
    const records: TimingSourceRecord[] = [
      record({
        eventType: 'turn',
        recordId: 't-1',
        payload: { ordinal: 1, role: 'assistant', timestamp: '2026-08-01T10:00:00.000Z' },
      }),
      record({
        eventType: 'message',
        recordId: 'm-1',
        parentId: 't-1',
        payload: {
          role: 'assistant',
          timestamp: '2026-08-01T10:00:00.000Z',
          numTokensPreceding: 42000,
        },
      }),
      record({
        eventType: 'model_usage',
        recordId: 'req-1',
        parentId: 't-1',
        payload: { requestOrder: 1, model: 'unknown', inputTokens: null, cacheReadTokens: null },
      }),
    ];
    const points = computeContextTimingPoints(records);
    expect(points[0]?.contextTokens).toBe(42000);
  });

  it('prefers resolved request context over numTokensPreceding when both exist', () => {
    const records: TimingSourceRecord[] = [
      record({
        eventType: 'message',
        recordId: 'm-1',
        sourceEventId: 'a-1',
        payload: {
          role: 'assistant',
          timestamp: '2026-08-01T10:00:00.000Z',
          numTokensPreceding: 42000,
        },
      }),
      record({
        eventType: 'model_usage',
        recordId: 'req-1',
        sourceEventId: 'a-1',
        payload: { inputTokens: 1000, outputTokens: 10 },
      }),
    ];
    const points = computeContextTimingPoints(records);
    expect(points[0]?.contextTokens).toBe(1000);
    expect(points[0]?.generationTokens).toBe(10);
  });

  it('detects compaction via consecutive context drops when no compaction record exists', () => {
    const records: TimingSourceRecord[] = [
      record({
        eventType: 'message',
        recordId: 'm-1',
        sourceEventId: 'e-1',
        payload: { role: 'assistant', timestamp: '2026-08-01T10:00:00.000Z' },
      }),
      record({
        eventType: 'message',
        recordId: 'm-2',
        sourceEventId: 'e-2',
        payload: { role: 'assistant', timestamp: '2026-08-01T10:00:01.000Z' },
      }),
      record({
        eventType: 'model_request',
        recordId: 'req-1',
        sourceEventId: 'e-1',
        payload: { inputTokens: 1000, outputTokens: 10 },
      }),
      record({
        eventType: 'model_request',
        recordId: 'req-2',
        sourceEventId: 'e-2',
        payload: { inputTokens: 300, outputTokens: 10 },
      }),
    ];
    const points = computeContextTimingPoints(records);
    expect(points[1]?.contextTokens).toBe(300);
    expect(points[1]?.compactedTokens).toBe(700);
  });
});

describe('context-series encode/decode', () => {
  it('round-trips points through the compact encoding', () => {
    const records: TimingSourceRecord[] = [
      record({
        eventType: 'message',
        recordId: 'm-1',
        sourceEventId: 'u-1',
        payload: { role: 'human', timestamp: '2026-08-01T10:00:00.000Z' },
      }),
      record({
        eventType: 'message',
        recordId: 'm-2',
        sourceEventId: 'a-1',
        payload: { role: 'assistant', timestamp: '2026-08-01T10:00:01.000Z' },
      }),
      record({
        eventType: 'model_request',
        recordId: 'req-1',
        sourceEventId: 'a-1',
        payload: {
          requestOrder: 1,
          model: 'claude-3-7',
          inputTokens: 500,
          outputTokens: 25,
          cacheReadTokens: 100,
          effort: 'high',
        },
      }),
      // A compaction event targeting m-2's position.
      record({
        eventType: 'normalized_event',
        recordId: 'comp-1',
        sourceEventId: 'a-1',
        payload: {
          category: 'compaction',
          timestamp: '2026-08-01T10:00:00.500Z',
          preTokens: 900,
          postTokens: 300,
        },
      }),
    ];

    const raw = computeRawTimingPoints(records);
    const encoded = encodeContextSeries(raw);
    expect(encoded.messageCount).toBe(2);

    const ctx = JSON.parse(encoded.contextTokensJson) as (number | null)[];
    // Position 2 carries the compaction: negative of removed tokens (600).
    expect(ctx[1]).toBe(-600);
    const meta = JSON.parse(encoded.pointMetaJson) as ({ ctx?: number | null } | null)[];
    expect(meta[1]?.ctx).toBe(600); // m-2's own context level (500+100)

    const decoded = decodeContextSeries({
      contextTokens: encoded.contextTokensJson,
      generationTokens: encoded.generationTokensJson,
      pointMeta: encoded.pointMetaJson,
    });
    expect(decoded).toHaveLength(2);
    expect(decoded[0]?.role).toBe('user');
    expect(decoded[0]?.transcriptIndex).toBe(1);
    expect(decoded[1]?.contextTokens).toBe(600);
    expect(decoded[1]?.compactedTokens).toBe(600);
    expect(decoded[1]?.removedTokens).toBe(600);
    expect(decoded[1]?.generationTokens).toBe(25);
    expect(decoded[1]?.model).toBe('claude-3-7');
    expect(decoded[1]?.inputTokens).toBe(500);
    expect(decoded[1]?.cacheReadTokens).toBe(100);
    expect(decoded[1]?.effort).toBe('high');
    expect(decoded[1]?.messageId).toBe('m-2');
    expect(decoded[1]?.sourceEventId).toBe('a-1');
    expect(decoded[1]?.content).toBeUndefined();
  });

  it('shifts transcriptIndex when a non-chat message record sits between chat points', () => {
    const records: TimingSourceRecord[] = [
      record({
        eventType: 'message',
        recordId: 'm-1',
        payload: { role: 'user', timestamp: '2026-08-01T10:00:00.000Z' },
      }),
      record({
        eventType: 'message',
        recordId: 'm-sys',
        payload: { role: 'system', timestamp: '2026-08-01T10:00:01.000Z' },
      }),
      record({
        eventType: 'message',
        recordId: 'm-2',
        payload: { role: 'assistant', timestamp: '2026-08-01T10:00:02.000Z' },
      }),
    ];
    const encoded = encodeContextSeries(computeRawTimingPoints(records));
    const decoded = decodeContextSeries({
      contextTokens: encoded.contextTokensJson,
      generationTokens: encoded.generationTokensJson,
      pointMeta: encoded.pointMetaJson,
    });
    // Transcript pages only expose chat roles: the system point has no
    // transcript position, and m-2's transcriptIndex is 2 (not 3).
    expect(decoded[0]?.transcriptIndex).toBe(1);
    expect(decoded[1]?.transcriptIndex).toBeUndefined();
    expect(decoded[2]?.transcriptIndex).toBe(2);
  });

  it('does not attribute an unparented session-level aggregate to a message', () => {
    // Regression (`brassy-humor` context growth): the Devin session-level
    // aggregate used to be parented to the first turn (and/or carry
    // requestOrder 1), so the whole-session total (~50.2M before the
    // cache-exclusive payload fix) landed on message #1 and fabricated a
    // matching compaction on message #2.
    const records: TimingSourceRecord[] = [
      record({ eventType: 'turn', recordId: 't-1', payload: { ordinal: 1, role: 'system' } }),
      record({
        eventType: 'message',
        recordId: 'm-1',
        parentId: 't-1',
        sourceEventId: 'sys-1',
        payload: { role: 'system', numTokensPreceding: 18639 },
      }),
      record({ eventType: 'turn', recordId: 't-2', payload: { ordinal: 2, role: 'assistant' } }),
      record({
        eventType: 'message',
        recordId: 'm-2',
        parentId: 't-2',
        sourceEventId: 'a-1',
        payload: { role: 'assistant' },
      }),
      record({
        eventType: 'model_usage',
        recordId: 'req-2',
        parentId: 't-2',
        sourceEventId: 'a-1',
        payload: { requestOrder: 2, inputTokens: 20000, cacheReadTokens: 12000, outputTokens: 112 },
      }),
      // Session-level aggregate: NO parentId and NO requestOrder (the fixed
      // transformer shape). Cache-exclusive input + cache reads.
      record({
        eventType: 'model_usage',
        recordId: 'agg',
        sourceEventId: 's1',
        payload: {
          requestId: 's1',
          inputTokens: 1280062,
          cacheReadTokens: 24456832,
          outputTokens: 106335,
        },
      }),
    ];

    const points = computeContextTimingPoints(records);
    // Message #1 keeps its own checkpoint — never the session aggregate.
    expect(points[0]?.contextTokens).toBe(18639);
    expect(points[1]?.contextTokens).toBe(32000);
    // No session-scale context point and no phantom session-scale compaction.
    expect(points.some((p) => (p.contextTokens ?? 0) > 1_000_000)).toBe(false);
    expect(points.some((p) => (p.compactedTokens ?? 0) > 1_000_000)).toBe(false);
  });

  it('collectSeriesModels unions model_request and model_usage payloads', () => {
    const records: TimingSourceRecord[] = [
      record({
        eventType: 'model_request',
        recordId: 'r1',
        payload: { model: 'claude-3-7' },
      }),
      record({
        eventType: 'model_usage',
        recordId: 'r2',
        payload: { model: 'devin-1' },
      }),
      record({
        eventType: 'model_usage',
        recordId: 'r3',
        payload: { model: 'claude-3-7' },
      }),
      record({
        eventType: 'model_request',
        recordId: 'r4',
        payload: {}, // no model — must not contribute
      }),
      record({ eventType: 'message', recordId: 'm1', payload: { model: 'ignored' } }),
    ];
    expect(collectSeriesModels(records)).toEqual(['claude-3-7', 'devin-1']);
  });
});

describe('timingRecordFromNormalizedRow', () => {
  it('maps a stored skeleton row to a timing source record', () => {
    const record = timingRecordFromNormalizedRow({
      id: 'ne-1',
      eventType: 'message',
      rawDetails: JSON.stringify({
        recordId: 'evt-msg-1',
        recordType: 'message',
        parentId: 'evt-turn-1',
        sourceEventId: 'u-1',
        payload: { storage: 'artifact-blob', path: 'sha256:abc', role: 'user' },
      }),
    });
    expect(record.eventType).toBe('message');
    expect(record.recordId).toBe('evt-msg-1');
    expect(record.parentId).toBe('evt-turn-1');
    expect(record.sourceEventId).toBe('u-1');
  });
});
