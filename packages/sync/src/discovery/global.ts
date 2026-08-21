import { CAPTURE_ALLOWLIST } from '@lucasschirm/sal-sync-core';
import type { DiscoveryResult, GlobalDiscoveryInput } from './contract.js';
import { makeDiscoveryContext, runScopeDiscovery } from './core.js';
import { expandAllowlist } from './glob.js';
import { getHomeDir, resolveClaudeConfigDir } from './paths.js';

export async function discoverGlobal(input: GlobalDiscoveryInput): Promise<DiscoveryResult> {
  const context = makeDiscoveryContext(input.limits);
  const claudeConfigDir = input.claudeConfigDir ?? resolveClaudeConfigDir();
  const homeDir = input.homeDir ?? getHomeDir();
  const patterns = expandAllowlist(CAPTURE_ALLOWLIST.global, claudeConfigDir, homeDir);
  await runScopeDiscovery(context, 'global', patterns, input.projectId, input.sessionId);
  return context.toResult();
}
