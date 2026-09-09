// Cross-process FileLock contender, forked by
// `../lock-cross-process.test.ts`. Plain JS (not TS): this worker imports
// the package's *built* output (`dist/index.js`), the same thing every real
// hook/watcher process runs against — never raw TS source — which is both
// the most faithful simulation available and sidesteps a real
// incompatibility: forking a `.ts` file directly would hit Node's native
// TypeScript type-stripping on `SyncStateError`'s constructor parameter
// properties (`public readonly code: ...`), a construct type-stripping-only
// mode rejects because it has runtime semantics, not just a type
// annotation to erase.
import { appendFile, readFile } from 'node:fs/promises';
import { FileLock } from '../../../dist/index.js';

const [, , lockPath, dataPath] = process.argv;
const lock = new FileLock(lockPath, { pollIntervalMs: 10, acquireTimeoutMs: 5000 });

async function readExistingLines() {
  try {
    return (await readFile(dataPath, 'utf8')).split('\n').filter(Boolean);
  } catch {
    return []; // first writer: the data file does not exist yet
  }
}

try {
  await lock.withLock(async () => {
    const existingLines = await readExistingLines();
    const seq = existingLines.length;
    // Widen the read-then-write race window so a broken lock deterministically
    // produces a duplicate `seq` instead of only rarely, mirroring the real
    // `materializeSessionTranscript` read-derive-append shape this test
    // stands in for (packages/plugins/devin-session-sync/src/session-sync.ts).
    await new Promise((resolve) => setTimeout(resolve, 50));
    await appendFile(dataPath, `${JSON.stringify({ pid: process.pid, seq })}\n`);
  });
  process.send?.({ ok: true, pid: process.pid });
} catch (err) {
  process.send?.({ ok: false, pid: process.pid, message: String(err?.message ?? err) });
} finally {
  process.exit(0);
}
