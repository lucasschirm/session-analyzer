/**
 * Parses `devin models list --format json` output into the normalized model
 * record shape persisted as `native/models.json`.
 *
 * DS-F7 (#149) will join `sessions.model` against `variants[].model_uid` and
 * use `sessions.metadata.response_dimensions` token counts. Out of scope for
 * DS-F4 (#153), but the record shape here is forward-compatible with that
 * future join.
 */

export interface DevinModelPricing {
  inputPerMTok: number;
  cachedInputPerMTok: number;
  outputPerMTok: number;
}

export interface ParsedModel {
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

const MIDDLE_DOT = '\u00b7';

interface DevinModelsList {
  families: unknown[];
}

interface DevinFamily {
  family_uid: unknown;
  variants: unknown[];
}

interface DevinVariant {
  model_uid: unknown;
  label: unknown;
  max_context_tokens: unknown;
  max_output_tokens: unknown;
  cost_tier: unknown;
  cost_summary: unknown;
}

export function parseDevinModelsList(raw: string): ParsedModel[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isModelsList(parsed)) return [];
    return parsed.families.flatMap((family) => flattenFamily(family));
  } catch {
    return [];
  }
}

function isModelsList(value: unknown): value is DevinModelsList {
  return (
    typeof value === 'object' &&
    value !== null &&
    'families' in value &&
    Array.isArray((value as DevinModelsList).families)
  );
}

function isFamily(value: unknown): value is DevinFamily {
  return isRecord(value) && Array.isArray(value.variants);
}

function flattenFamily(family: unknown): ParsedModel[] {
  if (!isFamily(family)) return [];
  return family.variants
    .filter((variant): variant is DevinVariant => isRecord(variant))
    .map((variant) => parseVariant(family, variant));
}

function parseVariant(family: DevinFamily, variant: DevinVariant): ParsedModel {
  const record: ParsedModel = {
    modelUid: stringOrEmpty(variant.model_uid),
    label: stringOrEmpty(variant.label),
    familyUid: stringOrEmpty(family.family_uid),
    costTier: stringOrEmpty(variant.cost_tier),
    maxContextTokens: toNumberOrNull(variant.max_context_tokens),
    maxOutputTokens: toNumberOrNull(variant.max_output_tokens),
  };

  if (typeof variant.cost_summary === 'string' && variant.cost_summary.length > 0) {
    const pricing = parseCostSummary(variant.cost_summary);
    if (pricing.ok) {
      record.pricing = pricing.value;
    } else {
      record.pricingUnavailableReason = pricing.reason;
      record.costSummaryRaw = variant.cost_summary;
    }
  }

  return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

interface ParsedPricing {
  ok: true;
  value: DevinModelPricing;
}

interface UnparsedPricing {
  ok: false;
  reason: string;
}

function parseCostSummary(costSummary: string): ParsedPricing | UnparsedPricing {
  const segments = costSummary.split(MIDDLE_DOT).map((s) => s.trim());
  const collected: Partial<DevinModelPricing> = {};

  for (const segment of segments) {
    const match = parsePriceSegment(segment);
    if (!match) continue;
    if (match.kind === 'Input') collected.inputPerMTok = match.value;
    if (match.kind === 'Cached input') collected.cachedInputPerMTok = match.value;
    if (match.kind === 'Output') collected.outputPerMTok = match.value;
  }

  if (
    typeof collected.inputPerMTok === 'number' &&
    typeof collected.cachedInputPerMTok === 'number' &&
    typeof collected.outputPerMTok === 'number'
  ) {
    return { ok: true, value: collected as DevinModelPricing };
  }

  return { ok: false, reason: 'unparsed-format' };
}

type PriceKind = 'Input' | 'Cached input' | 'Output';

function parsePriceSegment(segment: string): { kind: PriceKind; value: number } | undefined {
  const input = matchPrice(segment, 'Input');
  if (input !== undefined) return { kind: 'Input', value: input };

  const cached = matchPrice(segment, 'Cached input');
  if (cached !== undefined) return { kind: 'Cached input', value: cached };

  const output = matchPrice(segment, 'Output');
  if (output !== undefined) return { kind: 'Output', value: output };

  return undefined;
}

function matchPrice(segment: string, label: PriceKind): number | undefined {
  const pattern = new RegExp(
    `^\\$\\s*([0-9]+(?:\\.[0-9]+)?)\\s*/\\s*1M\\s+${escapeRegExp(label)}$`,
  );
  const match = segment.match(pattern);
  if (!match) return undefined;

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  return value;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
