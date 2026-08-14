/**
 * `ClaudeSessionBuilder` — spec §4 (public API — parse/compose split) + §5
 * ("Builder mutability": resolved decision, immutable).
 *
 * `parseSession` parses a transcript via the existing pure
 * `parseSessionTranscript` and wraps the result in a builder. Every
 * `appendX` call folds one already-parsed config/session piece into the
 * wrapped `ClaudeCodeSession` and returns a NEW builder instance — `this`
 * (the builder an earlier caller is holding) and the `ClaudeCodeSession` it
 * wraps are never mutated. This is what makes the builder safe to hold
 * across an optimistic UI re-render: an old reference keeps seeing the old
 * session forever.
 *
 * Implementation note on immutability: every append below produces a new
 * top-level `ClaudeCodeSession` object. Arrays that are actually changed are
 * rebuilt as new arrays; unrelated arrays/fields are carried over by
 * reference (structural sharing) since only the *returned* session needs to
 * differ from the original — the original's fields are never touched in
 * place, so sharing an unmodified array is observably identical to cloning
 * it, just cheaper.
 *
 * See spec: docs/superpowers/specs/2026-08-12-claude-session-parser-design.md
 */

import type { ClaudeScope, ParseError, ParseOptions } from '../types/common.js';
import type {
  AgentDefinition,
  ClaudeCodeSettings,
  McpConfig,
  McpServerConfig,
  RuleDefinition,
  SkillDefinition,
  SubagentMeta,
} from '../types/config.js';
import type { ClaudeCodeSession } from '../types/session.js';
import type {
  AgentAvailabilityRecord,
  McpServerRecord,
  RuleRecord,
  RuleScope,
  SkillAvailabilityRecord,
  SubagentLaunchRecord,
} from '../types/timeline.js';
import { makeParseError } from '../utils/errors.js';
import { mcpServerNameToNamespace } from '../utils/mcp-names.js';
import { parseSessionTranscript } from './parse-transcript.js';

/** Immutable: every appendX call returns a NEW builder instance rather
 *  than mutating `this` — avoids reference bugs if a UI layer
 *  optimistically appends to a builder mid-render (spec §4/§5). */
export interface ClaudeSessionBuilder {
  appendSubAgent(agentId: string, subSession: ClaudeCodeSession, meta?: SubagentMeta): this;
  appendMcp(config: McpConfig): this;
  appendSettings(settings: ClaudeCodeSettings): this;
  appendAgent(def: AgentDefinition): this;
  appendAgents(defs: AgentDefinition[]): this;
  appendSkill(def: SkillDefinition): this;
  appendSkills(defs: SkillDefinition[]): this;
  appendRule(def: RuleDefinition): this;
  appendRules(defs: RuleDefinition[]): this;
  toSession(): ClaudeCodeSession;
}

// ---------------------------------------------------------------------------
// Small defensive helpers — every appendX guards against "bad input" (spec's
// "Never throw" — a garbage/non-conforming runtime value handed to an
// appendX, despite TypeScript's compile-time signature) by never assuming
// shape past a plain-object check, and by wrapping its own body in
// try/catch. Bad input never mutates anything; it just appends one
// ParseError to the *new* session's parseErrors.
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withError(session: ClaudeCodeSession, code: string, message: string): ClaudeCodeSession {
  return { ...session, parseErrors: [...session.parseErrors, makeParseError(code, message)] };
}

function appendErrors(session: ClaudeCodeSession, errors: ParseError[]): ClaudeCodeSession {
  if (errors.length === 0) return session;
  return { ...session, parseErrors: [...session.parseErrors, ...errors] };
}

const RULE_SCOPE_BY_CLAUDE_SCOPE: Record<ClaudeScope, RuleScope> = {
  managed: 'Managed',
  user: 'User',
  project: 'Project',
  local: 'Local',
  plugin: 'Unknown',
  unknown: 'Unknown',
};

class ClaudeSessionBuilderImpl implements ClaudeSessionBuilder {
  constructor(private readonly session: ClaudeCodeSession) {}

  private next(session: ClaudeCodeSession): this {
    return new ClaudeSessionBuilderImpl(session) as this;
  }

  // ---- appendMcp -----------------------------------------------------

  appendMcp(config: McpConfig): this {
    try {
      if (!isPlainObject(config) || !Array.isArray((config as McpConfig).servers)) {
        return this.next(
          withError(
            this.session,
            'invalid_append_input',
            'appendMcp received a value that is not a valid McpConfig',
          ),
        );
      }

      let mcpServers = this.session.mcpServers;
      for (const serverConfig of config.servers) {
        mcpServers = foldMcpServerConfig(mcpServers, serverConfig);
      }

      let next: ClaudeCodeSession = { ...this.session, mcpServers };
      next = appendErrors(next, config.parseErrors ?? []);
      return this.next(next);
    } catch (err) {
      return this.next(
        withError(
          this.session,
          'append_threw',
          `appendMcp failed unexpectedly: ${errMessage(err)}`,
        ),
      );
    }
  }

