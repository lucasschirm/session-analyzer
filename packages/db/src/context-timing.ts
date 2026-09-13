import type { NormalizedTimingEventRow } from '@lucasschirm/sal-db-core';
import type { ContextTimingPoint } from './analytics.js';

/**
 * Shared context-growth computation for the analytics platform.
 *
 * One implementation serves three callers:
 *   1. ingest-time (`DefaultIngestionOrchestrator.commitAtomic`) — computes the
 *      series from in-memory `NormalizedEvidenceRecord`s and persists it in
 *      `session_context_series` (one row per session+generation);
 *   2. legacy read fallback (`analytics-session.getContextTimingSeries`) —
 *      re-derives points from `normalized_events.raw_details` for generations
 *      that predate the series table;
 *   3. processing-version backfill (`rebuildAnalyticsDerivedData`) — same
 *      computation as (2), materialized into `session_context_series`.
 *
 * Storage encoding (one array entry per transcript message position):
 *   context_tokens[i] > 0    — context tokens attributed to that message's
 *                              model request (input + cacheRead +
 *                              cacheCreation, after carry-forward fill);
 *   context_tokens[i] < 0    — a compaction applied at that position; |v| is
 *                              the removed token count and the point's own
 *                              post-compaction context level is carried in
 *                              `point_meta[i].ctx`;
 *   context_tokens[i] = null — no context signal (missing is never zero).
 * `generation_tokens[i]` is the parallel output-token array and `point_meta[i]`
 * a sparse object carrying the non-content fields needed to rebuild the
 * `ContextTimingPoint` DTO (role, model, timestamp, request breakdown, effort,
 * message/source ids, transcript position). Message content is never stored —
 * it is resolved on demand from the retained transcript artifact blob.
 */

function asString(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function asOptionalString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asNumber(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function asOptionalNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function formatTimestamp(value: unknown): string | undefined {
  const ts = asOptionalNumber(value);
  if (ts === null || ts <= 0) return undefined;
  return new Date(ts).toISOString();
}

function formatToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2);
  return content
    .map((sub: unknown) =>
      typeof sub === 'object' && sub !== null && 'text' in (sub as Record<string, unknown>)
        ? String((sub as Record<string, unknown>).text)
        : JSON.stringify(sub),
    )
    .join('\n');
}

function formatContentBlock(block: unknown): string {
  if (typeof block === 'string') return block;
  if (typeof block !== 'object' || block === null) return '';
  const b = block as Record<string, unknown>;
  if (b.type === 'text' && typeof b.text === 'string') return b.text;
  if (b.type === 'tool_use') {
    const name = typeof b.name === 'string' ? b.name : 'tool';
    const inputStr = b.input ? JSON.stringify(b.input, null, 2) : '';
    return `**Tool Call: \`${name}\`**\n\`\`\`json\n${inputStr}\n\`\`\``;
  }
  if (b.type === 'tool_result') {
    const errSuffix = b.is_error === true ? ' *(error)*' : '';
    return `**Tool Result${errSuffix}:**\n${formatToolResultContent(b.content)}`;
  }
  return '';
}

function formatMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(formatContentBlock).filter(Boolean).join('\n\n');
}

function safeJsonParse<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * The normalized shape the timing computation consumes. Adapters below map
 * both `NormalizedEvidenceRecord`s (ingest) and `normalized_events` rows
 * (legacy read / backfill) onto this shape.
 */
export interface TimingSourceRecord {
  readonly eventType: string;
  readonly recordId: string;
  readonly parentId?: string | null;
  readonly sourceEventId?: string | null;
  readonly payload: unknown;
}

interface TimingTurn {
  ordinal?: number;
  role?: string;
  timestamp?: string;
  sourceEventId?: string;
}

interface TimingRequest {
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheCreationTokens?: number | null;
  cacheReadTokens?: number | null;
  thinkingTokens?: number | null;
  effort?: string | null;
  normalizedEffort?: string | null;
  timestamp?: string;
  requestOrder?: number | null;
}

interface TimingMessage {
  id: string;
  turnId?: string;
  sourceEventId?: string;
  role: string;
  timestamp?: string;
  content: string;
  model?: string;
  turnOrdinal?: number;
}

