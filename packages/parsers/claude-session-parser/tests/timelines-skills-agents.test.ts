import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { deriveSkillTimeline } from '../src/session/timelines/skills.js';
import { deriveAgentTimeline } from '../src/session/timelines/agents.js';
import type {
  AssistantEntry,
  AttachmentEntry,
  ClaudeAttachment,
  ClaudeCodeEntry,
  ContentBlock,
  UserEntry,
} from '../src/types/session.js';
import type { SkillAvailabilityRecord } from '../src/types/timeline.js';

// ---------------------------------------------------------------------------
// Inline entry builders for the C6-added edge cases below (kept local to
// this file rather than growing the shared fixture, per the task brief:
// most timeline edge cases don't need a whole fixture file). All content is
// synthetic.
// ---------------------------------------------------------------------------

let c6UuidCounter = 0;
function c6Uuid(): string {
  c6UuidCounter += 1;
  return `c6-uuid-${c6UuidCounter}`;
}

const C6_BASE_MS = Date.parse('2026-08-05T00:00:00.000Z');

function c6Base(lineNumber: number, timestampMs = C6_BASE_MS) {
  return {
    uuid: c6Uuid(),
    parentUuid: null,
    timestamp: new Date(timestampMs).toISOString(),
    timestampMs,
    isSidechain: false,
    sessionId: 'session-c6-inline',
    lineNumber,
  };
}

function c6Attachment(lineNumber: number, attachment: ClaudeAttachment, timestampMs = C6_BASE_MS): AttachmentEntry {
  return { ...c6Base(lineNumber, timestampMs), type: 'attachment', attachment };
}

function c6Assistant(
  lineNumber: number,
  content: ContentBlock[],
  extra: Partial<AssistantEntry> = {},
  timestampMs = C6_BASE_MS,
): AssistantEntry {
  return { ...c6Base(lineNumber, timestampMs), type: 'assistant', message: { role: 'assistant', content }, ...extra };
}

function c6User(lineNumber: number, extra: Partial<UserEntry>, timestampMs = C6_BASE_MS): UserEntry {
  return {
    ...c6Base(lineNumber, timestampMs),
    type: 'user',
    message: { role: 'user', content: [] },
    ...extra,
  };
}

let c6ToolUseCounter = 0;
function c6ToolUse(name: string, input: Record<string, unknown> = {}): { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } {
  c6ToolUseCounter += 1;
  return { type: 'tool_use', id: `c6-toolu-${c6ToolUseCounter}`, name, input };
}

