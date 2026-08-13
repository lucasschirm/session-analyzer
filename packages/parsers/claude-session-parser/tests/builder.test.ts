import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseSession } from '../src/session/builder.js';
import { buildConfigSnapshot } from '../src/config/snapshot.js';
import { parseAgentDefinition } from '../src/config/agent-definition.js';
import { parseSkillDefinition } from '../src/config/skill-definition.js';
import { parseRuleDefinition } from '../src/config/rule-definition.js';
import { parseMcp } from '../src/config/mcp-config.js';
import { parseSettings } from '../src/config/settings.js';
import { parseSessionTranscript } from '../src/session/parse-transcript.js';
import type { ClaudeCodeSettings, McpConfig } from '../src/types/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

function baseSession() {
  return readFixture('t9-session-timeline.jsonl');
}

describe('ClaudeSessionBuilder immutability', () => {
  it('never mutates an earlier builder or its session across an appendX call', () => {
    const b1 = parseSession(baseSession());
    const before = b1.toSession();
    const beforeSnapshot = JSON.parse(JSON.stringify(before));

    const agentDef = parseAgentDefinition(readFixture('t9-agent-definition.md'), '/Users/dev/example-project/.claude/agents/example-agent.md', 'project');
    const b2 = b1.appendMcp(parseMcp(readFixture('t9-mcp-config.json'), 'project'))
      .appendSettings(parseSettings(readFixture('t9-settings-project.json'), 'project'))
      .appendAgent(agentDef);

    expect(b2).not.toBe(b1);
    expect(b2.toSession()).not.toBe(before);
    // The original builder's session is byte-identical to what it was
    // before any appendX call was ever made on any builder derived from it.
    expect(b1.toSession()).toBe(before);
    expect(JSON.parse(JSON.stringify(b1.toSession()))).toEqual(beforeSnapshot);
  });

  it('does not mutate the AgentAvailabilityRecord array in place on appendAgent', () => {
    const b1 = parseSession(baseSession());
    const originalAgents = b1.toSession().agents;
    const agentDef = parseAgentDefinition(readFixture('t9-agent-definition.md'), undefined, 'project');

    const b2 = b1.appendAgent(agentDef);

    expect(b1.toSession().agents).toBe(originalAgents);
    expect(b1.toSession().agents[0].definition).toBeUndefined();
    expect(b2.toSession().agents).not.toBe(originalAgents);
    expect(b2.toSession().agents[0].definition?.name).toBe('example-agent');
  });
});

describe('ClaudeSessionBuilder full chain (spec §4 usage example)', () => {
  it('folds appendMcp + appendSettings + appendAgent(s) + appendSkill(s) + appendRule(s) + appendSubAgent together', () => {
    const agentDef = parseAgentDefinition(readFixture('t9-agent-definition.md'), '/Users/dev/example-project/.claude/agents/example-agent.md', 'project');
    const skillDef = parseSkillDefinition(readFixture('t9-skill-definition.md'), '/Users/dev/example-project/.claude/skills/example-skill/SKILL.md', 'project');
    const ruleDef = parseRuleDefinition(
      readFixture('t9-rule-definition.md'),
      '/Users/dev/example-project/.claude/rules/existing-rule.md',
      'project',
    );
    const mcpConfig = parseMcp(readFixture('t9-mcp-config.json'), 'project');
    const settings = parseSettings(readFixture('t9-settings-project.json'), 'project');

    const subSession = parseSessionTranscript(readFixture('t9-subagent-transcript.jsonl'));

    const session = parseSession(baseSession())
      .appendMcp(mcpConfig)
      .appendSettings(settings)
      .appendAgents([agentDef])
      .appendSkills([skillDef])
      .appendRules([ruleDef])
      .appendSubAgent('agent-abc123', subSession, {
        agentType: 'example-agent',
        description: 'Review the widget module for correctness bugs.',
        toolUseId: 'toolu_agent1',
        spawnDepth: 1,
        model: 'sonnet',
        parseErrors: [],
      })
      .toSession();

    expect(session.agents.find((a) => a.agentType === 'example-agent')?.definition?.name).toBe('example-agent');
    // The transcript's own skill_listing already established a description
    // ("Runs the example diagnostic workflow.") — appendSkill must not
    // clobber it with the (different) definition-derived one.
    expect(session.skills.find((s) => s.name === 'example-skill')?.description).toBe(
      'Runs the example diagnostic workflow.',
    );
    expect(session.rules.find((r) => r.path === '/Users/dev/example-project/.claude/rules/existing-rule.md')?.injectionStatus).toBe(
      'injected',
    );
    expect(session.mcpServers.find((m) => m.server === 'acme:mcp')?.config?.command).toBe('node');
    expect(session.settings?.[0].scope).toBe('project');
    expect(session.subagentSessions?.['agent-abc123']).toBe(subSession);

    const launch = session.subagentLaunches.find((l) => l.agentId === 'agent-abc123');
    expect(launch?.description).toBe('Review the widget module for correctness bugs.');
    expect(launch?.model).toBe('sonnet');
    // Enrichment must be visible from the AgentAvailabilityRecord's own
    // `.invocations` view too, not just the flat `subagentLaunches` list.
    const agentInvocation = session.agents
      .find((a) => a.agentType === 'example-agent')
      ?.invocations.find((l) => l.agentId === 'agent-abc123');
    expect(agentInvocation?.description).toBe('Review the widget module for correctness bugs.');
  });
});