export interface RawTimingPoint {
  msg: TimingMessage;
  req?: TimingRequest;
  contextTokens: number | null;
  generationTokens: number | null;
  totalTokens: number | null;
  compactedTokens?: number | null;
}

interface TimingCompaction {
  id: string;
  timestampMs?: number;
  timestamp?: string;
  sourceEventId?: string;
  preTokens?: number;
  postTokens?: number;
  droppedTokens?: number;
}

function parseTimingTurn(
  recordId: string,
  payload: Record<string, unknown>,
  sourceEventId: string | null | undefined,
): [string, TimingTurn] {
  return [
    recordId,
    {
      ordinal: typeof payload.ordinal === 'number' ? payload.ordinal : undefined,
      role: typeof payload.role === 'string' ? payload.role : undefined,
      timestamp:
        typeof payload.timestamp === 'string'
          ? payload.timestamp
          : formatTimestamp(payload.timestamp),
      sourceEventId: sourceEventId ?? undefined,
    },
  ];
}

function parseTimingRequest(payload: Record<string, unknown>): TimingRequest {
  return {
    model: asOptionalString(payload.model),
    inputTokens: asOptionalNumber(payload.inputTokens),
    outputTokens: asOptionalNumber(payload.outputTokens),
    cacheCreationTokens: asOptionalNumber(payload.cacheCreationTokens),
    cacheReadTokens: asOptionalNumber(payload.cacheReadTokens),
    thinkingTokens: asOptionalNumber(payload.thinkingTokens),
    effort: asOptionalString(payload.effort),
    normalizedEffort: asOptionalString(payload.normalizedEffort),
    timestamp:
      typeof payload.timestamp === 'string'
        ? payload.timestamp
        : formatTimestamp(payload.timestamp),
    requestOrder:
      typeof payload.requestOrder === 'number'
        ? payload.requestOrder
        : asOptionalNumber(payload.requestOrder),
  };
}

function parseTimingMessage(
  recordId: string,
  parentId: string | null | undefined,
  sourceEventId: string | null | undefined,
  payload: Record<string, unknown>,
  turnsMap: Map<string, TimingTurn>,
): TimingMessage {
  const turn = parentId ? turnsMap.get(parentId) : undefined;
  const rawRole = typeof payload.role === 'string' ? payload.role : (turn?.role ?? 'unknown');
  const role = rawRole === 'human' ? 'user' : rawRole;
  const ts =
    typeof payload.timestamp === 'string'
      ? payload.timestamp
      : (formatTimestamp(payload.timestamp) ?? turn?.timestamp);
  return {
    id: recordId,
    turnId: parentId ?? undefined,
    sourceEventId: sourceEventId ?? undefined,
    role,
    timestamp: ts,
    content: formatMessageContent(payload.content),
    model: asOptionalString(payload.model) ?? undefined,
    turnOrdinal:
      turn?.ordinal ?? (typeof payload.ordinal === 'number' ? payload.ordinal : undefined),
  };
}

function parseTimingCompaction(
  recordId: string,
  sourceEventId: string | null | undefined,
  payload: Record<string, unknown>,
): TimingCompaction {
  const tsMs =
    typeof payload.timestampMs === 'number'
      ? payload.timestampMs
      : typeof payload.timestamp === 'string'
        ? Date.parse(payload.timestamp)
        : undefined;
  const preTokens = asOptionalNumber(payload.preTokens);
  const postTokens = asOptionalNumber(payload.postTokens);
  const droppedTokens =
    asOptionalNumber(payload.cumulativeDroppedTokens) ??
    asOptionalNumber(payload.droppedTokens) ??
    asOptionalNumber(payload.tokens_saved) ??
    (preTokens != null && postTokens != null ? preTokens - postTokens : undefined);
  return {
    id: recordId,
    timestampMs: Number.isNaN(tsMs) ? undefined : tsMs,
    timestamp:
      typeof payload.timestamp === 'string'
        ? payload.timestamp
        : tsMs
          ? new Date(tsMs).toISOString()
          : undefined,
    sourceEventId: sourceEventId ?? undefined,
    preTokens: preTokens ?? undefined,
    postTokens: postTokens ?? undefined,
    droppedTokens: droppedTokens ?? undefined,
  };
}

