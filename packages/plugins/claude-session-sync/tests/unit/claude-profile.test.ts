import { CAPTURE_ALLOWLIST, CLAUDE_SESSION_LAYOUT } from '@lucasschirm/sal-sync';
import { describe, expect, it } from 'vitest';

import {
  CLAUDE_HARNESS,
  CLAUDE_HARNESS_VERSION,
  ClaudeHarnessProfile,
} from '../../src/claude-profile.js';

describe('ClaudeHarnessProfile', () => {
  it('carries the Claude harness identity', () => {
    expect(ClaudeHarnessProfile.harness).toBe(CLAUDE_HARNESS);
    expect(ClaudeHarnessProfile.harness).toBe('claude');
    expect(ClaudeHarnessProfile.harnessVersion).toBe(CLAUDE_HARNESS_VERSION);
  });

  it('reuses the shared Claude capture allowlist and session layout data', () => {
    expect(ClaudeHarnessProfile.captureAllowlist).toBe(CAPTURE_ALLOWLIST);
    expect(ClaudeHarnessProfile.sessionLayout).toBe(CLAUDE_SESSION_LAYOUT);
  });

  it('resolves configDir from CLAUDE_CONFIG_DIR when set', () => {
    expect(ClaudeHarnessProfile.configDir({ CLAUDE_CONFIG_DIR: '/custom/config' })).toContain(
      '/custom/config',
    );
  });

  it('falls back to ~/.claude when CLAUDE_CONFIG_DIR is not set', () => {
    expect(ClaudeHarnessProfile.configDir({})).toMatch(/\.claude$/);
  });

  it('carries the storage-credential security blocklist', () => {
    expect(ClaudeHarnessProfile.securityBlocklist).toEqual(
      expect.arrayContaining([
        'SAL_STORAGE_ENDPOINT',
        'SAL_STORAGE_ACCESS_KEY_ID',
        'SAL_STORAGE_SECRET_ACCESS_KEY',
      ]),
    );
  });
});