describe('appendMcp', () => {
  it('joins a McpServerConfig onto the matching McpServerRecord by literal name', () => {
    const session = parseSession(baseSession())
      .appendMcp(parseMcp(readFixture('t9-mcp-config.json'), 'project'))
      .toSession();

    const record = session.mcpServers.find((m) => m.server === 'acme:mcp');
    expect(record).toBeDefined();
    expect(record?.config?.command).toBe('node');
    expect(record?.config?.args).toEqual(['tools/acme-mcp/dist/index.js']);
    // The literal-name join must not create a second, duplicate record.
    expect(session.mcpServers.filter((m) => m.server === 'acme:mcp')).toHaveLength(1);
  });

  it('falls back to mcpServerNameToNamespace(config.name) === record.toolNamespace when the literal name does not match', () => {
    // This session only ever saw the tool invoked as `mcp__acme_mcp__...`
    // with no mcp_instructions_delta/attribution signal at all, so
    // deriveMcpTimeline could not resolve a literal server name — the
    // resulting record's own `server` field IS the bare namespace
    // ("acme_mcp"), not the colon form. A `.mcp.json` config declaring the
    // canonical colon-form name ("acme:mcp") must still join to it via the
    // namespace fallback, not create a second unmatched record.
    const session = parseSession(readFixture('t9-mcp-invocation-only.jsonl')).toSession();
    expect(session.mcpServers).toHaveLength(1);
    expect(session.mcpServers[0].server).toBe('acme_mcp');
    expect(session.mcpServers[0].toolNamespace).toBe('acme_mcp');

    const mcpConfig: McpConfig = {
      kind: 'mcp-config',
      scope: 'project',
      servers: [
        { name: 'acme:mcp', toolNamespace: 'acme_mcp', transport: 'stdio', command: 'node', raw: {} },
      ],
      parseErrors: [],
    };

    const result = parseSession(readFixture('t9-mcp-invocation-only.jsonl')).appendMcp(mcpConfig).toSession();
    expect(result.mcpServers).toHaveLength(1);
    expect(result.mcpServers[0].server).toBe('acme_mcp');
    expect(result.mcpServers[0].config?.name).toBe('acme:mcp');
  });

  it('surfaces a config with no matching record as a new McpServerRecord with empty availability', () => {
    const session = parseSession(baseSession())
      .appendMcp(parseMcp(readFixture('t9-mcp-config.json'), 'project'))
      .toSession();

    const unmatched = session.mcpServers.find((m) => m.server === 'unmatched-server');
    expect(unmatched).toBeDefined();
    expect(unmatched?.availability).toEqual([]);
    expect(unmatched?.config?.command).toBe('node');
  });

  it('never throws on malformed input and records a ParseError instead', () => {
    const builder = parseSession(baseSession());
    expect(() => builder.appendMcp(null as unknown as McpConfig)).not.toThrow();
    expect(() => builder.appendMcp({} as unknown as McpConfig)).not.toThrow();

    const result = builder.appendMcp(null as unknown as McpConfig).toSession();
    expect(result.parseErrors.some((e) => e.code === 'invalid_append_input')).toBe(true);
    // The original builder's session must still be untouched.
    expect(builder.toSession().parseErrors.some((e) => e.code === 'invalid_append_input')).toBe(false);
  });
});