function sortTimingMessages(messagesList: TimingMessage[]): void {
  messagesList.sort((a, b) => {
    if (a.turnOrdinal !== undefined && b.turnOrdinal !== undefined) {
      return a.turnOrdinal - b.turnOrdinal;
    }
    if (a.timestamp && b.timestamp) {
      const cmp = a.timestamp.localeCompare(b.timestamp);
      if (cmp !== 0) return cmp;
    }
    return a.id.localeCompare(b.id);
  });
}

function resolveMessageRequest(
  m: TimingMessage,
  byTurn: Map<string, TimingRequest>,
  byEvent: Map<string, TimingRequest>,
  byOrder: Map<number, TimingRequest>,
): TimingRequest | undefined {
  if (m.turnId && byTurn.has(m.turnId)) return byTurn.get(m.turnId);
  if (m.sourceEventId && byEvent.has(m.sourceEventId)) return byEvent.get(m.sourceEventId);
  if (m.turnOrdinal !== undefined && byOrder.has(m.turnOrdinal)) return byOrder.get(m.turnOrdinal);
  return undefined;
}

function createRawTimingPoint(msg: TimingMessage, req?: TimingRequest): RawTimingPoint {
  if (!req) {
    return {
      msg,
      req,
      contextTokens: null,
      generationTokens: null,
      totalTokens: null,
      compactedTokens: null,
    };
  }
  const hasContext =
    req.inputTokens != null || req.cacheReadTokens != null || req.cacheCreationTokens != null;
  const contextTokens = hasContext
    ? asNumber(req.inputTokens) + asNumber(req.cacheReadTokens) + asNumber(req.cacheCreationTokens)
    : null;
  const generationTokens = asOptionalNumber(req.outputTokens) ?? null;
  const totalTokens =
    contextTokens !== null ? contextTokens + (generationTokens ?? 0) : generationTokens;
  return { msg, req, contextTokens, generationTokens, totalTokens, compactedTokens: null };
}

function fillForwardContextTokens(rawPoints: RawTimingPoint[]): void {
  for (let i = 0; i < rawPoints.length; i++) {
    if (rawPoints[i].contextTokens === null) {
      let forwardContext: number | null = null;
      for (let j = i + 1; j < rawPoints.length; j++) {
        if (rawPoints[j].contextTokens !== null) {
          forwardContext = rawPoints[j].contextTokens;
          break;
        }
      }
      const inherited = forwardContext ?? (i > 0 ? rawPoints[i - 1].contextTokens : null);
      rawPoints[i].contextTokens = inherited;
      rawPoints[i].totalTokens = inherited;
      rawPoints[i].generationTokens = null;
    }
  }
}

/**
 * Computes the sorted, carry-filled raw timing points for one session's
 * records. Runs in two passes so turn lookups resolve regardless of the
 * input ordering (`normalized_events` rows arrive in `id` order, while
 * in-memory evidence arrives in emission order).
 */
