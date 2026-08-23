import path from 'node:path';
import type { ArtifactScope } from '@lucasschirm/sal-sync-core';
import {
  CAPTURE_ALLOWLIST,
  DEFAULT_SYNC_LIMITS,
  type SyncLimits,
} from '@lucasschirm/sal-sync-core';
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

/**
 * Storage-relative name for the main transcript file within the `session` scope.
 *
 * The on-disk filename is `<sessionId>.jsonl`, but the S3 key already includes
 * the sessionId at `<projectId>/<sessionId>/session/...`, so we use a fixed
 * name to avoid repeating the sessionId in the key.
 */
export const MAIN_TRANSCRIPT_STORAGE_NAME = 'transcript.jsonl';

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
  // Use a fixed storage name so the sessionId is not repeated in the S3 key.
  await context.addFile(
    resolvedTranscriptPath,
    transcriptDir,
    'session',
    input.projectId,
    input.sessionId,
    MAIN_TRANSCRIPT_STORAGE_NAME,
  );

  if (context.stopped) {
    return;
  }

  // Per-session supplementary directory: <transcriptDir>/<sessionId>/
  // Use the per-session directory as the root so relativePaths don't include
  // the sessionId prefix (e.g. "subagents/agent-xxx.jsonl" instead of
  // "<sessionId>/subagents/agent-xxx.jsonl").
  const sessionDir = path.join(transcriptDir, input.sessionId);

  await discoverFromPattern(
    context,
    {
      root: sessionDir,
      relativePattern: SUBAGENT_TRANSCRIPTS_PATTERN,
      original: SUBAGENT_TRANSCRIPTS_PATTERN,
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
    { root: sessionDir, relativePattern: SUBAGENT_META_PATTERN, original: SUBAGENT_META_PATTERN },
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
