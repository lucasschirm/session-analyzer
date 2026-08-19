import type { DiscoveryResult, SessionDiscoveryInput } from './contract.js';
import { makeDiscoveryContext, runSessionDiscovery } from './core.js';

export async function discoverSession(input: SessionDiscoveryInput): Promise<DiscoveryResult> {
  const context = makeDiscoveryContext(input.limits);
  await runSessionDiscovery(context, input);
  return context.toResult();
}
