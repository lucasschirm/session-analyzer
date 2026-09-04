import { describe, expect, it } from 'vitest';
import {
  filterChangedToolCallStates,
  mergeToolCallStateHashes,
} from '../../src/extractor/tool-call-watermark.js';
import type { DevinToolCallStateRow } from '../../src/extractor/types.js';

function toolCall(overrides: Partial<DevinToolCallStateRow> = {}): DevinToolCallStateRow {
  return {
    row_id: 1,
    session_id: 's1',
    tool_call_id: 'call-1',
    tool_call_json: '{"status":"pending"}',
    tool_call_update_json: null,
    ...overrides,
  };
}

describe('filterChangedToolCallStates', () => {
  it('includes a row never seen before (empty prior hashes)', () => {
    const rows = [toolCall()];
    expect(filterChangedToolCallStates(rows, {})).toEqual(rows);
  });

  it('drops a row whose content is byte-identical to the prior hash, regardless of rowid', () => {
    const first = toolCall({ row_id: 100 });
    const prior = mergeToolCallStateHashes({}, [first]);

    // Same (session_id, tool_call_id), same content, but a DIFFERENT
    // rowid -- reproduces #298's live finding: Devin rewrites a session's
    // tool_call_state rows (delete+reinsert) even when content is
    // unchanged, so rowid alone must never be read as "changed".
    const reinserted = toolCall({ row_id: 103 });
    expect(filterChangedToolCallStates([reinserted], prior)).toEqual([]);
  });

  it('includes a row whose content changed even though its rowid went DOWN relative to the watermark', () => {
    // Reproduces the exact scenario a `rowid > watermark` strategy would
    // silently miss: SQLite can reuse a freed rowid (this table has no
    // AUTOINCREMENT column), so a real content mutation can land at a
    // rowid at or below a previously-recorded high-water mark.
    const first = toolCall({ row_id: 50, tool_call_update_json: null });
    const prior = mergeToolCallStateHashes({}, [first]);

    const mutated = toolCall({ row_id: 1, tool_call_update_json: '{"status":"completed"}' });
    expect(filterChangedToolCallStates([mutated], prior)).toEqual([mutated]);
  });

  it('never confuses two different tool_call_ids, or the same tool_call_id across sessions', () => {
    const a = toolCall({ session_id: 's1', tool_call_id: 'call-1' });
    const b = toolCall({ session_id: 's1', tool_call_id: 'call-2' });
    const c = toolCall({ session_id: 's2', tool_call_id: 'call-1' });
    const prior = mergeToolCallStateHashes({}, [a]);
    expect(filterChangedToolCallStates([a, b, c], prior)).toEqual([b, c]);
  });
});

describe('mergeToolCallStateHashes', () => {
  it('never drops a previously-recorded key when folding in a new (possibly empty) batch', () => {
    const first = mergeToolCallStateHashes({}, [toolCall({ tool_call_id: 'call-1' })]);
    const second = mergeToolCallStateHashes(first, []);
    expect(second).toEqual(first);
  });

  it('updates the hash for a key whose content changed', () => {
    const first = mergeToolCallStateHashes({}, [toolCall({ tool_call_update_json: null })]);
    const second = mergeToolCallStateHashes(first, [
      toolCall({ tool_call_update_json: '{"status":"completed"}' }),
    ]);
    // Deliberately doesn't hardcode the key's internal delimiter — just
    // that there is exactly one entry and its hash changed.
    expect(Object.keys(second)).toEqual(Object.keys(first));
    expect(Object.values(second)[0]).not.toBe(Object.values(first)[0]);
  });
});
