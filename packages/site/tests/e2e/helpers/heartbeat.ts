import type { Locator } from '@playwright/test';

export type ProgressValue = number;

/** Extract a numeric progress value from a progress element's text. */
export type ProgressParser = (text: string) => ProgressValue | null;

export interface HeartbeatOptions {
  /** Polling interval in milliseconds. Default 100. */
  intervalMs?: number;
  /** Maximum time to wait for progress in milliseconds. Default 5000. */
  timeoutMs?: number;
  /** Parser for extracting a numeric value from the locator text. Default is {@link defaultProgressParser}. */
  parser?: ProgressParser;
  /** Minimum number of distinct progress values required. Default 2. */
  minDistinctValues?: number;
  /** Optional message used in assertion errors. */
  message?: string;
}

export interface HeartbeatResult {
  /** All sampled numeric values, in the order observed. */
  series: ProgressValue[];
  /** Distinct values observed, in order of first appearance. */
  distinct: ProgressValue[];
}

const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MIN_DISTINCT = 2;
const DEFAULT_MESSAGE = 'Progress heartbeat';

/**
 * Generic progress parser that recognizes:
 * - A percentage, e.g. "Upload 42%".
 * - A count/total fraction, e.g. "Files 3 / 10" (returns the current count).
 * - Any plain number in the text.
 */
export function defaultProgressParser(text: string): ProgressValue | null {
  if (!text) return null;
  const normalized = text.trim();
  if (!normalized) return null;

  const percent = /(\d+(?:\.\d+)?)\s*%/.exec(normalized);
  if (percent) return Number.parseFloat(percent[1]);

  const fraction = /(\d+)\s*\/\s*\d+/.exec(normalized);
  if (fraction) return Number.parseInt(fraction[1], 10);

  const number = /(\d+(?:\.\d+)?)/.exec(normalized);
  if (number) return Number.parseFloat(number[1]);

  return null;
}

/**
 * Parser tuned for the `sync-progress-bar` text
 * `Projects S/P | Sessions S/P | Files D/F`.
 * Returns the files-downloaded count; falls back to {@link defaultProgressParser}
 * if no "Files" segment is found.
 */
export function syncProgressFilesParser(text: string): ProgressValue | null {
  const filesMatch = /[Ff]iles\s+(\d+)\s*\/\s*\d+/.exec(text);
  if (filesMatch) return Number.parseInt(filesMatch[1], 10);
  return defaultProgressParser(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll a progress value source at `intervalMs` until `timeoutMs`.
 *
 * Fails when fewer than `minDistinctValues` distinct values are observed
 * (a stall) or if the value ever decreases (non-monotonic regression).
 */
export async function pollHeartbeat(
  getText: () => Promise<string | null | undefined>,
  options: HeartbeatOptions = {},
): Promise<HeartbeatResult> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const parser = options.parser ?? defaultProgressParser;
  const minDistinctValues = options.minDistinctValues ?? DEFAULT_MIN_DISTINCT;
  const message = options.message ?? DEFAULT_MESSAGE;

  const series: ProgressValue[] = [];
  const seen = new Set<ProgressValue>();
  const start = Date.now();

  while (true) {
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) break;

    const raw = await getText().catch(() => null);
    const text = raw ?? null;
    const value = text === null ? null : parser(text);

    if (value !== null && !Number.isNaN(value)) {
      const lastValue = series[series.length - 1];
      if (lastValue !== undefined && value < lastValue) {
        throw new Error(
          `${message} is not monotonic: value regressed from ${lastValue} to ${value}. Series: [${series.join(', ')}]`,
        );
      }
      if (value !== lastValue) {
        series.push(value);
        seen.add(value);
      }
    }

    const remaining = timeoutMs - elapsed;
    const nextInterval = Math.min(intervalMs, remaining);
    if (nextInterval > 0) {
      await sleep(nextInterval);
    }
  }

  if (seen.size < minDistinctValues) {
    throw new Error(
      `${message} stalled: observed only ${seen.size} distinct value(s) in ${timeoutMs}ms (required ${minDistinctValues}). Series: [${series.join(', ')}]`,
    );
  }

  return { series, distinct: Array.from(seen) };
}

/**
 * Playwright-facing wrapper around {@link pollHeartbeat}.
 * Polls a `Locator`'s text content and asserts that it advances in a
 * monotonically non-decreasing way.
 */
export async function assertHeartbeat(
  locator: Locator,
  options: HeartbeatOptions = {},
): Promise<HeartbeatResult> {
  return pollHeartbeat(() => locator.textContent(), options);
}
