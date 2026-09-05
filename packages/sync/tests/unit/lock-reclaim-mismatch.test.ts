import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Deterministically forces #327's exact adversarial interleaving, rather
 * than hoping emergent `Promise.all` scheduling reproduces it: contender B
 * reads a stale (dead-PID) lock, but is suspended (via a controlled gate on
 * `fsp.readFile`) before it acts on that reading; contender A, meanwhile,
 * runs its entire reclaim-and-recreate cycle to completion; only then is B
 * released to act on the now-outdated snapshot it captured earlier.
 *
 * This is not a hypothetical worry: `unit/lock-stale-takeover.test.ts`'s
 * black-box stress test (N contenders racing via real `Promise.all`
 * scheduling) was empirically checked against the pre-fix code at up to 100
 * concurrent contenders x thousands of iterations and never reproduced the
 * bug on this system/Node version — real fs-threadpool timing here doesn't
 * naturally land in the few-microsecond window the race needs. A
 * deterministic, controlled-interleaving test is the only reliable way to
 * exercise this exact path, and is what actually caught that a first-draft
 * fix using a plain `rename`-back restore (instead of `link`) would let B's
 * backoff silently clobber a live lock a third contender had since created
 * — see `restoreClaim`'s doc comment in `lock.ts`.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile), link: vi.fn(actual.link) };
});

const { FileLock } = await import('../../src/index.js');
const fsp = await import('node:fs/promises');
// `vi.mock` above hoists and intercepts every import of this specifier in
// this file, so a plain `import * as fspReal from 'node:fs/promises'` would
// also resolve to the mock (and, if used as a mock implementation, recurse
// into itself). `vi.importActual` is the supported way to reach the true,
// unmocked module regardless.
const fspReal = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

describe('FileLock stale-takeover: deterministic outdated-snapshot interleaving (#327)', () => {
  let tempDir: string;
  let lockFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-lock-mismatch-'));
    lockFile = path.join(tempDir, 'test.lock');
    vi.mocked(fsp.readFile).mockImplementation(fspReal.readFile);
    vi.mocked(fsp.link).mockImplementation(fspReal.link);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.mocked(fsp.readFile).mockReset();
    vi.mocked(fsp.link).mockReset();
  });

  /**
   * Makes the first `readFile` call against `lockFile` capture its result
   * immediately (a faithful "read the stale state now") but not resolve
   * until `release()` is called on the returned controller — simulating a
   * contender suspended by the scheduler between observing stale state and
   * acting on it.
   */
  function interceptFirstStaleRead(): { released: Promise<void>; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let intercepted = false;

    vi.mocked(fsp.readFile).mockImplementation(async (...args) => {
      const [target] = args;
      if (target === lockFile && !intercepted) {
        intercepted = true;
        const captured = await fspReal.readFile(...(args as Parameters<typeof fspReal.readFile>));
        await gate;
        return captured;
      }
      return fspReal.readFile(...(args as Parameters<typeof fspReal.readFile>));
    });

    return { released: gate, release };
  }

  it("a contender's outdated stale-snapshot never clobbers a lock created after it read that snapshot", async () => {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999_999, startedAt: Date.now() - 10_000 }));

    const { release } = interceptFirstStaleRead();
    const lockB = new FileLock(lockFile, { pollIntervalMs: 5, acquireTimeoutMs: 1000 });
    const bAcquire = lockB.acquire().catch((err: unknown) => err);

    // Wait until B has actually issued its (now-paused) stale read before
    // starting A, so ordering is deterministic rather than assumed.
    await vi.waitFor(() => expect(vi.mocked(fsp.readFile)).toHaveBeenCalled());

    const lockA = new FileLock(lockFile, { pollIntervalMs: 5, acquireTimeoutMs: 1000 });
    await lockA.acquire();
    const contentAfterA = fs.readFileSync(lockFile, 'utf8');
    expect(JSON.parse(contentAfterA).pid).toBe(process.pid);

    // Only now does B's outdated snapshot get delivered to it. A never
    // releases before this point, so the only correct outcome is B
    // eventually losing/timing out on its own -- never silently
    // succeeding, and never disturbing A's live lock in the process.
    release();
    const bResult = await bAcquire;

    expect(
      bResult,
      'a second contender must never silently succeed against an outdated stale snapshot while the first still holds the lock',
    ).toBeInstanceOf(Error);
    expect(
      fs.readFileSync(lockFile, 'utf8'),
      "A's live lock content must survive B's failed takeover attempt untouched",
    ).toBe(contentAfterA);

    await lockA.release();
  }, 10_000);

  it('a restore failure that is NOT "path already re-occupied" fails loudly instead of discarding the live lock content (#327)', async () => {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999_999, startedAt: Date.now() - 10_000 }));

    const { release } = interceptFirstStaleRead();
    const lockB = new FileLock(lockFile, { pollIntervalMs: 5, acquireTimeoutMs: 1000 });
    const bAcquire = lockB.acquire().catch((err: unknown) => err);

    await vi.waitFor(() => expect(vi.mocked(fsp.readFile)).toHaveBeenCalled());

    const lockA = new FileLock(lockFile, { pollIntervalMs: 5, acquireTimeoutMs: 1000 });
    await lockA.acquire();
    const contentAfterA = fs.readFileSync(lockFile, 'utf8');

    // Once B's rename-aside has claimed A's live lock (a mismatch it must
    // then try to restore), force the restore's `link` call to fail for a
    // reason that is NOT "the path was legitimately re-occupied" -- e.g. a
    // permission error -- rather than the expected EEXIST.
    vi.mocked(fsp.link).mockImplementation(async () => {
      const err = new Error('EACCES: permission denied, link') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    });

    release();
    const bResult = (await bAcquire) as Error;

    expect(
      bResult,
      'a non-EEXIST restore failure must propagate, not resolve as success',
    ).toBeInstanceOf(Error);
    expect(bResult.message).toContain('Failed to restore lock');

    // The live content renamed aside during B's takeover attempt must
    // still exist somewhere, unharmed -- a failed restore must never
    // silently discard the only remaining copy of a live holder's lock.
    const claimFiles = fs
      .readdirSync(tempDir)
      .filter((name) => name.startsWith('test.lock.stale-'));
    expect(
      claimFiles,
      'the claim file holding the live lock content must survive a failed restore',
    ).toHaveLength(1);
    expect(fs.readFileSync(path.join(tempDir, claimFiles[0]), 'utf8')).toBe(contentAfterA);
  }, 10_000);
});