describe('appendAgent(s)', () => {
  it('fills AgentAvailabilityRecord.definition where def.name matches agentType', () => {
    const agentDef = parseAgentDefinition(readFixture('t9-agent-definition.md'), undefined, 'project');
    const session = parseSession(baseSession()).appendAgent(agentDef).toSession();

    const record = session.agents.find((a) => a.agentType === 'example-agent');
    expect(record?.definition?.name).toBe('example-agent');
    expect(record?.definition?.model).toBe('sonnet');
    // Transcript-derived fields survive untouched.
    expect(record?.listingDescription).toContain('Reviews widget code');
  });

  it('surfaces a non-matching agent definition as its own new record rather than dropping it', () => {
    const unmatchedDef = parseAgentDefinition(readFixture('t9-agent-definition-unmatched.md'), undefined, 'project');
    const session = parseSession(baseSession()).appendAgent(unmatchedDef).toSession();

    const record = session.agents.find((a) => a.agentType === 'example-formatter');
    expect(record).toBeDefined();
    expect(record?.definition?.name).toBe('example-formatter');
    expect(record?.availability).toEqual([]);
    expect(record?.invocations).toEqual([]);
  });
});

describe('appendSkill(s)', () => {
  it('enriches the matching SkillAvailabilityRecord (path fields) without clobbering a description the transcript already established', () => {
    const skillDef = parseSkillDefinition(
      readFixture('t9-skill-definition.md'),
      '/Users/dev/example-project/.claude/skills/example-skill/SKILL.md',
      'project',
    );
    const session = parseSession(baseSession()).appendSkill(skillDef).toSession();

    const record = session.skills.find((s) => s.name === 'example-skill');
    // The transcript's own skill_listing content already carries a
    // description ("Runs the example diagnostic workflow.") for this skill —
    // the definition's different description ("...end to end.") must NOT
    // overwrite it.
    expect(record?.description).toBe('Runs the example diagnostic workflow.');
    // `displayPath`, which the transcript never set, IS filled in.
    expect(record?.displayPath).toBe('/Users/dev/example-project/.claude/skills/example-skill/SKILL.md');
    // Transcript-established availability must survive.
    expect(record?.availability.length).toBeGreaterThan(0);
  });

  it('leaves an already-established description alone across repeated appends (idempotent enrichment, not a duplicate record)', () => {
    const transcript = parseSessionTranscript(baseSession());
    const existingDescription = transcript.skills.find((s) => s.name === 'example-skill')?.description;
    expect(existingDescription).toBe('Runs the example diagnostic workflow.');

    const skillDef = parseSkillDefinition(readFixture('t9-skill-definition.md'), undefined, 'project');
    const session = parseSession(baseSession()).appendSkill(skillDef).appendSkill(skillDef).toSession();

    expect(session.skills.filter((s) => s.name === 'example-skill')).toHaveLength(1);
    expect(session.skills.find((s) => s.name === 'example-skill')?.description).toBe(existingDescription);
  });

  it('surfaces a non-matching skill definition as its own new record', () => {
    const unmatchedDef = parseSkillDefinition(readFixture('t9-skill-definition-unmatched.md'), undefined, 'project');
    const session = parseSession(baseSession()).appendSkill(unmatchedDef).toSession();

    const record = session.skills.find((s) => s.bareName === 'example-packager');
    expect(record).toBeDefined();
    expect(record?.description).toBe('Packages example build artifacts for release.');
  });
});

describe('appendRule(s)', () => {
  it('adds a brand-new config-derived rule with injectionStatus "unknown", never "available"', () => {
    const ruleDef = parseRuleDefinition(readFixture('t9-rule-definition-new.md'), '/Users/dev/example-project/CHANGELOG-policy.md', 'project');
    const session = parseSession(baseSession()).appendRule(ruleDef).toSession();

    const record = session.rules.find((r) => r.path === '/Users/dev/example-project/CHANGELOG-policy.md');
    expect(record).toBeDefined();
    expect(record?.injectionStatus).toBe('unknown');
    expect(record?.origin).toBe('config_inventory');
  });

  it('enriches a rule already established via nested_memory without ever downgrading "injected"', () => {
    const ruleDef = parseRuleDefinition(
      readFixture('t9-rule-definition.md'),
      '/Users/dev/example-project/.claude/rules/existing-rule.md',
      'project',
    );

    const before = parseSessionTranscript(baseSession());
    const beforeRecord = before.rules.find((r) => r.path === '/Users/dev/example-project/.claude/rules/existing-rule.md');
    expect(beforeRecord?.injectionStatus).toBe('injected');

    const session = parseSession(baseSession()).appendRule(ruleDef).toSession();
    const record = session.rules.find((r) => r.path === '/Users/dev/example-project/.claude/rules/existing-rule.md');

    expect(record?.injectionStatus).toBe('injected');
    expect(record?.origin).toBe('nested_memory');
    // No duplicate record was created for the same path.
    expect(session.rules.filter((r) => r.path === '/Users/dev/example-project/.claude/rules/existing-rule.md')).toHaveLength(1);
  });
});

