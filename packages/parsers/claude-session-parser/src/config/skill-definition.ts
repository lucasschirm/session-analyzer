import type { ClaudeScope } from '../types/common.js';
import type { SkillDefinition } from '../types/config.js';

// TODO(T7): implement — see spec §3 (SkillDefinition) + §4 (parseSkillDefinition)
export function parseSkillDefinition(content: string, sourcePath?: string, scope?: ClaudeScope): SkillDefinition {
  void content;
  return {
    kind: 'skill-definition',
    sourcePath,
    scope: scope ?? 'unknown',
    name: '',
    frontmatter: {},
    body: '',
    parseErrors: [],
  };
}
