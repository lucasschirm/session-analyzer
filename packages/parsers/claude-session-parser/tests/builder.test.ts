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
import type {
  AgentDefinition,
  ClaudeCodeSettings,
  McpConfig,
  RuleDefinition,
  SkillDefinition,
  SubagentMeta,
} from '../src/types/config.js';

function inlineTranscript(entries: Array<Record<string, unknown>>): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n');
}

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

// ---------------------------------------------------------------------------
// C2 (retry) additions — closing branch-coverage gaps in builder.ts.
// ---------------------------------------------------------------------------

describe('append_threw catch paths (a throwing getter on a field the fold touches)', () => {
  it('appendMcp: catches a throw from within foldMcpServerConfig and records append_threw, never mutating the original', () => {
    const b1 = parseSession(baseSession());
    const before = b1.toSession();

    const throwingConfig = {
      kind: 'mcp-config',
      scope: 'project',
      // The throw happens deep inside the fold (mcpServerNameToNamespace(config.name)),
      // not at the appendMcp entry guard — and it's a non-Error throw, exercising
      // errMessage's `String(err)` fallback branch.
      servers: [
        {
          get name(): string {
            throw 'server-name-explosion';
          },
        },
      ],
      parseErrors: [],
    } as unknown as McpConfig;

    const b2 = b1.appendMcp(throwingConfig);
    const session = b2.toSession();

    const threw = session.parseErrors.find((e) => e.code === 'append_threw');
    expect(threw).toBeDefined();
    expect(threw?.message).toContain('server-name-explosion');

    expect(b1.toSession()).toBe(before);
    expect(before.parseErrors.some((e) => e.code === 'append_threw')).toBe(false);
  });

  it('appendSettings: catches a throw from a parseErrors getter and records append_threw, never mutating the original', () => {
    const b1 = parseSession(baseSession());
    const before = b1.toSession();

    const throwingSettings = {
      kind: 'settings',
      scope: 'project',
      get parseErrors(): never {
        throw new Error('settings-explosion');
      },
    } as unknown as ClaudeCodeSettings;

    const session = b1.appendSettings(throwingSettings).toSession();
    const threw = session.parseErrors.find((e) => e.code === 'append_threw');
    expect(threw).toBeDefined();
    expect(threw?.message).toContain('settings-explosion');

    expect(b1.toSession()).toBe(before);
  });

  it('appendAgent: catches a throw from foldAgentDefinition and records append_threw, never mutating the original', () => {
    const b1 = parseSession(baseSession());
    const before = b1.toSession();

    const throwingAgent = {
      kind: 'agent-definition',
      scope: 'project',
      get name(): never {
        throw new Error('agent-name-explosion');
      },
      parseErrors: [],
    } as unknown as AgentDefinition;

    const session = b1.appendAgent(throwingAgent).toSession();
    const threw = session.parseErrors.find((e) => e.code === 'append_threw');
    expect(threw).toBeDefined();
    expect(threw?.message).toContain('agent-name-explosion');

    expect(b1.toSession()).toBe(before);
  });

  it('appendSkill: catches a throw from skillQualifiedName(def.name) and records append_threw, never mutating the original', () => {
    const b1 = parseSession(baseSession());
    const before = b1.toSession();

    const throwingSkill = {
      kind: 'skill-definition',
      scope: 'project',
      get name(): never {
        throw new Error('skill-name-explosion');
      },
      parseErrors: [],
    } as unknown as SkillDefinition;

    const session = b1.appendSkill(throwingSkill).toSession();
    const threw = session.parseErrors.find((e) => e.code === 'append_threw');
    expect(threw).toBeDefined();
    expect(threw?.message).toContain('skill-name-explosion');

    expect(b1.toSession()).toBe(before);
  });

  it('appendRule: catches a throw from foldRuleDefinition(def.sourcePath) and records append_threw, never mutating the original', () => {
    const b1 = parseSession(baseSession());
    const before = b1.toSession();

    const throwingRule = {
      kind: 'rule-definition',
      scope: 'project',
      get sourcePath(): never {
        throw new Error('rule-path-explosion');
      },
      parseErrors: [],
    } as unknown as RuleDefinition;

    const session = b1.appendRule(throwingRule).toSession();
    const threw = session.parseErrors.find((e) => e.code === 'append_threw');
    expect(threw).toBeDefined();
    expect(threw?.message).toContain('rule-path-explosion');

    expect(b1.toSession()).toBe(before);
  });

  it('appendSubAgent: catches a throw from the enrich() closure reading meta.description and records append_threw, never mutating the original', () => {
    const b1 = parseSession(baseSession());
    const before = b1.toSession();
    // baseSession() already has a subagentLaunches entry with agentId
    // 'agent-abc123' and description undefined (see the immutability describe
    // block above) — enrich() must reach the meta.description read to throw.
    const subSession = parseSessionTranscript(readFixture('t9-subagent-transcript.jsonl'));
    const throwingMeta = {
      get description(): never {
        throw new Error('meta-description-explosion');
      },
      parseErrors: [],
    } as unknown as SubagentMeta;

    const session = b1.appendSubAgent('agent-abc123', subSession, throwingMeta).toSession();
    const threw = session.parseErrors.find((e) => e.code === 'append_threw');
    expect(threw).toBeDefined();
    expect(threw?.message).toContain('meta-description-explosion');

    expect(b1.toSession()).toBe(before);
  });
});

