import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  CaptureAllowlist,
  HarnessProfile,
  SessionLayoutDescriptor,
} from '@lucasschirm/sal-sync-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CAPTURE_ALLOWLIST,
  CLAUDE_SESSION_LAYOUT,
  createWatcherMatcher,
  DEFAULT_HARNESS_PROFILE,
  discover,
  discoverSession,
  discoverWorkspace,
  isPathWatched,
} from '../../src/index.js';

/**
 * A synthetic second harness profile, distinct from Claude's in every
 * dimension the `HarnessProfile` contract parameterizes: workspace/global
 * allowlist patterns, config directory resolution, and session transcript
 * layout. Used to prove discovery and the watcher matcher are genuinely
 * driven by the injected profile rather than still hardcoded to Claude.
 */
const SYNTHETIC_ALLOWLIST: CaptureAllowlist = {
  version: 1,
  session: [],
  workspace: [{ scope: 'workspace', pattern: 'AGENT.md' }],
  global: [{ scope: 'global', pattern: '~/.agent/settings.json' }],
};

const SYNTHETIC_SESSION_LAYOUT: SessionLayoutDescriptor = {
  mainTranscriptStorageName: 'main.log',
  mainTranscriptFilePattern: 'run-{sessionId}.log',
  subagentTranscriptsPattern: 'children/*.log',
  subagentMetaPattern: 'children/*.meta.json',
};

function makeSyntheticProfile(configDir: string): HarnessProfile {
  return {
    harness: 'synthetic',
    harnessVersion: '9.9.9',
    configDir: () => configDir,
    captureAllowlist: SYNTHETIC_ALLOWLIST,
    sessionLayout: SYNTHETIC_SESSION_LAYOUT,
    securityBlocklist: [],
  };
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content);
}

describe('discovery is genuinely parameterized by HarnessProfile', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-profile-ws-'));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('a Claude-shaped allowlist matches Claude paths and rejects a synthetic-only path', async () => {
    await writeFile(path.join(workspace, 'CLAUDE.md'), '# claude');
    await writeFile(path.join(workspace, 'AGENT.md'), '# synthetic-only');

    const result = await discoverWorkspace(
      { projectId: 'proj-1', sessionId: 'sess-1', workspaceRoot: workspace },
      DEFAULT_HARNESS_PROFILE,
    );

    const paths = result.artifacts.map((a) => a.relativePath);
    expect(paths).toContain('CLAUDE.md');
    expect(paths).not.toContain('AGENT.md');
  });

  it('a synthetic allowlist matches its own paths and rejects Claude-only paths', async () => {
    await writeFile(path.join(workspace, 'CLAUDE.md'), '# claude');
    await writeFile(path.join(workspace, 'AGENT.md'), '# synthetic-only');

    const result = await discoverWorkspace(
      { projectId: 'proj-1', sessionId: 'sess-1', workspaceRoot: workspace },
      makeSyntheticProfile('/unused'),
    );

    const paths = result.artifacts.map((a) => a.relativePath);
    expect(paths).toContain('AGENT.md');
    expect(paths).not.toContain('CLAUDE.md');
  });

  it('resolves the global config directory from the injected profile, not a Claude default', async () => {
    const claudeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-profile-claude-cfg-'));
    const syntheticConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-profile-synth-cfg-'));
    try {
      await writeFile(path.join(claudeConfigDir, 'settings.json'), '{"claude":true}');
      await writeFile(path.join(syntheticConfigDir, 'settings.json'), '{"synthetic":true}');

      const claudeResult = await discover(
        {
          projectId: 'proj-1',
          sessionId: 'sess-1',
          workspaceRoot: workspace,
          configDir: claudeConfigDir,
        },
        DEFAULT_HARNESS_PROFILE,
      );
      const syntheticResult = await discover(
        { projectId: 'proj-1', sessionId: 'sess-1', workspaceRoot: workspace },
        makeSyntheticProfile(syntheticConfigDir),
      );

      expect(claudeResult.artifacts.some((a) => a.relativePath === 'settings.json')).toBe(true);
      // The synthetic profile's allowlist has no `settings.json` global pattern
      // (its own global pattern is `~/.agent/settings.json`), so nothing from
      // the Claude-shaped global scope leaks through when a different profile
      // is injected.
      expect(syntheticResult.artifacts.some((a) => a.relativePath === 'settings.json')).toBe(false);
    } finally {
      fs.rmSync(claudeConfigDir, { recursive: true, force: true });
      fs.rmSync(syntheticConfigDir, { recursive: true, force: true });
    }
  });

  it('resolves the main transcript and subagent glob per sessionLayout, differing between profiles', async () => {
    const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-profile-tx-'));
    try {
      // Claude layout: <sessionId>.jsonl on disk, subagents/*.jsonl siblings.
      const claudeTranscriptPath = path.join(transcriptDir, 'sess-1.jsonl');
      await writeFile(claudeTranscriptPath, '{}\n');
      await writeFile(path.join(transcriptDir, 'sess-1', 'subagents', 'agent-1.jsonl'), '{}\n');

      const claudeResult = await discoverSession(
        { projectId: 'proj-1', sessionId: 'sess-1', transcriptPath: claudeTranscriptPath },
        DEFAULT_HARNESS_PROFILE,
      );
      const claudePaths = claudeResult.artifacts.map((a) => a.relativePath).sort();
      expect(claudePaths).toEqual(['subagents/agent-1.jsonl', 'transcript.jsonl']);

      // Synthetic layout: run-<sessionId>.log on disk, children/*.log siblings,
      // storage name "main.log" instead of "transcript.jsonl".
      const syntheticTranscriptPath = path.join(transcriptDir, 'run-sess-2.log');
      await writeFile(syntheticTranscriptPath, 'line\n');
      await writeFile(path.join(transcriptDir, 'sess-2', 'children', 'child-1.log'), 'line\n');

      const syntheticResult = await discoverSession(
        { projectId: 'proj-1', sessionId: 'sess-2', transcriptPath: syntheticTranscriptPath },
        makeSyntheticProfile('/unused'),
      );
      const syntheticPaths = syntheticResult.artifacts.map((a) => a.relativePath).sort();
      expect(syntheticPaths).toEqual(['children/child-1.log', 'main.log']);
    } finally {
      fs.rmSync(transcriptDir, { recursive: true, force: true });
    }
  });

  it('the watcher matcher locates files per an injected sessionLayout, not the hardcoded Claude one', () => {
    const claudeMatcher = createWatcherMatcher('/base', 'sess-1', CLAUDE_SESSION_LAYOUT);
    const syntheticMatcher = createWatcherMatcher('/base', 'sess-1', SYNTHETIC_SESSION_LAYOUT);

    expect(isPathWatched(claudeMatcher, '/base/sess-1.jsonl')).toBe(true);
    expect(isPathWatched(claudeMatcher, '/base/run-sess-1.log')).toBe(false);

    expect(isPathWatched(syntheticMatcher, '/base/run-sess-1.log')).toBe(true);
    expect(isPathWatched(syntheticMatcher, '/base/sess-1.jsonl')).toBe(false);
  });

  it('CAPTURE_ALLOWLIST (deprecated alias) still equals the profile-driven default', () => {
    expect(DEFAULT_HARNESS_PROFILE.captureAllowlist).toBe(CAPTURE_ALLOWLIST);
  });
});
