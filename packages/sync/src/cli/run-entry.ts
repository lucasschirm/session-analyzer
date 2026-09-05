import process from 'node:process';

import { main } from './run.js';

/**
 * Standalone entry script for running the generic `sal-sync` command
 * dispatcher as its own process.
 *
 * This file is deliberately NOT re-exported from `./index.js` or the
 * package barrel (`../index.js`). It exists only to be invoked directly
 * via `node <path-to-compiled-file> <command> [...args]`, so it can run
 * unconditionally with no `import.meta.url`/`process.argv[1]` identity
 * check — see `watch-entry.ts` for why that check is unreliable once code
 * is bundled as a library import. Because this script is never imported by
 * anything else, it has no "library" mode to protect against.
 */
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  () => process.exit(1),
);
