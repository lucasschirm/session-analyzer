import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { FileLock } from '../../src/index.js';

/**
 * Stress-reproduces #327: two or more contenders racing a stale (dead-PID)
 * lock must never both believe they hold it. This is deliberately a
 * separate file from `unit/state.test.ts`'s `FileLock` block — that block's
 * only concurrency case (`'serializes concurrent withLock calls in the same
 * process'`) drives everything through `withLock()`, which always
 * serializes same-path callers through the static in-process `localQueues`
 * map *before* `acquire()` ever runs. Same-process contenders driven
 * through `withLock()` would therefore never reach, let alone race, the
 * `EEXIST`/stale-takeover branch this issue is about. Racing the actual bug
 * requires calling `.acquire()` directly on distinct `FileLock` instances,
 * which is exactly what `raceOnce` below does.
 *
 * Default iteration count matches the original finding's reproduction
 * scale (300) and runs on every `pnpm test`/CI pass in a few seconds. The
 * acceptance criterion's 10,000-iteration check is an explicit, opt-in
 * pre-PR verification step, not a default CI gate:
 *
 *   SAL_LOCK_STRESS_ITERATIONS=10000 pnpm --filter @lucasschirm/sal-sync \
 *     exec vitest run tests/unit/lock-stale-takeover.test.ts
 */
const DEFAULT_ITERATIONS = 300;
const STRESS_ITERATIONS = Number(process.env.SAL_LOCK_STRESS_ITERATIONS ?? DEFAULT_ITERATIONS);
const CONTENDERS_PER_TAKEOVER = 5;
const DEAD_PID = 999_999;

let tempDir: string;
let lockPath: string;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-lock-stale-takeover-'));
  lockPath = path.join(tempDir, 'test.lock');
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * One contender's full acquire/release cycle, reporting the concurrent
 * holder count immediately after `acquire()` resolves (via `onPeak`) and
 * again just before `release()`. The `Promise.resolve()` microtask yield
 * between increment and decrement widens the window in which a second,
 * incorrectly-successful acquirer would be visible.
 */
async function raceOnce(
  lock: FileLock,
  holders: { current: number },
  onPeak: (n: number) => void,
): Promise<void> {
  await lock.acquire();
  holders.current += 1;
  onPeak(holders.current);
  await Promise.resolve();
  holders.current -= 1;
  await lock.release();
}

async function plantStaleLock(): Promise<void> {
  await fsp.writeFile(lockPath, JSON.stringify({ pid: DEAD_PID, startedAt: Date.now() - 10_000 }));
}

async function raceOneTakeover(
  holders: { current: number },
  onPeak: (n: number) => void,
): Promise<void> {
  await plantStaleLock();
  const contenders = Array.from(
    { length: CONTENDERS_PER_TAKEOVER },
    () => new FileLock(lockPath, { pollIntervalMs: 1, acquireTimeoutMs: 2000 }),
  );
  await Promise.all(contenders.map((lock) => raceOnce(lock, holders, onPeak)));
}

it(`never allows more than one concurrent holder across ${STRESS_ITERATIONS} stale-lock takeovers`, async () => {
  let maxConcurrentHolders = 0;
  const holders = { current: 0 };
  const onPeak = (n: number) => {
    maxConcurrentHolders = Math.max(maxConcurrentHolders, n);
  };

  for (let i = 0; i < STRESS_ITERATIONS; i += 1) {
    await raceOneTakeover(holders, onPeak);
  }

  expect(maxConcurrentHolders).toBe(1);
  expect(fs.existsSync(lockPath)).toBe(false);
}, 300_000);
