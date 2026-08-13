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
 * rather than depending on it. The fixture itself is still distilled from
 * real corpus shapes (see file header comment in the fixture and the PR
 * description's evidence notes), just pre-shaped as entry objects instead
 * of raw JSONL text.
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
    const debugging = findSkill(records, 'superpowers:systematic-debugging');
    const initialListed = debugging.availability.find((e) => e.action === 'listed' && e.isInitial === true);
    expect(initialListed).toBeDefined();
    expect(debugging.description).toContain('before proposing fixes');
  });

  it('records a mid-session skill_listing with isInitial false', () => {
    const records = deriveSkillTimeline(entries);
    const debugging = findSkill(records, 'superpowers:systematic-debugging');
    const midListed = debugging.availability.filter((e) => e.action === 'listed');
    expect(midListed.length).toBe(2);
    expect(midListed[1].isInitial).toBe(false);
  });

  it('detects delisting by diffing successive skill_listing attachments', () => {
    const records = deriveSkillTimeline(entries);
    const dataviz = findSkill(records, 'dataviz');
    const delisted = dataviz.availability.filter((e) => e.action === 'delisted');
    expect(delisted).toHaveLength(1);

    // A newly listed skill in the second delta is not itself delisted.
    const loop = findSkill(records, 'loop');
    expect(loop.availability.some((e) => e.action === 'delisted')).toBe(false);
    expect(loop.availability.some((e) => e.action === 'listed' && e.isInitial === false)).toBe(true);
  });

  it('splits plugin-prefixed vs bare skill names', () => {
    const records = deriveSkillTimeline(entries);
    const debugging = findSkill(records, 'superpowers:systematic-debugging');
    expect(debugging.pluginPrefix).toBe('superpowers');
    expect(debugging.bareName).toBe('systematic-debugging');

    const dataviz = findSkill(records, 'dataviz');
    expect(dataviz.pluginPrefix).toBeUndefined();
    expect(dataviz.bareName).toBe('dataviz');
  });

  it('pairs a Skill invocation with its isMeta expansion and marks it launched', () => {
    const records = deriveSkillTimeline(entries);
    const debugging = findSkill(records, 'superpowers:systematic-debugging');

    expect(debugging.invocationCount).toBe(1);
    const [invocation] = debugging.invocations;
    expect(invocation.toolUseId).toBe('toolu_skillA');
    expect(invocation.args).toBe('Debug the failing import job');
    expect(invocation.launched).toBe(true);

    expect(debugging.injectedContent).toContain('# Systematic Debugging');
    expect(debugging.sourceDir).toBe(
      '/Users/dev/.claude/plugins/cache/claude-plugins-official/superpowers/6.1.1/skills/systematic-debugging',
    );
    expect(debugging.availability.some((e) => e.action === 'expanded')).toBe(true);
  });

  it('leaves a Skill invocation with no expansion as launched: false, with no injectedContent', () => {
    const records = deriveSkillTimeline(entries);
    const unknown = findSkill(records, 'bhzai-create-driver');

    expect(unknown.invocationCount).toBe(1);
    expect(unknown.invocations[0].launched).toBe(false);
    expect(unknown.injectedContent).toBeUndefined();
    expect(unknown.availability.some((e) => e.action === 'expanded')).toBe(false);
  });

  it('ties a discovered skill to its on-disk directory via dynamic_skill', () => {
    const records = deriveSkillTimeline(entries);
    const tableMeta = findSkill(records, 'manage-table-metadata');
    expect(tableMeta.sourceDir).toBe('/Users/dev/project/.claude/skills');
    expect(tableMeta.displayPath).toBe('project/.claude/skills');
    expect(tableMeta.availability.some((e) => e.action === 'discovered')).toBe(true);
  });

  it('fills injectedContent/qualifiedPath from invoked_skills even without a listing', () => {
    const records = deriveSkillTimeline(entries);
    const devin = findSkill(records, 'delegating-to-devin');
    expect(devin.qualifiedPath).toBe('projectSettings:delegating-to-devin');
    expect(devin.injectedContent).toContain('Delegating to Devin');
    expect(devin.bareName).toBe('delegating-to-devin');
  });

  it('counts attributedTurnCount from matching attributionSkill on assistant entries', () => {
    const records = deriveSkillTimeline(entries);
    const debugging = findSkill(records, 'superpowers:systematic-debugging');
    expect(debugging.attributedTurnCount).toBe(1);
  });

  it('never conflates a skill record with a tool record shape (no `tool`/`mcpServer` fields)', () => {
    const records = deriveSkillTimeline(entries);
    const debugging = findSkill(records, 'superpowers:systematic-debugging') as unknown as Record<string, unknown>;
    expect(debugging.tool).toBeUndefined();
    expect(debugging.mcpServer).toBeUndefined();
  });
});