export function computeRawTimingPoints(records: readonly TimingSourceRecord[]): RawTimingPoint[] {
  const turnsMap = new Map<string, TimingTurn>();
  const messages: TimingMessage[] = [];
  const reqByTurn = new Map<string, TimingRequest>();
  const reqByEvent = new Map<string, TimingRequest>();
  const reqByOrder = new Map<number, TimingRequest>();
  const compactions: TimingCompaction[] = [];

  for (const record of records) {
    if (record.eventType !== 'turn') continue;
    const payload = (record.payload as Record<string, unknown>) ?? {};
    const [id, turn] = parseTimingTurn(record.recordId, payload, record.sourceEventId);
    turnsMap.set(id, turn);
  }

  for (const record of records) {
    const payload = (record.payload as Record<string, unknown>) ?? {};
    const eventType = record.eventType;
    if (eventType === 'model_request' || eventType === 'model_usage') {
      const req = parseTimingRequest(payload);
      if (record.parentId) reqByTurn.set(record.parentId, req);
      if (record.sourceEventId) reqByEvent.set(record.sourceEventId, req);
      if (typeof req.requestOrder === 'number') reqByOrder.set(req.requestOrder, req);
    } else if (eventType === 'message') {
      messages.push(
        parseTimingMessage(
          record.recordId,
          record.parentId,
          record.sourceEventId,
          payload,
          turnsMap,
        ),
      );
    } else if (
      eventType === 'compaction' ||
      (eventType === 'normalized_event' && payload.category === 'compaction')
    ) {
      compactions.push(parseTimingCompaction(record.recordId, record.sourceEventId, payload));
    }
  }

  if (messages.length === 0) return [];
  sortTimingMessages(messages);

  const rawPoints = messages.map((m) =>
    createRawTimingPoint(m, resolveMessageRequest(m, reqByTurn, reqByEvent, reqByOrder)),
  );
  fillForwardContextTokens(rawPoints);

  if (compactions.length > 0) {
    compactions.sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
    for (const c of compactions) {
      let targetPoint: RawTimingPoint | undefined;
      const cTs = c.timestampMs;
      if (cTs !== undefined) {
        targetPoint = rawPoints.find((p) => {
          const pTs = p.msg.timestamp ? Date.parse(p.msg.timestamp) : undefined;
          return pTs !== undefined && pTs >= cTs;
        });
      }
      if (!targetPoint && c.sourceEventId) {
        targetPoint = rawPoints.find(
          (p) => p.msg.sourceEventId === c.sourceEventId || p.msg.id === c.sourceEventId,
        );
      }
      if (targetPoint) {
        const dropped =
          c.droppedTokens ??
          (c.preTokens != null && c.postTokens != null ? c.preTokens - c.postTokens : null);
        targetPoint.compactedTokens = dropped ?? null;
      }
    }
  }

  // Fallback: detect context drop between consecutive points if compactedTokens
  // is not set.
  for (let i = 1; i < rawPoints.length; i++) {
    const prev = rawPoints[i - 1].contextTokens;
    const curr = rawPoints[i].contextTokens;
    if (rawPoints[i].compactedTokens == null && prev !== null && curr !== null && prev > curr) {
      rawPoints[i].compactedTokens = prev - curr;
    }
  }

  return rawPoints;
}

export function toContextTimingPoint(raw: RawTimingPoint, index: number): ContextTimingPoint {
  const { msg, req, contextTokens, generationTokens, totalTokens, compactedTokens } = raw;
  return {
    turnNumber: msg.turnOrdinal ?? index + 1,
    messageIndex: index + 1,
    messageId: msg.id,
    role: msg.role,
    model: (req ? asOptionalString(req.model) : msg.model) ?? undefined,
    timestamp: msg.timestamp,
    totalTokens,
    contextTokens,
    generationTokens,
    compactedTokens: compactedTokens ?? undefined,
    removedTokens: compactedTokens ?? undefined,
    inputTokens: req ? asOptionalNumber(req.inputTokens) : contextTokens,
    outputTokens: req ? asOptionalNumber(req.outputTokens) : generationTokens,
    cacheCreationTokens: req ? asOptionalNumber(req.cacheCreationTokens) : null,
    cacheReadTokens: req ? asOptionalNumber(req.cacheReadTokens) : null,
    thinkingTokens: req ? asOptionalNumber(req.thinkingTokens) : null,
    effort: req ? asOptionalString(req.effort) : null,
    normalizedEffort: req ? asOptionalString(req.normalizedEffort) : null,
    // Empty string → undefined so the view hydrates the body from the
    // transcript artifact (skeleton fallback rows carry no payload content).
    content: msg.content === '' ? undefined : msg.content,
    sourceEventId: msg.sourceEventId,
  };
}

export function computeContextTimingPoints(
  records: readonly TimingSourceRecord[],
): ContextTimingPoint[] {
  let transcriptIndex = 0;
  return computeRawTimingPoints(records).map((raw, index) => {
    const point = toContextTimingPoint(raw, index);
    if (point.role && TRANSCRIPT_CHAT_ROLES.has(point.role)) {
      transcriptIndex += 1;
      return { ...point, transcriptIndex };
    }
    return point;
  });
}

// ---------------------------------------------------------------------------
// Compact series encoding
// ---------------------------------------------------------------------------

