import type { ParseOptions } from '../types/common.js';
import type { ClaudeCodeSession } from '../types/session.js';
import type { AgentDefinition, McpConfig, RuleDefinition, SkillDefinition, SubagentMeta } from '../types/config.js';
import type { ClaudeCodeSettings } from '../types/config.js';
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

// TODO(T9): implement immutably — see spec §4 (parseSession, ClaudeSessionBuilder)
class ClaudeSessionBuilderImpl implements ClaudeSessionBuilder {
  constructor(private readonly session: ClaudeCodeSession) {}

  appendSubAgent(agentId: string, subSession: ClaudeCodeSession, meta?: SubagentMeta): this {
    void agentId;
    void subSession;
    void meta;
    return this;
  }

  appendMcp(config: McpConfig): this {
    void config;
    return this;
  }

  appendSettings(settings: ClaudeCodeSettings): this {
    void settings;
    return this;
  }

  appendAgent(def: AgentDefinition): this {
    void def;
    return this;
  }

  appendAgents(defs: AgentDefinition[]): this {
    void defs;
    return this;
  }

  appendSkill(def: SkillDefinition): this {
    void def;
    return this;
  }

  appendSkills(defs: SkillDefinition[]): this {
    void defs;
    return this;
  }

  appendRule(def: RuleDefinition): this {
    void def;
    return this;
  }

  appendRules(defs: RuleDefinition[]): this {
    void defs;
    return this;
  }

  toSession(): ClaudeCodeSession {
    return this.session;
  }
}

export function parseSession(content: string, options?: ParseOptions): ClaudeSessionBuilder {
  return new ClaudeSessionBuilderImpl(parseSessionTranscript(content, options));
}
