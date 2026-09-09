import type { HarnessProfile } from '@lucasschirm/sal-sync-core';
import type { DiscoveryResult, WorkspaceDiscoveryInput } from './contract.js';
import { makeDiscoveryContext, runScopeDiscovery } from './core.js';
import { expandAllowlist } from './glob.js';

export async function discoverWorkspace(
  input: WorkspaceDiscoveryInput,
  profile: HarnessProfile,
): Promise<DiscoveryResult> {
  const context = makeDiscoveryContext(input.limits);
  const patterns = expandAllowlist(profile.captureAllowlist.workspace, '', '', input.workspaceRoot);
  await runScopeDiscovery(context, 'workspace', patterns, input.projectId, input.sessionId);
  return context.toResult();
}
