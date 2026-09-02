/**
 * Parses `native/models.json` — the already-normalized model list DS-F4
 * (#153)'s `devin-session-sync` capture is specified to produce (this parser
 * consumes that authoritative output shape as typed input; it does not parse
 * `cost_summary` strings itself, that logic lives in DS-F4 (#153)).
 *
 * Per DS-F4 (#153)'s spec there are three distinguishable pricing states, not
 * just present/absent, and `missing-is-never-zero` forbids collapsing any of
 * them into a zero-valued pricing object:
 *   - absent    — `pricing` is `undefined` (e.g. a free-tier model)
 *   - parsed    — `pricing` is a well-formed per-token object
 *   - malformed — `pricingUnavailableReason` is set and the original raw
 *                 `cost_summary` string is preserved on `costSummaryRaw`
 */

export interface DevinModelPricing {
  inputPerMTok: number;
  cachedInputPerMTok: number;
  outputPerMTok: number;
}

export interface DevinModelRecord {
  modelUid: string;
  label: string;
  familyUid: string;
  costTier: string;
  maxContextTokens: number | null;
  maxOutputTokens: number | null;
  /** Present only in the "parsed" pricing state. */
  pricing?: DevinModelPricing;
  /** Present only in the "malformed/unavailable" pricing state. */
  pricingUnavailableReason?: string;
  /** The preserved raw `cost_summary` string in the "malformed" state. */
  costSummaryRaw?: string;
}

export interface ParseDevinModelsResult {
  models: DevinModelRecord[];
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parsePricing(raw: unknown): DevinModelPricing | undefined {
  if (!isRecord(raw)) return undefined;
  const input = optionalNumber(raw, 'inputPerMTok');
  const cached = optionalNumber(raw, 'cachedInputPerMTok');
  const output = optionalNumber(raw, 'outputPerMTok');
  if (input === null || cached === null || output === null) return undefined;
  return { inputPerMTok: input, cachedInputPerMTok: cached, outputPerMTok: output };
}

function requiredStrings(record: Record<string, unknown>): string[] | null {
  const keys = ['modelUid', 'label', 'familyUid', 'costTier'] as const;
  const values = keys.map((key) => record[key]);
  return values.every((value) => typeof value === 'string') ? (values as string[]) : null;
}

function parsePricingFields(record: Record<string, unknown>): Partial<DevinModelRecord> {
  const pricing = parsePricing(record.pricing);
  if (pricing) return { pricing };
  if (typeof record.pricingUnavailableReason !== 'string') return {};
  return {
    pricingUnavailableReason: record.pricingUnavailableReason,
    ...(typeof record.costSummaryRaw === 'string' ? { costSummaryRaw: record.costSummaryRaw } : {}),
  };
}

function parseModelRecord(raw: unknown): DevinModelRecord | null {
  if (!isRecord(raw)) return null;
  const strings = requiredStrings(raw);
  if (!strings) return null;
  const [modelUid, label, familyUid, costTier] = strings;
  return {
    modelUid,
    label,
    familyUid,
    costTier,
    maxContextTokens: optionalNumber(raw, 'maxContextTokens'),
    maxOutputTokens: optionalNumber(raw, 'maxOutputTokens'),
    ...parsePricingFields(raw),
  };
}

/** Parses a `native/models.json` payload; malformed entries are skipped, never thrown. */
export function parseDevinModelsJson(raw: unknown): ParseDevinModelsResult {
  if (!Array.isArray(raw)) {
    return { models: [], warnings: ['models.json root is not an array'] };
  }
  const models: DevinModelRecord[] = [];
  const warnings: string[] = [];
  raw.forEach((entry, index) => {
    const model = parseModelRecord(entry);
    model ? models.push(model) : warnings.push(`skipped malformed model entry at index ${index}`);
  });
  return { models, warnings };
}