  // ---- appendSettings --------------------------------------------------

  appendSettings(settings: ClaudeCodeSettings): this {
    try {
      if (!isPlainObject(settings) || (settings as ClaudeCodeSettings).kind !== 'settings') {
        return this.next(
          withError(
            this.session,
            'invalid_append_input',
            'appendSettings received a value that is not a valid ClaudeCodeSettings',
          ),
        );
      }

      // `permissions.defaultMode` is context only — per spec §4/appendSettings
      // this must NOT fabricate a `PermissionModeChange` timeline event (no
      // transcript entry backs it), so `permissionModes` is deliberately left
      // untouched here.
      const existing = this.session.settings ?? [];
      let next: ClaudeCodeSession = { ...this.session, settings: [...existing, settings] };
      next = appendErrors(next, settings.parseErrors ?? []);
      return this.next(next);
    } catch (err) {
      return this.next(
        withError(
          this.session,
          'append_threw',
          `appendSettings failed unexpectedly: ${errMessage(err)}`,
        ),
      );
    }
  }

  // ---- appendAgent(s) ----------------------------------------------------

  appendAgent(def: AgentDefinition): this {
    try {
      if (!isPlainObject(def) || (def as AgentDefinition).kind !== 'agent-definition') {
        return this.next(
          withError(
            this.session,
            'invalid_append_input',
            'appendAgent received a value that is not a valid AgentDefinition',
          ),
        );
      }
      const agents = foldAgentDefinition(this.session.agents, def);
      let next: ClaudeCodeSession = { ...this.session, agents };
      next = appendErrors(next, def.parseErrors ?? []);
      return this.next(next);
    } catch (err) {
      return this.next(
        withError(
          this.session,
          'append_threw',
          `appendAgent failed unexpectedly: ${errMessage(err)}`,
        ),
      );
    }
  }

  appendAgents(defs: AgentDefinition[]): this {
    if (!Array.isArray(defs)) {
      return this.next(
        withError(
          this.session,
          'invalid_append_input',
          'appendAgents received a value that is not an array',
        ),
      );
    }
    let builder: this = this;
    for (const def of defs) builder = builder.appendAgent(def);
    return builder;
  }

  // ---- appendSkill(s) ----------------------------------------------------

  appendSkill(def: SkillDefinition): this {
    try {
      if (!isPlainObject(def) || (def as SkillDefinition).kind !== 'skill-definition') {
        return this.next(
          withError(
            this.session,
            'invalid_append_input',
            'appendSkill received a value that is not a valid SkillDefinition',
          ),
        );
      }
      const skills = foldSkillDefinition(this.session.skills, def);
      let next: ClaudeCodeSession = { ...this.session, skills };
      next = appendErrors(next, def.parseErrors ?? []);
      return this.next(next);
    } catch (err) {
      return this.next(
        withError(
          this.session,
          'append_threw',
          `appendSkill failed unexpectedly: ${errMessage(err)}`,
        ),
      );
    }
  }

  appendSkills(defs: SkillDefinition[]): this {
    if (!Array.isArray(defs)) {
      return this.next(
        withError(
          this.session,
          'invalid_append_input',
          'appendSkills received a value that is not an array',
        ),
      );
    }
    let builder: this = this;
    for (const def of defs) builder = builder.appendSkill(def);
    return builder;
  }

  // ---- appendRule(s) ----------------------------------------------------

  appendRule(def: RuleDefinition): this {
    try {
      if (!isPlainObject(def) || (def as RuleDefinition).kind !== 'rule-definition') {
        return this.next(
          withError(
            this.session,
            'invalid_append_input',
            'appendRule received a value that is not a valid RuleDefinition',
          ),
        );
      }
      const rules = foldRuleDefinition(this.session.rules, def);
      let next: ClaudeCodeSession = { ...this.session, rules };
      next = appendErrors(next, def.parseErrors ?? []);
      return this.next(next);
    } catch (err) {
      return this.next(
        withError(
          this.session,
          'append_threw',
          `appendRule failed unexpectedly: ${errMessage(err)}`,
        ),
      );
    }
  }

  appendRules(defs: RuleDefinition[]): this {
    if (!Array.isArray(defs)) {
      return this.next(
        withError(
          this.session,
          'invalid_append_input',
          'appendRules received a value that is not an array',
        ),
      );
    }
    let builder: this = this;
    for (const def of defs) builder = builder.appendRule(def);
    return builder;
  }

  // ---- appendSubAgent ----------------------------------------------------

