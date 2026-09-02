import { describe, expect, it } from 'vitest';
import { RequestSequenceGuard } from '../../src/pages/portfolio/request-sequence-guard';

describe('RequestSequenceGuard', () => {
  it('treats the first begun token as current', () => {
    const guard = new RequestSequenceGuard();
    const token = guard.begin();
    expect(guard.isCurrent(token)).toBe(true);
  });

  it('invalidates an earlier token once a newer request begins', () => {
    const guard = new RequestSequenceGuard();
    const tokenA = guard.begin();
    const tokenB = guard.begin();

    expect(guard.isCurrent(tokenA)).toBe(false);
    expect(guard.isCurrent(tokenB)).toBe(true);
  });

  /**
   * Proves out-of-order resolution: request A (e.g. a slow 90d query)
   * starts first but resolves *after* request B (a fast 7d query) that
   * started later. Only B's token should be current when both resolve,
   * so A's late response is correctly identified as stale and discarded
   * by the caller.
   */
  it('proves out-of-order resolution — a slow earlier request stays stale', async () => {
    const guard = new RequestSequenceGuard();

    const tokenA = guard.begin(); // slow 90d request starts first
    const slowResponse = new Promise<string>((resolve) => setTimeout(() => resolve('90d'), 20));

    const tokenB = guard.begin(); // fast 7d request starts second
    const fastResponse = Promise.resolve('7d');

    const fastResult = await fastResponse;
    expect(guard.isCurrent(tokenB)).toBe(true);
    // Applying the fast (current) result is correct.
    let applied = fastResult;

    const slowResult = await slowResponse;
    // The slow request's token is no longer current — its result must be
    // discarded, not applied over the fresher one.
    expect(guard.isCurrent(tokenA)).toBe(false);
    if (guard.isCurrent(tokenA)) {
      applied = slowResult;
    }

    expect(applied).toBe('7d');
  });
});
