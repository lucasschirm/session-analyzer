import { describe, expect, it } from 'vitest';

import {
  buildObjectKey,
  CAS_NAMESPACE_ROOT,
  CAS_PREFIX,
  parseObjectKey,
  StorageError,
  type StorageObjectScope,
} from '../../src/index.js';

describe('buildObjectKey', () => {
  it('places the manifest at the session root', () => {
    expect(
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'manifest',
        relativePath: 'manifest.json',
      }),
    ).toBe('p/s/manifest.json');
  });

  it('builds session artifact keys without a scope segment', () => {
    expect(
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'session',
        relativePath: 'transcript.jsonl',
      }),
    ).toBe('p/s/transcript.jsonl');
  });

  it('builds workspace artifact keys as global/cas/<hash>', () => {
    const hash = 'a'.repeat(64);
    expect(
      buildObjectKey({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        scope: 'workspace',
        relativePath: '.claude/settings.json',
        contentSha256: hash,
      }),
    ).toBe(`global/cas/${hash}`);
  });

  it('builds global artifact keys as global/cas/<hash>', () => {
    const hash = 'b'.repeat(64);
    expect(
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'global',
        relativePath: '~/.claude/settings.json',
        contentSha256: hash,
      }),
    ).toBe(`global/cas/${hash}`);
  });

  it('builds runtime artifact keys', () => {
    expect(
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'runtime',
        relativePath: 'telemetry.json',
      }),
    ).toBe('p/s/runtime/telemetry.json');
  });

  it('encodes project and session identifiers', () => {
    expect(
      buildObjectKey({
        projectId: 'my project',
        sessionId: 'sess:1',
        scope: 'session',
        relativePath: 'file.json',
      }),
    ).toBe('my%20project/sess%3A1/file.json');
  });

  it('encodes special characters in path segments', () => {
    expect(
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'session',
        relativePath: 'foo bar/baz:qux',
      }),
    ).toBe('p/s/foo%20bar/baz%3Aqux');
  });

  it('encodes Unicode path segments', () => {
    expect(
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'session',
        relativePath: 'café/emoji',
      }),
    ).toBe('p/s/caf%C3%A9/emoji');
  });

  it('pins Buffer and TextEncoder UTF-8 byte length equivalence', () => {
    const x = 'café/?a&b=c 🎉';
    expect(Buffer.byteLength(x, 'utf8')).toBe(new TextEncoder().encode(x).length);
  });

  it('encodes URL-unsafe path segments', () => {
    expect(
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'session',
        relativePath: 'a?b&c=d',
      }),
    ).toBe('p/s/a%3Fb%26c%3Dd');
  });

  it('collapses and normalizes slashes and backslashes', () => {
    expect(
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'session',
        relativePath: 'a\\b//c',
      }),
    ).toBe('p/s/a/b/c');
  });

  it('strips leading and trailing slashes', () => {
    expect(
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'session',
        relativePath: './.claude/settings.json/',
      }),
    ).toBe('p/s/.claude/settings.json');
  });

  it('rejects absolute unix paths', () => {
    expect(() =>
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'session',
        relativePath: '/etc/passwd',
        body: new Uint8Array(),
      }),
    ).toThrow(StorageError);
  });

  it('rejects absolute windows paths', () => {
    expect(() =>
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'session',
        relativePath: 'C:\\Users\\x\\y',
        body: new Uint8Array(),
      }),
    ).toThrow(StorageError);
  });

  it('rejects parent directory traversal', () => {
    expect(() =>
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'session',
        relativePath: 'foo/../../bar',
        body: new Uint8Array(),
      }),
    ).toThrow(StorageError);
  });

  it('rejects empty relativePath', () => {
    expect(() =>
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'session',
        relativePath: '',
        body: new Uint8Array(),
      }),
    ).toThrow(StorageError);
  });

  it('rejects unsupported scopes', () => {
    expect(() =>
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'unknown' as StorageObjectScope,
        relativePath: 'file.txt',
        body: new Uint8Array(),
      }),
    ).toThrow(StorageError);
  });

  it('rejects missing contentSha256 for workspace scope', () => {
    expect(() =>
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'workspace',
        relativePath: 'file.txt',
        body: new Uint8Array(),
      }),
    ).toThrow(StorageError);
  });

  it('rejects missing contentSha256 for global scope', () => {
    expect(() =>
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'global',
        relativePath: 'file.txt',
        body: new Uint8Array(),
      }),
    ).toThrow(StorageError);
  });

  it('rejects keys that exceed S3 maximum length', () => {
    const longProjectId = 'a'.repeat(1024);
    expect(() =>
      buildObjectKey({
        projectId: longProjectId,
        sessionId: 's',
        scope: 'session',
        relativePath: 'file.txt',
        body: new Uint8Array(),
      }),
    ).toThrow(StorageError);
  });

  it('preserves the 1024-byte boundary with a key that is exactly the limit', () => {
    // 'p/s/' is 4 ASCII bytes; pad the remainder to 1024 bytes with
    // unencoded ASCII so the final key length is exactly the S3 limit.
    const segment = 'a'.repeat(1024 - 4);
    const key = buildObjectKey({
      projectId: 'p',
      sessionId: 's',
      scope: 'session',
      relativePath: segment,
    });
    expect(new TextEncoder().encode(key).length).toBe(1024);
  });

  it('rejects keys one byte over the 1024-byte boundary', () => {
    const segment = 'a'.repeat(1024 - 4 + 1);
    expect(() =>
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'session',
        relativePath: segment,
      }),
    ).toThrow(StorageError);
  });

  it('never produces keys containing absolute path markers', () => {
    const scopes: StorageObjectScope[] = ['session', 'workspace', 'global', 'runtime', 'manifest'];
    for (const scope of scopes) {
      const relativePath = scope === 'manifest' ? 'manifest.json' : 'subpath/file.txt';
      const contentSha256 =
        scope === 'workspace' || scope === 'global' ? 'a'.repeat(64) : undefined;
      const key = buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope,
        relativePath,
        contentSha256,
      });
      expect(key.startsWith('/')).toBe(false);
      expect(key.includes('/../')).toBe(false);
      expect(key.includes('//')).toBe(false);
    }
  });

  it('exposes the CAS prefix constants', () => {
    expect(CAS_PREFIX).toBe('global/cas');
    expect(CAS_NAMESPACE_ROOT).toBe('global');
  });
});

