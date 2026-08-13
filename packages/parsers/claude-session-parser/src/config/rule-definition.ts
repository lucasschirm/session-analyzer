import type { ClaudeScope } from '../types/common.js';
import type { RuleDefinition } from '../types/config.js';

// TODO(T7): implement — see spec §3 (RuleDefinition) + §4 (parseRuleDefinition)
export function parseRuleDefinition(content: string, sourcePath: string, scope?: ClaudeScope): RuleDefinition {
  void content;
  return {
    kind: 'rule-definition',
    sourcePath,
    scope: scope ?? 'unknown',
    ruleKind: 'rule',
    frontmatter: {},
    globs: [],
    body: '',
    parseErrors: [],
  };
}
