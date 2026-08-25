import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type Artifact,
  ClaudeCodeTransformer,
  createDefaultRegistry,
  type TransformContext,
  type UnknownArtifactBundle,
} from '../../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const parserFixtures = join(__dirname, '../../../parsers/claude-session-parser/tests/fixtures');

function fixture(name: string): string {
  return readFileSync(join(parserFixtures, name), 'utf8');
}

function artifact(
  relativePath: string,
  content: string,
  mediaType = 'text/plain',
): Artifact<string> {
  return { relativePath, mediaType, content };
}

const defaultContext: TransformContext = {
  analysisReleaseId: 'r1',
  parserId: '@lucasschirm/sal-claude-session-parser',
  parserVersion: '0.1.0',
  sourceFingerprint: 'fp-1',
  sourceEnvironmentId: 'env-1',
  sourceProjectId: 'proj-1',
  sourceSessionId: 'sess-1',
};

function bundle(artifacts: Artifact<string>[]): UnknownArtifactBundle {
  return {
    artifacts,
    sourceIdentity: {
      sourceId: 'test-source',
      environmentId: 'test-env',
      projectId: 'test-proj',
      sessionId: 'test-sess',
    },
    sourceFingerprint: 'fp-test',
  };
}

describe('ClaudeCodeTransformer', () => {
  it('is registered in the default registry', () => {
    const registry = createDefaultRegistry();
    expect(registry.ids()).toContain('claude-code');
    expect(registry.harnesses()).toContain('claude-code');
    expect(registry.resolve('claude-code').id).toBe('claude-code');
  });

  describe('detect()', () => {
    it('matches when manifest harness identity is claude-code', () => {
      const b = {
        ...bundle([artifact('transcript.jsonl', fixture('t2-happy-path.jsonl'))]),
        harness: 'claude-code' as const,
      };
      const result = ClaudeCodeTransformer.detect(b as unknown as UnknownArtifactBundle);
      expect(result.kind).toBe('matched');
      if (result.kind === 'matched') {
        expect(result.harness).toBe('claude-code');
        expect(result.reason).toContain('manifest');
      }
    });

    it('does not match when manifest harness is another harness, even if content looks like Claude', () => {
      const b = {
        ...bundle([artifact('transcript.jsonl', fixture('t2-happy-path.jsonl'))]),
        harness: 'other-harness',
      };
      const result = ClaudeCodeTransformer.detect(b as unknown as UnknownArtifactBundle);
      expect(result.kind).toBe('unmatched');
    });

    it('matches by schema detection for a manual bundle', () => {
      const b = bundle([artifact('transcript.jsonl', fixture('t2-happy-path.jsonl'))]);
      const result = ClaudeCodeTransformer.detect(b);
      expect(result.kind).toBe('matched');
      if (result.kind === 'matched') {
        expect(result.harness).toBe('claude-code');
      }
    });

    it('returns unmatched for an empty bundle', () => {
      const result = ClaudeCodeTransformer.detect(bundle([]));
      expect(result.kind).toBe('unmatched');
    });

    it('scans all artifacts before deciding, not first-match', () => {
      const b = bundle([
        artifact('unknown.bin', 'not claude'),
        artifact('transcript.jsonl', fixture('t2-happy-path.jsonl')),
      ]);
      const result = ClaudeCodeTransformer.detect(b);
      expect(result.kind).toBe('matched');
    });

    it('returns a structured error for ambiguous multiple root transcripts', () => {
      const content = fixture('t2-happy-path.jsonl');
      const b = bundle([
        artifact('transcript-a.jsonl', content),
        artifact('transcript-b.jsonl', content),
      ]);
      const result = ClaudeCodeTransformer.detect(b);
      expect(result.kind).toBe('unmatched');
      if (result.kind === 'unmatched') {
        expect(result.reason).toContain('multiple');
      }
    });
  });

  describe('classifyArtifacts()', () => {
    it('classifies every supported Claude path pattern', () => {
      const b = bundle([
        artifact('transcript.jsonl', fixture('t2-happy-path.jsonl'), 'application/jsonl'),
        artifact(
          'subagents/agent-xyz.jsonl',
          fixture('e2e-subagent-transcript.jsonl'),
          'application/jsonl',
        ),
        artifact(
          'subagents/agent-xyz.meta.json',
          fixture('e2e-subagent-meta.json'),
          'application/json',
        ),
        artifact(
          '.claude/skills/csv-wrangler/SKILL.md',
          fixture('e2e-skill-csv-wrangler.md'),
          'text/markdown',
        ),
        artifact(
          '.claude/agents/docs-drafter.md',
          fixture('e2e-agent-docs-drafter.md'),
          'text/markdown',
        ),
        artifact('.claude/rules/style.md', fixture('e2e-rule-style.md'), 'text/markdown'),
        artifact('CLAUDE.md', fixture('t8-claude-md-memory.md'), 'text/markdown'),
        artifact('.mcp.json', fixture('e2e-mcp.json'), 'application/json'),
        artifact('.claude/settings.json', fixture('t6-settings-full.json'), 'application/json'),
        artifact(
          '.claude/settings.local.json',
          fixture('t6-settings-local-secret.json'),
          'application/json',
        ),
        artifact('.claude.json', fixture('e2e-settings-user.json'), 'application/json'),
        artifact('unknown.bin', 'some binary content'),
      ]);

      const result = ClaudeCodeTransformer.classifyArtifacts(b);
      const byPath = new Map(result.artifacts.map((a) => [a.relativePath, a]));

      expect(byPath.get('transcript.jsonl')?.kind).toBe('transcript');
      expect(byPath.get('subagents/agent-xyz.jsonl')?.kind).toBe('subagent');
      expect(byPath.get('subagents/agent-xyz.meta.json')?.kind).toBe('subagent');
      expect(byPath.get('subagents/agent-xyz.meta.json')?.role).toBe('metadata');
      expect(byPath.get('.claude/skills/csv-wrangler/SKILL.md')?.kind).toBe('skill');
      expect(byPath.get('.claude/agents/docs-drafter.md')?.kind).toBe('agent');
      expect(byPath.get('.claude/rules/style.md')?.kind).toBe('rule');
      expect(byPath.get('CLAUDE.md')?.kind).toBe('rule');
      expect(byPath.get('.mcp.json')?.kind).toBe('mcp');
      expect(byPath.get('.claude/settings.json')?.kind).toBe('settings');
      expect(byPath.get('.claude/settings.local.json')?.kind).toBe('settings');
      expect(byPath.get('.claude.json')?.kind).toBe('settings');
      expect(byPath.get('unknown.bin')?.kind).toBe('unclassified');

      const unclassified = result.artifacts.filter((a) => a.kind === 'unclassified');
      expect(unclassified.length).toBe(1);
    });

    it('extracts multiple components from a settings artifact', () => {
      const b = bundle([
        artifact('.claude/settings.json', fixture('t6-settings-full.json'), 'application/json'),
      ]);
      const result = ClaudeCodeTransformer.classifyArtifacts(b);
      const settingsComponents = result.components.filter((c) => c.kind === 'settings');
      const hookComponents = result.components.filter((c) => c.kind === 'tool');

      expect(settingsComponents.length).toBe(1);
      expect(hookComponents.length).toBeGreaterThan(0);
      expect(result.configurationSnapshot.completeness.settings).toBe('complete');
      expect(result.configurationSnapshot.completeness.tool).toBe('complete');
    });

    it('extracts one component per MCP server', () => {
      const b = bundle([artifact('.mcp.json', fixture('e2e-mcp.json'), 'application/json')]);
      const result = ClaudeCodeTransformer.classifyArtifacts(b);
      const mcpComponents = result.components.filter((c) => c.kind === 'mcp');

      expect(mcpComponents.length).toBe(2);
      expect(mcpComponents.map((c) => c.identity.nativeId).sort()).toEqual([
        'quill-db',
        'zephyr:tools',
      ]);
      expect(mcpComponents.every((c) => c.sourcePointer?.jsonPointer)).toBe(true);
    });

    it('retains a source pointer on extracted components', () => {
      const b = bundle([
        artifact(
          '.claude/skills/csv-wrangler/SKILL.md',
          fixture('e2e-skill-csv-wrangler.md'),
          'text/markdown',
        ),
      ]);
      const result = ClaudeCodeTransformer.classifyArtifacts(b);
      const skill = result.components.find((c) => c.kind === 'skill');
      expect(skill).toBeDefined();
      expect(skill?.sourcePointer?.path).toBeDefined();
    });
  });

  describe('transform()', () => {
    it('normalizes the session spine from a root transcript', () => {
      const b = bundle([
        artifact('transcript.jsonl', fixture('t2-happy-path.jsonl'), 'application/jsonl'),
      ]);
      const result = ClaudeCodeTransformer.transform(b, defaultContext);

      expect(result.errors).toEqual([]);
      const sessions = result.evidence.filter((r) => r.recordType === 'session');
      const turns = result.evidence.filter((r) => r.recordType === 'turn');
      const messages = result.evidence.filter((r) => r.recordType === 'message');
      const requests = result.evidence.filter((r) => r.recordType === 'model_request');

      expect(sessions.length).toBe(1);
      expect(sessions[0]?.sessionId).toBe(result.sessionSummaries[0]?.sessionId);
      expect(sessions[0]?.payload).toMatchObject({
        harness: 'claude-code',
        nativeSessionId: 'sess-happy-1',
      });

      expect(turns.length).toBeGreaterThan(0);
      expect(messages.length).toBeGreaterThanOrEqual(turns.length);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests[0]?.payload).toMatchObject({ model: 'model-a' });

      expect(result.sessionSummaries[0]?.rootSessionId).toBe(result.sessionSummaries[0]?.sessionId);
      expect(result.sessionSummaries[0]?.parentSessionId).toBeUndefined();
    });

    it('normalizes root and child sessions, relations, and model requests', () => {
      const b = bundle([
        artifact('transcript.jsonl', fixture('e2e-main-session.jsonl'), 'application/jsonl'),
        artifact(
          'subagents/agent-e2e-agent-0001.jsonl',
          fixture('e2e-subagent-transcript.jsonl'),
          'application/jsonl',
        ),
        artifact(
          'subagents/agent-e2e-agent-0001.meta.json',
          fixture('e2e-subagent-meta.json'),
          'application/json',
        ),
      ]);
      const result = ClaudeCodeTransformer.transform(b, defaultContext);

      expect(result.errors).toEqual([]);
      const sessions = result.evidence.filter((r) => r.recordType === 'session');
      const relations = result.evidence.filter((r) => r.recordType === 'session_relation');

      expect(sessions.length).toBe(2);
      expect(relations.length).toBe(1);
      expect(relations[0]?.payload).toMatchObject({
        nativeInclusionSemantics: 'subagent',
        spawnInvocation: 'toolu_agent_1',
      });

      const root = result.sessionSummaries.find((s) => s.sessionId === sessions[0]?.sessionId);
      const child = result.sessionSummaries.find((s) => s.sessionId !== sessions[0]?.sessionId);
      expect(root?.sessionId).toBe(root?.rootSessionId);
      expect(child?.rootSessionId).toBe(root?.sessionId);
      expect(child?.parentSessionId).toBe(root?.sessionId);
    });

    it('produces deterministic ids for the same bundle and context', () => {
      const b = bundle([
        artifact('transcript.jsonl', fixture('e2e-main-session.jsonl'), 'application/jsonl'),
        artifact(
          'subagents/agent-e2e-agent-0001.jsonl',
          fixture('e2e-subagent-transcript.jsonl'),
          'application/jsonl',
        ),
        artifact(
          'subagents/agent-e2e-agent-0001.meta.json',
          fixture('e2e-subagent-meta.json'),
          'application/json',
        ),
      ]);

      const first = ClaudeCodeTransformer.transform(b, defaultContext);
      const second = ClaudeCodeTransformer.transform(b, defaultContext);

      const firstIds = first.evidence.map((r) => r.recordId);
      const secondIds = second.evidence.map((r) => r.recordId);
      expect(firstIds).toEqual(secondIds);
      expect(first.sessionSummaries.map((s) => s.sessionId)).toEqual(
        second.sessionSummaries.map((s) => s.sessionId),
      );
      expect(first.bundleHash).toBe(second.bundleHash);
    });

    it('produces the same ids regardless of artifact order', () => {
      const artifacts = [
        artifact(
          'subagents/agent-e2e-agent-0001.meta.json',
          fixture('e2e-subagent-meta.json'),
          'application/json',
        ),
        artifact('transcript.jsonl', fixture('e2e-main-session.jsonl'), 'application/jsonl'),
        artifact(
          'subagents/agent-e2e-agent-0001.jsonl',
          fixture('e2e-subagent-transcript.jsonl'),
          'application/jsonl',
        ),
      ];
      const reversed = bundle([...artifacts].reverse());
      const normal = bundle(artifacts);

      const normalResult = ClaudeCodeTransformer.transform(normal, defaultContext);
      const reversedResult = ClaudeCodeTransformer.transform(reversed, defaultContext);

      expect(normalResult.sessionSummaries.map((s) => s.sessionId)).toEqual(
        reversedResult.sessionSummaries.map((s) => s.sessionId),
      );
    });
  });
});
