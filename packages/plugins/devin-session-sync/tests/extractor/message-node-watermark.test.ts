import { describe, expect, it } from 'vitest';
import {
  filterChangedMessageNodes,
  mergeMessageNodeHashes,
} from '../../src/extractor/message-node-watermark.js';
import type { DevinMessageNodeRow } from '../../src/extractor/types.js';

function messageNode(overrides: Partial<DevinMessageNodeRow> = {}): DevinMessageNodeRow {
  return {
    row_id: 1,
    session_id: 's1',
    node_id: 1,
    parent_node_id: null,
    chat_message: '{"role":"user","content":"hi"}',
    created_at: 1_700_000_000,
    metadata: null,
    ...overrides,
  };
}

describe('filterChangedMessageNodes', () => {
  it('includes a row never seen before (empty prior hashes)', () => {
    const rows = [messageNode()];
    expect(filterChangedMessageNodes(rows, {})).toEqual(rows);
  });

  it('drops a row whose content is byte-identical to the prior hash, regardless of row_id (core churn regression, #341)', () => {
    const first = messageNode({ row_id: 100 });
    const prior = mergeMessageNodeHashes({}, [first]);

    // Same (session_id, node_id), same content, but a DIFFERENT row_id --
    // reproduces #341's live finding: Devin deletes and reinserts a
    // session's entire message_nodes forest (delete+reinsert) even when
    // content is unchanged, so row_id alone must never be read as
    // "changed". This is the exact scenario that made the old
    // row_id-watermark re-append a session's whole history on every pass.
    const reinserted = messageNode({ row_id: 250 });
    expect(filterChangedMessageNodes([reinserted], prior)).toEqual([]);
  });

  it('includes a row whose content changed even at the SAME row_id (in-place-update gap, #341 AC2)', () => {
    const first = messageNode({ row_id: 50, chat_message: '{"role":"user","content":"draft"}' });
    const prior = mergeMessageNodeHashes({}, [first]);

    const mutated = messageNode({ row_id: 50, chat_message: '{"role":"user","content":"final"}' });
    expect(filterChangedMessageNodes([mutated], prior)).toEqual([mutated]);
  });

  it('includes a row whose content changed even though its row_id went DOWN relative to the watermark', () => {
    // Defensive robustness guard at the pure-function level: this module
    // must never rely on row_id direction at all, only on content
    // identity. Unlike tool_call_state's implicit (AUTOINCREMENT-free,
    // reusable) rowid, message_nodes' row_id IS a real AUTOINCREMENT
    // column that SQLite never reuses or reassigns downward in practice
    // (see reader.test.ts's "fresh, higher row_id" test for the realistic
    // shape of #341's churn) -- but `filterChangedMessageNodes` itself
    // makes no such assumption, so this proves it independently of that
    // guarantee.
    const first = messageNode({ row_id: 500, chat_message: '{"role":"user","content":"v1"}' });
    const prior = mergeMessageNodeHashes({}, [first]);

    const mutated = messageNode({ row_id: 3, chat_message: '{"role":"user","content":"v2"}' });
    expect(filterChangedMessageNodes([mutated], prior)).toEqual([mutated]);
  });

  it('never confuses two different node_ids, or the same node_id across sessions (hash-collision guard)', () => {
    const a = messageNode({ session_id: 's1', node_id: 1 });
    const b = messageNode({ session_id: 's1', node_id: 2 });
    const c = messageNode({ session_id: 's2', node_id: 1 });
    const prior = mergeMessageNodeHashes({}, [a]);
    expect(filterChangedMessageNodes([a, b, c], prior)).toEqual([b, c]);
  });

  it('does NOT trigger re-emission when only created_at differs (the deliberate exclusion, #341)', () => {
    // created_at is shared across every row of a session and stamped fresh
    // on every wholesale rewrite (DevinMessageNodeRow's own doc comment) --
    // if the hash included it, this test would fail because every row
    // would look "changed" on every pass, reproducing the exact bug this
    // issue fixes. This is the single most important guard in this file.
    const first = messageNode({ row_id: 10, created_at: 1_700_000_000 });
    const prior = mergeMessageNodeHashes({}, [first]);

    const rewritten = messageNode({ row_id: 999, created_at: 1_800_000_000 });
    expect(filterChangedMessageNodes([rewritten], prior)).toEqual([]);
  });
});

describe('mergeMessageNodeHashes', () => {
  it('never drops a previously-recorded key when folding in a new (possibly empty) batch', () => {
    const first = mergeMessageNodeHashes({}, [messageNode({ node_id: 1 })]);
    const second = mergeMessageNodeHashes(first, []);
    expect(second).toEqual(first);
  });

  it('updates the hash for a key whose content changed', () => {
    const first = mergeMessageNodeHashes({}, [
      messageNode({ chat_message: '{"role":"user","content":"v1"}' }),
    ]);
    const second = mergeMessageNodeHashes(first, [
      messageNode({ chat_message: '{"role":"user","content":"v2"}' }),
    ]);
    // Deliberately doesn't hardcode the key's internal delimiter -- just
    // that there is exactly one entry and its hash changed.
    expect(Object.keys(second)).toEqual(Object.keys(first));
    expect(Object.values(second)[0]).not.toBe(Object.values(first)[0]);
  });

  it('keeps the hash stable across a created_at-only change (round-trips with the filter guard above)', () => {
    const first = mergeMessageNodeHashes({}, [messageNode({ created_at: 1 })]);
    const second = mergeMessageNodeHashes(first, [messageNode({ created_at: 2 })]);
    expect(second).toEqual(first);
  });
});
