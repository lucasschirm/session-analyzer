/**
 * Config-surface types — spec §3. Covers `settings.json`, `.mcp.json`,
 * agent/skill/rule definition files, plugin marketplaces, and a full
 * `.claude` folder inventory, independent of any one session transcript.
 *
 * See spec: docs/superpowers/specs/2026-08-12-claude-session-parser-design.md
 */

import type { ClaudeScope, ParseError } from './common.js';
import type { RuleFrontmatter } from './timeline.js';

export interface ClaudeCodeSettings {
  /** Discriminant. */
  kind: 'settings';
  scope: ClaudeScope;
  sourcePath?: string;
  model?: string;
  effortLevel?: string;
  permissions?: { defaultMode?: string; allow?: string[]; deny?: string[]; ask?: string[] };
  /** Never redacted — see spec §5 resolved decisions ("Secret handling in parseSettings"). */
  env?: Record<string, string>;
  hooks?: Record<string, HookMatcherGroup[]>;
  enabledPlugins?: Record<string, boolean>;
  extraKnownMarketplaces?: Record<string, { source: { source: string; repo?: string; path?: string } }>;
  sandbox?: { enabled?: boolean; network?: { allowedDomains?: string[] } };
  tui?: string;
  statusLine?: unknown;
  /** Lossless passthrough. */
  raw: Record<string, unknown>;
  parseErrors: ParseError[];
}

export interface HookMatcherGroup {
  matcher?: string;
  hooks: Array<{ type: 'command' | 'agent' | (string & {}); command?: string; prompt?: string; timeout?: number; statusMessage?: string }>;
}

export interface McpConfig {
  /** Discriminant. */
  kind: 'mcp-config';
  sourcePath?: string;
  scope: ClaudeScope;
  servers: McpServerConfig[];
  parseErrors: ParseError[];
}

export interface McpServerConfig {
  name: string;
  toolNamespace: string;
  transport: 'stdio' | 'sse' | 'http' | 'unknown';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  raw: Record<string, unknown>;
}

export interface AgentDefinition {
  /** Discriminant — see note on ClaudeFolderInventory. */
  kind: 'agent-definition';
  sourcePath?: string;
  scope: ClaudeScope;
  name: string;
  description?: string;
  model?: string;
  memory?: 'user' | 'project' | (string & {});
  tools?: string[];
  color?: string;
  frontmatter: Record<string, unknown>;
  body: string;
  parseErrors: ParseError[];
}

export interface SkillDefinition {
  /** Discriminant. */
  kind: 'skill-definition';
  sourcePath?: string;
  scope: ClaudeScope;
  name: string;
  description?: string;
  pluginPrefix?: string;
  allowedTools?: string[];
  frontmatter: Record<string, unknown>;
  body: string;
  supportingFiles?: string[];
  parseErrors: ParseError[];
}

export interface RuleDefinition {
  /** Discriminant (distinct from `ruleKind` below). */
  kind: 'rule-definition';
  sourcePath: string;
  scope: ClaudeScope;
  title?: string;
  /** CLAUDE.md/AGENTS.md vs .claude/rules/*.md */
  ruleKind: 'memory' | 'rule';
  frontmatter: RuleFrontmatter;
  globs: string[];
  body: string;
  parseErrors: ParseError[];
}

export interface PluginMarketplace {
  /** Discriminant. */
  kind: 'plugin-marketplace';
  sourcePath?: string;
  name: string;
  description?: string;
  owner?: { name?: string };
  plugins: Array<{ name: string; source: string; description?: string }>;
}

export interface ClaudeFolderInventory {
  scope: ClaudeScope;
  rootPath?: string;
  settings?: ClaudeCodeSettings;
  localSettings?: ClaudeCodeSettings;
  mcp?: McpConfig;
  agents: AgentDefinition[];
  skills: SkillDefinition[];
  rules: RuleDefinition[];
  hooks: Array<{ path: string; event?: string }>;
  marketplace?: PluginMarketplace;
  /** Files found but not understood — keeps the inventory honest. */
  unrecognized: string[];
  parseErrors: ParseError[];
}

/** Merge of every discovered .claude root, including worktree/nested-resource
 *  copies — resolved decision: merge everything found, no default exclusion. */
export interface ClaudeConfigSnapshot {
  inventories: ClaudeFolderInventory[];
  /** Precedence: managed < user < project < local. */
  effectiveSettings: ClaudeCodeSettings;
  agentsByName: Record<string, AgentDefinition>;
  skillsByName: Record<string, SkillDefinition>;
  mcpServersByName: Record<string, McpServerConfig>;
}

/** Parsed shape of `~/.claude/projects/<project>/subagents/<id>.meta.json`. Spec §4
 *  sketches this inline as `{agentType, description, toolUseId, spawnDepth}`;
 *  cross-checked against real meta files on this machine, which also
 *  consistently carry a `model` field (e.g. `"sonnet"`) not mentioned in
 *  that sketch — added here since it's real and cheap, not a spec
 *  deviation in spirit (the spec's own methodology favors real data over
 *  its own inline sketches when they disagree). None of the fields are
 *  reliably present across every real file observed, so all are optional. */
export interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
  model?: string;
  parseErrors: ParseError[];
}