/** Sparse per-point metadata stored in `session_context_series.point_meta`. */
interface ContextPointMeta {
  role?: string;
  msgId?: string;
  src?: string;
  ts?: string;
  model?: string;
  /** `1` when the point resolved a model request — distinguishes
   *  "request with null field" from "no request" on decode. */
  rq?: number;
  in?: number;
  cr?: number;
  cc?: number;
  out?: number;
  th?: number;
  eff?: string;
  neff?: string;
  /** turnOrdinal when it differs from the 1-based array position. */
  t?: number;
  /** Transcript-page position when it differs from the 1-based position. */
  tr?: number;
  /** Post-compaction context level, present on compaction positions
   *  (where `context_tokens[i] < 0`). */
  ctx?: number | null;
  /** Compaction removed-tokens when it cannot be encoded as a negative
   *  context value (zero or negative drops). */
  cmp?: number;
}

const TRANSCRIPT_CHAT_ROLES = new Set(['user', 'assistant']);

export interface EncodedContextSeries {
  readonly messageCount: number;
  readonly contextTokensJson: string;
  readonly generationTokensJson: string;
  readonly pointMetaJson: string;
}

/**
 * Encodes raw timing points into the compact JSON columns of a
 * `session_context_series` row. `transcriptIndex` is tracked in parallel so a
 * point can be joined back to `getTranscriptPages` output — transcript pages
 * only surface user/assistant chat messages, so positions drift whenever a
 * session emits non-chat-role message records (e.g. Devin system nodes).
 */
export function encodeContextSeries(rawPoints: readonly RawTimingPoint[]): EncodedContextSeries {
  const contextTokens: (number | null)[] = [];
  const generationTokens: (number | null)[] = [];
  const pointMeta: ContextPointMeta[] = [];
  let transcriptIndex = 0;

  rawPoints.forEach((raw, index) => {
    const { msg, req } = raw;
    const meta: ContextPointMeta = { role: msg.role, msgId: msg.id };
    if (msg.sourceEventId) meta.src = msg.sourceEventId;
    if (msg.timestamp) meta.ts = msg.timestamp;
    const model = (req ? asOptionalString(req.model) : msg.model) ?? undefined;
    if (model) meta.model = model;
    if (req) {
      meta.rq = 1;
      if (req.inputTokens != null) meta.in = req.inputTokens;
      if (req.cacheReadTokens != null) meta.cr = req.cacheReadTokens;
      if (req.cacheCreationTokens != null) meta.cc = req.cacheCreationTokens;
      if (req.outputTokens != null) meta.out = req.outputTokens;
      if (req.thinkingTokens != null) meta.th = req.thinkingTokens;
      if (req.effort != null) meta.eff = req.effort;
      if (req.normalizedEffort != null) meta.neff = req.normalizedEffort;
    }
    if (msg.turnOrdinal !== undefined && msg.turnOrdinal !== index + 1) {
      meta.t = msg.turnOrdinal;
    }
    if (TRANSCRIPT_CHAT_ROLES.has(msg.role)) {
      transcriptIndex += 1;
      if (transcriptIndex !== index + 1) meta.tr = transcriptIndex;
    }

    const compacted = raw.compactedTokens;
    if (compacted != null && compacted > 0) {
      contextTokens.push(-compacted);
      meta.ctx = raw.contextTokens;
    } else {
      contextTokens.push(raw.contextTokens);
      if (compacted != null) meta.cmp = compacted;
    }
    generationTokens.push(raw.generationTokens);
    pointMeta.push(meta);
  });

  return {
    messageCount: rawPoints.length,
    contextTokensJson: JSON.stringify(contextTokens),
    generationTokensJson: JSON.stringify(generationTokens),
    pointMetaJson: JSON.stringify(pointMeta),
  };
}

/**
 * Expands a stored `session_context_series` row back into the
 * `ContextTimingPoint[]` DTO — the same shape the legacy normalized-events
 * computation produced, minus `content` (hydrated on demand from the retained
 * transcript artifact).
 */
