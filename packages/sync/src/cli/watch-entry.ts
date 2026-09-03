import process from 'node:process';

import { watch } from './watch.js';

/**
 * Standalone entry script for running the watcher as its own process.
 *
 * This file is deliberately NOT re-exported from `./index.js` or the
 * package barrel (`../index.js`). It exists only to be invoked directly
 * via `node <path-to-compiled-file> [...args]` (see
 * `defaultSpawnWatcher`/`getWatchScriptPath` in `common.ts`), so it can run
 * unconditionally with no `import.meta.url`/`process.argv[1]` identity
 * check: bundlers collapse every merged module's `import.meta.url` to the
 * bundle's own URL, which makes that kind of guard fire spuriously once
 * this code is pulled into another package's bundle as a library import.
 * Because this script is never imported by anything else, it has no
 * "library" mode to protect against — it only ever runs as a process.
 */
watch({ argv: process.argv.slice(2) }).then(
  (result) => process.exit(result.exitCode),
  () => process.exit(1),
);