describe('deriveAgentTimeline', () => {
  it('returns empty agents/subagentLaunches for an empty entry list', () => {
    expect(deriveAgentTimeline([])).toEqual({ agents: [], subagentLaunches: [] });
  });

  it('records the initial agent_listing_delta with isInitial true and parses listingDescription/listingTools', () => {
    const { agents } = deriveAgentTimeline(entries);
    const generalPurpose = agents.find((a) => a.agentType === 'general-purpose');
    expect(generalPurpose).toBeDefined();
    expect(generalPurpose!.listingDescription).toContain('General-purpose agent');
    expect(generalPurpose!.listingTools).toBe('All tools');
    expect(generalPurpose!.availability.some((e) => e.action === 'listed' && e.isInitial === true)).toBe(true);

    const explore = agents.find((a) => a.agentType === 'Explore');
    expect(explore!.listingTools).toBe('Bash, Read, Grep, Glob');
  });

  it('detects delisting directly from agent_listing_delta.removedTypes', () => {
    const { agents } = deriveAgentTimeline(entries);
    const explore = agents.find((a) => a.agentType === 'Explore')!;
    expect(explore.availability.some((e) => e.action === 'delisted')).toBe(true);

    const plan = agents.find((a) => a.agentType === 'Plan')!;
    expect(plan.availability.some((e) => e.action === 'listed' && e.isInitial === false)).toBe(true);
  });

  it('records an agent_mention as a mentioned event', () => {
    const { agents } = deriveAgentTimeline(entries);
    const plan = agents.find((a) => a.agentType === 'Plan')!;
    expect(plan.availability.some((e) => e.action === 'mentioned')).toBe(true);
  });

  it('pairs an Agent launch with its result: agentId, model, totalTokens', () => {
    const { subagentLaunches } = deriveAgentTimeline(entries);
    const launch = subagentLaunches.find((l) => l.toolUseId === 'toolu_agentA');
    expect(launch).toBeDefined();
    expect(launch!.agentType).toBe('general-purpose');
    expect(launch!.agentId).toBe('a7825f4a0ca1e001a');
    expect(launch!.model).toBe('claude-fable-5');
    expect(launch!.totalTokens).toBe(77668);
    expect(launch!.isAsync).toBe(true);
    expect(launch!.resultEntryUuid).toBe('e0000000-0000-0000-0000-000000000016');
    expect(launch!.runInBackground).toBe(false);
  });

  it('does not throw when an Agent launch result never arrives, and leaves resultEntryUuid unset', () => {
    const { subagentLaunches } = deriveAgentTimeline(entries);
    const launch = subagentLaunches.find((l) => l.toolUseId === 'toolu_agentB');
    expect(launch).toBeDefined();
    expect(launch!.agentType).toBe('Explore');
    expect(launch!.resultEntryUuid).toBeUndefined();
    expect(launch!.agentId).toBeUndefined();
    expect(launch!.totalTokens).toBeUndefined();
  });

  it('attaches each launch to its agent type record invocations', () => {
    const { agents } = deriveAgentTimeline(entries);
    const generalPurpose = agents.find((a) => a.agentType === 'general-purpose')!;
    expect(generalPurpose.invocations.map((l) => l.toolUseId)).toContain('toolu_agentA');
  });

  it('counts attributedTurnCount from matching attributionAgent on sidechain entries', () => {
    const { agents } = deriveAgentTimeline(entries);
    const generalPurpose = agents.find((a) => a.agentType === 'general-purpose')!;
    expect(generalPurpose.attributedTurnCount).toBe(1);
  });

  it('never mistakes TaskCreate for an Agent launch', () => {
    const { agents, subagentLaunches } = deriveAgentTimeline(entries);
    expect(agents.some((a) => a.agentType === 'TaskCreate')).toBe(false);
    expect(subagentLaunches.some((l) => l.toolUseId === 'toolu_taskcreateA')).toBe(false);
    // Only the two real `Agent` tool_use blocks in the fixture produced launches.
    expect(subagentLaunches).toHaveLength(2);
  });
});