export function decodeContextSeries(row: {
  readonly contextTokens: string;
  readonly generationTokens: string | null;
  readonly pointMeta: string | null;
}): ContextTimingPoint[] {
  const contextArr = safeJsonParse<(number | null)[]>(row.contextTokens, []);
  const generationArr = safeJsonParse<(number | null)[]>(row.generationTokens, []);
  const metaArr = safeJsonParse<(ContextPointMeta | null)[]>(row.pointMeta, []);

  const points: ContextTimingPoint[] = [];
  for (let i = 0; i < contextArr.length; i++) {
    const meta = metaArr[i] ?? {};
    const v = contextArr[i];
    let contextTokens: number | null;
    let compacted: number | undefined;
    if (typeof v === 'number' && v < 0) {
      compacted = -v;
      contextTokens = typeof meta.ctx === 'number' ? meta.ctx : null;
    } else {
      contextTokens = typeof v === 'number' ? v : null;
      compacted = typeof meta.cmp === 'number' ? meta.cmp : undefined;
    }
    const generation = typeof generationArr[i] === 'number' ? generationArr[i] : null;
    const rq = meta.rq === 1;
    const role = typeof meta.role === 'string' ? meta.role : undefined;
    const transcriptIndex =
      typeof meta.tr === 'number'
        ? meta.tr
        : role !== undefined && TRANSCRIPT_CHAT_ROLES.has(role)
          ? i + 1
          : undefined;
    points.push({
      turnNumber: typeof meta.t === 'number' ? meta.t : i + 1,
      messageIndex: i + 1,
      messageId: typeof meta.msgId === 'string' ? meta.msgId : undefined,
      role,
      model: typeof meta.model === 'string' ? meta.model : undefined,
      timestamp: typeof meta.ts === 'string' ? meta.ts : undefined,
      totalTokens: contextTokens !== null ? contextTokens + (generation ?? 0) : generation,
      contextTokens,
      generationTokens: generation,
      compactedTokens: compacted,
      removedTokens: compacted,
      inputTokens: rq ? asOptionalNumber(meta.in) : contextTokens,
      outputTokens: rq ? asOptionalNumber(meta.out) : generation,
      cacheCreationTokens: rq ? asOptionalNumber(meta.cc) : null,
      cacheReadTokens: rq ? asOptionalNumber(meta.cr) : null,
      thinkingTokens: rq ? asOptionalNumber(meta.th) : null,
      effort: rq ? asOptionalString(meta.eff) : null,
      normalizedEffort: rq ? asOptionalString(meta.neff) : null,
      sourceEventId: typeof meta.src === 'string' ? meta.src : undefined,
      transcriptIndex,
    });
  }
  return points;
}

/**
 * Distinct models observed on model_request/model_usage records — the
 * `session_context_series.models` payload that replaces the normalized_events
 * fallback for portfolio model counts.
 */
export function collectSeriesModels(records: readonly TimingSourceRecord[]): string[] {
  const models = new Set<string>();
  for (const record of records) {
    if (record.eventType !== 'model_request' && record.eventType !== 'model_usage') continue;
    const payload = record.payload as Record<string, unknown> | undefined;
    const model = payload?.model;
    if (typeof model === 'string' && model.length > 0) models.add(model);
  }
  return [...models].sort();
}

// ---------------------------------------------------------------------------
// Input adapters
// ---------------------------------------------------------------------------

/** In-memory evidence records (ingest path). */
export function timingRecordFromEvidence(record: {
  readonly recordId: string;
  readonly recordType: string;
  readonly parentId?: string;
  readonly sourceEventId: string;
  readonly payload: unknown;
}): TimingSourceRecord {
  return {
    eventType: record.recordType,
    recordId: record.recordId,
    parentId: record.parentId,
    sourceEventId: record.sourceEventId,
    payload: record.payload,
  };
}

/** `normalized_events` rows (legacy read fallback + backfill). */
export function timingRecordFromNormalizedRow(row: NormalizedTimingEventRow): TimingSourceRecord {
  const record = safeJsonParse<Record<string, unknown>>(row.rawDetails, {});
  return {
    eventType: row.eventType,
    recordId: asString(record.recordId) || row.id,
    parentId: asOptionalString(record.parentId),
    sourceEventId: asOptionalString(record.sourceEventId),
    payload: record.payload ?? {},
  };
}
