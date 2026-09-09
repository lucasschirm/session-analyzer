import { describe, expect, it } from 'vitest';
import { parseSchemaDescriptor } from './parse.js';

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    devinCliVersion: '3000.6.7',
    refineryVersion: 16,
    refineryMigrations: [
      { version: 1, name: 'init', appliedOn: '2026-01-01T00:00:00Z', checksum: 'abc' },
    ],
    tableChecksums: { sessions: 'sha-1', tool_call_state: null },
    supported: true,
    warnings: [],
    ...overrides,
  };
}

describe('parseSchemaDescriptor', () => {
  it('extracts devin CLI version, refinery history, and table checksums', () => {
    const result = parseSchemaDescriptor(descriptor());
    expect(result).toEqual(descriptor());
  });

  it('nulls devinCliVersion when unknown, never a placeholder string', () => {
    const result = parseSchemaDescriptor(descriptor({ devinCliVersion: null }));
    expect(result?.devinCliVersion).toBeNull();
  });

  it('defaults refineryMigrations to an empty array when absent', () => {
    const { refineryMigrations: _refineryMigrations, ...rest } = descriptor();
    const result = parseSchemaDescriptor(rest);
    expect(result?.refineryMigrations).toEqual([]);
  });

  it('drops a malformed migration entry without throwing', () => {
    const result = parseSchemaDescriptor(
      descriptor({ refineryMigrations: [{ version: 1 }, descriptor().refineryMigrations[0]] }),
    );
    expect(result?.refineryMigrations).toHaveLength(1);
  });

  it('defaults tableChecksums to an empty object when absent', () => {
    const { tableChecksums: _tableChecksums, ...rest } = descriptor();
    const result = parseSchemaDescriptor(rest);
    expect(result?.tableChecksums).toEqual({});
  });

  it('preserves a null table checksum for an absent table', () => {
    const result = parseSchemaDescriptor(descriptor());
    expect(result?.tableChecksums.tool_call_state).toBeNull();
  });

  it('preserves the supported/degraded flag and warnings', () => {
    const result = parseSchemaDescriptor(
      descriptor({ supported: false, warnings: ['unknown refinery version 99'] }),
    );
    expect(result).toMatchObject({ supported: false, warnings: ['unknown refinery version 99'] });
  });

  it('returns null for non-object input without throwing', () => {
    expect(() => parseSchemaDescriptor(null)).not.toThrow();
    expect(parseSchemaDescriptor(null)).toBeNull();
    expect(parseSchemaDescriptor('a string')).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    const { refineryVersion: _refineryVersion, ...rest } = descriptor();
    expect(parseSchemaDescriptor(rest)).toBeNull();
  });
});