describe('appendSubAgent', () => {
  it('keys the sub-session by agentId, joining SubagentLaunchRecord.agentId', () => {
    const subSession = parseSessionTranscript(readFixture('t9-subagent-transcript.jsonl'));
    const session = parseSession(baseSession()).appendSubAgent('agent-abc123', subSession).toSession();

    expect(session.subagentSessions?.['agent-abc123']).toBe(subSession);
    const launch = session.subagentLaunches.find((l) => l.agentId === 'agent-abc123');
    expect(launch).toBeDefined();
  });

  it('fills in missing description/model from SubagentMeta without clobbering transcript-derived values', () => {
    const subSession = parseSessionTranscript(readFixture('t9-subagent-transcript.jsonl'));
    const before = parseSessionTranscript(baseSession());
    const beforeLaunch = before.subagentLaunches.find((l) => l.agentId === 'agent-abc123');
    expect(beforeLaunch?.description).toBeUndefined();
    expect(beforeLaunch?.model).toBeUndefined();

    const session = parseSession(baseSession())
      .appendSubAgent('agent-abc123', subSession, {
        description: 'Review the widget module for correctness bugs.',
        model: 'sonnet',
        parseErrors: [],
      })
      .toSession();

    const launch = session.subagentLaunches.find((l) => l.agentId === 'agent-abc123');
    expect(launch?.description).toBe('Review the widget module for correctness bugs.');
    expect(launch?.model).toBe('sonnet');
  });

  it('never throws when agentId matches no SubagentLaunchRecord, and still stores the sub-session', () => {
    const subSession = parseSessionTranscript(readFixture('t9-subagent-transcript.jsonl'));
    const builder = parseSession(baseSession());

    expect(() => builder.appendSubAgent('agent-does-not-exist', subSession)).not.toThrow();
    const session = builder.appendSubAgent('agent-does-not-exist', subSession).toSession();
    expect(session.subagentSessions?.['agent-does-not-exist']).toBe(subSession);
  });
});

describe('appendSettings', () => {
  it('attaches settings and does not fabricate a PermissionModeChange timeline event', () => {
    const settings = parseSettings(readFixture('t9-settings-project.json'), 'project');
    expect(settings.permissions?.defaultMode).toBe('auto');

    const before = parseSessionTranscript(baseSession());
    const session = parseSession(baseSession()).appendSettings(settings).toSession();

    expect(session.settings).toEqual([settings]);
    expect(session.permissionModes).toEqual(before.permissionModes);
  });
});

