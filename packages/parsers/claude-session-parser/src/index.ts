/**
 * Public API barrel for `@lucasschirm/sal-claude-session-parser` — spec §4.
 * This is the complete public surface; every symbol spec §4 lists is
 * exported here, plus every type from `./types`. Downstream agents (T2-T9)
 * never edit this file — their modules are wired in already, each behind
 * its frozen signature.
 */

export { parseAgentDefinition } from './config/agent-definition.js';
export { parsePluginMarketplace } from './config/marketplace.js';
export { parseMcp } from './config/mcp-config.js';
export { parseRuleDefinition } from './config/rule-definition.js';
export { parseSettings } from './config/settings.js';
export { parseSkillDefinition } from './config/skill-definition.js';
// ---- Config-only composition -----------------------------------------
export { buildConfigSnapshot } from './config/snapshot.js';
export type { ClaudeCodeArtifactKind } from './detect.js';
// ---- Detection --------------------------------------------------------
export { detectClaudeCode, detectClaudeCodeArtifact } from './detect.js';
export type { ClaudeSessionBuilder } from './session/builder.js';
// ---- Session composition -------------------------------------------------
export { parseSession } from './session/builder.js';
// ---- Pure parsers -------------------------------------------------------
export { parseSessionTranscript } from './session/parse-transcript.js';
export { parseSubagentMeta } from './session/subagent-meta.js';
// ---- Types ----------------------------------------------------------------
export * from './types/index.js';

// ---- Utilities (also useful to the site transformer) ---------------------
export { normalizeGlobs, parseFrontmatter } from './utils/frontmatter.js';
export { mcpServerNameToNamespace, splitMcpToolName } from './utils/mcp-names.js';
export { ALWAYS_AVAILABLE_TOOLS, isAgentTool, isSkillTool } from './utils/tool-names.js';