  appendSubAgent(agentId: string, subSession: ClaudeCodeSession, meta?: SubagentMeta): this {
    try {
      if (typeof agentId !== 'string' || agentId.length === 0) {
        return this.next(
          withError(
            this.session,
            'invalid_append_input',
            'appendSubAgent received an empty/non-string agentId',
          ),
        );
      }
      if (!isPlainObject(subSession) || !Array.isArray((subSession as ClaudeCodeSession).entries)) {
        return this.next(
          withError(
            this.session,
            'invalid_append_input',
            'appendSubAgent received a value that is not a valid ClaudeCodeSession',
          ),
        );
      }

      // Enrich every SubagentLaunchRecord whose `agentId` matches — the
      // confirmed bidirectional key (spec §2/Agents evidence). A launch
      // record can appear in both `session.subagentLaunches` (the flat list)
      // and inside the matching `AgentAvailabilityRecord.invocations` — both
      // are rebuilt consistently below so neither view goes stale relative
      // to the other.
      const enrich = (launch: SubagentLaunchRecord): SubagentLaunchRecord => {
        if (launch.agentId !== agentId) return launch;
        const patch: Partial<SubagentLaunchRecord> = {};
        if (meta) {
          if (launch.description === undefined && meta.description !== undefined)
            patch.description = meta.description;
          if (launch.model === undefined && meta.model !== undefined) patch.model = meta.model;
        }
        return Object.keys(patch).length > 0 ? { ...launch, ...patch } : launch;
      };

      const subagentLaunches = this.session.subagentLaunches.map(enrich);
      const agents = this.session.agents.map((rec) => ({
        ...rec,
        invocations: rec.invocations.map(enrich),
      }));

      const existingSubSessions = this.session.subagentSessions ?? {};
      const subagentSessions = { ...existingSubSessions, [agentId]: subSession };

      let next: ClaudeCodeSession = { ...this.session, agents, subagentLaunches, subagentSessions };
      if (meta?.parseErrors?.length) next = appendErrors(next, meta.parseErrors);
      return this.next(next);
    } catch (err) {
      return this.next(
        withError(
          this.session,
          'append_threw',
          `appendSubAgent failed unexpectedly: ${errMessage(err)}`,
        ),
      );
    }
  }

  // ---- toSession -----------------------------------------------------

