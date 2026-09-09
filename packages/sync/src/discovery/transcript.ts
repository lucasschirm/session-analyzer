import type { HarnessProfile } from '@lucasschirm/sal-sync-core';
import type { DiscoveryResult, SessionDiscoveryInput } from './contract.js';
import { makeDiscoveryContext, runSessionDiscovery } from './core.js';

export async function discoverSession(
  input: SessionDiscoveryInput,
  profile: HarnessProfile,
): Promise<DiscoveryResult> {
  const context = makeDiscoveryContext(input.limits);
  await runSessionDiscovery(context, input, profile.sessionLayout);
  return context.toResult();
}
