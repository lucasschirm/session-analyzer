import { createHash } from 'node:crypto';
import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SYNC_LIMITS,
  discover,
  discoverGlobal,
  discoverSession,
  discoverWorkspace,
  getRelativePath,
  isPathWithinRoot,
  resolveClaudeConfigDir,
  type SyncLimits,
} from '../../src/index.js';

function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

function makeLimits(overrides: Partial<SyncLimits> = {}): SyncLimits {
  return { ...DEFAULT_SYNC_LIMITS, ...overrides };
}

async function writeFile(filePath: string, content: Buffer | string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content);
}

describe('filesystem isolation', () => {
  describe('isPathWithinRoot', () => {
    it('accepts paths inside the root', () => {
      expect(isPathWithinRoot('/workspace/.claude/settings.json', '/workspace')).toBe(true);
      expect(isPathWithinRoot('/workspace/CLAUDE.md', '/workspace/')).toBe(true);
    });

    it('rejects relative traversal with ..', () => {
      expect(isPathWithinRoot('/workspace/../etc/passwd', '/workspace')).toBe(false);
      expect(isPathWithinRoot('/workspace/foo/../../etc', '/workspace')).toBe(false);
    });

    it('rejects absolute paths outside the root', () => {
      expect(isPathWithinRoot('/etc/passwd', '/workspace')).toBe(false);
      expect(isPathWithinRoot('/other/file', '/workspace')).toBe(false);
    });

    it('treats the root itself as inside', () => {
      expect(isPathWithinRoot('/workspace', '/workspace')).toBe(true);
    });
  });

  describe('getRelativePath', () => {
    it('returns the path relative to the root', () => {
      expect(getRelativePath('/workspace/.claude/settings.json', '/workspace')).toBe(
        '.claude/settings.json',
      );
      expect(getRelativePath('/workspace/CLAUDE.md', '/workspace')).toBe('CLAUDE.md');
    });

    it('throws for out-of-boundary paths', () => {
      expect(() => getRelativePath('/etc/passwd', '/workspace')).toThrow();
    });
  });
});

describe('resolveClaudeConfigDir', () => {
  it('uses CLAUDE_CONFIG_DIR when provided', () => {
    expect(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: '/custom/config' })).toBe(
      path.resolve('/custom/config'),
    );
  });

  it('falls back to ~/.claude when the env var is missing', () => {
    expect(resolveClaudeConfigDir({})).toBe(path.join(os.homedir(), '.claude'));
  });
});

