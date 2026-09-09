import { describe, expect, it } from 'vitest';
import {
  detectUnknownColumns,
  KNOWN_REFINERY_VERSION,
  KNOWN_TABLE_COLUMNS,
  knownColumnsFor,
  resolveDevinSchema,
} from '../../src/extractor/schema-registry.js';

describe('resolveDevinSchema', () => {
  it('resolves the known version (16) as supported with the full table list', () => {
    const resolution = resolveDevinSchema(KNOWN_REFINERY_VERSION);
    expect(resolution.supported).toBe(true);
    expect(resolution.warnings).toEqual([]);
    expect(resolution.knownTables.sort()).toEqual(Object.keys(KNOWN_TABLE_COLUMNS).sort());
  });

  it('resolves an unrecognized newer version in degraded mode with warnings', () => {
    const resolution = resolveDevinSchema(KNOWN_REFINERY_VERSION + 1);
    expect(resolution.supported).toBe(false);
    expect(resolution.warnings.length).toBeGreaterThan(0);
    expect(resolution.warnings[0]).toContain('newer');
    expect(resolution.knownTables).not.toContain('tool_call_state');
  });

  it('resolves an unrecognized older version in degraded mode with warnings', () => {
    const resolution = resolveDevinSchema(1);
    expect(resolution.supported).toBe(false);
    expect(resolution.warnings[0]).toContain('older');
  });

  it('degraded mode uses a reduced known-table set relative to supported mode', () => {
    const supported = resolveDevinSchema(KNOWN_REFINERY_VERSION);
    const degraded = resolveDevinSchema(999);
    expect(degraded.knownTables.length).toBeLessThan(supported.knownTables.length);
  });

  it('never throws, even for pathological version values', () => {
    for (const version of [0, -1, Number.MAX_SAFE_INTEGER]) {
      expect(() => resolveDevinSchema(version)).not.toThrow();
    }
  });
});

describe('knownColumnsFor', () => {
  it('returns the full column list for a known table under a supported resolution', () => {
    const resolution = resolveDevinSchema(KNOWN_REFINERY_VERSION);
    expect(knownColumnsFor('sessions', resolution)).toEqual(KNOWN_TABLE_COLUMNS.sessions);
  });

  it('returns an empty list for a table dropped in degraded mode', () => {
    const resolution = resolveDevinSchema(999);
    expect(knownColumnsFor('tool_call_state', resolution)).toEqual([]);
  });

  it('returns an empty list for a table the registry has never heard of', () => {
    const resolution = resolveDevinSchema(KNOWN_REFINERY_VERSION);
    expect(knownColumnsFor('not_a_real_table', resolution)).toEqual([]);
  });
});

describe('detectUnknownColumns', () => {
  it('flags the real, confirmed sessions.shell_last_seen_index gap (#298)', () => {
    const realColumns = [...KNOWN_TABLE_COLUMNS.sessions, 'shell_last_seen_index'];
    expect(detectUnknownColumns('sessions', realColumns)).toEqual(['shell_last_seen_index']);
  });

  it('returns empty when every real column is already known', () => {
    expect(detectUnknownColumns('sessions', KNOWN_TABLE_COLUMNS.sessions)).toEqual([]);
  });

  it('never affects what reader.ts reads — informational only, never a filter', () => {
    // KNOWN_TABLE_COLUMNS itself has no bearing on detectUnknownColumns's
    // own output beyond the diff; this asserts the diff direction is
    // "real minus known", not the reverse (which would instead flag
    // columns reader.ts no longer needs to worry about).
    const missingFromReal = KNOWN_TABLE_COLUMNS.sessions.slice(0, -1);
    expect(detectUnknownColumns('sessions', missingFromReal)).toEqual([]);
  });

  it('treats a table the registry has never heard of as all-unknown', () => {
    expect(detectUnknownColumns('not_a_real_table', ['a', 'b'])).toEqual(['a', 'b']);
  });
});
