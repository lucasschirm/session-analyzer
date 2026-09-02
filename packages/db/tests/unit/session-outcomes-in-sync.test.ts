import { SESSION_OUTCOMES as DB_CORE_SESSION_OUTCOMES } from '@lucasschirm/sal-db-core';
import { SESSION_OUTCOMES as TRANSFORMER_SESSION_OUTCOMES } from '@lucasschirm/sal-transformer';
import { describe, expect, it } from 'vitest';

/**
 * `packages/transformer/src/session.ts`'s `SESSION_OUTCOMES` and
 * `packages/db-core/src/session-evidence.ts`'s `SESSION_OUTCOMES` are
 * deliberately independent literal arrays (transformers never depend on
 * `db-core`, per `.agents/rules/transformers-never-write-sqlite.md`, so
 * there is no single shared source of truth to import from). `packages/db`
 * depends on both, so it is the one package positioned to catch drift
 * between them before it reaches production — a value the transformer
 * classifies but the `sessions.outcome` CHECK constraint doesn't recognize
 * (or vice versa) would otherwise fail silently at ingestion time.
 */
describe('SESSION_OUTCOMES stays in sync between transformer and db-core', () => {
  it('has identical, identically-ordered values in both packages', () => {
    expect(TRANSFORMER_SESSION_OUTCOMES).toEqual(DB_CORE_SESSION_OUTCOMES);
  });
});