  toSession(): ClaudeCodeSession {
    return this.session;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// appendMcp folding — spec §4/appendMcp: join each McpServerConfig onto the
// matching McpServerRecord via `config`. Literal-name match first, then the
// mcpServerNameToNamespace fallback (the confirmed real name-normalization
// gotcha, spec §2/MCP). A config with no matching record still surfaces: a
// new McpServerRecord is created for it with empty `availability` (no
// transcript evidence exists for it) rather than being dropped — chosen over
// a separate "unmatched configs" bucket so every server, seen or not, stays
// in the one place a consumer already looks (`session.mcpServers`).
// ---------------------------------------------------------------------------

function foldMcpServerConfig(
  records: McpServerRecord[],
  config: McpServerConfig,
): McpServerRecord[] {
  const namespace = mcpServerNameToNamespace(config.name);
  let matchIdx = records.findIndex((r) => r.server === config.name);
  if (matchIdx === -1) {
    matchIdx = records.findIndex((r) => r.toolNamespace === namespace);
  }

  if (matchIdx === -1) {
    const created: McpServerRecord = {
      server: config.name,
      toolNamespace: config.toolNamespace ?? namespace,
      availability: [],
      offeredTools: [],
      invokedTools: [],
      pending: false,
      needsAuth: false,
      config,
    };
    return [...records, created];
  }

  const next = records.slice();
  next[matchIdx] = { ...next[matchIdx], config };
  return next;
}

// ---------------------------------------------------------------------------
// appendAgent folding — spec §4/appendAgent: fill AgentAvailabilityRecord
// .definition where def.name matches agentType. A definition matching no
// transcript-derived record still surfaces (mirrors the appendMcp policy
// above, for the same reason): a new record is created with the definition
// attached and no availability/invocation evidence, rather than silently
// dropping a real, parsed agent definition just because it was never
// mentioned in this particular transcript.
// ---------------------------------------------------------------------------

function foldAgentDefinition(
  records: AgentAvailabilityRecord[],
  def: AgentDefinition,
): AgentAvailabilityRecord[] {
  const idx = records.findIndex((r) => r.agentType === def.name);
  if (idx === -1) {
    const created: AgentAvailabilityRecord = {
      agentType: def.name,
      availability: [],
      invocations: [],
      attributedTurnCount: 0,
      definition: def,
    };
    return [...records, created];
  }
  const next = records.slice();
  next[idx] = { ...next[idx], definition: def };
  return next;
}

// ---------------------------------------------------------------------------
// appendSkill folding — spec §4/appendSkill: enrich the matching
// SkillAvailabilityRecord (description, path fields) without clobbering
// values the transcript already established. Matching mirrors the same
// prefix/bare-name gotcha `deriveSkillTimeline` already handles internally
// (spec §2/Skills): a definition's `name` may be bare (`"my-skill"`) while
// the transcript record's `name` is fully qualified (`"my-plugin:my-skill"`)
// via its own `pluginPrefix`. Matching tries, in order: exact `name`
// equality, then the definition's own qualified form
// (`${pluginPrefix}:${name}`) against the record's `name`, then the
// definition's bare name against the record's `bareName`.
// ---------------------------------------------------------------------------

function skillQualifiedName(def: SkillDefinition): string {
  if (def.name.includes(':')) return def.name;
  return def.pluginPrefix ? `${def.pluginPrefix}:${def.name}` : def.name;
}

function skillBareName(def: SkillDefinition): string {
  const idx = def.name.indexOf(':');
  return idx === -1 ? def.name : def.name.slice(idx + 1);
}

function foldSkillDefinition(
  records: SkillAvailabilityRecord[],
  def: SkillDefinition,
): SkillAvailabilityRecord[] {
  const qualified = skillQualifiedName(def);
  const bare = skillBareName(def);
  let idx = records.findIndex((r) => r.name === def.name || r.name === qualified);
  if (idx === -1) idx = records.findIndex((r) => r.bareName === bare);

  if (idx === -1) {
    const created: SkillAvailabilityRecord = {
      name: qualified,
      pluginPrefix: def.pluginPrefix,
      bareName: bare,
      description: def.description,
      availability: [],
      invocationCount: 0,
      invocations: [],
      attributedTurnCount: 0,
    };
    if (def.sourcePath !== undefined) created.displayPath = def.sourcePath;
    return [...records, created];
  }

  const rec = records[idx];
  const patch: Partial<SkillAvailabilityRecord> = {};
  if (rec.description === undefined && def.description !== undefined)
    patch.description = def.description;
  if (rec.displayPath === undefined && def.sourcePath !== undefined)
    patch.displayPath = def.sourcePath;
  if (rec.qualifiedPath === undefined && def.pluginPrefix !== undefined) {
    patch.qualifiedPath = `plugin:${def.pluginPrefix}:${bare}`;
  }
  if (Object.keys(patch).length === 0) return records;
  const next = records.slice();
  next[idx] = { ...rec, ...patch };
  return next;
}

// ---------------------------------------------------------------------------
// appendRule folding — spec §4/appendRule + §5 (tri-state injectionStatus):
// a config-derived rule gets `injectionStatus: 'unknown'`, never
// `'available'` — a transcript can't prove a root-scope rule was in context.
// If `def.sourcePath` already exists as a `RuleRecord.path` from a
// `nested_memory` attachment, this enriches that record but NEVER downgrades
// an already-`'injected'` status back toward `'unknown'`.
// ---------------------------------------------------------------------------

function foldRuleDefinition(records: RuleRecord[], def: RuleDefinition): RuleRecord[] {
  const idx = records.findIndex((r) => r.path === def.sourcePath);

  if (idx === -1) {
    const created: RuleRecord = {
      path: def.sourcePath,
      title: def.title,
      scope: RULE_SCOPE_BY_CLAUDE_SCOPE[def.scope] ?? 'Unknown',
      injectionStatus: 'unknown',
      availability: [],
      frontmatter: def.frontmatter,
      globs: def.globs,
      origin: 'config_inventory',
    };
    return [...records, created];
  }

  const rec = records[idx];
  const patch: Partial<RuleRecord> = {};
  // Never downgrade a proven 'injected' status — see doc comment above. Any
  // other existing status (in practice only 'unknown', since neither
  // `deriveRuleTimeline` nor this function ever produces 'available') stays
  // (or becomes) 'unknown' — config-derived evidence alone is never grounds
  // for 'available'.
  if (rec.injectionStatus !== 'injected' && rec.injectionStatus !== 'unknown') {
    patch.injectionStatus = 'unknown';
  }
  if (rec.title === undefined && def.title !== undefined) patch.title = def.title;
  if ((rec.scope === undefined || rec.scope === 'Unknown') && def.scope) {
    const mapped = RULE_SCOPE_BY_CLAUDE_SCOPE[def.scope];
    if (mapped) patch.scope = mapped;
  }
  if (rec.frontmatter === undefined && def.frontmatter !== undefined)
    patch.frontmatter = def.frontmatter;
  if ((rec.globs === undefined || rec.globs.length === 0) && def.globs?.length)
    patch.globs = def.globs;
  if (Object.keys(patch).length === 0) return records;
  const next = records.slice();
  next[idx] = { ...rec, ...patch };
  return next;
}

export function parseSession(content: string, options?: ParseOptions): ClaudeSessionBuilder {
  return new ClaudeSessionBuilderImpl(parseSessionTranscript(content, options));
}