describe('parseErrors ?? [] fallbacks (def.parseErrors is undefined, not just empty)', () => {
  it('appendMcp does not throw and appends nothing when config.parseErrors is undefined', () => {
    const config = { kind: 'mcp-config', scope: 'project', servers: [] } as unknown as McpConfig;
    const before = parseSession(baseSession()).toSession();
    const session = parseSession(baseSession()).appendMcp(config).toSession();
    expect(session.parseErrors).toEqual(before.parseErrors);
  });

  it('appendSettings does not throw and appends nothing when settings.parseErrors is undefined', () => {
    const settings = { kind: 'settings', scope: 'project', raw: {} } as unknown as ClaudeCodeSettings;
    const before = parseSession(baseSession()).toSession();
    const session = parseSession(baseSession()).appendSettings(settings).toSession();
    expect(session.parseErrors).toEqual(before.parseErrors);
  });

  it('appendAgent does not throw and appends nothing when def.parseErrors is undefined', () => {
    const def = {
      kind: 'agent-definition',
      name: 'unmatched-agent-x',
      scope: 'project',
      frontmatter: {},
      body: '',
    } as unknown as AgentDefinition;
    const before = parseSession(baseSession()).toSession();
    const session = parseSession(baseSession()).appendAgent(def).toSession();
    expect(session.parseErrors).toEqual(before.parseErrors);
  });

  it('appendSkill does not throw and appends nothing when def.parseErrors is undefined', () => {
    const def = {
      kind: 'skill-definition',
      name: 'unmatched-skill-x',
      scope: 'project',
      frontmatter: {},
      body: '',
    } as unknown as SkillDefinition;
    const before = parseSession(baseSession()).toSession();
    const session = parseSession(baseSession()).appendSkill(def).toSession();
    expect(session.parseErrors).toEqual(before.parseErrors);
  });

  it('appendRule does not throw and appends nothing when def.parseErrors is undefined', () => {
    const def = {
      kind: 'rule-definition',
      sourcePath: '/home/testuser/projects/orbit-tracker/UNMATCHED-rule-x.md',
      scope: 'project',
      ruleKind: 'rule',
      frontmatter: {},
      globs: [],
      body: '',
    } as unknown as RuleDefinition;
    const before = parseSession(baseSession()).toSession();
    const session = parseSession(baseSession()).appendRule(def).toSession();
    expect(session.parseErrors).toEqual(before.parseErrors);
  });
});

