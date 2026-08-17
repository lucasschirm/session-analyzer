import { CAPTURE_ALLOWLIST } from '../allowlist.js';
import type { DiscoveryResult, WorkspaceDiscoveryInput } from './contract.js';
import { makeDiscoveryContext, runScopeDiscovery } from './core.js';
import { expandAllowlist } from './glob.js';

export async function discoverWorkspace(input: WorkspaceDiscoveryInput): Promise<DiscoveryResult> {
  const context = makeDiscoveryContext(input.limits);
  const patterns = expandAllowlist(CAPTURE_ALLOWLIST.workspace, '', '', input.workspaceRoot);
  await runScopeDiscovery(context, 'workspace', patterns, input.projectId, input.sessionId);
  return context.toResult();
}