function c6ToolResult(toolUseId: string, content: string): ContentBlock[] {
  return [{ type: 'tool_result', tool_use_id: toolUseId, content }] as ContentBlock[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

/**
 * `parseSessionTranscript` (T2) may still be a stub on this branch — per
 * the task brief, `ClaudeCodeEntry[]` arrays are constructed directly here
 * rather than depending on it.
 *
 * The fixture's *structure* (entry/attachment shapes, field names, the
 * real adjacency patterns for skill-expansion and agent-result pairing)
 * is distilled from the real `~/.claude/projects/*.jsonl` corpus. All
 * *content* — skill/agent names, descriptions, prompts, ids, model names,
 * token counts, file paths — is synthetic/invented, not real user or
 * project data, so this fixture is safe in a public repo.
 */
function loadFixtureEntries(name: string): ClaudeCodeEntry[] {
  const raw = readFileSync(join(fixturesDir, name), 'utf8');
  return JSON.parse(raw) as ClaudeCodeEntry[];
}

function findSkill(records: SkillAvailabilityRecord[], name: string): SkillAvailabilityRecord {
  const rec = records.find((r) => r.name === name);
  if (!rec) throw new Error(`fixture missing expected skill record: ${name}`);
  return rec;
}

const entries = loadFixtureEntries('t4-skills-agents-session.json');

describe('deriveSkillTimeline', () => {
  it('returns an empty array for an empty entry list', () => {
    expect(deriveSkillTimeline([])).toEqual([]);
  });

  it('records the initial skill_listing with isInitial true and parses descriptions', () => {
    const records = deriveSkillTimeline(entries);
    const rootCause = findSkill(records, 'acme:root-cause-analysis');
    const initialListed = rootCause.availability.find((e) => e.action === 'listed' && e.isInitial === true);
    expect(initialListed).toBeDefined();
    expect(rootCause.description).toContain('before proposing a fix');
  });

  it('records a mid-session skill_listing with isInitial false', () => {
    const records = deriveSkillTimeline(entries);
    const rootCause = findSkill(records, 'acme:root-cause-analysis');
    const midListed = rootCause.availability.filter((e) => e.action === 'listed');
    expect(midListed.length).toBe(2);
    expect(midListed[1].isInitial).toBe(false);
  });

  it('detects delisting by diffing successive skill_listing attachments', () => {
    const records = deriveSkillTimeline(entries);
    const chartBuilder = findSkill(records, 'chart-builder');
    const delisted = chartBuilder.availability.filter((e) => e.action === 'delisted');
    expect(delisted).toHaveLength(1);

    // A newly listed skill in the second delta is not itself delisted.
    const scheduler = findSkill(records, 'task-scheduler');
    expect(scheduler.availability.some((e) => e.action === 'delisted')).toBe(false);
    expect(scheduler.availability.some((e) => e.action === 'listed' && e.isInitial === false)).toBe(true);
  });

  it('splits plugin-prefixed vs bare skill names', () => {
    const records = deriveSkillTimeline(entries);
    const rootCause = findSkill(records, 'acme:root-cause-analysis');
    expect(rootCause.pluginPrefix).toBe('acme');
    expect(rootCause.bareName).toBe('root-cause-analysis');

    const chartBuilder = findSkill(records, 'chart-builder');
    expect(chartBuilder.pluginPrefix).toBeUndefined();
    expect(chartBuilder.bareName).toBe('chart-builder');
  });

  it('pairs a Skill invocation with its isMeta expansion and marks it launched', () => {
    const records = deriveSkillTimeline(entries);
    const rootCause = findSkill(records, 'acme:root-cause-analysis');

    expect(rootCause.invocationCount).toBe(1);
    const [invocation] = rootCause.invocations;
    expect(invocation.toolUseId).toBe('toolu_skillA');
    expect(invocation.args).toBe('Investigate why the example calculation returns the wrong total');
    expect(invocation.launched).toBe(true);

    expect(rootCause.injectedContent).toContain('# Root Cause Analysis');
    expect(rootCause.sourceDir).toBe(
      '/Users/dev/.claude/plugins/cache/example-marketplace/acme/1.0.0/skills/root-cause-analysis',
    );
    expect(rootCause.availability.some((e) => e.action === 'expanded')).toBe(true);
  });

  it('leaves a Skill invocation with no expansion as launched: false, with no injectedContent', () => {
    const records = deriveSkillTimeline(entries);
    const unknown = findSkill(records, 'mystery-widget-driver');

    expect(unknown.invocationCount).toBe(1);
    expect(unknown.invocations[0].launched).toBe(false);
    expect(unknown.injectedContent).toBeUndefined();
    expect(unknown.availability.some((e) => e.action === 'expanded')).toBe(false);
  });

  it('ties a discovered skill to its on-disk directory via dynamic_skill', () => {
    const records = deriveSkillTimeline(entries);
    const widgetMeta = findSkill(records, 'widget-metadata-manager');
    expect(widgetMeta.sourceDir).toBe('/Users/dev/example/.claude/skills');
    expect(widgetMeta.displayPath).toBe('example/.claude/skills');
    expect(widgetMeta.availability.some((e) => e.action === 'discovered')).toBe(true);
  });

  it('fills injectedContent/qualifiedPath from invoked_skills even without a listing', () => {
    const records = deriveSkillTimeline(entries);
    const handoff = findSkill(records, 'handoff-to-helper');
    expect(handoff.qualifiedPath).toBe('projectSettings:handoff-to-helper');
    expect(handoff.injectedContent).toContain('Handoff To Helper');
    expect(handoff.bareName).toBe('handoff-to-helper');
  });

  it('counts attributedTurnCount from matching attributionSkill on assistant entries', () => {
    const records = deriveSkillTimeline(entries);
    const rootCause = findSkill(records, 'acme:root-cause-analysis');
    expect(rootCause.attributedTurnCount).toBe(1);
  });

  it('never conflates a skill record with a tool record shape (no `tool`/`mcpServer` fields)', () => {
    const records = deriveSkillTimeline(entries);
    const rootCause = findSkill(records, 'acme:root-cause-analysis') as unknown as Record<string, unknown>;
    expect(rootCause.tool).toBeUndefined();
    expect(rootCause.mcpServer).toBeUndefined();
  });

  it('leaves description unset for a listed name whose "- name: " marker is missing from content', () => {
    const listing = c6Attachment(1, {
      type: 'skill_listing',
      isInitial: true,
      skillCount: 2,
      names: ['csv-wrangler', 'orphan-skill'],
      content: '- csv-wrangler: Wrangle CSV files into tidy tables.',
    });
    const records = deriveSkillTimeline([listing]);
    const csv = records.find((r) => r.name === 'csv-wrangler');
    expect(csv?.description).toBe('Wrangle CSV files into tidy tables.');
    const orphan = records.find((r) => r.name === 'orphan-skill');
    expect(orphan).toBeDefined();
    expect(orphan?.description).toBeUndefined();
  });

  it('skips a Skill tool_use with no input.skill entirely', () => {
    const call = c6Assistant(1, [c6ToolUse('Skill', { args: 'no skill field here' })]);
    const records = deriveSkillTimeline([call]);
    expect(records).toEqual([]);
  });

  it('leaves launched false when the entry right after tool_result is a user entry but not isMeta', () => {
    const skillToolUse = c6ToolUse('Skill', { skill: 'csv-wrangler' });
    const call = c6Assistant(1, [skillToolUse]);
    const toolUseId = skillToolUse.id;
    const result = c6User(2, { message: { role: 'user', content: c6ToolResult(toolUseId, 'Launching skill: csv-wrangler') } });
    const notMeta = c6User(3, { message: { role: 'user', content: 'Base directory for this skill: /Users/dev/.claude/skills/csv-wrangler\n\n# CSV Wrangler' } });

    const records = deriveSkillTimeline([call, result, notMeta]);
    const csv = records.find((r) => r.name === 'csv-wrangler');
    expect(csv?.invocations[0].launched).toBe(false);
    expect(csv?.injectedContent).toBeUndefined();
  });

  it('leaves launched false when the expansion text does not start with the exact "Base directory for this skill: " prefix', () => {
    const skillToolUse = c6ToolUse('Skill', { skill: 'csv-wrangler' });
    const call = c6Assistant(1, [skillToolUse]);
    const toolUseId = skillToolUse.id;
    const result = c6User(2, { message: { role: 'user', content: c6ToolResult(toolUseId, 'ok') } });
    const meta = c6User(3, { isMeta: true, message: { role: 'user', content: 'Base dir for this skill: /Users/dev/.claude/skills/csv-wrangler\n\n# CSV Wrangler' } });

    const records = deriveSkillTimeline([call, result, meta]);
    const csv = records.find((r) => r.name === 'csv-wrangler');
    expect(csv?.invocations[0].launched).toBe(false);
  });

  it('marks launched true from a valid expansion, but leaves sourceDir unset when the text has no \\n\\n separator', () => {
    const skillToolUse = c6ToolUse('Skill', { skill: 'csv-wrangler' });
    const call = c6Assistant(1, [skillToolUse]);
    const toolUseId = skillToolUse.id;
    const result = c6User(2, { message: { role: 'user', content: c6ToolResult(toolUseId, 'ok') } });
    const text = 'Base directory for this skill: /Users/dev/.claude/skills/csv-wrangler (no blank-line separator here)';
    const meta = c6User(3, { isMeta: true, message: { role: 'user', content: text } });

    const records = deriveSkillTimeline([call, result, meta]);
    const csv = records.find((r) => r.name === 'csv-wrangler');
    expect(csv?.invocations[0].launched).toBe(true);
    expect(csv?.injectedContent).toBe(text);
    expect(csv?.sourceDir).toBeUndefined();
  });

  it('does not overwrite an existing qualifiedPath/injectedContent from a later invoked_skills sighting', () => {
    const first = c6Attachment(1, {
      type: 'invoked_skills',
      skills: [{ name: 'csv-wrangler', path: 'first-source:csv-wrangler', content: 'First injected content.' }],
    });
    const second = c6Attachment(2, {
      type: 'invoked_skills',
      skills: [{ name: 'csv-wrangler', path: 'second-source:csv-wrangler', content: 'Second injected content.' }],
    });

    const records = deriveSkillTimeline([first, second]);
    const csv = records.find((r) => r.name === 'csv-wrangler');
    expect(csv?.qualifiedPath).toBe('first-source:csv-wrangler');
    expect(csv?.injectedContent).toBe('First injected content.');
  });
});

describe('deriveAgentTimeline', () => {
  it('returns empty agents/subagentLaunches for an empty entry list', () => {
    expect(deriveAgentTimeline([])).toEqual({ agents: [], subagentLaunches: [] });
  });

  it('records the initial agent_listing_delta with isInitial true and parses listingDescription/listingTools', () => {
    const { agents } = deriveAgentTimeline(entries);
    const generalist = agents.find((a) => a.agentType === 'generalist');
    expect(generalist).toBeDefined();
    expect(generalist!.listingDescription).toContain('general-purpose agent');
    expect(generalist!.listingTools).toBe('All tools');
    expect(generalist!.availability.some((e) => e.action === 'listed' && e.isInitial === true)).toBe(true);

    const codeFinder = agents.find((a) => a.agentType === 'code-finder');
    expect(codeFinder!.listingTools).toBe('Bash, Read, Grep, Glob');
  });

  it('detects delisting directly from agent_listing_delta.removedTypes', () => {
    const { agents } = deriveAgentTimeline(entries);
    const codeFinder = agents.find((a) => a.agentType === 'code-finder')!;
    expect(codeFinder.availability.some((e) => e.action === 'delisted')).toBe(true);

    const architect = agents.find((a) => a.agentType === 'architect')!;
    expect(architect.availability.some((e) => e.action === 'listed' && e.isInitial === false)).toBe(true);
  });

  it('records an agent_mention as a mentioned event', () => {
    const { agents } = deriveAgentTimeline(entries);
    const architect = agents.find((a) => a.agentType === 'architect')!;
    expect(architect.availability.some((e) => e.action === 'mentioned')).toBe(true);
  });

  it('pairs an Agent launch with its result: agentId, model, totalTokens', () => {
    const { subagentLaunches } = deriveAgentTimeline(entries);
    const launch = subagentLaunches.find((l) => l.toolUseId === 'toolu_agentA');
    expect(launch).toBeDefined();
    expect(launch!.agentType).toBe('generalist');
    expect(launch!.agentId).toBe('syn0000000000001');
    expect(launch!.model).toBe('example-model-large');
    expect(launch!.totalTokens).toBe(42000);
    expect(launch!.isAsync).toBe(true);
    expect(launch!.resultEntryUuid).toBe('e0000000-0000-0000-0000-000000000016');
    expect(launch!.runInBackground).toBe(false);
  });

  it('does not throw when an Agent launch result never arrives, and leaves resultEntryUuid unset', () => {
    const { subagentLaunches } = deriveAgentTimeline(entries);
    const launch = subagentLaunches.find((l) => l.toolUseId === 'toolu_agentB');
    expect(launch).toBeDefined();
    expect(launch!.agentType).toBe('code-finder');
    expect(launch!.resultEntryUuid).toBeUndefined();
    expect(launch!.agentId).toBeUndefined();
    expect(launch!.totalTokens).toBeUndefined();
  });

  it('attaches each launch to its agent type record invocations', () => {
    const { agents } = deriveAgentTimeline(entries);
    const generalist = agents.find((a) => a.agentType === 'generalist')!;
    expect(generalist.invocations.map((l) => l.toolUseId)).toContain('toolu_agentA');
  });

  it('counts attributedTurnCount from matching attributionAgent on sidechain entries', () => {
    const { agents } = deriveAgentTimeline(entries);
    const generalist = agents.find((a) => a.agentType === 'generalist')!;
    expect(generalist.attributedTurnCount).toBe(1);
  });

  it('never mistakes TaskCreate for an Agent launch', () => {
    const { agents, subagentLaunches } = deriveAgentTimeline(entries);
    expect(agents.some((a) => a.agentType === 'TaskCreate')).toBe(false);
    expect(subagentLaunches.some((l) => l.toolUseId === 'toolu_taskcreateA')).toBe(false);
    // Only the two `Agent` tool_use blocks in the fixture produced launches.
    expect(subagentLaunches).toHaveLength(2);
  });

  it('splits a plugin-prefixed agent type in addedTypes into pluginPrefix', () => {
    const listing = c6Attachment(1, {
      type: 'agent_listing_delta',
      isInitial: true,
      addedTypes: ['pluglet:docs-drafter'],
      addedLines: ['- pluglet:docs-drafter: Draft docs for a module. (Tools: All tools)'],
      removedTypes: [],
    });
    const { agents } = deriveAgentTimeline([listing]);
    const drafter = agents.find((a) => a.agentType === 'pluglet:docs-drafter');
    expect(drafter?.pluginPrefix).toBe('pluglet');
    expect(drafter?.listingDescription).toBe('Draft docs for a module.');
    expect(drafter?.listingTools).toBe('All tools');
  });

  it('parses a listing line with no " (Tools: " suffix as description-only', () => {
    const listing = c6Attachment(1, {
      type: 'agent_listing_delta',
      isInitial: false,
      addedTypes: ['solo-agent'],
      addedLines: ['- solo-agent: Just a description with no tools suffix.'],
      removedTypes: [],
    });
    const { agents } = deriveAgentTimeline([listing]);
    const solo = agents.find((a) => a.agentType === 'solo-agent');
    expect(solo?.listingDescription).toBe('Just a description with no tools suffix.');
    expect(solo?.listingTools).toBeUndefined();
  });

  it('leaves listingDescription/listingTools unset for an empty listing line', () => {
    const listing = c6Attachment(1, {
      type: 'agent_listing_delta',
      isInitial: false,
      addedTypes: ['empty-agent'],
      addedLines: [],
      removedTypes: [],
    });
    const { agents } = deriveAgentTimeline([listing]);
    const empty = agents.find((a) => a.agentType === 'empty-agent');
    expect(empty).toBeDefined();
    expect(empty?.listingDescription).toBeUndefined();
    expect(empty?.listingTools).toBeUndefined();
  });

  it('pairs a launch result via the sourceToolUseID fallback when there is no tool_result content block', () => {
    const agentToolUse = c6ToolUse('Agent', { subagent_type: 'docs-drafter' });
    const launchEntry = c6Assistant(1, [agentToolUse]);
    const resultEntry = c6User(2, {
      sourceToolUseID: agentToolUse.id,
      message: { role: 'user', content: 'Plain-text result, no structured tool_result block.' },
      toolUseResult: { agentId: 'agent-fallback-0001', resolvedModel: 'test-model-a', totalTokens: 1200 },
    });

    const { subagentLaunches } = deriveAgentTimeline([launchEntry, resultEntry]);
    const launch = subagentLaunches.find((l) => l.toolUseId === agentToolUse.id);
    expect(launch?.resultEntryUuid).toBe(resultEntry.uuid);
    expect(launch?.agentId).toBe('agent-fallback-0001');
    expect(launch?.model).toBe('test-model-a');
    expect(launch?.totalTokens).toBe(1200);
  });

  it('ignores an agent_mention with an empty agentType', () => {
    const mention = c6Attachment(1, { type: 'agent_mention', agentType: '' });
    const { agents } = deriveAgentTimeline([mention]);
    expect(agents).toEqual([]);
  });

  it('leaves all optional launch fields unset when no result entry ever arrives', () => {
    const agentToolUse = c6ToolUse('Agent', { subagent_type: 'docs-drafter' });
    const launchEntry = c6Assistant(1, [agentToolUse]);

    const { subagentLaunches } = deriveAgentTimeline([launchEntry]);
    const launch = subagentLaunches.find((l) => l.toolUseId === agentToolUse.id);
    expect(launch).toBeDefined();
    expect(launch?.resultEntryUuid).toBeUndefined();
    expect(launch?.agentId).toBeUndefined();
    expect(launch?.model).toBeUndefined();
    expect(launch?.totalTokens).toBeUndefined();
    expect(launch?.isAsync).toBeUndefined();
  });

  it('falls back to an empty agentType string when input.subagent_type is not a string', () => {
    const agentToolUse = c6ToolUse('Agent', { subagent_type: 42 });
    const launchEntry = c6Assistant(1, [agentToolUse]);

    const { subagentLaunches, agents } = deriveAgentTimeline([launchEntry]);
    const launch = subagentLaunches.find((l) => l.toolUseId === agentToolUse.id);
    expect(launch?.agentType).toBe('');
    expect(agents.some((a) => a.agentType === '')).toBe(true);
  });

  it('records runInBackground: true from input.run_in_background', () => {
    const agentToolUse = c6ToolUse('Agent', { subagent_type: 'docs-drafter', run_in_background: true });
    const launchEntry = c6Assistant(1, [agentToolUse]);

    const { subagentLaunches } = deriveAgentTimeline([launchEntry]);
    const launch = subagentLaunches.find((l) => l.toolUseId === agentToolUse.id);
    expect(launch?.runInBackground).toBe(true);
  });
});