describe('never throw on garbage appendX input', () => {
  it('every appendX records a ParseError instead of throwing on a garbage value', () => {
    const builder = parseSession(baseSession());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const garbage = 42 as any;

    expect(() => builder.appendMcp(garbage)).not.toThrow();
    expect(() => builder.appendSettings(garbage)).not.toThrow();
    expect(() => builder.appendAgent(garbage)).not.toThrow();
    expect(() => builder.appendAgents(garbage)).not.toThrow();
    expect(() => builder.appendSkill(garbage)).not.toThrow();
    expect(() => builder.appendSkills(garbage)).not.toThrow();
    expect(() => builder.appendRule(garbage)).not.toThrow();
    expect(() => builder.appendRules(garbage)).not.toThrow();
    expect(() => builder.appendSubAgent('x', garbage)).not.toThrow();
    expect(() => builder.appendSubAgent(garbage, garbage)).not.toThrow();

    expect(builder.appendMcp(garbage).toSession().parseErrors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildConfigSnapshot
// ---------------------------------------------------------------------------

describe('buildConfigSnapshot', () => {
  it('merges effectiveSettings with precedence managed < user < project < local', () => {
    const managed = parseSettings(readFixture('t9-settings-managed.json'), 'managed');
    const user = parseSettings(readFixture('t9-settings-user.json'), 'user');
    const project = parseSettings(readFixture('t9-settings-project.json'), 'project');
    const local = parseSettings(readFixture('t9-settings-local.json'), 'local');

    // Deliberately out of scope-precedence order in the input array, to
    // prove the merge sorts by scope rather than trusting array order.
    const snapshot = buildConfigSnapshot([local, managed, user, project]);

    // `model`: last (highest-precedence) scope that set it wins. `local`
    // never sets `model`, so `project`'s absence + `user`'s "sonnet" means
    // "sonnet" should win over managed's "opus".
    expect(snapshot.effectiveSettings.model).toBe('sonnet');

    // `permissions.defaultMode`: single-value, last (highest-precedence)
    // wins -> local's "acceptEdits" beats project's "auto".
    expect(snapshot.effectiveSettings.permissions?.defaultMode).toBe('acceptEdits');

    // `permissions.allow`/`.deny`: concatenate + de-dupe across scopes,
    // never silently replaced by a narrower scope.
    expect(snapshot.effectiveSettings.permissions?.deny).toEqual(['Bash(rm -rf *)']);
    expect(snapshot.effectiveSettings.permissions?.allow).toEqual(['Read', 'Bash(git *)']);

    // `env`: per-key merge, later scope wins per key, earlier-only keys survive.
    expect(snapshot.effectiveSettings.env).toEqual({
      MANAGED_FLAG: '1',
      USER_FLAG: 'overridden-by-local',
      PROJECT_FLAG: '1',
      LOCAL_SECRET: 'sk-fake-anonymized-0000000000000000',
    });

    expect(snapshot.effectiveSettings.scope).toBe('local');
  });

  it('keys agentsByName/skillsByName/mcpServersByName with last-wins on duplicate names', () => {
    const firstAgent = parseAgentDefinition(readFixture('t9-agent-definition.md'), '/Users/dev/example-project/.claude/agents/example-agent.md', 'project');
    const secondAgent = parseAgentDefinition(
      '---\nname: "example-agent"\ndescription: "A different, later definition of the same agent name."\nmodel: opus\n---\n\nOverride body.\n',
      '/Users/dev/example-project/.claude/agents-override/example-agent.md',
      'local',
    );

    const mcp = parseMcp(readFixture('t9-mcp-config.json'), 'project');

    const snapshot = buildConfigSnapshot([firstAgent, secondAgent, mcp]);

    expect(snapshot.agentsByName['example-agent'].description).toBe('A different, later definition of the same agent name.');
    expect(snapshot.mcpServersByName['acme:mcp'].command).toBe('node');
    expect(snapshot.mcpServersByName['unmatched-server']).toBeDefined();
  });

  it('collects agent/skill/rule/mcp/settings parseErrors into the owning inventory rather than dropping them', () => {
    const badMcp = parseMcp('not valid json {{{', 'project', '/Users/dev/example-project/.claude/.mcp.json');
    expect(badMcp.parseErrors.length).toBeGreaterThan(0);

    const snapshot = buildConfigSnapshot([badMcp]);
    const inventory = snapshot.inventories.find((inv) => inv.mcp === badMcp);
    expect(inventory?.parseErrors.length).toBeGreaterThan(0);
  });

  it('buckets settings.local.json (scope "local") into localSettings alongside a sibling settings bucket', () => {
    const project = parseSettings(readFixture('t9-settings-project.json'), 'project', '/Users/dev/example-project/.claude/settings.json');
    const local = parseSettings(readFixture('t9-settings-local.json'), 'local', '/Users/dev/example-project/.claude/settings.local.json');

    const snapshot = buildConfigSnapshot([project, local]);

    expect(snapshot.inventories).toHaveLength(1);
    expect(snapshot.inventories[0].settings).toBe(project);
    expect(snapshot.inventories[0].localSettings).toBe(local);
    expect(snapshot.inventories[0].scope).toBe('project');
  });

  it('returns a valid empty snapshot for empty input without throwing', () => {
    expect(() => buildConfigSnapshot([])).not.toThrow();
    const snapshot = buildConfigSnapshot([]);
    expect(snapshot.inventories).toEqual([]);
    expect(snapshot.agentsByName).toEqual({});
    expect(snapshot.skillsByName).toEqual({});
    expect(snapshot.mcpServersByName).toEqual({});
    expect(snapshot.effectiveSettings.kind).toBe('settings');
    expect(snapshot.effectiveSettings.raw).toEqual({});
  });

  it('never throws on garbage input and still returns a valid snapshot', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const garbageInput = [null, undefined, 42, 'oops', [1, 2, 3], { kind: 'not-a-real-kind' }, {}] as any;

    expect(() => buildConfigSnapshot(garbageInput)).not.toThrow();
    const snapshot = buildConfigSnapshot(garbageInput);

    expect(snapshot.agentsByName).toEqual({});
    expect(snapshot.skillsByName).toEqual({});
    expect(snapshot.mcpServersByName).toEqual({});
    // Nothing was silently dropped: every garbage item is accounted for
    // somewhere in an inventory's `unrecognized`/`parseErrors`.
    const totalUnrecognized = snapshot.inventories.reduce((n, inv) => n + inv.unrecognized.length, 0);
    expect(totalUnrecognized).toBe(garbageInput.length);
  });

  it('never throws when handed a non-array', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => buildConfigSnapshot(null as any)).not.toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = buildConfigSnapshot(null as any);
    expect(snapshot.inventories).toEqual([]);
  });
});
