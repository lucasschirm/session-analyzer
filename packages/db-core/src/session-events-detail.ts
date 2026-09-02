import type { SqliteExecutor, SqliteRow, SqliteTransaction, SqliteValue } from './contract.js';

type Queryable = SqliteExecutor | SqliteTransaction;

// TextDecoder is a stable global in Node and browsers but is not part of the
// ES2021 lib used by this package. This local declaration keeps the module
// runtime-agnostic (matches packages/db/src/artifact-diff.ts).
interface TextDecoder {
  decode(input?: Uint8Array): string;
}
declare const TextDecoder: { new (): TextDecoder };

/**
 * Per-payload truncation cap for the session-events transfer response
 * (issue #169). This bounds the structured-clone size of the full-detail
 * session-events DTO independent of the payload-store's own `truncated`
 * flag (set at ingestion time for a different reason/threshold). A payload
 * larger than this cap ships truncated with `truncated: true`; the full
 * content is available on demand via
 * {@link SessionEventsDetailStore.getPayloadContent}.
 */
export const PAYLOAD_TRUNCATION_BYTES = 16 * 1024;

/** Raw invocation-derived row before db-facade shaping (see analytics-session.ts). */
export interface RawInvocationEventRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly latencyMs: number | null;
  readonly createdAt: number;
  readonly componentKind: string | null;
  readonly nativeId: string | null;
  readonly displayName: string | null;
  readonly turnOrdering: number | null;
  readonly inputPayload: RawPayloadRef | null;
  readonly resultPayload: RawPayloadRef | null;
}

/** Raw message-derived row before db-facade shaping. */
export interface RawMessageEventRow {
  readonly id: string;
  readonly role: string;
  readonly timestamp: number | null;
  readonly turnOrdering: number | null;
}

export interface RawPayloadRef {
  readonly payloadId: string;
  /** Decoded UTF-8 text, or `null` when the payload's raw bytes were not retained. */
  readonly content: string | null;
  readonly sizeBytes: number | null;
  readonly exactTokens: number | null;
  readonly estimatedTokens: number | null;
  readonly storedTruncated: boolean;
}

function asString(value: SqliteValue): string {
  return value === null || value === undefined ? '' : String(value);
}

function asOptionalString(value: SqliteValue): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toNumber(value: SqliteValue): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function toOptionalNumber(value: SqliteValue): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function decodePayloadBytes(value: SqliteValue): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return String(value);
}

function payloadRefFromRow(
  row: SqliteRow,
  idKey: string,
  contentKey: string,
  sizeKey: string,
  exactKey: string,
  estimatedKey: string,
  truncatedKey: string,
): RawPayloadRef | null {
  const payloadId = asOptionalString(row[idKey]);
  if (!payloadId) return null;
  return {
    payloadId,
    content: decodePayloadBytes(row[contentKey]),
    sizeBytes: toOptionalNumber(row[sizeKey]),
    exactTokens: toOptionalNumber(row[exactKey]),
    estimatedTokens: toOptionalNumber(row[estimatedKey]),
    storedTruncated: Boolean(row[truncatedKey]),
  };
}

function rowToInvocationEvent(row: SqliteRow): RawInvocationEventRow {
  return {
    id: asString(row.id),
    kind: asString(row.kind),
    status: asString(row.status),
    latencyMs: toOptionalNumber(row.latency_ms),
    createdAt: toNumber(row.created_at),
    componentKind: asOptionalString(row.component_kind),
    nativeId: asOptionalString(row.native_id),
    displayName: asOptionalString(row.display_name),
    turnOrdering: toOptionalNumber(row.turn_ordering),
    inputPayload: payloadRefFromRow(
      row,
      'input_payload_id',
      'input_raw',
      'input_size',
      'input_exact_tokens',
      'input_estimated_tokens',
      'input_truncated',
    ),
    resultPayload: payloadRefFromRow(
      row,
      'result_payload_id',
      'result_raw',
      'result_size',
      'result_exact_tokens',
      'result_estimated_tokens',
      'result_truncated',
    ),
  };
}