describe('discoverWorkspace', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-workspace-'));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('discovers all workspace allowlist files', async () => {
    await writeFile(path.join(workspace, 'CLAUDE.md'), '# project rules');
    await writeFile(path.join(workspace, '.mcp.json'), '{"mcpServers": {}}');
    await writeFile(path.join(workspace, '.claude', 'settings.json'), '{"foo": 1}');
    await writeFile(path.join(workspace, '.claude', 'settings.local.json'), '{"bar": 2}');
    await writeFile(path.join(workspace, '.claude', 'agents', 'agent-a.md'), '# agent a');
    await writeFile(path.join(workspace, '.claude', 'skills', 'skill-a.md'), '# skill a');
    await writeFile(path.join(workspace, '.claude', 'rules', 'rule-a.md'), '# rule a');

    const result = await discoverWorkspace({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      workspaceRoot: workspace,
    });

    const relativePaths = result.artifacts.map((a) => a.relativePath).sort();
    expect(relativePaths).toEqual([
      '.claude/agents/agent-a.md',
      '.claude/rules/rule-a.md',
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.claude/skills/skill-a.md',
      '.mcp.json',
      'CLAUDE.md',
    ]);
    expect(result.errors).toHaveLength(0);
    expect(result.filesDiscovered).toBe(7);
  });

  it('does not discover arbitrary workspace content', async () => {
    await writeFile(path.join(workspace, 'src', 'main.ts'), 'console.log(1)');
    await writeFile(path.join(workspace, 'README.md'), '# readme');
    await writeFile(path.join(workspace, '.claude', 'settings.json'), '{}');

    const result = await discoverWorkspace({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      workspaceRoot: workspace,
    });

    expect(result.artifacts.map((a) => a.relativePath)).toEqual(['.claude/settings.json']);
  });

  it('silently skips missing allowlist files', async () => {
    await writeFile(path.join(workspace, 'CLAUDE.md'), '# project rules');

    const result = await discoverWorkspace({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      workspaceRoot: workspace,
    });

    expect(result.artifacts.map((a) => a.relativePath)).toEqual(['CLAUDE.md']);
    expect(result.errors).toHaveLength(0);
  });

  it('records sha256 hashes and sizes for discovered files', async () => {
    const content = Buffer.from('# project rules');
    await writeFile(path.join(workspace, 'CLAUDE.md'), content);

    const result = await discoverWorkspace({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      workspaceRoot: workspace,
    });

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.sha256).toBe(sha256(content));
    expect(result.artifacts[0]?.size).toBe(content.length);
  });

  it('rejects symlinks inside the workspace', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-outside-'));
    try {
      await writeFile(path.join(outside, 'secret.md'), 'secret');
      const linkPath = path.join(workspace, '.claude', 'agents', 'leaked.md');
      await fsp.mkdir(path.dirname(linkPath), { recursive: true });
      fs.symlinkSync(path.join(outside, 'secret.md'), linkPath);

      const result = await discoverWorkspace({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        workspaceRoot: workspace,
      });

      expect(result.artifacts).toHaveLength(0);
      expect(result.errors.some((e) => e.code === 'SYNC_DISCOVERY_ERROR')).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('enforces the per-file size limit', async () => {
    const content = Buffer.alloc(101);
    await writeFile(path.join(workspace, '.claude', 'settings.json'), content);

    const result = await discoverWorkspace({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      workspaceRoot: workspace,
      limits: makeLimits({ maxFileBytes: 100 }),
    });

    expect(result.artifacts).toHaveLength(0);
    expect(result.errors[0]?.code).toBe('SYNC_FILE_TOO_LARGE');
  });

  it('enforces the total size limit', async () => {
    await writeFile(path.join(workspace, 'CLAUDE.md'), Buffer.alloc(60));
    await writeFile(path.join(workspace, '.mcp.json'), Buffer.alloc(60));

    const result = await discoverWorkspace({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      workspaceRoot: workspace,
      limits: makeLimits({ maxTotalBytes: 100 }),
    });

    expect(result.artifacts.length).toBeLessThanOrEqual(1);
    expect(result.errors.some((e) => e.code === 'SYNC_TOTAL_SIZE_EXCEEDED')).toBe(true);
  });

  it('enforces the file count limit', async () => {
    await writeFile(path.join(workspace, 'CLAUDE.md'), 'a');
    await writeFile(path.join(workspace, '.mcp.json'), 'b');

    const result = await discoverWorkspace({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      workspaceRoot: workspace,
      limits: makeLimits({ maxFiles: 1 }),
    });

    expect(result.artifacts).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('SYNC_FILE_COUNT_EXCEEDED');
  });

  it('rejects JSON files that exceed the configured depth', async () => {
    await writeFile(path.join(workspace, '.claude', 'settings.json'), '{"a":{"b":{"c":1}}}');

    const result = await discoverWorkspace({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      workspaceRoot: workspace,
      limits: makeLimits({ maxJsonDepth: 1 }),
    });

    expect(result.artifacts).toHaveLength(0);
    expect(result.errors[0]?.code).toBe('SYNC_JSON_PARSE_FAILED');
  });

  it('survives a permission error on a directory', async () => {
    const agentsDir = path.join(workspace, '.claude', 'agents');
    await writeFile(path.join(agentsDir, 'agent-a.md'), '# agent a');
    fs.chmodSync(agentsDir, 0o000);

    try {
      const result = await discoverWorkspace({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        workspaceRoot: workspace,
      });

      expect(result.artifacts.map((a) => a.relativePath)).not.toContain(
        '.claude/agents/agent-a.md',
      );
      expect(result.errors.some((e) => e.code === 'SYNC_DISCOVERY_ERROR')).toBe(true);
    } finally {
      fs.chmodSync(agentsDir, 0o755);
    }
  });
});

