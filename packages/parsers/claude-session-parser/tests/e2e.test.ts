/**
 * End-to-end test (chunk C7) — spec `coverage-plan.md` §4.
 *
 * One coherent synthetic session (project `orbit-tracker`, session
 * `e2e-sess-0001`, git branch `feat/telemetry`) pushed through the entire
 * public API surface, imported exclusively from the package barrel
 * (`../src/index.js`) so the barrel's own re-exports are exercised too.
 *
 * All fixture content under `tests/fixtures/e2e-*` is fully synthetic —
 * invented project/agent/skill/MCP/marketplace names, invented prose,
 * invented paths. See `tests/fixtures/README.md`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  detectClaudeCode,
  detectClaudeCodeArtifact,
  parseSessionTranscript,
  parseSubagentMeta,
  parseSettings,
  parseMcp,
  parseAgentDefinition,
  parseSkillDefinition,
  parseRuleDefinition,
  parsePluginMarketplace,
  parseSession,
  buildConfigSnapshot,
} from '../src/index.js';
import type {
  AssistantEntry,
  AttachmentEntry,
  ClaudeCodeSession,
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

/** Locates the 1-based line number of the first physical line containing
 *  `needle` in `content` — computed from the fixture text itself rather
 *  than hand-counted, so the test never depends on a manually-maintained
 *  line count staying in sync with the fixture. */
function lineNumberOf(content: string, needle: string): number {
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.includes(needle));
  if (idx === -1) throw new Error(`fixture line containing ${JSON.stringify(needle)} not found`);
  return idx + 1;
}

// ---------------------------------------------------------------------------
// Fixture content
// ---------------------------------------------------------------------------

const mainContent = readFixture('e2e-main-session.jsonl');
const subagentContent = readFixture('e2e-subagent-transcript.jsonl');
const subagentMetaContent = readFixture('e2e-subagent-meta.json');
const settingsUserContent = readFixture('e2e-settings-user.json');
const settingsProjectContent = readFixture('e2e-settings-project.json');
const mcpContent = readFixture('e2e-mcp.json');
const agentDocsDrafterContent = readFixture('e2e-agent-docs-drafter.md');
const skillCsvWranglerContent = readFixture('e2e-skill-csv-wrangler.md');
const ruleStyleContent = readFixture('e2e-rule-style.md');
const marketplaceContent = readFixture('e2e-marketplace.json');

const AGENT_SOURCE_PATH = '/home/testuser/.claude/agents/docs-drafter.md';
const SKILL_SOURCE_PATH = '/home/testuser/.claude/skills/csv-wrangler/SKILL.md';
const RULE_SOURCE_PATH = '/home/testuser/projects/orbit-tracker/.claude/rules/style.md';
const SETTINGS_USER_PATH = '/home/testuser/.claude/settings.json';
const SETTINGS_PROJECT_PATH = '/home/testuser/projects/orbit-tracker/.claude/settings.json';
const MCP_SOURCE_PATH = '/home/testuser/projects/orbit-tracker/.mcp.json';
const MARKETPLACE_SOURCE_PATH = '/home/testuser/projects/orbit-tracker/.claude-plugin/marketplace.json';

// ---------------------------------------------------------------------------
// Assertion 1: detection round-trip — every fixture classifies to its own
// kind; the main transcript -> 'session-transcript', the subagent transcript
// -> 'subagent-transcript' via CONTENT (isSidechain on every entry), not path
// (no relativePath/fileName hint is passed for it below).
// ---------------------------------------------------------------------------