// NOTE: invocations carry no turn_id FK, and component_evidence_links rows
// are single-grain (its CHECK constraint forbids a row from setting both
// invocation_id and turn_id), so there is no join path from an invocation to
// a turn ordering today. turn_ordering is therefore always NULL for
// invocation-derived rows — reported as missing (never coerced to 0 or an
// invented turn number) per .agents/rules/missing-is-never-zero.md. This is
// a documented limitation (see issue #169 report); message-derived rows do
// carry a real turn ordering via messages.turn_id.
const INVOCATION_EVENTS_SQL = `
  SELECT
    i.id AS id, i.kind AS kind, i.status AS status, i.latency_ms AS latency_ms,
    i.created_at AS created_at,
    ci.kind AS component_kind, ci.native_id AS native_id, ci.display_name AS display_name,
    NULL AS turn_ordering,
    pin.id AS input_payload_id, pin.raw_content AS input_raw, pin.size_bytes AS input_size,
    pin.exact_tokens AS input_exact_tokens, pin.estimated_tokens AS input_estimated_tokens,
    pin.truncated AS input_truncated,
    pres.id AS result_payload_id, pres.raw_content AS result_raw, pres.size_bytes AS result_size,
    pres.exact_tokens AS result_exact_tokens, pres.estimated_tokens AS result_estimated_tokens,
    pres.truncated AS result_truncated
  FROM invocations i
  LEFT JOIN component_identities ci ON ci.id = i.component_id
  LEFT JOIN invocation_payloads ipin ON ipin.invocation_id = i.id AND ipin.is_input = 1
  LEFT JOIN payloads pin ON pin.id = ipin.payload_id
  LEFT JOIN invocation_payloads ipres ON ipres.invocation_id = i.id AND ipres.is_result = 1
  LEFT JOIN payloads pres ON pres.id = ipres.payload_id
  WHERE i.session_id = ?
  ORDER BY i.created_at
`;

const MESSAGE_EVENTS_SQL = `
  SELECT m.id AS id, m.role AS role, m.timestamp AS timestamp, t.ordering AS turn_ordering
  FROM messages m
  JOIN turns t ON t.id = m.turn_id
  WHERE m.session_id = ?
  ORDER BY m.ordering
`;

const PAYLOAD_CONTENT_SQL = `
  SELECT id, raw_content, size_bytes, exact_tokens, estimated_tokens, truncated
  FROM payloads
  WHERE id = ?
`;

/**
 * Read-only queries backing the full-detail session-events DTO (issue #169).
 * Deliberately separate from the paginated `getEvidencePages` path — it
 * returns every invocation and user/assistant message for a session in one
 * response so the redesigned evidence table can filter/search client-side.
 * All SQL lives here per `.agents/rules/sql-only-in-db-core.md`; the db
 * facade (`packages/db/src/analytics-session.ts`) only shapes these rows.
 */
export const SessionEventsDetailStore = {
  async listInvocationEvents(
    queryable: Queryable,
    sessionId: string,
  ): Promise<readonly RawInvocationEventRow[]> {
    const { rows } = await queryable.exec(INVOCATION_EVENTS_SQL, [sessionId]);
    return rows.map(rowToInvocationEvent);
  },

  async listMessageEvents(
    queryable: Queryable,
    sessionId: string,
  ): Promise<readonly RawMessageEventRow[]> {
    const { rows } = await queryable.exec(MESSAGE_EVENTS_SQL, [sessionId]);
    return rows.map((row) => ({
      id: asString(row.id),
      role: asString(row.role),
      timestamp: toOptionalNumber(row.timestamp),
      turnOrdering: toOptionalNumber(row.turn_ordering),
    }));
  },

  /** Full (untruncated) payload content for the per-event "fetch full payload" affordance. */
  async getPayloadContent(queryable: Queryable, payloadId: string): Promise<RawPayloadRef | null> {
    const { rows } = await queryable.exec(PAYLOAD_CONTENT_SQL, [payloadId]);
    const row = rows[0];
    if (!row) return null;
    return {
      payloadId: asString(row.id),
      content: decodePayloadBytes(row.raw_content),
      sizeBytes: toOptionalNumber(row.size_bytes),
      exactTokens: toOptionalNumber(row.exact_tokens),
      estimatedTokens: toOptionalNumber(row.estimated_tokens),
      storedTruncated: Boolean(row.truncated),
    };
  },
};
