import { describe, expect, it } from 'vitest';
import { parseDevinCogsJson } from './parse-cogs.js';

function cog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: { Session: 'Hook' },
    lifetime: { Unique: 'skill/add-e2e-test' },
    set_system_prefix: null,
    append_system_messages: [],
    context: [],
    footer_messages: [],
    user_display: [],
    permissions: [],
    tool_availability: null,
    model: null,
    ...overrides,
  };
}

describe('parseDevinCogsJson — top-level tolerance', () => {
  it('returns empty cogs and no warnings for null input', () => {
    expect(parseDevinCogsJson(null)).toEqual({ cogs: [], warnings: [] });
  });

  it('returns empty cogs and a warning for invalid JSON, never throws', () => {
    expect(() => parseDevinCogsJson('{not json')).not.toThrow();
    const result = parseDevinCogsJson('{not json');
    expect(result.cogs).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('returns empty cogs and a warning for a non-array root', () => {
    const result = parseDevinCogsJson(JSON.stringify({ not: 'an array' }));
    expect(result.cogs).toEqual([]);
    expect(result.warnings).toEqual(['cogs_json root is not an array']);
  });

  it('skips a malformed individual cog without dropping the rest of the array', () => {
    const result = parseDevinCogsJson(
      JSON.stringify([cog({ lifetime: { Unique: 'core/model' } }), { garbage: true }]),
    );
    expect(result.cogs).toHaveLength(1);
    expect(result.cogs[0].lifetime.unique).toBe('core/model');
    expect(result.warnings).toEqual(['skipped malformed cog entry at index 1']);
  });
});

describe('parseDevinCogsJson — lifetime', () => {
  it('splits lifetime.Unique into namespace/name', () => {
    const result = parseDevinCogsJson(
      JSON.stringify([cog({ lifetime: { Unique: 'skill/pr-review' } })]),
    );
    expect(result.cogs[0].lifetime).toEqual({
      unique: 'skill/pr-review',
      namespace: 'skill',
      name: 'pr-review',
    });
  });
});

describe('parseDevinCogsJson — source (5 variants)', () => {
  it.each([
    { Session: 'Hook' },
    { Session: 'User' },
    { Session: 'System' },
    'Base',
    'Managed',
    'SubagentDefault',
  ])('preserves source %j verbatim', (source) => {
    const result = parseDevinCogsJson(JSON.stringify([cog({ source })]));
    expect(result.cogs[0].source).toEqual(source);
  });
});

describe('parseDevinCogsJson — tool_availability', () => {
  it('parses an AllowList with both Name entry forms', () => {
    const raw = [
      cog({
        lifetime: { Unique: 'core/model' },
        tool_availability: {
          AllowList: [{ Name: { exact: 'mcp_call_tool' } }, { Name: { literal: 'read' } }],
        },
      }),
    ];
    const result = parseDevinCogsJson(JSON.stringify(raw));
    expect(result.cogs[0].toolAvailability).toEqual({
      mode: 'allow',
      names: ['mcp_call_tool', 'read'],
    });
  });

  it('parses a BlockList', () => {
    const raw = [
      cog({
        lifetime: { Unique: 'local_fusion/lead_framing' },
        tool_availability: { BlockList: [{ Name: { exact: 'sidekick' } }] },
      }),
    ];
    const result = parseDevinCogsJson(JSON.stringify(raw));
    expect(result.cogs[0].toolAvailability).toEqual({ mode: 'block', names: ['sidekick'] });
  });

  it('returns undefined (never a zero-valued object) when tool_availability is null', () => {
    const result = parseDevinCogsJson(JSON.stringify([cog({ tool_availability: null })]));
    expect(result.cogs[0].toolAvailability).toBeUndefined();
  });
});

describe('parseDevinCogsJson — permission target variants (5 shapes)', () => {
  it('parses a Tool/Kind target', () => {
    const raw = [cog({ permissions: [[{ Tool: { Kind: 'read' } }, 'Allow']] })];
    const result = parseDevinCogsJson(JSON.stringify(raw));
    expect(result.cogs[0].permissions).toEqual([
      { target: { kind: 'tool_kind', toolKind: 'read' }, action: 'Allow' },
    ]);
  });

  it('parses a Tool/Name target', () => {
    const raw = [cog({ permissions: [[{ Tool: { Name: { exact: 'grep' } } }, 'Allow']] })];
    const result = parseDevinCogsJson(JSON.stringify(raw));
    expect(result.cogs[0].permissions).toEqual([
      { target: { kind: 'tool_name', toolName: 'grep' }, action: 'Allow' },
    ]);
  });

  it('parses a Scope/Read target', () => {
    const raw = [cog({ permissions: [[{ Scope: { Read: { glob: 'src/**' } } }, 'ForceAsk']] })];
    const result = parseDevinCogsJson(JSON.stringify(raw));
    expect(result.cogs[0].permissions).toEqual([
      { target: { kind: 'scope_read', glob: 'src/**' }, action: 'ForceAsk' },
    ]);
  });

  it('parses a Scope/Write target', () => {
    const raw = [cog({ permissions: [[{ Scope: { Write: { glob: 'dist/**' } } }, 'Allow']] })];
    const result = parseDevinCogsJson(JSON.stringify(raw));
    expect(result.cogs[0].permissions).toEqual([
      { target: { kind: 'scope_write', glob: 'dist/**' }, action: 'Allow' },
    ]);
  });

  it('parses the bare "AnyScope" target', () => {
    const raw = [cog({ permissions: [['AnyScope', 'Allow']] })];
    const result = parseDevinCogsJson(JSON.stringify(raw));
    expect(result.cogs[0].permissions).toEqual([
      { target: { kind: 'any_scope' }, action: 'Allow' },
    ]);
  });

  it('falls back to unknown for an unrecognized target shape, preserving the raw value', () => {
    const raw = [cog({ permissions: [[{ Weird: true }, 'Allow']] })];
    const result = parseDevinCogsJson(JSON.stringify(raw));
    expect(result.cogs[0].permissions).toEqual([
      { target: { kind: 'unknown', raw: { Weird: true } }, action: 'Allow' },
    ]);
  });
});

describe('parseDevinCogsJson — model', () => {
  it('preserves a string model', () => {
    const result = parseDevinCogsJson(JSON.stringify([cog({ model: 'devin-default' })]));
    expect(result.cogs[0].model).toBe('devin-default');
  });

  it('defaults to null when model is absent', () => {
    const raw = cog();
    delete raw.model;
    const result = parseDevinCogsJson(JSON.stringify([raw]));
    expect(result.cogs[0].model).toBeNull();
  });
});