describe('parseObjectKey', () => {
  it('parses a manifest key', () => {
    expect(parseObjectKey('p/s/manifest.json')).toEqual({
      projectId: 'p',
      sessionId: 's',
      scope: 'manifest',
      relativePath: 'manifest.json',
    });
  });

  it('parses a new session-scoped artifact key (no scope segment)', () => {
    expect(parseObjectKey('p/s/transcript.jsonl')).toEqual({
      projectId: 'p',
      sessionId: 's',
      scope: 'session',
      relativePath: 'transcript.jsonl',
    });
  });

  it('parses a legacy session-scoped artifact key (with scope segment)', () => {
    expect(parseObjectKey('p/s/session/transcript.jsonl')).toEqual({
      projectId: 'p',
      sessionId: 's',
      scope: 'session',
      relativePath: 'transcript.jsonl',
    });
  });

  it('parses a new session-scoped subagent key', () => {
    expect(parseObjectKey('p/s/subagents/agent-abc.jsonl')).toEqual({
      projectId: 'p',
      sessionId: 's',
      scope: 'session',
      relativePath: 'subagents/agent-abc.jsonl',
    });
  });

  it('parses a workspace-scoped artifact key with nested path', () => {
    expect(parseObjectKey('p/s/workspace/.claude/settings.json')).toEqual({
      projectId: 'p',
      sessionId: 's',
      scope: 'workspace',
      relativePath: '.claude/settings.json',
    });
  });

  it('parses a global-scoped artifact key', () => {
    expect(parseObjectKey('p/s/global/~/.claude/settings.json')).toEqual({
      projectId: 'p',
      sessionId: 's',
      scope: 'global',
      relativePath: '~/.claude/settings.json',
    });
  });

  it('decodes percent-encoded segments', () => {
    expect(parseObjectKey('my%20project/sess%3A1/file.json')).toEqual({
      projectId: 'my project',
      sessionId: 'sess:1',
      scope: 'session',
      relativePath: 'file.json',
    });
  });

  it('decodes percent-encoded Unicode segments', () => {
    expect(parseObjectKey('p/s/caf%C3%A9/emoji')).toEqual({
      projectId: 'p',
      sessionId: 's',
      scope: 'session',
      relativePath: 'café/emoji',
    });
  });

  it('returns undefined for keys with too few segments', () => {
    expect(parseObjectKey('p')).toBeUndefined();
    expect(parseObjectKey('p/s')).toBeUndefined();
  });

  it('treats keys with an unrecognized third segment as session-scoped', () => {
    // New session-scoped keys omit the `session/` segment. An unrecognized
    // third segment is therefore interpreted as the start of a session-scoped
    // relativePath, not rejected as an unknown scope.
    expect(parseObjectKey('p/s/unknown/file.json')).toEqual({
      projectId: 'p',
      sessionId: 's',
      scope: 'session',
      relativePath: 'unknown/file.json',
    });
  });

  it('returns undefined for empty keys', () => {
    expect(parseObjectKey('')).toBeUndefined();
  });

  it('parses a CAS flat key', () => {
    const hash = 'a'.repeat(64);
    expect(parseObjectKey(`global/cas/${hash}`)).toEqual({
      projectId: undefined,
      sessionId: undefined,
      scope: 'cas',
      relativePath: hash,
      contentSha256: hash,
    });
  });

  it('parses a CAS flat key with uppercase hash', () => {
    const hash = 'A'.repeat(64);
    expect(parseObjectKey(`global/cas/${hash}`)).toEqual({
      projectId: undefined,
      sessionId: undefined,
      scope: 'cas',
      relativePath: hash.toLowerCase(),
      contentSha256: hash.toLowerCase(),
    });
  });

  it('returns undefined for CAS keys with a malformed hash', () => {
    expect(parseObjectKey('global/cas/not-a-hash')).toBeUndefined();
    expect(parseObjectKey('global/cas/abc')).toBeUndefined();
  });

  it('parses a 3-segment key that looks like CAS but has a non-hash third segment as legacy', () => {
    expect(parseObjectKey('global/cas/manifest.json')).toEqual({
      projectId: 'global',
      sessionId: 'cas',
      scope: 'manifest',
      relativePath: 'manifest.json',
    });
  });

  it('round-trips with buildObjectKey', () => {
    const inputs: Array<{
      projectId: string;
      sessionId: string;
      scope: StorageObjectScope;
      relativePath: string;
    }> = [
      { projectId: 'p', sessionId: 's', scope: 'manifest', relativePath: 'manifest.json' },
      { projectId: 'p', sessionId: 's', scope: 'session', relativePath: 'transcript.jsonl' },
      { projectId: 'p', sessionId: 's', scope: 'runtime', relativePath: 'telemetry.json' },
    ];
    for (const input of inputs) {
      const key = buildObjectKey(input);
      const parsed = parseObjectKey(key);
      expect(parsed).toEqual(input);
    }
  });

  it('round-trips CAS flat keys with buildObjectKey', () => {
    const hash = 'a'.repeat(64);
    const key = buildObjectKey({
      projectId: 'p',
      sessionId: 's',
      scope: 'workspace',
      relativePath: '.claude/settings.json',
      contentSha256: hash,
    });
    expect(parseObjectKey(key)).toEqual({
      projectId: undefined,
      sessionId: undefined,
      scope: 'cas',
      relativePath: hash,
      contentSha256: hash,
    });
  });
});