describe('assertion 1 — detection round-trip', () => {
  it('classifies every fixture to its own artifact kind', () => {
    expect(detectClaudeCode(mainContent)).toBe(true);
    expect(detectClaudeCodeArtifact({ content: mainContent, fileName: 'e2e-main-session.jsonl' })).toBe('session-transcript');

    expect(detectClaudeCode(subagentContent)).toBe(true);
    // Deliberately no fileName/relativePath — proves this resolves from
    // content (isSidechain: true on every line), not the "subagents/" path
    // tiebreak.
    expect(detectClaudeCodeArtifact({ content: subagentContent })).toBe('subagent-transcript');

    expect(detectClaudeCodeArtifact({ content: subagentMetaContent })).toBe('subagent-meta');
    expect(detectClaudeCodeArtifact({ content: settingsUserContent })).toBe('settings');
    expect(detectClaudeCodeArtifact({ content: settingsProjectContent })).toBe('settings');
    expect(detectClaudeCodeArtifact({ content: mcpContent })).toBe('mcp-config');
    expect(detectClaudeCodeArtifact({ content: agentDocsDrafterContent, fileName: 'docs-drafter.md' })).toBe('agent-definition');
    expect(detectClaudeCodeArtifact({ content: skillCsvWranglerContent, fileName: 'SKILL.md' })).toBe('skill-definition');
    expect(detectClaudeCodeArtifact({ content: ruleStyleContent, fileName: 'style.md' })).toBe('rule-definition');

    // `e2e-marketplace.json` uses one string-form and one object-form plugin
    // source (both real, documented-valid shapes per `normalizeSource`'s doc
    // comment in config/marketplace.ts) — `isPluginMarketplaceShape` must
    // accept both. (Previously misclassified as 'unknown' by a detector
    // stricter than the type it was classifying; fixed in src/detect.ts.)
    expect(detectClaudeCodeArtifact({ content: marketplaceContent, fileName: 'marketplace.json' })).toBe('plugin-marketplace');
  });
});

// ---------------------------------------------------------------------------
// Direct parseSessionTranscript assertions (feeds assertions 2, 3, 9 below).
// ---------------------------------------------------------------------------

const session1 = parseSessionTranscript(mainContent);

describe('parseSessionTranscript(main) — direct parse assertions', () => {
  it('parses every non-blank line, one entry per line (minus the one malformed line)', () => {
    // 49 physical lines: 1 blank line (skipped, no entry/no error) + 1
    // malformed JSON line (error, no entry) => 47 entries.
    const totalLines = mainContent.split('\n').filter((l) => l.trim() !== '').length;
    expect(session1.entries.length).toBe(totalLines - 1); // -1 for the malformed line
  });
});

// ---------------------------------------------------------------------------
// Assertion 2: root-field folding.
// ---------------------------------------------------------------------------

describe('assertion 2 — root-field folding', () => {
  it('sessionId/cwd/gitBranch first-wins, aiTitle last-wins, cliVersions deduped in order', () => {
    expect(session1.sessionId).toBe('e2e-sess-0001');
    expect(session1.cwd).toBe('/home/testuser/projects/orbit-tracker');
    expect(session1.gitBranch).toBe('feat/telemetry');
    // Last of the two ai-title entries ("Old title" then "Telemetry
    // ingestion fix") wins.
    expect(session1.aiTitle).toBe('Telemetry ingestion fix');
    // Two distinct CLI versions appear (2.1.0 then 2.1.1 mid-session);
    // deduped, in first-seen order.
    expect(session1.cliVersions).toEqual(['2.1.0', '2.1.1']);
  });
});

// ---------------------------------------------------------------------------
// Assertion 3: cross-timeline tool consistency + aggregateUsage hand-sum.
// ---------------------------------------------------------------------------

