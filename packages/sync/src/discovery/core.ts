import path from 'node:path';

import { CAPTURE_ALLOWLIST } from '../allowlist.js';
import type { ArtifactScope } from '../artifact.js';
import { DEFAULT_SYNC_LIMITS, type SyncLimits } from '../limits.js';
import { DiscoveryContext } from './context.js';
import type { DiscoveryInput, DiscoveryResult } from './contract.js';
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
    const transcriptDir = path.dirname(path.resolve(input.transcriptPath));
    const sessionPatterns = expandAllowlist(CAPTURE_ALLOWLIST.session, '', '', transcriptDir);
    await runScopeDiscovery(context, 'session', sessionPatterns, input.projectId, input.sessionId);
  }

  return context.toResult();
}
