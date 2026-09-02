/**
 * Stale-response guard for the portfolio view's filter-driven reloads
 * (issue #167). Each call to `load()` issues several parallel queries;
 * without a guard, a slow response for a stale filter selection (e.g. a
 * 90d window issued before the user switched to 7d) could resolve after
 * the newer response and overwrite it with outdated data.
 *
 * Usage: call `begin()` synchronously when a reload starts to obtain a
 * token, await the async work, then check `isCurrent(token)` before
 * applying the results — a `false` result means a newer reload has since
 * started and this response must be discarded.
 */
export class RequestSequenceGuard {
  private current = 0;

  /** Starts a new request generation and returns its token. */
  begin(): number {
    this.current += 1;
    return this.current;
  }

  /** True if `token` is still the most recently started generation. */
  isCurrent(token: number): boolean {
    return token === this.current;
  }
}
