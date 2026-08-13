/** `name === 'Skill'`. */
export function isSkillTool(name: string): boolean {
  return name === 'Skill';
}

/**
 * Accepts both the current `Agent` tool name and the legacy `Task` name
 * (spec §2/Agents "Decision": the real corpus only shows `Agent`, but
 * older code/comments imply `Task` existed historically). Exact-string
 * equality means this deliberately does NOT match the unrelated
 * todo-management tools `TaskCreate`, `TaskUpdate`, `TaskGet`, `TaskList`,
 * `TaskOutput`, `TaskStop`.
 */
export function isAgentTool(name: string): boolean {
  return name === 'Agent' || name === 'Task';
}

/**
 * Corpus-derived base set of tools observed being invoked but never
 * appearing in any `deferred_tools_delta` — i.e. tools that were always
 * loaded rather than deferred. This is documented as INFERRED, a
 * fallback/reference set: the authoritative value
 * (`ToolAvailabilityRecord.alwaysAvailable`) is computed per-session by
 * set-differencing that session's invoked tools against its own deltas,
 * since the base set is not guaranteed stable across CLI versions.
 */
export const ALWAYS_AVAILABLE_TOOLS: readonly string[] = [
  'Agent',
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'Read',
  'Write',
  'Skill',
  'AskUserQuestion',
  'ReportFindings',
  'ScheduleWakeup',
  'StructuredOutput',
  'ToolSearch',
];
