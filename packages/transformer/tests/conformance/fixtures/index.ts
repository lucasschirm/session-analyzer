import { readFileSync } from 'node:fs';
import type { Artifact, TransformContext, UnknownArtifactBundle } from '../../../src/index.js';

const parserFixtures = new URL(
  '../../../../parsers/claude-session-parser/tests/fixtures/',
  import.meta.url,
);

const conformanceData = new URL('./data/', import.meta.url);

function loadParserFixture(name: string): string {
  return readFileSync(new URL(name, parserFixtures), 'utf8');
}

function loadConformanceData(name: string): string {
  return readFileSync(new URL(name, conformanceData), 'utf8');
}

export const testContext: TransformContext = {
  analysisReleaseId: 'conformance-r1',
  parserId: '@lucasschirm/sal-claude-session-parser',
  parserVersion: '0.1.0',
  sourceFingerprint: 'fp-conformance',
  sourceEnvironmentId: 'env-conformance',
  sourceProjectId: 'proj-conformance',
  sourceSessionId: 'sess-conformance',
};

function artifact(relativePath: string, content: string, mediaType: string): Artifact<string> {
  return { relativePath, mediaType, content };
}

function bundle(artifacts: Artifact<string>[]): UnknownArtifactBundle {
  return {
    artifacts,
    sourceIdentity: {
      sourceId: 'conformance-source',
      environmentId: 'conformance-env',
      projectId: 'conformance-proj',
      sessionId: 'conformance-sess',
    },
    sourceFingerprint: 'fp-conformance',
  };
}

const mainSessionJsonl = loadParserFixture('e2e-main-session.jsonl');
const subagentJsonl = loadParserFixture('e2e-subagent-transcript.jsonl');
const subagentMeta = loadParserFixture('e2e-subagent-meta.json');
const skillMd = loadParserFixture('e2e-skill-csv-wrangler.md');
const agentMd = loadParserFixture('e2e-agent-docs-drafter.md');
const ruleMd = loadParserFixture('e2e-rule-style.md');
const mcpJson = loadParserFixture('e2e-mcp.json');
const settingsJson = loadParserFixture('e2e-settings-project.json');
const happyJsonl = loadParserFixture('t2-happy-path.jsonl');
const replayedJsonl = loadConformanceData('replayed.jsonl');

const commonConfigArtifacts: Artifact<string>[] = [
  artifact('.claude/skills/csv-wrangler/SKILL.md', skillMd, 'text/markdown'),
  artifact('.claude/agents/docs-drafter.md', agentMd, 'text/markdown'),
  artifact('.claude/rules/style.md', ruleMd, 'text/markdown'),
  artifact('.mcp.json', mcpJson, 'application/json'),
  artifact('.claude/settings.json', settingsJson, 'application/json'),
];

export interface ConformanceFixture<TBundle = UnknownArtifactBundle> {
  readonly name: string;
  readonly bundle: TBundle;
  readonly context: TransformContext;
  readonly tags: readonly string[];
  readonly description: string;
}

export interface TransformerFixtures<TBundle = UnknownArtifactBundle> {
  readonly fixtures: readonly ConformanceFixture<TBundle>[];
}

export const claudeConformanceFixtures: TransformerFixtures<UnknownArtifactBundle> = {
  fixtures: [
    {
      name: 'root-and-subagent-complete',
      description:
        'A complete root session with a Sub Agent, skill, agent, rule, MCP and settings artifacts.',
      bundle: bundle([
        artifact('transcript.jsonl', mainSessionJsonl, 'application/jsonl'),
        artifact('subagents/agent-e2e-agent-0001.jsonl', subagentJsonl, 'application/jsonl'),
        artifact('subagents/agent-e2e-agent-0001.meta.json', subagentMeta, 'application/json'),
        ...commonConfigArtifacts,
      ]),
      context: testContext,
      tags: [
        'root',
        'subagent',
        'complete',
        'provenance',
        'anti-double-counting',
        'formulas',
        'deterministic',
      ],
    },
    {
      name: 'root-only-happy',
      description: 'A small root transcript with compaction and file operations but no Sub Agent.',
      bundle: bundle([artifact('transcript.jsonl', happyJsonl, 'application/jsonl')]),
      context: testContext,
      tags: ['root', 'compaction', 'root-only', 'deterministic'],
    },
    {
      name: 'partial-missing-subagent',
      description:
        'The main session references a Sub Agent launch but the transcript is not supplied.',
      bundle: bundle([artifact('transcript.jsonl', mainSessionJsonl, 'application/jsonl')]),
      context: testContext,
      tags: ['root', 'partial', 'unavailable', 'missing-subagent'],
    },
    {
      name: 'redacted-unknown-model',
      description:
        'A session whose model name is not in the pricing registry, so cost is estimated/unavailable.',
      bundle: bundle([
        artifact(
          'transcript.jsonl',
          mainSessionJsonl.replace(/test-model-[ab]/g, 'acme-unknown-llm'),
          'application/jsonl',
        ),
      ]),
      context: testContext,
      tags: ['root', 'redacted', 'exact-estimated', 'unavailable'],
    },
    {
      name: 'compacted-root',
      description: 'A small root transcript that contains a compact_boundary event.',
      bundle: bundle([artifact('transcript.jsonl', happyJsonl, 'application/jsonl')]),
      context: testContext,
      tags: ['root', 'compacted', 'compaction'],
    },
    {
      name: 'malformed-transcript',
      description: 'A transcript with an invalid JSON line; the rest should still parse.',
      bundle: bundle([
        artifact(
          'transcript.jsonl',
          'this is not json\n{"type":"user","message":{"role":"user","content":\n' +
            mainSessionJsonl,
          'application/jsonl',
        ),
      ]),
      context: testContext,
      tags: ['root', 'malformed'],
    },
    {
      name: 'replayed-events',
      description: 'A transcript that repeats the same assistant/user source events.',
      bundle: bundle([artifact('transcript.jsonl', replayedJsonl, 'application/jsonl')]),
      context: testContext,
      tags: ['root', 'replayed'],
    },
    {
      name: 'config-classification',
      description:
        'A bundle of configuration artifacts and an unclassified file, with no root transcript.',
      bundle: bundle([...commonConfigArtifacts, artifact('unknown.bin', 'some binary content')]),
      context: testContext,
      tags: ['classification', 'multi-component', 'unclassified'],
    },
    {
      name: 'no-root-capabilities',
      description: 'An empty bundle used to inspect default capability matrices.',
      bundle: bundle([]),
      context: testContext,
      tags: ['capabilities', 'unavailable'],
    },
  ],
};