describe('assertion 3 — cross-timeline tool consistency', () => {
  it('Bash is always-available (invoked, never deferred); a delta-listed tool is not', () => {
    const bash = session1.tools.find((t) => t.tool === 'Bash');
    expect(bash).toBeDefined();
    expect(bash!.alwaysAvailable).toBe(true);
    // Never appears in any deferred_tools_delta.
    expect(bash!.availability.every((e) => e.action === 'invoked')).toBe(true);

    // The specific assistant entry that carried the first Bash tool_use
    // (uuid "a-bash-1") is the exact entryUuid one of Bash's 'invoked'
    // availability events references.
    const bashEntry = session1.entries.find(
      (e): e is AssistantEntry => e.type === 'assistant' && e.uuid === 'a-bash-1',
    );
    expect(bashEntry).toBeDefined();
    const bashToolUse = (bashEntry as AssistantEntry).message.content.find((b) => b.type === 'tool_use' && (b as { name?: string }).name === 'Bash');
    expect(bashToolUse).toBeDefined();
    expect(bash!.availability.some((e) => e.entryUuid === 'a-bash-1' && e.action === 'invoked')).toBe(true);

    // "Write" is delta-listed (present in the initial deferred_tools_delta)
    // AND invoked once — alwaysAvailable must be false despite being used,
    // in contrast to Bash above.
    const write = session1.tools.find((t) => t.tool === 'Write');
    expect(write).toBeDefined();
    expect(write!.invocationCount).toBe(1);
    expect(write!.alwaysAvailable).toBe(false);
    expect(write!.availability.some((e) => e.action === 'deferred')).toBe(true);
  });

  it('sums both assistants’ usage by hand and matches aggregateUsage exactly, per model', () => {
    // Hand-computed from the two usage-bearing assistant turns in the fixture:
    //   turn1 (model "test-model-a"): input 1000, output 200, cache_creation 150, cache_read 50
    //   turn2 (model "test-model-b"): input 500,  output 100, cache_creation 20,  cache_read 10
    const expectedTotal = {
      inputTokens: 1000 + 500,
      outputTokens: 200 + 100,
      cacheCreationTokens: 150 + 20,
      cacheReadTokens: 50 + 10,
    };
    expect(session1.aggregateUsage.inputTokens).toBe(expectedTotal.inputTokens);
    expect(session1.aggregateUsage.outputTokens).toBe(expectedTotal.outputTokens);
    expect(session1.aggregateUsage.cacheCreationTokens).toBe(expectedTotal.cacheCreationTokens);
    expect(session1.aggregateUsage.cacheReadTokens).toBe(expectedTotal.cacheReadTokens);

    expect(Object.keys(session1.aggregateUsage.models).sort()).toEqual(['test-model-a', 'test-model-b']);
    expect(session1.aggregateUsage.models['test-model-a']).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationTokens: 150,
      cacheReadTokens: 50,
    });
    expect(session1.aggregateUsage.models['test-model-b']).toEqual({
      inputTokens: 500,
      outputTokens: 100,
      cacheCreationTokens: 20,
      cacheReadTokens: 10,
    });

    // That assistant's usage is included in aggregateUsage: the turn1
    // assistant entry (a-turn1) really does carry the usage summed above.
    const turn1 = session1.entries.find((e): e is AssistantEntry => e.type === 'assistant' && e.uuid === 'a-turn1');
    expect(turn1?.message.usage?.input_tokens).toBe(1000);
    expect(turn1?.message.model).toBe('test-model-a');
    const turn2 = session1.entries.find((e): e is AssistantEntry => e.type === 'assistant' && e.uuid === 'a-turn2');
    expect(turn2?.message.usage?.input_tokens).toBe(500);
    expect(turn2?.message.model).toBe('test-model-b');
  });
});

// ---------------------------------------------------------------------------
// Full builder chain + parallel buildConfigSnapshot — feeds assertions 4-8,
// 10, 11, 13.
// ---------------------------------------------------------------------------

const mcpConfig = parseMcp(mcpContent, 'project', MCP_SOURCE_PATH);
const settingsUser = parseSettings(settingsUserContent, 'user', SETTINGS_USER_PATH);
const settingsProject = parseSettings(settingsProjectContent, 'project', SETTINGS_PROJECT_PATH);
const agentDef = parseAgentDefinition(agentDocsDrafterContent, AGENT_SOURCE_PATH, 'user');
const skillDef = parseSkillDefinition(skillCsvWranglerContent, SKILL_SOURCE_PATH, 'user');
const ruleDef = parseRuleDefinition(ruleStyleContent, RULE_SOURCE_PATH, 'project');
const marketplace = parsePluginMarketplace(marketplaceContent, MARKETPLACE_SOURCE_PATH);
const subagentSession = parseSessionTranscript(subagentContent);
const subagentMeta = parseSubagentMeta(subagentMetaContent);