describe('appendSubAgent meta error propagation and matching-by-agentId scoping', () => {
  it('propagates non-empty meta.parseErrors onto the session', () => {
    const subSession = parseSessionTranscript(readFixture('t9-subagent-transcript.jsonl'));
    const session = parseSession(baseSession())
      .appendSubAgent('agent-abc123', subSession, {
        parseErrors: [{ code: 'subagent_meta_error', message: 'Could not fully parse the subagent meta file.' }],
      })
      .toSession();

    expect(session.parseErrors.some((e) => e.code === 'subagent_meta_error')).toBe(true);
  });

  it('enriches only the SubagentLaunchRecord matching agentId, filling only unset fields, leaving a differently-agentId\'d launch untouched', () => {
    // A synthetic two-launch transcript: the first launch already carries
    // description/model (from the tool_use input and toolUseResult), the
    // second carries neither and has a different agentId.
    const transcript = inlineTranscript([
      {
        parentUuid: null,
        isSidechain: false,
        userType: 'external',
        type: 'user',
        message: { role: 'user', content: 'Work on the orbit-tracker telemetry module.' },
        uuid: 'c2-u-0001',
        timestamp: '2026-08-11T09:00:00.000Z',
        sessionId: 'c2-sess-0001',
      },
      {
        parentUuid: 'c2-u-0001',
        isSidechain: false,
        userType: 'external',
        type: 'assistant',
        message: {
          id: 'msg_c2_001',
          model: 'test-model-a',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_c2_agent_x',
              name: 'Agent',
              input: { subagent_type: 'docs-drafter', description: 'Draft the initial doc outline.' },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        uuid: 'c2-a-0001',
        timestamp: '2026-08-11T09:00:01.000Z',
        sessionId: 'c2-sess-0001',
      },
      {
        parentUuid: 'c2-a-0001',
        isSidechain: false,
        userType: 'external',
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c2_agent_x', content: 'Outline drafted.' }] },
        toolUseResult: { agentId: 'agent-x001', resolvedModel: 'sonnet' },
        uuid: 'c2-u-0002',
        timestamp: '2026-08-11T09:00:02.000Z',
        sessionId: 'c2-sess-0001',
      },
      {
        parentUuid: 'c2-u-0002',
        isSidechain: false,
        userType: 'external',
        type: 'assistant',
        message: {
          id: 'msg_c2_002',
          model: 'test-model-a',
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_c2_agent_y', name: 'Agent', input: { subagent_type: 'test-scout' } },
          ],
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        uuid: 'c2-a-0002',
        timestamp: '2026-08-11T09:00:03.000Z',
        sessionId: 'c2-sess-0001',
      },
      {
        parentUuid: 'c2-a-0002',
        isSidechain: false,
        userType: 'external',
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c2_agent_y', content: 'Scouted.' }] },
        toolUseResult: { agentId: 'agent-y002' },
        uuid: 'c2-u-0003',
        timestamp: '2026-08-11T09:00:04.000Z',
        sessionId: 'c2-sess-0001',
      },
    ]);

    const before = parseSessionTranscript(transcript);
    const launchXBefore = before.subagentLaunches.find((l) => l.agentId === 'agent-x001');
    expect(launchXBefore?.description).toBe('Draft the initial doc outline.');
    expect(launchXBefore?.model).toBe('sonnet');
    const launchYBefore = before.subagentLaunches.find((l) => l.agentId === 'agent-y002');
    expect(launchYBefore?.description).toBeUndefined();
    expect(launchYBefore?.model).toBeUndefined();

    const subSession = parseSessionTranscript(readFixture('t9-subagent-transcript.jsonl'));
    const session = parseSession(transcript)
      .appendSubAgent('agent-x001', subSession, {
        description: 'Overridden description that must NOT apply — already set from the transcript.',
        model: 'opus',
        parseErrors: [],
      })
      .toSession();

    const launchX = session.subagentLaunches.find((l) => l.agentId === 'agent-x001');
    // Already-set fields survive untouched — fill-only-when-unset.
    expect(launchX?.description).toBe('Draft the initial doc outline.');
    expect(launchX?.model).toBe('sonnet');

    // The other launch, whose agentId doesn't match, is completely untouched.
    const launchY = session.subagentLaunches.find((l) => l.agentId === 'agent-y002');
    expect(launchY?.description).toBeUndefined();
    expect(launchY?.model).toBeUndefined();
  });
});

describe('appendMcp: toolNamespace ?? fallback on a new record', () => {
  it('derives toolNamespace from the server name when config.toolNamespace is not provided', () => {
    const config = {
      kind: 'mcp-config',
      scope: 'project',
      servers: [
        // toolNamespace deliberately omitted (bypassing the TS type) to
        // exercise the `config.toolNamespace ?? namespace` fallback.
        { name: 'zephyr:tools', transport: 'stdio', command: 'node', raw: {} },
      ],
      parseErrors: [],
    } as unknown as McpConfig;

    const session = parseSession(baseSession()).appendMcp(config).toSession();
    const record = session.mcpServers.find((m) => m.server === 'zephyr:tools');
    expect(record).toBeDefined();
    expect(record?.toolNamespace).toBe('zephyr_tools');
  });
});

describe('skillQualifiedName / foldSkillDefinition branch coverage', () => {
  it('leaves an already-colonized def.name unchanged as the qualified name on a brand-new record', () => {
    const def = {
      kind: 'skill-definition',
      name: 'pluglet:csv-wrangler',
      scope: 'project',
      sourcePath: '/home/testuser/projects/orbit-tracker/.claude/skills/csv-wrangler/SKILL.md',
      description: 'Wrangles CSV files for the orbit-tracker project.',
      frontmatter: {},
      body: '',
      parseErrors: [],
    } as unknown as SkillDefinition;

    const session = parseSession(baseSession()).appendSkill(def).toSession();
    const record = session.skills.find((s) => s.name === 'pluglet:csv-wrangler');
    expect(record).toBeDefined();
    // Colon already present: skillQualifiedName returns def.name unchanged.
    expect(record?.name).toBe('pluglet:csv-wrangler');
    expect(record?.bareName).toBe('csv-wrangler');
    // New-record path also fills displayPath from def.sourcePath.
    expect(record?.displayPath).toBe('/home/testuser/projects/orbit-tracker/.claude/skills/csv-wrangler/SKILL.md');
  });

  it('enriches an existing record (description/displayPath/qualifiedPath, each filled only where unset) then no-ops on a repeat append', () => {
    const def = {
      kind: 'skill-definition',
      name: 'example-skill',
      pluginPrefix: 'pluglet',
      scope: 'project',
      sourcePath: '/home/testuser/projects/orbit-tracker/.claude/skills/example-skill/SKILL.md',
      description: 'A different description the transcript never established.',
      frontmatter: {},
      body: '',
      parseErrors: [],
    } as unknown as SkillDefinition;

    const b1 = parseSession(baseSession()).appendSkill(def);
    const s1 = b1.toSession();
    const record1 = s1.skills.find((s) => s.name === 'example-skill');
    // The transcript's own skill_listing already set a description — not clobbered.
    expect(record1?.description).toBe('Runs the example diagnostic workflow.');
    expect(record1?.displayPath).toBe('/home/testuser/projects/orbit-tracker/.claude/skills/example-skill/SKILL.md');
    // qualifiedPath was unset before this append and def.pluginPrefix is set, so it fills.
    expect(record1?.qualifiedPath).toBe('plugin:pluglet:example-skill');

    // A second, identical append now finds nothing left to fill — patch is
    // empty, and foldSkillDefinition must return the identical array
    // reference rather than a new (equal-but-different) one.
    const b2 = b1.appendSkill(def);
    const s2 = b2.toSession();
    expect(s2.skills).toBe(s1.skills);
  });
});

describe('foldRuleDefinition branch coverage: scope fallback/mapping and field enrichment', () => {
  it('falls back to "Unknown" scope on record creation when def.scope is not a recognized ClaudeScope', () => {
    const bogusDef = {
      kind: 'rule-definition',
      sourcePath: '/home/testuser/projects/orbit-tracker/BOGUS-SCOPE-rule.md',
      scope: 'not-a-real-scope',
      ruleKind: 'rule',
      frontmatter: {},
      globs: [],
      body: '',
      parseErrors: [],
    } as unknown as RuleDefinition;

    const session = parseSession(baseSession()).appendRule(bogusDef).toSession();
    const record = session.rules.find((r) => r.path === '/home/testuser/projects/orbit-tracker/BOGUS-SCOPE-rule.md');
    expect(record?.scope).toBe('Unknown');
  });

  it('fills title/scope/frontmatter/globs only where unset across two appends for the same path, then no-ops on a third', () => {
    const path = '/home/testuser/projects/orbit-tracker/CHANGELOG-policy.md';
    // First def deliberately supplies no title, an empty frontmatter object
    // omitted via cast (undefined), scope 'unknown' (maps to 'Unknown'),
    // and no globs — everything left to fill on a later append.
    const firstDef = {
      kind: 'rule-definition',
      sourcePath: path,
      scope: 'unknown',
      ruleKind: 'rule',
      globs: [],
      body: '',
      parseErrors: [],
    } as unknown as RuleDefinition;

    const b1 = parseSession(baseSession()).appendRule(firstDef);
    const s1 = b1.toSession();
    const created = s1.rules.find((r) => r.path === path);
    expect(created?.title).toBeUndefined();
    expect(created?.frontmatter).toBeUndefined();
    expect(created?.globs).toEqual([]);
    expect(created?.scope).toBe('Unknown');

    const secondDef = {
      kind: 'rule-definition',
      sourcePath: path,
      scope: 'managed',
      ruleKind: 'rule',
      title: 'Changelog Policy',
      frontmatter: { description: 'Changelog update policy.' },
      globs: ['CHANGELOG.md'],
      body: '',
      parseErrors: [],
    } as unknown as RuleDefinition;

    const b2 = b1.appendRule(secondDef);
    const s2 = b2.toSession();
    const enriched = s2.rules.find((r) => r.path === path);
    expect(enriched?.title).toBe('Changelog Policy');
    expect(enriched?.scope).toBe('Managed');
    expect(enriched?.frontmatter).toEqual({ description: 'Changelog update policy.' });
    expect(enriched?.globs).toEqual(['CHANGELOG.md']);
    // Never downgraded: this record's status was 'unknown' both before and
    // after (config-derived rules never reach 'injected').
    expect(enriched?.injectionStatus).toBe('unknown');

    // A third append with the exact same def adds nothing new — patch is
    // empty, so foldRuleDefinition returns the identical records array.
    const b3 = b2.appendRule(secondDef);
    const s3 = b3.toSession();
    expect(s3.rules).toBe(s2.rules);
  });

  it('skips the scope patch when the enrichment def carries an unrecognized scope (mapped is falsy)', () => {
    const path = '/home/testuser/projects/orbit-tracker/UNRECOGNIZED-SCOPE-rule.md';
    const firstDef = {
      kind: 'rule-definition',
      sourcePath: path,
      scope: 'unknown',
      ruleKind: 'rule',
      frontmatter: {},
      globs: [],
      body: '',
      parseErrors: [],
    } as unknown as RuleDefinition;
    const b1 = parseSession(baseSession()).appendRule(firstDef);
    expect(b1.toSession().rules.find((r) => r.path === path)?.scope).toBe('Unknown');

    const secondDef = {
      kind: 'rule-definition',
      sourcePath: path,
      scope: 'still-not-a-real-scope',
      ruleKind: 'rule',
      frontmatter: {},
      globs: [],
      body: '',
      parseErrors: [],
    } as unknown as RuleDefinition;
    const session = b1.appendRule(secondDef).toSession();
    // rec.scope stayed 'Unknown' — the outer condition was true (rec.scope
    // === 'Unknown'), but `mapped` was falsy for the bogus scope, so the
    // patch never applied.
    expect(session.rules.find((r) => r.path === path)?.scope).toBe('Unknown');
  });
});
