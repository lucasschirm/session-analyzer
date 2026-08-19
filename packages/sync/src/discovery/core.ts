import path from 'node:path';

import { CAPTURE_ALLOWLIST } from '../allowlist.js';
import type { ArtifactScope } from '../artifact.js';
import { DEFAULT_SYNC_LIMITS, type SyncLimits } from '../limits.js';
import { DiscoveryContext } from './context.js';
import type { DiscoveryInput, DiscoveryResult, SessionDiscoveryInput } from './contract.js';
import { discoverFromPattern, type ExpandedPattern, expandAllowlist } from './glob.js';
import { getHomeDir, resolveClaudeConfigDir } from './paths.js';

export async function runScopeDiscovery(
  context: DiscoveryContext,
  scope: ArtifactScope,
  patterns: ExpandedPattern[],
  projectId: string,
  sessionId: string,
): Promise<void> {
  for (const pattern of patterns) {
    if (context.stopped) {
      break;
    }
    await discoverFromPattern(context, pattern, scope, projectId, sessionId);
  }
}

export function makeDiscoveryContext(limits?: SyncLimits): DiscoveryContext {
  return new DiscoveryContext(limits ?? DEFAULT_SYNC_LIMITS);
}

const SUBAGENT_TRANSCRIPTS_PATTERN = 'subagents/*.jsonl';
const SUBAGENT_META_PATTERN = 'subagents/*.meta.json';

export async function runSessionDiscovery(
  context: DiscoveryContext,
  input: SessionDiscoveryInput,
): Promise<void> {
  if (input.captureTranscripts === false || !input.transcriptPath) {
    return;
  }

  const resolvedTranscriptPath = path.resolve(input.transcriptPath);
  const transcriptDir = path.dirname(resolvedTranscriptPath);

  // Capture the exact main transcript file; never glob *.jsonl from the project dir.
  await context.addFile(
    resolvedTranscriptPath,
    transcriptDir,
    'session',
    input.projectId,
    input.sessionId,
  );

  if (context.stopped) {
    return;
  }

  // Per-session supplementary directory: <transcriptDir>/<sessionId>/subagents/
  const subagentTranscriptPattern = path
    .join(input.sessionId, SUBAGENT_TRANSCRIPTS_PATTERN)
    .replace(/\\/g, '/');
  const subagentMetaPattern = path.join(input.sessionId, SUBAGENT_META_PATTERN).replace(/\\/g, '/');

  await discoverFromPattern(
    context,
    {
      root: transcriptDir,
      relativePattern: subagentTranscriptPattern,
      original: subagentTranscriptPattern,
    },
    'session',
    input.projectId,
    input.sessionId,
  );

  if (context.stopped) {
    return;
  }

  await discoverFromPattern(
    context,
    { root: transcriptDir, relativePattern: subagentMetaPattern, original: subagentMetaPattern },
    'session',
    input.projectId,
    input.sessionId,
  );
}

export async function discover(input: DiscoveryInput): Promise<DiscoveryResult> {
  const context = makeDiscoveryContext(input.limits);
  const claudeConfigDir = input.claudeConfigDir ?? resolveClaudeConfigDir();
  const homeDir = input.homeDir ?? getHomeDir();

  const workspacePatterns = expandAllowlist(
    CAPTURE_ALLOWLIST.workspace,
    '',
    '',
    input.workspaceRoot,
  );
  await runScopeDiscovery(
    context,
    'workspace',
    workspacePatterns,
    input.projectId,
    input.sessionId,
  );

  if (!context.stopped) {
    const globalPatterns = expandAllowlist(CAPTURE_ALLOWLIST.global, claudeConfigDir, homeDir);
    await runScopeDiscovery(context, 'global', globalPatterns, input.projectId, input.sessionId);
  }

  if (!context.stopped && input.transcriptPath && input.captureTranscripts !== false) {
    await runSessionDiscovery(context, input);
  }

  return context.toResult();
}
