import { describe, expect, it } from 'vitest';
import { parseDevinModelsList } from '../../src/models/parse.js';

const MIDDLE_DOT = '\u00b7';

function rawList(overrides: { costSummary?: string; costTier?: string } = {}): string {
  return JSON.stringify({
    families: [
      {
        family_label: 'Claude',
        family_uid: 'claude-family',
        slug: 'claude',
        aliases: [],
        variants: [
          {
            model_uid: 'claude-sonnet-4-20250514',
            label: 'Claude Sonnet 4',
            max_context_tokens: 200000,
            max_output_tokens: 8192,
            cost_tier: overrides.costTier ?? 'Paid',
            ...(overrides.costSummary !== undefined ? { cost_summary: overrides.costSummary } : {}),
            is_new: false,
            is_beta: false,
          },
        ],
      },
    ],
  });
}

describe('parseDevinModelsList', () => {
  it('preserves modelUid as identity, not the display label', () => {
    const parsed = parseDevinModelsList(rawList());
    expect(parsed).toHaveLength(1);
    expect(parsed[0].modelUid).toBe('claude-sonnet-4-20250514');
    expect(parsed[0].label).toBe('Claude Sonnet 4');
  });

  it('passes through max context and output token limits', () => {
    const parsed = parseDevinModelsList(rawList());
    expect(parsed[0].maxContextTokens).toBe(200000);
    expect(parsed[0].maxOutputTokens).toBe(8192);
  });

  it('uses null for missing token limits, never zero', () => {
    const raw = JSON.stringify({
      families: [
        {
          family_uid: 'claude-family',
          variants: [{ model_uid: 'claude-free', label: 'Free', cost_tier: 'Free' }],
        },
      ],
    });
    const parsed = parseDevinModelsList(raw);
    expect(parsed[0].maxContextTokens).toBeNull();
    expect(parsed[0].maxOutputTokens).toBeNull();
  });

  it('leaves pricing undefined for an absent cost_summary (free tier)', () => {
    const parsed = parseDevinModelsList(rawList({ costTier: 'Free' }));
    expect(parsed[0].pricing).toBeUndefined();
    expect(parsed[0].pricingUnavailableReason).toBeUndefined();
    expect(parsed[0].costSummaryRaw).toBeUndefined();
  });

  it('parses the U+00B7 middle-dot cost_summary into structured pricing', () => {
    const summary = `$0.7 / 1M Input ${MIDDLE_DOT} $0.13 / 1M Cached input ${MIDDLE_DOT} $2.2 / 1M Output`;
    const parsed = parseDevinModelsList(rawList({ costSummary: summary }));
    expect(parsed[0].pricing).toEqual({
      inputPerMTok: 0.7,
      cachedInputPerMTok: 0.13,
      outputPerMTok: 2.2,
    });
    expect(parsed[0].pricingUnavailableReason).toBeUndefined();
    expect(parsed[0].costSummaryRaw).toBeUndefined();
  });

  it('treats a malformed cost_summary as unavailable with a reason and raw string', () => {
    const summary = `$0.7 / 1M Input ${MIDDLE_DOT} $2.2 / 1M Output`;
    const parsed = parseDevinModelsList(rawList({ costSummary: summary }));
    expect(parsed[0].pricing).toBeUndefined();
    expect(parsed[0].pricingUnavailableReason).toBe('unparsed-format');
    expect(parsed[0].costSummaryRaw).toBe(summary);
  });

  it('treats an unknown separator as unavailable, no throw', () => {
    const summary = '$0.7 / 1M Input | $0.13 / 1M Cached input | $2.2 / 1M Output';
    const parsed = parseDevinModelsList(rawList({ costSummary: summary }));
    expect(parsed[0].pricing).toBeUndefined();
    expect(parsed[0].pricingUnavailableReason).toBe('unparsed-format');
    expect(parsed[0].costSummaryRaw).toBe(summary);
  });

  it('returns an empty array for invalid JSON, no throw', () => {
    expect(parseDevinModelsList('not json')).toEqual([]);
  });
});
