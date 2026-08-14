/**
 * Public API barrel for `@lucasschirm/sal-claude-session-parser` — spec §4.
 * This is the complete public surface; every symbol spec §4 lists is
 * exported here, plus every type from `./types`. Downstream agents (T2-T9)
 * never edit this file — their modules are wired in already, each behind
 * its frozen signature.
 */

// ---- Types ----------------------------------------------------------------
export * from './types/index.js';

// ---- Detection --------------------------------------------------------
export { detectClaudeCode, detectClaudeCodeArtifact } from './detect.js';
export type { ClaudeCodeArtifactKind } from './detect.js';

// ---- Pure parsers -------------------------------------------------------
export { parseSessionTranscript } from './session/parse-transcript.js';
export { parseSubagentMeta } from './session/subagent-meta.js';
export { parseSettings } from './config/settings.js';
export { parseMcp } from './config/mcp-config.js';
export { parseAgentDefinition } from './config/agent-definition.js';
export { parseSkillDefinition } from './config/skill-definition.js';
export { parseRuleDefinition } from './config/rule-definition.js';
export { parsePluginMarketplace } from './config/marketplace.js';

// ---- Session composition -------------------------------------------------
export { parseSession } from './session/builder.js';
export type { ClaudeSessionBuilder } from './session/builder.js';

// ---- Config-only composition -----------------------------------------
export { buildConfigSnapshot } from './config/snapshot.js';

// ---- Utilities (also useful to the site transformer) ---------------------
export { parseFrontmatter, normalizeGlobs } from './utils/frontmatter.js';
export { splitMcpToolName, mcpServerNameToNamespace } from './utils/mcp-names.js';
export { isSkillTool, isAgentTool, ALWAYS_AVAILABLE_TOOLS } from './utils/tool-names.js';