describe('discoverGlobal', () => {
  let homeDir: string;
  let claudeConfigDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-home-'));
    claudeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-claude-'));
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(claudeConfigDir, { recursive: true, force: true });
  });

  it('discovers global allowlist files from the correct roots', async () => {
    await writeFile(path.join(claudeConfigDir, 'settings.json'), '{"global": true}');
    await writeFile(path.join(claudeConfigDir, 'CLAUDE.md'), '# global rules');
    await writeFile(path.join(claudeConfigDir, 'agents', 'agent-global.md'), '# agent');
    await writeFile(path.join(homeDir, '.claude.json'), '{"mcpServers": {}}');

    const result = await discoverGlobal({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      claudeConfigDir,
      homeDir,
    });

    const relativePaths = result.artifacts.map((a) => a.relativePath).sort();
    expect(relativePaths).toEqual([
      '.claude.json',
      'CLAUDE.md',
      'agents/agent-global.md',
      'settings.json',
    ]);
    expect(result.errors).toHaveLength(0);
  });

  it('uses ~/.claude.json in the home directory, not the claude config directory', async () => {
    await writeFile(path.join(homeDir, '.claude.json'), '{"user": true}');
    await writeFile(path.join(claudeConfigDir, '.claude.json'), '{"wrong": true}');

    const result = await discoverGlobal({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      claudeConfigDir,
      homeDir,
    });

    const found = result.artifacts.find((a) => a.relativePath === '.claude.json');
    expect(found).toBeDefined();
    if (!found) throw new Error('expected .claude.json artifact');
    const content = await fsp.readFile(found.absolutePath, 'utf8');
    expect(content).toBe('{"user": true}');
  });

  it('respects CLAUDE_CONFIG_DIR when provided', async () => {
    await writeFile(path.join(claudeConfigDir, 'settings.json'), '{"fromOverride": true}');

    const result = await discoverGlobal({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      claudeConfigDir,
      homeDir,
    });

    const found = result.artifacts.find((a) => a.relativePath === 'settings.json');
    expect(found).toBeDefined();
    if (!found) throw new Error('expected settings.json artifact');
    expect(found.absolutePath.startsWith(claudeConfigDir)).toBe(true);
  });

  it('rejects symlinks in the global config directory', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-global-outside-'));
    try {
      await writeFile(path.join(outside, 'leaked.md'), 'leak');
      const linkPath = path.join(claudeConfigDir, 'agents', 'leaked.md');
      await fsp.mkdir(path.dirname(linkPath), { recursive: true });
      fs.symlinkSync(path.join(outside, 'leaked.md'), linkPath);

      const result = await discoverGlobal({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        claudeConfigDir,
        homeDir,
      });

      expect(result.artifacts).toHaveLength(0);
      expect(result.errors.some((e) => e.code === 'SYNC_DISCOVERY_ERROR')).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('discoverSession', () => {
  let transcriptDir: string;

  beforeEach(() => {
    transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-transcript-'));
  });

  afterEach(() => {
    fs.rmSync(transcriptDir, { recursive: true, force: true });
  });

  it('discovers the main transcript and subagent transcripts', async () => {
    const transcriptPath = path.join(transcriptDir, 'transcript.jsonl');
    const subagentDir = path.join(transcriptDir, 'subagents');
    await writeFile(transcriptPath, '{"type":"message"}\n');
    await writeFile(path.join(subagentDir, 'agent-1.jsonl'), '{"type":"message"}\n');

    const result = await discoverSession({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      transcriptPath,
    });

    const relativePaths = result.artifacts.map((a) => a.relativePath).sort();
    expect(relativePaths).toEqual(['subagents/agent-1.jsonl', 'transcript.jsonl']);
  });

  it('does not confuse .claude/agents with runtime subagent transcripts', async () => {
    const transcriptPath = path.join(transcriptDir, 'transcript.jsonl');
    const agentDir = path.join(transcriptDir, '.claude', 'agents');
    await writeFile(transcriptPath, '{}\n');
    await writeFile(path.join(agentDir, 'agent-def.jsonl'), '{}\n');

    const result = await discoverSession({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      transcriptPath,
    });

    expect(result.artifacts.map((a) => a.relativePath)).not.toContain(
      '.claude/agents/agent-def.jsonl',
    );
  });

  it('respects captureTranscripts=false', async () => {
    const transcriptPath = path.join(transcriptDir, 'transcript.jsonl');
    await writeFile(transcriptPath, '{}\n');

    const result = await discoverSession({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      transcriptPath,
      captureTranscripts: false,
    });

    expect(result.artifacts).toHaveLength(0);
  });

  it('returns empty when no transcript path is provided', async () => {
    const result = await discoverSession({
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });

    expect(result.artifacts).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('enforces the transcript byte limit', async () => {
    const transcriptPath = path.join(transcriptDir, 'transcript.jsonl');
    await writeFile(transcriptPath, Buffer.alloc(101));

    const result = await discoverSession({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      transcriptPath,
      limits: makeLimits({ maxTranscriptBytes: 100 }),
    });

    expect(result.artifacts).toHaveLength(0);
    expect(result.errors[0]?.code).toBe('SYNC_FILE_TOO_LARGE');
  });

  it('enforces the JSONL line byte limit', async () => {
    const transcriptPath = path.join(transcriptDir, 'transcript.jsonl');
    await writeFile(transcriptPath, `${'x'.repeat(51)}\n`);

    const result = await discoverSession({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      transcriptPath,
      limits: makeLimits({ maxJsonlLineBytes: 50 }),
    });

    expect(result.artifacts).toHaveLength(0);
    expect(result.errors[0]?.code).toBe('SYNC_JSON_PARSE_FAILED');
  });
});

describe('discover', () => {
  let homeDir: string;
  let claudeConfigDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-home-'));
    claudeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-claude-'));
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(claudeConfigDir, { recursive: true, force: true });
  });

  it('combines workspace, global, and session discovery', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-workspace-'));
    const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-transcript-'));

    try {
      await writeFile(path.join(workspace, 'CLAUDE.md'), '# workspace');
      await writeFile(path.join(claudeConfigDir, 'settings.json'), '{}');
      await writeFile(path.join(homeDir, '.claude.json'), '{}');
      const transcriptPath = path.join(transcriptDir, 'transcript.jsonl');
      await writeFile(transcriptPath, '{}\n');

      const result = await discover({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        workspaceRoot: workspace,
        claudeConfigDir,
        homeDir,
        transcriptPath,
      });

      const scopes = new Set(result.artifacts.map((a) => a.scope));
      expect(scopes).toContain('workspace');
      expect(scopes).toContain('global');
      expect(scopes).toContain('session');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(transcriptDir, { recursive: true, force: true });
    }
  });

  it('stops additional scopes when the total size limit is reached', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-workspace-'));
    const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-transcript-'));

    try {
      await writeFile(path.join(workspace, 'CLAUDE.md'), Buffer.alloc(80));
      await writeFile(path.join(claudeConfigDir, 'settings.json'), '{}');
      const transcriptPath = path.join(transcriptDir, 'transcript.jsonl');
      await writeFile(transcriptPath, '{}\n');

      const result = await discover({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        workspaceRoot: workspace,
        claudeConfigDir,
        homeDir,
        transcriptPath,
        limits: makeLimits({ maxTotalBytes: 50 }),
      });

      expect(result.artifacts).toHaveLength(0);
      expect(result.errors[0]?.code).toBe('SYNC_TOTAL_SIZE_EXCEEDED');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(transcriptDir, { recursive: true, force: true });
    }
  });
});
