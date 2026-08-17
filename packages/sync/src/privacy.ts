import { TRANSCRIPT_OPT_OUT_ENV_VAR } from './sanitization.js';

export const FULL_DISABLE_ENV_VAR = 'SAL_SYNC_DISABLED';
export const FULL_DISABLE_VALUE = 'true';

export type RetentionScope = 'remote' | 'local';
export type DeletionBehavior = 'manual' | 'on-opt-out';

export interface SyncPrivacyPolicy {
  capturedData: readonly string[];
  sanitizedData: readonly string[];
  transcriptDefault: 'raw';
  transcriptOptOut: string;
  mcpConfigCaptured: boolean;
  globalConfigCaptured: boolean;
  remoteRetention: RetentionScope;
  localRetention: RetentionScope;
  deletion: DeletionBehavior;
  fullDisable: string;
}

export const DEFAULT_PRIVACY_POLICY: SyncPrivacyPolicy = {
  capturedData: [
    'session metadata (sessionId, projectId, harness, model, timing)',
    'session and subagent transcript JSONLs',
    'workspace CLAUDE.md and .mcp.json',
    'workspace .claude/settings, agents, skills, and rules',
    'global ~/.claude settings, CLAUDE.md, agents, and ~/.claude.json',
  ],
  sanitizedData: [
    'workspace and global configuration files (settings, .mcp.json, CLAUDE.md, agents, skills, rules)',
  ],
  transcriptDefault: 'raw',
  transcriptOptOut: `${TRANSCRIPT_OPT_OUT_ENV_VAR}=false`,
  mcpConfigCaptured: true,
  globalConfigCaptured: true,
  remoteRetention: 'remote',
  localRetention: 'local',
  deletion: 'manual',
  fullDisable: `${FULL_DISABLE_ENV_VAR}=true`,
};
