import process from 'node:process';
import type { HarnessProfile } from '@lucasschirm/sal-sync-core';
import type { DiscoveryResult, GlobalDiscoveryInput } from './contract.js';
import { makeDiscoveryContext, runScopeDiscovery } from './core.js';
import { expandAllowlist } from './glob.js';
import { getHomeDir } from './paths.js';

export async function discoverGlobal(
  input: GlobalDiscoveryInput,
  profile: HarnessProfile,
): Promise<DiscoveryResult> {
  const context = makeDiscoveryContext(input.limits);
  const configDir = input.configDir ?? profile.configDir(input.env ?? process.env);
  const homeDir = input.homeDir ?? getHomeDir();
  const patterns = expandAllowlist(profile.captureAllowlist.global, configDir, homeDir);
  await runScopeDiscovery(context, 'global', patterns, input.projectId, input.sessionId);
  return context.toResult();
}
