import path from 'node:path';

import { CAPTURE_ALLOWLIST } from '../allowlist.js';
import type { DiscoveryResult, SessionDiscoveryInput } from './contract.js';
import { makeDiscoveryContext, runScopeDiscovery } from './core.js';
import { expandAllowlist } from './glob.js';

export async function discoverSession(input: SessionDiscoveryInput): Promise<DiscoveryResult> {
  const context = makeDiscoveryContext(input.limits);
  if (input.captureTranscripts === false || !input.transcriptPath) {
    return context.toResult();
  }
  const transcriptDir = path.dirname(path.resolve(input.transcriptPath));
  const patterns = expandAllowlist(CAPTURE_ALLOWLIST.session, '', '', transcriptDir);
  await runScopeDiscovery(context, 'session', patterns, input.projectId, input.sessionId);
  return context.toResult();
}
