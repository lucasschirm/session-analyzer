import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { deriveSkillTimeline } from '../src/session/timelines/skills.js';
import { deriveAgentTimeline } from '../src/session/timelines/agents.js';
import type { ClaudeCodeEntry } from '../src/types/session.js';
import type { SkillAvailabilityRecord } from '../src/types/timeline.js';

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
});
