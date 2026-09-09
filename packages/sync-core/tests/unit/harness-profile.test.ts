import { describe, expect, it } from 'vitest';

import type { CaptureAllowlist, HarnessProfile, SessionLayoutDescriptor } from '../../src/index.js';
import { resolveMainTranscriptFileName } from '../../src/index.js';

function makeAllowlist(): CaptureAllowlist {
  return {
    version: 1,
    session: [],
    workspace: [{ scope: 'workspace', pattern: 'AGENT.md' }],
    global: [{ scope: 'global', pattern: '~/.agent/settings.json' }],
  };
}

function makeSessionLayout(): SessionLayoutDescriptor {
  return {
    mainTranscriptStorageName: 'transcript.jsonl',
    mainTranscriptFilePattern: 'session-{sessionId}.log',
    subagentTranscriptsPattern: 'children/*.log',
    subagentMetaPattern: 'children/*.meta.json',
  };
}

function makeProfile(overrides: Partial<HarnessProfile> = {}): HarnessProfile {
  return {
    harness: 'synthetic',
    harnessVersion: '1.2.3',
    configDir: (env) => env.SYNTHETIC_CONFIG_DIR ?? '/default/.synthetic',
    captureAllowlist: makeAllowlist(),
    sessionLayout: makeSessionLayout(),
    securityBlocklist: ['SYNTHETIC_SECRET'],
    ...overrides,
  };
}

describe('HarnessProfile contract', () => {
  it('is constructible with the documented shape', () => {
    const profile = makeProfile();
    expect(profile.harness).toBe('synthetic');
    expect(profile.harnessVersion).toBe('1.2.3');
    expect(profile.captureAllowlist.workspace).toHaveLength(1);
    expect(profile.securityBlocklist).toContain('SYNTHETIC_SECRET');
  });

  it('configDir resolves from the injected env, independent of process.env', () => {
    const profile = makeProfile();
    expect(profile.configDir({ SYNTHETIC_CONFIG_DIR: '/custom' })).toBe('/custom');
    expect(profile.configDir({})).toBe('/default/.synthetic');
  });

  it('two profiles with distinct sessionLayout data remain distinct objects', () => {
    const a = makeProfile();
    const b = makeProfile({ harness: 'other', sessionLayout: makeSessionLayout() });
    expect(a.sessionLayout).not.toBe(b.sessionLayout);
    expect(a.harness).not.toBe(b.harness);
  });
});

describe('resolveMainTranscriptFileName', () => {
  it('substitutes the sessionId placeholder', () => {
    const layout = makeSessionLayout();
    expect(resolveMainTranscriptFileName(layout, 'sess-42')).toBe('session-sess-42.log');
  });

  it('produces different filenames for different layouts, given the same sessionId', () => {
    const claudeShaped: SessionLayoutDescriptor = {
      mainTranscriptStorageName: 'transcript.jsonl',
      mainTranscriptFilePattern: '{sessionId}.jsonl',
      subagentTranscriptsPattern: 'subagents/*.jsonl',
      subagentMetaPattern: 'subagents/*.meta.json',
    };
    const synthetic = makeSessionLayout();

    expect(resolveMainTranscriptFileName(claudeShaped, 'sess-1')).toBe('sess-1.jsonl');
    expect(resolveMainTranscriptFileName(synthetic, 'sess-1')).toBe('session-sess-1.log');
  });
});
