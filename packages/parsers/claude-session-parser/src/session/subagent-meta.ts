/**
 * Parses `~/.claude/projects/<project>/subagents/agent-<id>.meta.json`
 * sidecars — spec §3 (`SubagentMeta`) + §4 (`parseSubagentMeta`).
 *
 * Verified against real files on this machine (all consistently a single
 * flat JSON object, e.g.:
 * `{"agentType":"general-purpose","description":"Implement Task 6: webmcp
 * tab registry and lifecycle","toolUseId":"toolu_01KiBu5gtNpHDXmiYAC36Log",
 * "spawnDepth":1,"model":"sonnet"}`), which matches the `SubagentMeta`
 * shape T1 already defined in `types/config.ts`. No real file was missing
 * `toolUseId` in this machine's corpus, but every field stays optional per
 * T1's type (not every real file elsewhere is guaranteed to carry all five).
 *
 * See spec: docs/superpowers/specs/2026-08-12-claude-session-parser-design.md
 */

import type { SubagentMeta } from '../types/config.js';
import { stripBom, safeJsonParse } from '../utils/text.js';
import { makeParseError } from '../utils/errors.js';

export function parseSubagentMeta(content: string): SubagentMeta {
  const parseErrors: SubagentMeta['parseErrors'] = [];

  if (typeof content !== 'string' || content.trim() === '') {
    return { parseErrors };
  }

  const stripped = stripBom(content);
  const { value, error } = safeJsonParse<unknown>(stripped);

  if (error !== undefined) {
    parseErrors.push(
      makeParseError('invalid_json', error, { rawSnippet: stripped.slice(0, 200) }),
    );
    return { parseErrors };
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    parseErrors.push(
      makeParseError('unexpected_shape', 'Expected a JSON object at the top level', {
        rawSnippet: stripped.slice(0, 200),
      }),
    );
    return { parseErrors };
  }

  const record = value as Record<string, unknown>;
  const meta: SubagentMeta = { parseErrors };

  if (typeof record.agentType === 'string') meta.agentType = record.agentType;
  if (typeof record.description === 'string') meta.description = record.description;
  if (typeof record.toolUseId === 'string') meta.toolUseId = record.toolUseId;
  if (typeof record.spawnDepth === 'number' && Number.isFinite(record.spawnDepth)) {
    meta.spawnDepth = record.spawnDepth;
  }
  if (typeof record.model === 'string') meta.model = record.model;

  return meta;
}
