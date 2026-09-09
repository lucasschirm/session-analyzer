import path from 'node:path';
import process from 'node:process';
import type {
  ArtifactScope,
  HarnessProfile,
  SessionLayoutDescriptor,
} from '@lucasschirm/sal-sync-core';
import { DEFAULT_SYNC_LIMITS, type SyncLimits } from '@lucasschirm/sal-sync-core';
import { DiscoveryContext } from './context.js';
import type { DiscoveryInput, DiscoveryResult, SessionDiscoveryInput } from './contract.js';
import { discoverFromPattern, type ExpandedPattern, expandAllowlist } from './glob.js';
import { getHomeDir } from './paths.js';
import { MAIN_TRANSCRIPT_STORAGE_NAME } from './session-layout.js';

// Re-exported for backward compatibility: this constant used to be defined
// here. The canonical definition (and the rest of Claude's session layout)
// now lives in `./session-layout.js` alongside `CLAUDE_SESSION_LAYOUT`.
export { MAIN_TRANSCRIPT_STORAGE_NAME };

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

export async function runSessionDiscovery(
  context: DiscoveryContext,
  input: SessionDiscoveryInput,
  sessionLayout: SessionLayoutDescriptor,
): Promise<void> {
  if (input.captureTranscripts === false || !input.transcriptPath) {
    return;
  }

  const resolvedTranscriptPath = path.resolve(input.transcriptPath);
  const transcriptDir = path.dirname(resolvedTranscriptPath);

  // Capture the exact main transcript file; never glob *.jsonl from the project dir.
  // Use the profile's fixed storage name so the sessionId is not repeated in the S3 key.
  await context.addFile(
    resolvedTranscriptPath,
    transcriptDir,
    'session',
    input.projectId,
    input.sessionId,
    sessionLayout.mainTranscriptStorageName,
  );

  if (context.stopped) {
    return;
  }

  // Per-session supplementary directory: <transcriptDir>/<sessionId>/
  // Use the per-session directory as the root so relativePaths don't include
  // the sessionId prefix (e.g. "subagents/agent-xxx.jsonl" instead of
  // "<sessionId>/subagents/agent-xxx.jsonl").
  const sessionDir = path.join(transcriptDir, input.sessionId);
  const { subagentTranscriptsPattern, subagentMetaPattern } = sessionLayout;

  await discoverFromPattern(
    context,
    {
      root: sessionDir,
      relativePattern: subagentTranscriptsPattern,
      original: subagentTranscriptsPattern,
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
    { root: sessionDir, relativePattern: subagentMetaPattern, original: subagentMetaPattern },
    'session',
    input.projectId,
    input.sessionId,
  );
}

export async function discover(
  input: DiscoveryInput,
  profile: HarnessProfile,
): Promise<DiscoveryResult> {
  const context = makeDiscoveryContext(input.limits);
  const configDir = input.configDir ?? profile.configDir(input.env ?? process.env);
  const homeDir = input.homeDir ?? getHomeDir();

  const workspacePatterns = expandAllowlist(
    profile.captureAllowlist.workspace,
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
    const globalPatterns = expandAllowlist(profile.captureAllowlist.global, configDir, homeDir);
    await runScopeDiscovery(context, 'global', globalPatterns, input.projectId, input.sessionId);
  }

  if (!context.stopped && input.transcriptPath && input.captureTranscripts !== false) {
    await runSessionDiscovery(context, input, profile.sessionLayout);
  }

  return context.toResult();
}
