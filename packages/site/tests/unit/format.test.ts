import { describe, expect, it } from 'vitest';
import {
  estimateTokenCount,
  formatCompactNumber,
  formatDate,
  formatDuration,
  formatEstimatedTokens,
  formatFullNumber,
  formatSessionTitle,
} from '../../src/lib/format';

describe('formatCompactNumber', () => {
  it('keeps sub-million values as plain comma-grouped numbers', () => {
    expect(formatCompactNumber(0)).toBe('0');
    expect(formatCompactNumber(265)).toBe('265');
    expect(formatCompactNumber(999_999)).toBe('999,999');
  });

  it('rounds millions to one decimal with an M suffix', () => {
    expect(formatCompactNumber(1_357_717)).toBe('1.4M');
    expect(formatCompactNumber(5_000_000)).toBe('5M');
    expect(formatCompactNumber(1_000_000)).toBe('1M');
  });

  it('rounds billions to one decimal with a B suffix', () => {
    expect(formatCompactNumber(1_357_717_861)).toBe('1.4B');
    expect(formatCompactNumber(2_000_000_000)).toBe('2B');
  });

  it('preserves the sign for negative values', () => {
    expect(formatCompactNumber(-2_500_000)).toBe('-2.5M');
  });
});

describe('formatFullNumber', () => {
  it('renders the exact comma-grouped number for tooltips', () => {
    expect(formatFullNumber(1_357_717_861)).toBe('1,357,717,861');
  });
});

describe('formatDuration', () => {
  it('renders sub-minute durations in seconds', () => {
    expect(formatDuration(45_000)).toBe('45s');
  });

  it('renders sub-hour durations in minutes and seconds', () => {
    expect(formatDuration(3 * 60_000 + 20_000)).toBe('3m 20s');
  });

  it('renders long durations in hours and minutes', () => {
    expect(formatDuration(2 * 3_600_000 + 15 * 60_000)).toBe('2h 15m');
  });

  it('treats non-positive or non-finite durations as zero', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-500)).toBe('0s');
    expect(formatDuration(NaN)).toBe('0s');
  });
});

describe('estimateTokenCount', () => {
  it('estimates roughly one token per 4 characters, rounded up', () => {
    expect(estimateTokenCount('abcd')).toBe(1);
    expect(estimateTokenCount('abcde')).toBe(2);
    expect(estimateTokenCount('a'.repeat(100))).toBe(25);
  });

  it('returns 0 for empty or falsy text', () => {
    expect(estimateTokenCount('')).toBe(0);
  });
});

describe('formatEstimatedTokens', () => {
  it('prefixes the compact number with a tilde and labels it as an estimate', () => {
    expect(formatEstimatedTokens(265)).toBe('~265 tokens (est.)');
    expect(formatEstimatedTokens(1_357_717)).toBe('~1.4M tokens (est.)');
  });
});

describe('formatDate', () => {
  it('formats valid timestamp numbers and ISO strings into dates', () => {
    const ts = Date.parse('2026-05-15T12:00:00Z');
    expect(formatDate(ts)).toBe(new Date(ts).toLocaleDateString());
    expect(formatDate('2026-05-15T12:00:00Z')).toBe(new Date(ts).toLocaleDateString());
  });

  it('safely handles null, undefined, empty, and invalid values without throwing or returning NaN', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
    expect(formatDate('')).toBe('');
    expect(formatDate('invalid-date')).toBe('');
    expect(formatDate(NaN)).toBe('');
  });
});

describe('formatSessionTitle', () => {
  it('uses title when non-empty', () => {
    expect(formatSessionTitle('My Session', Date.now())).toBe('My Session');
    expect(formatSessionTitle('  Refactoring Auth  ', Date.now())).toBe('Refactoring Auth');
  });

  it('falls back to formatted date when title is absent or blank', () => {
    const ts = Date.parse('2026-05-15T12:00:00Z');
    const expected = `Session ${new Date(ts).toLocaleDateString()}`;
    expect(formatSessionTitle(null, ts)).toBe(expected);
    expect(formatSessionTitle('', ts)).toBe(expected);
    expect(formatSessionTitle('   ', ts)).toBe(expected);
  });

  it('falls back to "Session" when both title and date are invalid or missing', () => {
    expect(formatSessionTitle(null, null)).toBe('Session');
    expect(formatSessionTitle('', 'invalid-date')).toBe('Session');
  });
});