const baseBuilder = parseSession(mainContent);
const preChainSession = baseBuilder.toSession();
const preChainSnapshotJson = JSON.stringify(preChainSession);

const chainedBuilder = baseBuilder
  .appendMcp(mcpConfig)
  .appendSettings(settingsUser)
  .appendSettings(settingsProject)
  .appendAgents([agentDef])
  .appendSkills([skillDef])
  .appendRules([ruleDef])
  .appendSubAgent('e2e-agent-0001', subagentSession, subagentMeta);

const session2 = chainedBuilder.toSession();

const configSnapshot = buildConfigSnapshot(
  [mcpConfig, settingsUser, settingsProject, agentDef, skillDef, ruleDef, marketplace],
  'project',
);

// ---------------------------------------------------------------------------
// Assertion 4: MCP namespace join, end to end.
// ---------------------------------------------------------------------------

describe('assertion 4 — MCP namespace join, end to end', () => {
  it('joins mcp__zephyr_tools__forecast onto the zephyr:tools record, before and after appendMcp', () => {
    const zephyr = session1.mcpServers.find((m) => m.server === 'zephyr:tools');
    expect(zephyr).toBeDefined();
    expect(zephyr!.toolNamespace).toBe('zephyr_tools');
    expect(zephyr!.invokedTools).toEqual([{ tool: 'forecast', count: 1 }]);

    // After appendMcp, the SAME record (not a duplicate) carries `config`
    // from the .mcp.json fixture.
    const zephyr2 = session2.mcpServers.find((m) => m.server === 'zephyr:tools');
    expect(zephyr2).toBeDefined();
    expect(zephyr2!.invokedTools).toEqual([{ tool: 'forecast', count: 1 }]);
    expect(zephyr2!.config?.command).toBe('node');
    // Exactly one zephyr:tools record post-append, not two.
    expect(session2.mcpServers.filter((m) => m.server === 'zephyr:tools')).toHaveLength(1);
  });

  it('quill-db stays pending: true, with its config attached as the same (not a duplicate) record', () => {
    const quill1 = session1.mcpServers.find((m) => m.server === 'quill-db');
    expect(quill1).toBeDefined();
    expect(quill1!.pending).toBe(true);
    expect(quill1!.config).toBeUndefined();

    const quill2 = session2.mcpServers.find((m) => m.server === 'quill-db');
    expect(quill2).toBeDefined();
    expect(quill2!.pending).toBe(true);
    expect(quill2!.config?.url).toBe('https://quill-db.example.invalid/mcp');
    expect(session2.mcpServers.filter((m) => m.server === 'quill-db')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Assertion 5: subagent join.
// ---------------------------------------------------------------------------

describe('assertion 5 — subagent join', () => {
  it('the SubagentLaunchRecord carries agentId from toolUseResult, and appendSubAgent enriches consistently in both views', () => {
    const launch1 = session1.subagentLaunches.find((l) => l.toolUseId === 'toolu_agent_1');
    expect(launch1).toBeDefined();
    expect(launch1!.agentId).toBe('e2e-agent-0001');
    // The transcript's own Agent tool_use omitted `description`, and its
    // toolUseResult carried a `resolvedModel` distinct from the meta's
    // `model` — set up specifically to prove appendSubAgent only fills
    // UNSET fields.
    expect(launch1!.description).toBeUndefined();
    expect(launch1!.model).toBe('test-model-transcript');

    // After appendSubAgent: session.subagentSessions['e2e-agent-0001'] is
    // the parsed subagent session (isSidechain true, agentId folded to root).
    const subSession = session2.subagentSessions?.['e2e-agent-0001'];
    expect(subSession).toBeDefined();
    expect((subSession as ClaudeCodeSession).isSidechain).toBe(true);
    expect((subSession as ClaudeCodeSession).agentId).toBe('e2e-agent-0001');
    expect(subSession).toBe(subagentSession); // same parsed object, stored verbatim

    // meta.description fills the unset field; meta.model does NOT override
    // the already-set transcript value.
    const launch2 = session2.subagentLaunches.find((l) => l.toolUseId === 'toolu_agent_1');
    expect(launch2!.description).toBe('Draft docs for telemetry module');
    expect(launch2!.model).toBe('test-model-transcript');

    // The same enriched launch object appears identically inside
    // agents['docs-drafter'].invocations — both views rebuilt consistently.
    const docsDrafterAgent = session2.agents.find((a) => a.agentType === 'docs-drafter');
    expect(docsDrafterAgent).toBeDefined();
    const invocationView = docsDrafterAgent!.invocations.find((l) => l.toolUseId === 'toolu_agent_1');
    expect(invocationView).toEqual(launch2);
  });
});

// ---------------------------------------------------------------------------
// Assertion 6: skill lifecycle.
// ---------------------------------------------------------------------------

describe('assertion 6 — skill lifecycle', () => {
  it('csv-wrangler goes listed -> invoked -> expanded, with launched:true and sourceDir extracted', () => {
    const csvWrangler = session1.skills.find((s) => s.name === 'csv-wrangler');
    expect(csvWrangler).toBeDefined();
    expect(csvWrangler!.availability.map((e) => e.action)).toEqual(['listed', 'invoked', 'expanded']);
    expect(csvWrangler!.availability[0].isInitial).toBe(true);
    expect(csvWrangler!.invocations).toHaveLength(1);
    expect(csvWrangler!.invocations[0].launched).toBe(true);
    expect(csvWrangler!.sourceDir).toBe('/home/testuser/.claude/skills/csv-wrangler');
  });

  it('appendSkill fills description/displayPath only where unset', () => {
    const before = session1.skills.find((s) => s.name === 'csv-wrangler')!;
    // The transcript's own skill_listing already supplied a description —
    // appendSkill must NOT clobber it.
    expect(before.description).toBe('Normalizes CSV exports from the telemetry pipeline into tidy tables.');
    expect(before.displayPath).toBeUndefined();

    const after = session2.skills.find((s) => s.name === 'csv-wrangler')!;
    // description unchanged (already set, from the transcript)
    expect(after.description).toBe(before.description);
    // displayPath newly filled from the definition (was unset)
    expect(after.displayPath).toBe(SKILL_SOURCE_PATH);
  });

  it('the plugin skill pluglet:report-gen has pluginPrefix/bareName split', () => {
    const reportGen = session1.skills.find((s) => s.name === 'pluglet:report-gen');
    expect(reportGen).toBeDefined();
    expect(reportGen!.pluginPrefix).toBe('pluglet');
    expect(reportGen!.bareName).toBe('report-gen');
  });
});

// ---------------------------------------------------------------------------
// Assertion 7: rule tri-state.
// ---------------------------------------------------------------------------

describe('assertion 7 — rule tri-state', () => {
  it('style.md is injected via nested_memory, with globs from the attachment', () => {
    const rule = session1.rules.find((r) => r.path === RULE_SOURCE_PATH);
    expect(rule).toBeDefined();
    expect(rule!.injectionStatus).toBe('injected');
    expect(rule!.origin).toBe('nested_memory');
    expect(rule!.globs).toEqual(['src/**']);
  });

  it('compact_file_reference for the same path adds a referenced event without downgrading status', () => {
    const rule = session1.rules.find((r) => r.path === RULE_SOURCE_PATH)!;
    expect(rule.availability.map((e) => e.action)).toEqual(['injected', 'referenced']);
    expect(rule.injectionStatus).toBe('injected'); // never downgraded
  });

  it('appendRule for the same sourcePath leaves status injected, and globs agree with the definition', () => {
    // NOTE: `before` must come from `preChainSession` (the same parse that
    // feeds `chainedBuilder`/`session2`), not the separately-parsed
    // `session1` — otherwise the reference-identity check below compares
    // objects from two independent `parseSessionTranscript` calls, which
    // are only ever structurally equal, never `===`.
    const before = preChainSession.rules.find((r) => r.path === RULE_SOURCE_PATH)!;
    const beforeFrontmatter = before.frontmatter;

    const after = session2.rules.find((r) => r.path === RULE_SOURCE_PATH)!;
    expect(after.injectionStatus).toBe('injected'); // unchanged
    expect(after.globs).toEqual(['src/**']);
    expect(after.globs).toEqual(ruleDef.globs); // record and definition agree
    // frontmatter was already set from the transcript (a nested_memory
    // sighting) — appendRule only fills UNSET fields, so it must be left
    // exactly as it was (same reference), not replaced by the definition's.
    expect(after.frontmatter).toBe(beforeFrontmatter);
  });

  it('a second appended rule with no transcript sighting is unknown, never available', () => {
    const untouchedRuleDef = parseRuleDefinition(
      '# Testing conventions\n\nWrite tests before implementation.\n',
      '/home/testuser/projects/orbit-tracker/.claude/rules/testing.md',
      'project',
    );
    const withExtraRule = chainedBuilder.appendRule(untouchedRuleDef).toSession();
    const newRecord = withExtraRule.rules.find((r) => r.path === untouchedRuleDef.sourcePath);
    expect(newRecord).toBeDefined();
    expect(newRecord!.injectionStatus).toBe('unknown');
    expect(newRecord!.origin).toBe('config_inventory');
  });
});

// ---------------------------------------------------------------------------
// Assertion 8: supporting records.
// ---------------------------------------------------------------------------

describe('assertion 8 — supporting records', () => {
  it('exactly one PR link despite two sources (pr-link entry + gitOperation.pr)', () => {
    expect(session1.prLinks).toHaveLength(1);
    expect(session1.prLinks[0]).toMatchObject({
      prNumber: 7,
      prUrl: 'https://github.com/demo-org/orbit-tracker/pull/7',
      prRepository: 'demo-org/orbit-tracker',
    });
  });

  it('permission modes collapse to the real transitions only', () => {
    expect(session1.permissionModes.map((m) => m.mode)).toEqual(['default', 'acceptEdits']);
  });

  it('exactly one compaction, with the fixture’s preTokens/postTokens', () => {
    expect(session1.compactions).toHaveLength(1);
    expect(session1.compactions[0].metadata.preTokens).toBe(50000);
    expect(session1.compactions[0].metadata.postTokens).toBe(12000);
  });

  it('hook records include hook_success (outcome success, exit code) and hook_additional_context (outcome additional_context)', () => {
    const success = session1.hooks.find((h) => h.hookName === 'lint-check');
    expect(success).toBeDefined();
    expect(success!.outcome).toBe('success');
    expect(success!.exitCode).toBe(0);

    const additionalContext = session1.hooks.find((h) => h.hookName === 'context-hook');
    expect(additionalContext).toBeDefined();
    expect(additionalContext!.outcome).toBe('additional_context');
    expect(additionalContext!.injectedContext).toEqual(['Reminder: telemetry schema changed in migration 0007.']);
  });
});

// ---------------------------------------------------------------------------
// Assertion 9: error/unknown accounting at scale.
// ---------------------------------------------------------------------------

describe('assertion 9 — error/unknown accounting at scale', () => {
  it('exactly one invalid_json ParseError, with a line number matching the fixture', () => {
    const invalidJsonErrors = session1.parseErrors.filter((e) => e.code === 'invalid_json');
    expect(invalidJsonErrors).toHaveLength(1);
    const expectedLine = lineNumberOf(mainContent, '"content": "incomplete');
    expect(invalidJsonErrors[0].line).toBe(expectedLine);
  });

  it('unknownTypes counts the one forward-compatible unknown entry exactly once', () => {
    expect(session1.unknownTypes).toEqual({ 'wibble-unknown': 1 });
  });

  it('entry lineNumbers reflect real file lines — blank/malformed lines do not shift numbering', () => {
    const expectedUnknownLine = lineNumberOf(mainContent, 'wibble-unknown');
    const unknownEntry = session1.entries.find((e) => e.type === 'wibble-unknown');
    expect(unknownEntry?.lineNumber).toBe(expectedUnknownLine);

    // The final ai-title entry ("Telemetry ingestion fix") is the very last
    // physical line, AFTER the blank line and the malformed line — proving
    // both were counted toward line numbering even though neither produced
    // an entry of their own (the malformed line produced only a ParseError,
    // the blank line produced nothing).
    const lastLine = mainContent.split('\n').filter((l) => l.length > 0).length === 0
      ? 0
      : mainContent.split('\n').length - (mainContent.endsWith('\n') ? 1 : 0);
    const finalAiTitle = session1.entries.filter((e) => e.type === 'ai-title').pop();
    expect(finalAiTitle).toBeDefined();
    expect((finalAiTitle as { lineNumber: number }).lineNumber).toBe(lastLine);
  });
});

// ---------------------------------------------------------------------------
// Assertion 10: builder immutability.
// ---------------------------------------------------------------------------

describe('assertion 10 — builder immutability', () => {
  it('the original session is deep-equal to its pre-chain snapshot after the whole append chain runs', () => {
    // Sanity: the chain actually produced a different object.
    expect(session2).not.toBe(preChainSession);
    expect(chainedBuilder).not.toBe(baseBuilder);

    // The ORIGINAL builder's session was never mutated by any appendX call
    // made on builders derived from it.
    expect(baseBuilder.toSession()).toBe(preChainSession);
    expect(JSON.stringify(baseBuilder.toSession())).toBe(preChainSnapshotJson);
  });
});

// ---------------------------------------------------------------------------
// Assertion 11: buildConfigSnapshot coherence.
// ---------------------------------------------------------------------------

describe('assertion 11 — buildConfigSnapshot coherence', () => {
  it('inventories bucket by root: user root, project root, and marketplace’s own .claude-plugin root', () => {
    const userRoot = configSnapshot.inventories.find((i) => i.rootPath === '/home/testuser/.claude');
    expect(userRoot).toBeDefined();
    expect(userRoot!.scope).toBe('user');
    expect(userRoot!.agents).toHaveLength(1);
    expect(userRoot!.skills).toHaveLength(1);

    const projectRoot = configSnapshot.inventories.find((i) => i.rootPath === '/home/testuser/projects/orbit-tracker/.claude');
    expect(projectRoot).toBeDefined();
    expect(projectRoot!.scope).toBe('project');
    expect(projectRoot!.rules).toHaveLength(1);

    // The marketplace gets its OWN inventory — a distinct .claude-plugin
    // root, not merged into either root above.
    const marketplaceInventory = configSnapshot.inventories.find((i) => i.marketplace !== undefined);
    expect(marketplaceInventory).toBeDefined();
    expect(marketplaceInventory!.rootPath).toBe('/home/testuser/projects/orbit-tracker/.claude-plugin');
    expect(marketplaceInventory!.marketplace?.name).toBe('nimbus-market');
    expect(marketplaceInventory).not.toBe(userRoot);
    expect(marketplaceInventory).not.toBe(projectRoot);
  });

  it('effectiveSettings.env: project overrides the shared key, the user-only key survives', () => {
    expect(configSnapshot.effectiveSettings.env?.API_HOST).toBe('https://telemetry-project.example.invalid');
    expect(configSnapshot.effectiveSettings.env?.USER_ONLY_VAR).toBe('user-value');
    expect(configSnapshot.effectiveSettings.env?.PROJECT_ONLY_VAR).toBe('project-value');
  });

  it('permissions.allow is the deduped union across scopes', () => {
    expect(configSnapshot.effectiveSettings.permissions?.allow).toEqual(['Bash(pnpm test)', 'Write(src/**)']);
    expect(configSnapshot.effectiveSettings.permissions?.defaultMode).toBe('acceptEdits');
  });

  it('agentsByName/skillsByName/mcpServersByName all resolve', () => {
    expect(configSnapshot.agentsByName['docs-drafter']?.name).toBe('docs-drafter');
    expect(configSnapshot.skillsByName['csv-wrangler']?.name).toBe('csv-wrangler');
    expect(configSnapshot.mcpServersByName['zephyr:tools']?.command).toBe('node');
    expect(configSnapshot.mcpServersByName['quill-db']?.url).toBe('https://quill-db.example.invalid/mcp');
  });
});

// ---------------------------------------------------------------------------
// Assertion 12: determinism.
// ---------------------------------------------------------------------------

describe('assertion 12 — determinism', () => {
  it('parsing the same fixture twice yields deep-equal sessions', () => {
    const parseA = parseSessionTranscript(mainContent);
    const parseB = parseSessionTranscript(mainContent);
    expect(parseA).not.toBe(parseB);
    expect(parseA).toEqual(parseB);
  });
});

// ---------------------------------------------------------------------------
// Assertion 13: ParseOptions pass-through on the real fixture.
// ---------------------------------------------------------------------------

describe('assertion 13 — ParseOptions pass-through', () => {
  it('maxBlobBytes clamps skills[].injectedContent and hook stdout', () => {
    const clamped = parseSession(mainContent, { maxBlobBytes: 48 }).toSession();

    const clampedSkill = clamped.skills.find((s) => s.name === 'csv-wrangler');
    expect(clampedSkill?.injectedContent).toBeDefined();
    expect((clampedSkill!.injectedContent as string).length).toBeLessThanOrEqual(48);
    const unclamped = session1.skills.find((s) => s.name === 'csv-wrangler')!;
    expect((clampedSkill!.injectedContent as string).length).toBeLessThan((unclamped.injectedContent as string).length);

    const clampedHook = clamped.hooks.find((h) => h.hookName === 'lint-check');
    expect(clampedHook?.stdout).toBeDefined();
    expect((clampedHook!.stdout as string).length).toBeLessThanOrEqual(48);
    const unclampedHook = session1.hooks.find((h) => h.hookName === 'lint-check')!;
    expect((clampedHook!.stdout as string).length).toBeLessThan((unclampedHook.stdout as string).length);
  });

  it('skipTimelines yields empty timelines but identical entries/aggregateUsage/parseErrors', () => {
    const skipped = parseSession(mainContent, { skipTimelines: true }).toSession();

    expect(skipped.tools).toEqual([]);
    expect(skipped.skills).toEqual([]);
    expect(skipped.agents).toEqual([]);
    expect(skipped.rules).toEqual([]);
    expect(skipped.mcpServers).toEqual([]);
    expect(skipped.permissionModes).toEqual([]);
    expect(skipped.hooks).toEqual([]);
    expect(skipped.compactions).toEqual([]);
    expect(skipped.prLinks).toEqual([]);
    expect(skipped.subagentLaunches).toEqual([]);

    expect(skipped.entries).toEqual(session1.entries);
    expect(skipped.aggregateUsage).toEqual(session1.aggregateUsage);
    expect(skipped.parseErrors).toEqual(session1.parseErrors);
  });
});

// ---------------------------------------------------------------------------
// Sanity: attachment entry shape check used above (assertion 3) actually
// discriminates correctly — guards against a future entry-parsers regression
// silently turning the Bash tool_use assertion into a false positive.
// ---------------------------------------------------------------------------

describe('sanity — attachment discrimination used elsewhere in this file', () => {
  it('the initial deferred_tools_delta attachment really is that attachment type', () => {
    const first = session1.entries.find(
      (e): e is AttachmentEntry => e.type === 'attachment' && (e as AttachmentEntry).uuid === 'att-deferred-1',
    );
    expect(first?.attachment.type).toBe('deferred_tools_delta');
  });
});
