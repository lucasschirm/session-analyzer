// Hoisted to `packages/sync/src/cli/is-main-module.ts` (#354) — this logic
// has zero Claude-specific content, so this file is now a thin re-export
// that preserves the plugin's public import path
// (`../../src/is-main-module.js`, asserted on directly by
// `tests/unit/is-main-module.test.ts`).
export { isMainModule } from '@lucasschirm/sal-sync';
